SELECT set_config('app.system','on',true);
-- Finite launch safety caps, independent of purchased Organization seats.
-- Explicit operator rows are preserved. Disk includes replacement headroom.
ALTER TABLE cloud_workspace_quotas ADD COLUMN default_policy_version text;
ALTER TABLE cloud_workspace_object_storage_limits ADD COLUMN default_policy_version text;
CREATE FUNCTION provision_cloud_workspace_pro_defaults(target_org_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT coalesce(app_is_system(),false) THEN RAISE EXCEPTION 'system context required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM organizations WHERE id=target_org_id AND NOT is_personal AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib,default_policy_version)
    VALUES(target_org_id,10,5,40000,81920,1500000,'pro-v1') ON CONFLICT(org_id) DO NOTHING;
  INSERT INTO cloud_workspace_object_storage_limits(org_id,max_organization_bytes,max_workspace_bytes,default_policy_version)
    VALUES(target_org_id,107374182400,21474836480,'pro-v1') ON CONFLICT(org_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION provision_cloud_workspace_pro_defaults(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_cloud_workspace_pro_defaults(uuid) TO zeros_app;

-- The migration owner backfills only absent policy; no existing operational
-- switch, explicit limit or subscription record changes.
INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib,default_policy_version)
  SELECT id,10,5,40000,81920,1500000,'pro-v1' FROM organizations WHERE NOT is_personal AND deleted_at IS NULL
  ON CONFLICT(org_id) DO NOTHING;
INSERT INTO cloud_workspace_object_storage_limits(org_id,max_organization_bytes,max_workspace_bytes,default_policy_version)
  SELECT id,107374182400,21474836480,'pro-v1' FROM organizations WHERE NOT is_personal AND deleted_at IS NULL
  ON CONFLICT(org_id) DO NOTHING;
