-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces ADD COLUMN worker_runtime_sha256 text
  CHECK (worker_runtime_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE cloud_v2_workspaces ADD COLUMN worker_runtime_boot_id uuid,
  ADD COLUMN worker_runtime_handoff_id uuid,
  ADD COLUMN worker_runtime_unknown_activity boolean NOT NULL DEFAULT false;

CREATE TABLE cloud_worker_runtime_handoffs (
  workspace_id uuid PRIMARY KEY REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL,
  creator_user_id uuid NOT NULL,
  repository text NOT NULL,
  source_identity jsonb NOT NULL,
  sandbox_id text NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash)=32),
  old_boot_id uuid NOT NULL,
  next_boot_id uuid NOT NULL,
  rollback_boot_id uuid NOT NULL,
  prior_rollback_boot_id uuid,
  rollback_attempt integer NOT NULL DEFAULT 0 CHECK (rollback_attempt BETWEEN 0 AND 3),
  instance_id uuid NOT NULL,
  previous_sha256 text NOT NULL CHECK (previous_sha256 ~ '^[a-f0-9]{64}$'),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  access_epoch bigint NOT NULL,
  login_revision bigint NOT NULL,
  stop_generation bigint NOT NULL,
  worker_generation bigint NOT NULL CHECK (worker_generation BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('prepared','committed','activating','rolling_back','succeeded','rolled_back','cancelled')),
  environment_boot_id uuid,
  environment_report jsonb CHECK (jsonb_typeof(environment_report)='object'),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (old_boot_id<>next_boot_id AND next_boot_id<>rollback_boot_id AND rollback_boot_id<>old_boot_id)
);

CREATE TABLE cloud_worker_runtime_clients (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  boot_id uuid,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,client_id)
);
CREATE INDEX cloud_worker_runtime_client_expiry ON cloud_worker_runtime_clients(expires_at);

ALTER TABLE cloud_worker_runtime_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_worker_runtime_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_worker_runtime_handoffs USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_worker_runtime_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_worker_runtime_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_worker_runtime_clients USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_worker_runtime_handoffs,cloud_worker_runtime_clients TO zeros_app;

-- An older hello writer cannot publish a private replacement boot. Explicit
-- Stop and access revocation retain their existing state transitions.
CREATE FUNCTION cloud_runtime_handoff_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state='running' AND NEW.state IN ('running','starting') AND
    (NEW.worker_boot_id IS DISTINCT FROM OLD.worker_boot_id OR NEW.state='starting') AND
    EXISTS (SELECT 1 FROM public.cloud_worker_runtime_handoffs h WHERE h.workspace_id=OLD.id
      AND h.state IN ('committed','activating','rolling_back')) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cloud_runtime_handoff_private', CONSTRAINT='cloud_runtime_handoff_private';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_runtime_handoff_private BEFORE UPDATE OF state,worker_boot_id ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_runtime_handoff_guard();
