-- ──────────────────────────────────────────────────────────
-- 0028 — recovery handshakes and per-device replica authority
--
-- A lifecycle request must not retire the engine that owns dirty work until
-- that exact generation has published a durable checkpoint. Setup recovery
-- grants are short-lived, run/fence-bound capabilities which can read only the
-- checkpoint blobs selected for the replacement generation. Replica grants
-- are independently revocable per device and are also fenced by the current
-- cloud-workspace authority epoch.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_checkpoints
  DROP CONSTRAINT workspace_checkpoints_reason_check,
  ADD CONSTRAINT workspace_checkpoints_reason_check CHECK (
    reason IN (
      'periodic', 'before_stop', 'before_archive', 'before_delete',
      'before_fork', 'before_rebuild', 'manual', 'recovery'
    )
  );

CREATE TABLE workspace_checkpoint_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  generation                 integer NOT NULL CHECK (generation > 0),
  org_id                     uuid NOT NULL,
  requested_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  lifecycle_intent_id        uuid UNIQUE REFERENCES cloud_workspace_lifecycle_intents(id)
                             ON DELETE CASCADE,
  reason                     text NOT NULL CHECK (
                               reason IN ('before_stop', 'before_archive',
                                          'before_delete', 'before_fork',
                                          'before_rebuild', 'manual')
                             ),
  state                      text NOT NULL DEFAULT 'queued' CHECK (
                               state IN ('queued', 'delivered', 'succeeded',
                                         'failed', 'cancelled', 'expired')
                             ),
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                               AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
                             ),
  checkpoint_id              uuid,
  delivery_count             integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  last_delivered_at          timestamptz,
  deadline_at                timestamptz NOT NULL,
  error_code                 text CHECK (
                               error_code IS NULL OR char_length(error_code) <= 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id, generation, org_id),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (checkpoint_id, workspace_id, org_id)
    REFERENCES workspace_checkpoints(id, workspace_id, org_id)
    ON DELETE RESTRICT,
  CHECK (deadline_at > created_at),
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled', 'expired')
      AND completed_at IS NOT NULL)
    OR
    (state IN ('queued', 'delivered') AND completed_at IS NULL)
  ),
  CHECK ((state = 'succeeded') = (checkpoint_id IS NOT NULL))
);
CREATE INDEX workspace_checkpoint_requests_delivery_idx
  ON workspace_checkpoint_requests(workspace_id, generation, created_at, id)
  WHERE state IN ('queued', 'delivered');
CREATE INDEX workspace_checkpoint_requests_deadline_idx
  ON workspace_checkpoint_requests(deadline_at, id)
  WHERE state IN ('queued', 'delivered');

-- The setup admission itself is consumed before the helper downloads recovery
-- data. Keep recovery on a distinct bearer so replaying setup materials cannot
-- mint or broaden access. A grant may read only the two checkpoint blobs named
-- here and becomes unusable as soon as its setup run/fence is reclaimed.
CREATE TABLE workspace_setup_recovery_grants (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  generation                 integer NOT NULL CHECK (generation > 0),
  org_id                     uuid NOT NULL,
  setup_run_id               uuid NOT NULL,
  setup_execution_fence      bigint NOT NULL CHECK (setup_execution_fence > 0),
  checkpoint_id              uuid NOT NULL,
  manifest_blob_id           uuid NOT NULL,
  artifact_blob_id           uuid,
  token_sha256               bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  expires_at                 timestamptz NOT NULL,
  revoked_at                 timestamptz,
  last_used_at               timestamptz,
  use_count                  integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id, generation, org_id),
  FOREIGN KEY (
    setup_run_id, workspace_id, generation, org_id, setup_execution_fence
  ) REFERENCES cloud_workspace_setup_runs(
    id, workspace_id, generation, org_id, execution_fence
  ) ON DELETE CASCADE,
  FOREIGN KEY (checkpoint_id, workspace_id, org_id)
    REFERENCES workspace_checkpoints(id, workspace_id, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (manifest_blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX workspace_setup_recovery_grants_live_idx
  ON workspace_setup_recovery_grants(setup_run_id, expires_at, id)
  WHERE revoked_at IS NULL;

ALTER TABLE cloud_workspace_generations
  ADD COLUMN recovery_checkpoint_id uuid,
  ADD CONSTRAINT cloud_workspace_generation_recovery_checkpoint_fkey
    FOREIGN KEY (recovery_checkpoint_id, workspace_id, org_id)
    REFERENCES workspace_checkpoints(id, workspace_id, org_id)
    ON DELETE RESTRICT;

-- `authority_epoch` on the original grant is the replica-local grant epoch.
-- Store the cloud epoch separately so either a pause/device rotation OR a
-- cloud authority transition revokes every outstanding delivery capability.
ALTER TABLE workspace_replicas
  ADD COLUMN grant_epoch bigint NOT NULL DEFAULT 1 CHECK (grant_epoch > 0),
  ADD COLUMN client_manifest_sha256 bytea CHECK (
    client_manifest_sha256 IS NULL OR octet_length(client_manifest_sha256) = 32
  ),
  ADD COLUMN last_applied_at timestamptz,
  ADD COLUMN last_error_code text CHECK (
    last_error_code IS NULL OR char_length(last_error_code) <= 128
  );

UPDATE workspace_replicas SET grant_epoch = authority_epoch;

ALTER TABLE workspace_replica_grants
  ADD COLUMN workspace_authority_epoch bigint;
UPDATE workspace_replica_grants replica_grant
SET workspace_authority_epoch = workspace.authority_epoch
FROM cloud_workspaces workspace
WHERE workspace.id = replica_grant.workspace_id
  AND workspace.org_id = replica_grant.org_id;
ALTER TABLE workspace_replica_grants
  ALTER COLUMN workspace_authority_epoch SET NOT NULL,
  ADD CONSTRAINT workspace_replica_grants_workspace_epoch_check
    CHECK (workspace_authority_epoch > 0);

CREATE TABLE workspace_replica_receipts (
  replica_id                 uuid NOT NULL,
  sequence                   bigint GENERATED ALWAYS AS IDENTITY,
  org_id                     uuid NOT NULL,
  grant_epoch                bigint NOT NULL CHECK (grant_epoch > 0),
  workspace_authority_epoch  bigint NOT NULL CHECK (workspace_authority_epoch > 0),
  from_revision              bigint NOT NULL CHECK (from_revision >= 0),
  to_revision                bigint NOT NULL CHECK (to_revision >= from_revision),
  manifest_sha256            bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
  outcome                    text NOT NULL CHECK (
                               outcome IN ('applied', 'diverged', 'failed')
                             ),
  error_code                 text CHECK (
                               error_code IS NULL OR char_length(error_code) <= 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, sequence),
  FOREIGN KEY (replica_id, org_id)
    REFERENCES workspace_replicas(id, org_id) ON DELETE CASCADE,
  CHECK ((outcome = 'applied') = (error_code IS NULL))
);

ALTER TABLE workspace_checkpoint_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_setup_recovery_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_checkpoint_requests_read
  ON workspace_checkpoint_requests FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_checkpoint_requests_system
  ON workspace_checkpoint_requests FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_setup_recovery_grants_system
  ON workspace_setup_recovery_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_replica_receipts_read
  ON workspace_replica_receipts FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_replica_receipts_system
  ON workspace_replica_receipts FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE workspace_checkpoint_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_setup_recovery_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_receipts FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspace_checkpoint_requests, workspace_setup_recovery_grants,
  workspace_replica_receipts
TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE workspace_replica_receipts_sequence_seq
TO zeros_app;
