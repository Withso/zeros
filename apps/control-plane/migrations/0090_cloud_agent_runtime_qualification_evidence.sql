-- Exact image/auth qualification is an operator decision, never an application
-- write. Retain target-bound, append-only evidence without a fabricated org.
CREATE TABLE cloud_agent_runtime_qualification_changes (
  operation_id uuid PRIMARY KEY,
  change_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deployment_channel text NOT NULL CHECK (deployment_channel IN ('development','alpha','beta','production')),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('boat','daytona')),
  image_ref text NOT NULL CHECK (length(image_ref) BETWEEN 1 AND 512),
  runtime_contract_sha256 text NOT NULL CHECK (runtime_contract_sha256 ~ '^[a-f0-9]{64}$'),
  source_commit text NOT NULL CHECK (source_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  previous_state jsonb NOT NULL CHECK (jsonb_typeof(previous_state)='array'),
  next_state jsonb NOT NULL CHECK (jsonb_typeof(next_state)='array'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_agent_runtime_qualification_changes_image_revision ON cloud_agent_runtime_qualification_changes(provider,image_ref,change_sequence DESC);
ALTER TABLE cloud_agent_runtime_qualification_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_runtime_qualification_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_runtime_qualification_changes_owner ON cloud_agent_runtime_qualification_changes
  FOR ALL USING(current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.cloud_agent_runtime_qualification_changes'::regclass)))
  WITH CHECK(current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.cloud_agent_runtime_qualification_changes'::regclass)));
CREATE FUNCTION reject_cloud_agent_runtime_qualification_change_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cloud_agent_runtime_qualification_changes is append-only' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER cloud_agent_runtime_qualification_changes_append_only
  BEFORE UPDATE OR DELETE ON cloud_agent_runtime_qualification_changes FOR EACH ROW
  EXECUTE FUNCTION reject_cloud_agent_runtime_qualification_change_mutation();
CREATE TRIGGER cloud_agent_runtime_qualification_changes_no_truncate
  BEFORE TRUNCATE ON cloud_agent_runtime_qualification_changes FOR EACH STATEMENT
  EXECUTE FUNCTION reject_cloud_agent_runtime_qualification_change_mutation();
REVOKE ALL ON cloud_agent_runtime_qualification_changes FROM PUBLIC,zeros_app;
REVOKE ALL ON FUNCTION reject_cloud_agent_runtime_qualification_change_mutation() FROM PUBLIC;
