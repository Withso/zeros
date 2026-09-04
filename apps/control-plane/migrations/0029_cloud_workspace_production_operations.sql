-- ──────────────────────────────────────────────────────────
-- 0029 — production operations, recovery, forks, and replica grants
--
-- Provider resource identifiers are account-scoped, not globally unique.
-- Usage, orphan cleanup, exports, retention, and replica delivery therefore
-- retain the exact tenant/connection/version identity that authorized them.
-- ──────────────────────────────────────────────────────────

-- A Daytona sandbox id may be repeated in two customer-owned Daytona
-- accounts. Replace the legacy provider-global orphan key with a scoped key.
ALTER TABLE cloud_workspace_provider_orphans
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN org_id uuid,
  ADD COLUMN provider_connection_id uuid,
  ADD COLUMN provider_connection_version bigint;

ALTER TABLE cloud_workspace_provider_orphans
  DROP CONSTRAINT cloud_workspace_provider_orphans_pkey,
  ADD CONSTRAINT cloud_workspace_provider_orphans_pkey PRIMARY KEY (id),
  ADD CONSTRAINT cloud_workspace_provider_orphans_scope_shape CHECK (
    (org_id IS NULL AND provider_connection_id IS NULL
      AND provider_connection_version IS NULL)
    OR
    (org_id IS NOT NULL AND provider_connection_id IS NOT NULL
      AND provider_connection_version IS NOT NULL
      AND provider_connection_version > 0)
  ),
  ADD CONSTRAINT cloud_workspace_provider_orphans_connection_fkey
    FOREIGN KEY (provider_connection_id, provider_connection_version, org_id)
    REFERENCES provider_connection_versions(connection_id, version, org_id)
    ON DELETE RESTRICT;

-- Null scope is reserved for the deployment-hosted credential (and legacy
-- rows awaiting an operator decision). Delegated sweeps always use the exact
-- connection version. NULLS NOT DISTINCT is available on the supported
-- PostgreSQL 16 deployment and prevents duplicate hosted observations.
CREATE UNIQUE INDEX cloud_workspace_provider_orphans_scoped_unique
  ON cloud_workspace_provider_orphans (
    provider, provider_resource_id, org_id, provider_connection_id,
    provider_connection_version
  ) NULLS NOT DISTINCT;

CREATE INDEX cloud_workspace_provider_orphans_cleanup_idx
  ON cloud_workspace_provider_orphans (
    provider_connection_id, provider_connection_version, first_seen_at, id
  ) WHERE deletion_verified_at IS NULL;

-- Usage producers can retry and can be attached to customer-owned provider
-- accounts. The request hash makes an idempotency replay distinguishable from
-- a key collision; the exact provider version prevents cross-account aliasing.
ALTER TABLE cloud_workspace_usage_events
  ADD COLUMN provider_connection_id uuid,
  ADD COLUMN provider_connection_version bigint,
  ADD COLUMN request_sha256 bytea;

UPDATE cloud_workspace_usage_events usage
SET provider_connection_id = generation.provider_connection_id,
    provider_connection_version = generation.provider_connection_version,
    request_sha256 = digest(
      jsonb_build_object(
        'workspaceId', usage.workspace_id,
        'generation', usage.generation,
        'meter', usage.meter,
        'quantity', usage.quantity,
        'sourceIdempotencyKey', usage.source_idempotency_key
      )::text,
      'sha256'
    )
FROM cloud_workspace_generations generation
WHERE generation.workspace_id = usage.workspace_id
  AND generation.generation = usage.generation
  AND generation.org_id = usage.org_id;

ALTER TABLE cloud_workspace_usage_events
  ALTER COLUMN provider_connection_id SET NOT NULL,
  ALTER COLUMN provider_connection_version SET NOT NULL,
  ALTER COLUMN request_sha256 SET NOT NULL,
  ADD CONSTRAINT cloud_workspace_usage_request_sha256_check
    CHECK (octet_length(request_sha256) = 32),
  ADD CONSTRAINT cloud_workspace_usage_provider_version_fkey
    FOREIGN KEY (provider_connection_id, provider_connection_version, org_id)
    REFERENCES provider_connection_versions(connection_id, version, org_id)
    ON DELETE RESTRICT;

ALTER TABLE cloud_workspace_usage_events
  DROP CONSTRAINT cloud_workspace_usage_events_provider_source_idempotency_ke_key;
CREATE UNIQUE INDEX cloud_workspace_usage_source_unique
  ON cloud_workspace_usage_events (
    provider_connection_id, provider_connection_version,
    source_idempotency_key
  );

ALTER TABLE cloud_workspace_outbox
  ADD COLUMN last_error_code text CHECK (
    last_error_code IS NULL OR char_length(last_error_code) <= 128
  ),
  ADD COLUMN last_error_at timestamptz;

-- A blob is a stable logical content identity. Key rotation changes its
-- current ciphertext envelope, not its id, so immutable event/checkpoint rows
-- never need to be rewritten. Deduplicate plaintext across key versions and
-- require old keys to remain configured until rotation has completed.
ALTER TABLE workspace_blobs
  DROP CONSTRAINT workspace_blobs_org_id_plaintext_sha256_encryption_key_vers_key;
CREATE UNIQUE INDEX workspace_blobs_org_plaintext_unique
  ON workspace_blobs(org_id, plaintext_sha256);

CREATE TYPE workspace_export_state AS ENUM (
  'queued', 'processing', 'available', 'failed', 'expired', 'deleting', 'deleted'
);

CREATE TABLE workspace_exports (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id               uuid NOT NULL,
  requested_by               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  checkpoint_id              uuid NOT NULL,
  record_revision            bigint NOT NULL CHECK (record_revision >= 0),
  content_revision           bigint NOT NULL CHECK (content_revision > 0),
  include_chats              boolean NOT NULL DEFAULT false,
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                             ),
  request_sha256             bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  state                      workspace_export_state NOT NULL DEFAULT 'queued',
  export_blob_id             uuid,
  lease_owner                text,
  lease_expires_at           timestamptz,
  attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code                 text CHECK (
                               error_code IS NULL OR char_length(error_code) <= 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  available_at               timestamptz,
  expires_at                 timestamptz,
  completed_at               timestamptz,
  UNIQUE (org_id, requested_by, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (checkpoint_id, workspace_id, org_id)
    REFERENCES workspace_checkpoints(id, workspace_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (export_blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state = 'available' AND export_blob_id IS NOT NULL
      AND available_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > available_at)
    OR state <> 'available'
  )
);
CREATE INDEX workspace_exports_claim_idx
  ON workspace_exports(created_at, id)
  WHERE state IN ('queued', 'processing');

CREATE TABLE workspace_retention_policies (
  workspace_id               uuid PRIMARY KEY,
  org_id                     uuid NOT NULL,
  record_event_days          integer NOT NULL DEFAULT 365 CHECK (
                               record_event_days BETWEEN 1 AND 3650
                             ),
  content_event_days         integer NOT NULL DEFAULT 90 CHECK (
                               content_event_days BETWEEN 1 AND 3650
                             ),
  checkpoint_days            integer NOT NULL DEFAULT 90 CHECK (
                               checkpoint_days BETWEEN 1 AND 3650
                             ),
  export_days                integer NOT NULL DEFAULT 7 CHECK (
                               export_days BETWEEN 1 AND 90
                             ),
  legal_hold                 boolean NOT NULL DEFAULT false,
  version                    bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);

CREATE TABLE workspace_deletion_jobs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  requested_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                             ),
  state                      text NOT NULL DEFAULT 'waiting_for_provider' CHECK (
                               state IN (
                                 'waiting_for_provider', 'deleting_objects',
                                 'deleting_records', 'succeeded', 'failed'
                               )
                             ),
  lease_owner                text,
  lease_expires_at           timestamptz,
  attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code                 text CHECK (
                               error_code IS NULL OR char_length(error_code) <= 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  CHECK (
    (state IN ('deleting_objects', 'deleting_records')
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('deleting_objects', 'deleting_records')
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

-- Rotation is copy-on-write. The old object key remains authoritative until
-- ciphertext read-back succeeds and this job atomically publishes the new
-- envelope. Crash recovery can safely resume either side of that publication.
CREATE TABLE workspace_blob_rotation_jobs (
  blob_id                    uuid NOT NULL,
  org_id                     uuid NOT NULL,
  target_key_version         integer NOT NULL CHECK (target_key_version > 0),
  source_object_key          text NOT NULL CHECK (
                               char_length(source_object_key) BETWEEN 16 AND 1024
                             ),
  target_object_key          text NOT NULL CHECK (
                               char_length(target_object_key) BETWEEN 16 AND 1024
                             ),
  target_nonce               bytea NOT NULL DEFAULT gen_random_bytes(12) CHECK (
                               octet_length(target_nonce) = 12
                             ),
  state                      text NOT NULL DEFAULT 'queued' CHECK (
                               state IN (
                                 'queued', 'processing', 'cleanup_pending',
                                 'succeeded', 'failed'
                               )
                             ),
  lease_owner                text,
  lease_expires_at           timestamptz,
  attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code                 text CHECK (
                               error_code IS NULL OR char_length(error_code) <= 128
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  PRIMARY KEY (blob_id, target_key_version),
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE CASCADE,
  CHECK (
    (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (target_object_key)
);

-- Device bearer material is never stored. Each grant is bound to the exact
-- device key version and replica authority epoch; rotating/revoking the device
-- immediately invalidates all outstanding grants.
CREATE TABLE workspace_replica_grants (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replica_id                 uuid NOT NULL,
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                  uuid NOT NULL,
  device_key_version         bigint NOT NULL CHECK (device_key_version > 0),
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  token_sha256               bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  issued_at                  timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz NOT NULL,
  revoked_at                 timestamptz,
  last_used_at               timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (replica_id, org_id)
    REFERENCES workspace_replicas(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id)
    REFERENCES devices(id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX workspace_replica_grants_live_idx
  ON workspace_replica_grants(replica_id, expires_at DESC, id)
  WHERE revoked_at IS NULL;

ALTER TABLE workspace_fork_intents
  ADD COLUMN export_id uuid,
  ADD COLUMN result_blob_id uuid,
  ADD COLUMN source_kind text GENERATED ALWAYS AS (
    CASE WHEN source_cloud_workspace_id IS NULL THEN 'local' ELSE 'cloud' END
  ) STORED,
  ADD CONSTRAINT workspace_fork_export_fkey
    FOREIGN KEY (export_id, org_id) REFERENCES workspace_exports(id, org_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_fork_result_blob_fkey
    FOREIGN KEY (result_blob_id, org_id) REFERENCES workspace_blobs(id, org_id)
    ON DELETE RESTRICT;

ALTER TABLE workspace_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_blob_rotation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_exports_read ON workspace_exports FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_exports_system ON workspace_exports FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_retention_read ON workspace_retention_policies FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_retention_system ON workspace_retention_policies FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_deletion_jobs_system ON workspace_deletion_jobs FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_blob_rotation_jobs_system ON workspace_blob_rotation_jobs FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_replica_grants_system ON workspace_replica_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE workspace_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_retention_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_blob_rotation_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_replica_grants FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspace_exports, workspace_retention_policies, workspace_deletion_jobs,
  workspace_blob_rotation_jobs, workspace_replica_grants
TO zeros_app;
