-- zeros-migration: expand
-- Short-lived infrastructure allocations cannot use the workspace journal's
-- generation/org foreign keys. Keep their provider intent before every create,
-- and retain deletion evidence independently of a qualification worker's life.
CREATE TABLE cloud_builder_vm_operations (
  account_scope text NOT NULL CHECK (account_scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9._:-]{1,255}$'),
  purpose text NOT NULL CHECK (purpose IN ('runtime-qualification', 'computer-build')),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object' AND octet_length(intent::text) <= 4096),
  provider_request jsonb NOT NULL CHECK (jsonb_typeof(provider_request) = 'object' AND octet_length(provider_request::text) <= 4096),
  state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'stopping', 'archived', 'deleting', 'deleted')),
  sandbox_id text CHECK (sandbox_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  deletion_operation_id text CHECK (deletion_operation_id ~ '^bdop_[a-f0-9]{32}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  create_dispatched_at timestamptz,
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (account_scope, operation_key),
  UNIQUE (account_scope, sandbox_id),
  CHECK (deleted_at IS NULL OR (state = 'deleted' AND deletion_requested_at IS NOT NULL)),
  CHECK (state NOT IN ('ready', 'stopping', 'archived', 'deleting', 'deleted') OR sandbox_id IS NOT NULL)
);

CREATE FUNCTION preserve_cloud_builder_vm_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'builder provider journal cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.account_scope, NEW.operation_key, NEW.purpose, NEW.request_sha256,
         NEW.intent, NEW.provider_request, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.account_scope, OLD.operation_key, OLD.purpose, OLD.request_sha256,
         OLD.intent, OLD.provider_request, OLD.created_at)
     OR (OLD.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id)
     OR (OLD.create_dispatched_at IS NOT NULL AND NEW.create_dispatched_at IS DISTINCT FROM OLD.create_dispatched_at)
     OR (OLD.deletion_operation_id IS NOT NULL AND NEW.deletion_operation_id IS DISTINCT FROM OLD.deletion_operation_id)
     OR (OLD.deletion_requested_at IS NOT NULL AND NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     OR (OLD.state = 'deleted' AND NEW.state <> 'deleted')
     OR (OLD.state = 'deleting' AND NEW.state NOT IN ('deleting', 'deleted')) THEN
    RAISE EXCEPTION 'builder provider identity or retirement is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_builder_vm_operation_immutable BEFORE UPDATE OR DELETE ON cloud_builder_vm_operations
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_builder_vm_operation();

CREATE TABLE cloud_runtime_qualification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  base_image_id text,
  base_compatibility_id text,
  sandbox_id text CHECK (sandbox_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  diagnostic jsonb CHECK (jsonb_typeof(diagnostic) = 'object' AND octet_length(diagnostic::text) <= 4096
    AND diagnostic @> '{"schema":"zeros.diagnostic/v1"}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  deadline_at timestamptz,
  finished_at timestamptz,
  cleanup_confirmed_at timestamptz,
  cleanup_lease_until timestamptz,
  FOREIGN KEY (base_image_id, base_compatibility_id)
    REFERENCES cloud_runtime_base_images(base_image_id, base_compatibility_id),
  CHECK (num_nonnulls(base_image_id, base_compatibility_id) IN (0, 2)),
  CHECK (state <> 'running' OR (started_at IS NOT NULL AND deadline_at IS NOT NULL AND base_image_id IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  CHECK (state <> 'succeeded' OR (cleanup_confirmed_at IS NOT NULL AND diagnostic @> '{"ok":true}'::jsonb))
);
CREATE UNIQUE INDEX cloud_runtime_qualification_run_pending ON cloud_runtime_qualification_runs(runtime_id)
  WHERE state IN ('queued', 'running');
-- Global capacity includes overdue runs whose cleanup is still unconfirmed.
CREATE UNIQUE INDEX cloud_runtime_qualification_one_running ON cloud_runtime_qualification_runs((true)) WHERE state = 'running';
CREATE INDEX cloud_runtime_qualification_runs_queue ON cloud_runtime_qualification_runs(created_at) WHERE state = 'queued';
CREATE INDEX cloud_runtime_qualification_runs_runtime ON cloud_runtime_qualification_runs(runtime_id, created_at DESC);
CREATE INDEX cloud_runtime_qualification_runs_base ON cloud_runtime_qualification_runs(base_image_id, base_compatibility_id);

ALTER TABLE cloud_builder_vm_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_builder_vm_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_builder_vm_operations_system ON cloud_builder_vm_operations
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_runtime_qualification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_qualification_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_qualification_runs_system ON cloud_runtime_qualification_runs
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
