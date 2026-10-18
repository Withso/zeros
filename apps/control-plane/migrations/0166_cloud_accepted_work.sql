-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Deliberately unadvertised by existing registration/transfer code. A later
-- qualified detached.v1 runtime must opt in before any enrollment is allowed.
ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN accepted_work_version integer CHECK (accepted_work_version = 1);

CREATE TABLE cloud_accepted_work_enrollments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  engine_instance_id uuid NOT NULL,
  writer_epoch uuid NOT NULL,
  command_id uuid NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
  capability_expires_at timestamptz NOT NULL CHECK (isfinite(capability_expires_at)),
  provider_expires_at timestamptz NOT NULL CHECK (isfinite(provider_expires_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  UNIQUE (workspace_id,generation,writer_epoch,command_id),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_engine_instances(id,workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  CHECK (receipt->>'acceptedWorkId'=id::text AND receipt#>>'{scope,workspaceId}'=workspace_id::text
    AND receipt#>>'{scope,organizationId}'=org_id::text AND receipt#>>'{scope,engineInstanceId}'=engine_instance_id::text
    AND receipt#>>'{scope,writerEpoch}'=writer_epoch::text AND receipt#>>'{command,commandId}'=command_id::text),
  CHECK (capability_expires_at>created_at AND provider_expires_at>created_at)
);
CREATE INDEX cloud_accepted_work_live ON cloud_accepted_work_enrollments(workspace_id,writer_epoch,capability_expires_at)
  WHERE closed_at IS NULL;

CREATE FUNCTION preserve_cloud_accepted_work() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW)-'closed_at') IS DISTINCT FROM (to_jsonb(OLD)-'closed_at')
    OR OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'accepted work is immutable and terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_accepted_work_immutable BEFORE UPDATE ON cloud_accepted_work_enrollments
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_accepted_work();
ALTER TABLE cloud_accepted_work_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_accepted_work_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_accepted_work_system ON cloud_accepted_work_enrollments
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

-- The runtime role has SELECT only on signing keys. This closed system-only
-- predicate takes the revocation fence without granting key mutation or
-- exposing the private envelope. The key operator's UPDATE serializes here.
CREATE FUNCTION cloud_accepted_work_key_live(target_kid text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE live boolean;
BEGIN
  IF app_is_system() IS NOT TRUE THEN RETURN false; END IF;
  SELECT state IN ('next','current','retiring') INTO live
    FROM cloud_capability_signing_keys WHERE kid=target_kid FOR SHARE;
  RETURN coalesce(live,false);
END $$;
-- zeros-expand-exception: privilege-tightening Only remove PUBLIC's default EXECUTE on the new system-only predicate.
REVOKE ALL ON FUNCTION cloud_accepted_work_key_live(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_accepted_work_key_live(text) TO zeros_app;
