-- ───────────────────────────────────────────────────────────
-- 0014 — Setup authority and durable readiness attestations
--
-- A setup token authorizes one claimed execution, not merely a workspace.
-- Binding grants to setup_run_id + execution_fence prevents a crashed worker's
-- credential from being replayed after another worker reclaims the lease.
-- Readiness is recorded as structured, immutable evidence before the workspace
-- row can move to ready; a successful process exit alone is never sufficient.
-- ───────────────────────────────────────────────────────────

ALTER TABLE cloud_workspace_setup_runs
  ADD CONSTRAINT cloud_workspace_setup_runs_identity_unique
    UNIQUE (id, workspace_id, generation, org_id),
  ADD CONSTRAINT cloud_workspace_setup_runs_fenced_identity_unique
    UNIQUE (id, workspace_id, generation, org_id, execution_fence);

ALTER TABLE cloud_workspace_endpoint_grants
  ADD COLUMN setup_run_id uuid,
  ADD COLUMN setup_execution_fence bigint CHECK (
    setup_execution_fence IS NULL OR setup_execution_fence > 0
  );

-- No production setup grant issuer existed before this migration. Retire any
-- manually-created/pre-production setup grant rather than guessing which live
-- execution fence it was intended to authorize.
UPDATE cloud_workspace_endpoint_grants
SET revoked_at = coalesce(revoked_at, now())
WHERE purpose = 'setup';

ALTER TABLE cloud_workspace_endpoint_grants
  ADD CONSTRAINT cloud_workspace_endpoint_grants_setup_run_fkey
    FOREIGN KEY (setup_run_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_setup_runs(
      id, workspace_id, generation, org_id
    )
    ON DELETE CASCADE,
  ADD CONSTRAINT cloud_workspace_endpoint_grants_setup_binding_check CHECK (
    (
      purpose = 'setup'
      AND (
        (setup_run_id IS NOT NULL AND setup_execution_fence IS NOT NULL)
        OR (
          setup_run_id IS NULL
          AND setup_execution_fence IS NULL
          AND revoked_at IS NOT NULL
        )
      )
    )
    OR (
      purpose <> 'setup'
      AND setup_run_id IS NULL
      AND setup_execution_fence IS NULL
    )
  );

CREATE FUNCTION enforce_cloud_workspace_setup_grant_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purpose = 'setup' THEN
    IF NEW.setup_run_id IS NULL OR NEW.setup_execution_fence IS NULL THEN
      RAISE EXCEPTION 'new setup grants require an execution binding'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM cloud_workspace_setup_runs sr
      WHERE sr.id = NEW.setup_run_id
        AND sr.workspace_id = NEW.workspace_id
        AND sr.generation = NEW.generation
        AND sr.org_id = NEW.org_id
        AND sr.execution_fence = NEW.setup_execution_fence
        AND sr.state = 'running'
        AND sr.lease_expires_at > now()
    ) THEN
      RAISE EXCEPTION 'setup grant execution binding is not live'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.setup_run_id IS NOT NULL OR NEW.setup_execution_fence IS NOT NULL THEN
    RAISE EXCEPTION 'non-setup grants cannot carry setup authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_endpoint_grants_setup_binding
  BEFORE INSERT OR UPDATE OF purpose, setup_run_id, setup_execution_fence
  ON cloud_workspace_endpoint_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_workspace_setup_grant_binding();

CREATE INDEX cloud_workspace_endpoint_grants_setup_live_idx
  ON cloud_workspace_endpoint_grants (
    setup_run_id, setup_execution_fence, expires_at
  )
  WHERE purpose = 'setup'
    AND revoked_at IS NULL
    AND consumed_at IS NULL;

CREATE TABLE cloud_workspace_setup_attestations (
  setup_run_id              uuid PRIMARY KEY,
  workspace_id              uuid NOT NULL,
  generation                integer NOT NULL CHECK (generation > 0),
  org_id                    uuid NOT NULL,
  execution_fence           bigint NOT NULL CHECK (execution_fence > 0),
  readiness_version         integer NOT NULL DEFAULT 1 CHECK (
                              readiness_version = 1
                            ),
  image_ref                 text NOT NULL CHECK (
                              char_length(image_ref) BETWEEN 1 AND 1024
                            ),
  image_source_commit       text NOT NULL CHECK (
                              image_source_commit ~
                                '^([a-f0-9]{40}|[a-f0-9]{64})$'
                            ),
  repository_revision       text NOT NULL CHECK (
                              char_length(repository_revision) BETWEEN 1 AND 512
                            ),
  repository_commit         text NOT NULL CHECK (
                              repository_commit ~
                                '^([a-f0-9]{40}|[a-f0-9]{64})$'
                            ),
  settings_version          integer NOT NULL CHECK (settings_version > 0),
  settings_snapshot_sha256  bytea NOT NULL CHECK (
                              octet_length(settings_snapshot_sha256) = 32
                            ),
  engine_instance_id        uuid NOT NULL,
  engine_protocol_version   integer NOT NULL CHECK (
                              engine_protocol_version BETWEEN 1 AND 65535
                            ),
  engine_health             text NOT NULL CHECK (engine_health = 'ready'),
  durable_record_connected  boolean NOT NULL CHECK (
                              durable_record_connected
                            ),
  attested_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (
    setup_run_id, workspace_id, generation, org_id, execution_fence
  ) REFERENCES cloud_workspace_setup_runs(
    id, workspace_id, generation, org_id, execution_fence
  ) ON DELETE CASCADE
);

CREATE FUNCTION enforce_cloud_workspace_setup_attestation_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cloud_workspace_setup_runs sr
    JOIN cloud_workspace_generations g
      ON g.workspace_id = sr.workspace_id
     AND g.generation = sr.generation
     AND g.org_id = sr.org_id
    JOIN cloud_workspace_setup_specs ss
      ON ss.workspace_id = sr.workspace_id
     AND ss.generation = sr.generation
     AND ss.org_id = sr.org_id
    WHERE sr.id = NEW.setup_run_id
      AND sr.workspace_id = NEW.workspace_id
      AND sr.generation = NEW.generation
      AND sr.org_id = NEW.org_id
      AND sr.execution_fence = NEW.execution_fence
      AND sr.state = 'running'
      AND sr.lease_expires_at > now()
      AND g.image_ref = NEW.image_ref
      AND g.source_commit = NEW.image_source_commit
      AND ss.repository_revision = NEW.repository_revision
      AND ss.spec_version = NEW.settings_version
      AND ss.settings_snapshot_sha256 = NEW.settings_snapshot_sha256
  ) THEN
    RAISE EXCEPTION 'setup attestation does not match a live setup contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_setup_attestations_binding
  BEFORE INSERT ON cloud_workspace_setup_attestations
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_workspace_setup_attestation_binding();

CREATE FUNCTION reject_cloud_workspace_setup_attestation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud workspace setup attestations are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_workspace_setup_attestations_immutable
  BEFORE UPDATE ON cloud_workspace_setup_attestations
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_setup_attestation_update();

ALTER TABLE cloud_workspace_setup_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY cloud_workspace_setup_attestations_read
  ON cloud_workspace_setup_attestations FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY cloud_workspace_setup_attestations_system
  ON cloud_workspace_setup_attestations FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_setup_attestations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_setup_attestations
  TO zeros_app;
