-- ───────────────────────────────────────────────────────────
-- 0020 — Fenced cloud-workspace setup execution
--
-- Setup commands run outside database transactions and may outlive a worker
-- process. Durable leases make crashed work reclaimable; an incrementing fence
-- prevents a reclaimed execution's late result from publishing readiness.
-- Every run also resolves through one immutable generation setup specification
-- so mutable workspace metadata cannot silently change an in-flight checkout.
-- ───────────────────────────────────────────────────────────

CREATE TABLE cloud_workspace_setup_specs (
  workspace_id             uuid NOT NULL,
  generation               integer NOT NULL CHECK (generation > 0),
  org_id                   uuid NOT NULL,
  spec_version             integer NOT NULL DEFAULT 1 CHECK (spec_version > 0),
  repository_forge         text NOT NULL CHECK (
                             char_length(repository_forge) BETWEEN 1 AND 255
                           ),
  repository_owner         text NOT NULL CHECK (
                             char_length(repository_owner) BETWEEN 1 AND 255
                           ),
  repository_name          text NOT NULL CHECK (
                             char_length(repository_name) BETWEEN 1 AND 255
                           ),
  repository_revision      text NOT NULL CHECK (
                             char_length(repository_revision) BETWEEN 1 AND 512
                           ),
  -- Historical binding only, never a credential. The installation may later
  -- be disconnected; a worker must resolve and authorize it just in time.
  github_installation_id   uuid,
  -- Redacted, non-secret effective settings. Secret values remain in scoped
  -- credential storage and are resolved only for the bounded execution.
  settings_snapshot        jsonb NOT NULL CHECK (
                             jsonb_typeof(settings_snapshot) = 'object'
                             AND octet_length(settings_snapshot::text) <= 262144
                           ),
  settings_snapshot_sha256 bytea NOT NULL CHECK (
                             octet_length(settings_snapshot_sha256) = 32
                             AND settings_snapshot_sha256 =
                               digest(settings_snapshot::text, 'sha256')
                           ),
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, generation),
  UNIQUE (workspace_id, generation, org_id),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE
);

-- The pre-production schema had no generation settings record. Preserve every
-- existing generation by snapshotting its current repository metadata and an
-- explicit empty version-1 settings document. No credential value is copied.
INSERT INTO cloud_workspace_setup_specs (
  workspace_id, generation, org_id, repository_forge, repository_owner,
  repository_name, repository_revision, github_installation_id,
  settings_snapshot, settings_snapshot_sha256
)
SELECT
  g.workspace_id, g.generation, g.org_id, cw.repository_forge,
  cw.repository_owner, cw.repository_name, cw.repository_revision,
  cw.github_installation_id, snapshot.doc, digest(snapshot.doc::text, 'sha256')
FROM cloud_workspace_generations g
JOIN cloud_workspaces cw ON cw.id = g.workspace_id AND cw.org_id = g.org_id
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'values', '{}'::jsonb
  ) AS doc
) snapshot;

CREATE FUNCTION reject_cloud_workspace_setup_spec_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud workspace setup specifications are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_workspace_setup_specs_immutable
  BEFORE UPDATE ON cloud_workspace_setup_specs
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_setup_spec_update();

ALTER TABLE cloud_workspace_setup_runs
  ADD COLUMN claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  ADD COLUMN execution_fence bigint NOT NULL DEFAULT 0 CHECK (execution_fence >= 0),
  ADD COLUMN lease_owner text CHECK (
    lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 255
  ),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

-- No production setup worker existed before this migration. If an operator
-- manually marked an attempt running, requeue it rather than manufacturing a
-- lease or accepting a result that has no execution fence.
UPDATE cloud_workspace_setup_runs
SET state = 'queued', started_at = NULL,
    error_code = coalesce(error_code, 'setup_lease_upgrade_requeued'),
    updated_at = now()
WHERE state = 'running';

ALTER TABLE cloud_workspace_setup_runs
  ADD CONSTRAINT cloud_workspace_setup_runs_spec_fkey
  FOREIGN KEY (workspace_id, generation, org_id)
  REFERENCES cloud_workspace_setup_specs(workspace_id, generation, org_id)
  ON DELETE CASCADE,
  ADD CONSTRAINT cloud_workspace_setup_runs_lease_check CHECK (
    (
      state = 'running'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND last_heartbeat_at IS NOT NULL
      AND lease_expires_at > last_heartbeat_at
      AND execution_fence > 0
    )
    OR (
      state <> 'running'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  );

CREATE INDEX cloud_workspace_setup_runs_claim_idx
  ON cloud_workspace_setup_runs (next_attempt_at, created_at, id)
  WHERE state = 'queued'
     OR (state = 'running' AND lease_expires_at IS NOT NULL);

ALTER TABLE cloud_workspace_setup_specs ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_workspace_setup_specs_read
  ON cloud_workspace_setup_specs FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_setup_specs_system
  ON cloud_workspace_setup_specs FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_setup_specs FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_setup_specs
  TO zeros_app;
