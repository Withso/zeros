-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Runtime archives are immutable registry objects, outside workspace blob GC.
-- Keep a per-allocation pin and the exact original root receipt before any
-- local payload may be evicted. Release retirement does not release this pin.
CREATE TABLE cloud_workspace_runtime_rollback_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  provider_resource_id text NOT NULL CHECK (provider_resource_id ~ '^bx_[A-Za-z0-9_-]{1,128}$'),
  intent_id uuid NOT NULL,
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts(base_compatibility_id),
  proof jsonb NOT NULL CHECK (jsonb_typeof(proof)='object' AND octet_length(proof::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,intent_id,runtime_id),
  UNIQUE (id,workspace_id,org_id),
  FOREIGN KEY (workspace_id,generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  CHECK (coalesce(proof->'runtime'->>'runtimeId'=runtime_id AND proof->>'baseCompatibilityId'=base_compatibility_id
    AND proof->'scope'->>'workspaceId'=workspace_id::text AND proof->'scope'->>'organizationId'=org_id::text
    AND proof->'scope'->>'generation'=generation::text AND proof->'scope'->>'providerResourceId'=provider_resource_id
    AND proof->'scope'->>'intentId'=intent_id::text,false))
);
CREATE INDEX cloud_runtime_rollback_allocation ON cloud_workspace_runtime_rollback_refs
  (workspace_id,provider_resource_id,runtime_id,created_at DESC);
CREATE INDEX cloud_runtime_rollback_object ON cloud_workspace_runtime_rollback_refs(runtime_id);

-- Preparation fetches while source authority is still live. Each exact
-- transition gets one nonrenewable 240-second preparation budget. Existing
-- activation/rollback watchdogs and qualification remain independently strict.
CREATE TABLE cloud_workspace_runtime_rollback_restores (
  transition_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  retention_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deadline_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '240 seconds',
  FOREIGN KEY (transition_id,workspace_id,org_id)
    REFERENCES cloud_workspace_runtime_transitions(transition_id,workspace_id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (retention_id,workspace_id,org_id)
    REFERENCES cloud_workspace_runtime_rollback_refs(id,workspace_id,org_id),
  CHECK (deadline_at>created_at AND deadline_at<=created_at+interval '240 seconds')
);

CREATE FUNCTION preserve_cloud_runtime_rollback_pin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND cloud_workspace_data_purge_authorized(OLD.workspace_id,OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'runtime rollback retention is immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER cloud_runtime_rollback_ref_immutable BEFORE UPDATE OR DELETE ON cloud_workspace_runtime_rollback_refs
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_rollback_pin();
CREATE TRIGGER cloud_runtime_rollback_restore_immutable BEFORE UPDATE OR DELETE ON cloud_workspace_runtime_rollback_restores
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_rollback_pin();
ALTER TABLE cloud_workspace_runtime_rollback_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_rollback_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_runtime_rollback_refs FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_workspace_runtime_rollback_refs FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_purge ON cloud_workspace_runtime_rollback_refs FOR DELETE
  USING(cloud_workspace_data_purge_authorized(workspace_id,org_id));
ALTER TABLE cloud_workspace_runtime_rollback_restores ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_rollback_restores FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_runtime_rollback_restores FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_workspace_runtime_rollback_restores FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_purge ON cloud_workspace_runtime_rollback_restores FOR DELETE
  USING(cloud_workspace_data_purge_authorized(workspace_id,org_id));
GRANT SELECT,INSERT,DELETE ON cloud_workspace_runtime_rollback_refs,cloud_workspace_runtime_rollback_restores TO zeros_app;
