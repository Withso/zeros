-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- An older registration changes instance_id, invalidating both optional proofs.
ALTER TABLE local_command_devices
  ADD COLUMN liveness_instance_id uuid,
  ADD COLUMN liveness_stream_id uuid;

-- Catalog hints use the same committed replay cursor without waking authority
-- revalidation for every title, setup or pull-request update.
-- zeros-expand-exception: catalog-notification-channel Separates catalog-only wakeups while retaining every existing authority notification
CREATE OR REPLACE FUNCTION notify_security_event() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind='organization.data_changed' AND NEW.workspace_id IS NULL
    AND NEW.payload->>'resource'='cloud_workspace' THEN
    PERFORM pg_notify('zeros_cloud_v2_catalog', NEW.sequence::text);
  ELSE
    PERFORM pg_notify('zeros_security_event', NEW.sequence::text);
  END IF;
  RETURN NEW;
END;
$$;

-- workspace_id stays NULL: these are organization catalog invalidations, so a
-- deleted workspace remains replayable and is not a legacy workspace ACL row.
CREATE FUNCTION notify_cloud_v2_catalog_row() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target uuid; organization uuid; change text;
BEGIN
  IF TG_TABLE_NAME='cloud_v2_workspaces' THEN
    IF TG_OP='DELETE' THEN
      target:=OLD.id; organization:=OLD.org_id; change:='deleted';
    ELSE
      target:=NEW.id; organization:=NEW.org_id;
      IF TG_OP='INSERT' THEN change:='created';
      ELSIF NEW.state='deleted' THEN change:='deleted';
      ELSIF ROW(NEW.state,NEW.error_code) IS DISTINCT FROM ROW(OLD.state,OLD.error_code) THEN change:='lifecycle';
      ELSE change:='document'; END IF;
      IF TG_OP='UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id THEN
        INSERT INTO public.security_events(kind,org_id,payload)
          SELECT 'organization.data_changed',o.id,jsonb_build_object('resource','cloud_workspace','workspaceId',target,'change','deleted')
          FROM public.organizations o WHERE o.id=OLD.org_id;
      END IF;
    END IF;
  ELSE
    IF TG_OP='DELETE' THEN target:=OLD.workspace_id; ELSE target:=NEW.workspace_id; END IF;
    SELECT org_id INTO organization FROM public.cloud_v2_workspaces WHERE id=target;
    change:=CASE WHEN TG_TABLE_NAME='cloud_v2_github_workspaces' THEN 'pull_request' ELSE 'document' END;
    IF TG_OP='UPDATE' AND OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      INSERT INTO public.security_events(kind,org_id,payload)
        SELECT 'organization.data_changed',w.org_id,jsonb_build_object('resource','cloud_workspace','workspaceId',w.id,'change',change)
        FROM public.cloud_v2_workspaces w JOIN public.organizations o ON o.id=w.org_id WHERE w.id=OLD.workspace_id;
    END IF;
  END IF;
  -- An organization cascade needs no catalog hint after the organization is gone.
  INSERT INTO public.security_events(kind,org_id,payload)
    SELECT 'organization.data_changed',o.id,jsonb_build_object('resource','cloud_workspace','workspaceId',target,'change',change)
    FROM public.organizations o WHERE o.id=organization;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Only table triggers call the new catalog notification function
REVOKE ALL ON FUNCTION notify_cloud_v2_catalog_row() FROM PUBLIC;

CREATE TRIGGER catalog_workspaces_insert AFTER INSERT ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_workspaces_delete AFTER DELETE ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_workspaces_update AFTER UPDATE ON cloud_v2_workspaces
  FOR EACH ROW WHEN (
    ROW(NEW.org_id,NEW.name,NEW.title,NEW.number,NEW.repository,NEW.branch,NEW.base_branch,NEW.state,NEW.error_code,NEW.archived_at,
      NEW.creator_user_id,NEW.created_by_user_id,NEW.source_pending,
      NEW.setup_status,NEW.agent_cost_usd,NEW.agent_cost_turns,NEW.agent_cost_estimated_turns,
      NEW.creator_revision,NEW.creator_absent_reason,NEW.execution_mode,coalesce(NEW.worker_boot_id=ANY(NEW.acting_user_boot_ids),false))
    IS DISTINCT FROM
    ROW(OLD.org_id,OLD.name,OLD.title,OLD.number,OLD.repository,OLD.branch,OLD.base_branch,OLD.state,OLD.error_code,OLD.archived_at,
      OLD.creator_user_id,OLD.created_by_user_id,OLD.source_pending,
      OLD.setup_status,OLD.agent_cost_usd,OLD.agent_cost_turns,OLD.agent_cost_estimated_turns,
      OLD.creator_revision,OLD.creator_absent_reason,OLD.execution_mode,coalesce(OLD.worker_boot_id=ANY(OLD.acting_user_boot_ids),false)))
  EXECUTE FUNCTION notify_cloud_v2_catalog_row();

CREATE TRIGGER catalog_github_insert AFTER INSERT ON cloud_v2_github_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_github_delete AFTER DELETE ON cloud_v2_github_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_github_update AFTER UPDATE ON cloud_v2_github_workspaces
  FOR EACH ROW WHEN (
    ROW(NEW.workspace_id,NEW.repository_id,NEW.canonical_repository,NEW.checkout_boot_id IS NOT NULL,NEW.branch,NEW.base_branch,NEW.head_sha,NEW.pr_number,NEW.pr_state,NEW.pr_url,NEW.pr_connection_generation)
    IS DISTINCT FROM
    ROW(OLD.workspace_id,OLD.repository_id,OLD.canonical_repository,OLD.checkout_boot_id IS NOT NULL,OLD.branch,OLD.base_branch,OLD.head_sha,OLD.pr_number,OLD.pr_state,OLD.pr_url,OLD.pr_connection_generation))
  EXECUTE FUNCTION notify_cloud_v2_catalog_row();

CREATE TRIGGER catalog_followers_insert AFTER INSERT ON cloud_v2_workspace_followers
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_followers_delete AFTER DELETE ON cloud_v2_workspace_followers
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_followers_update AFTER UPDATE ON cloud_v2_workspace_followers
  FOR EACH ROW WHEN (ROW(NEW.workspace_id,NEW.user_id) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.user_id))
  EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_pins_insert AFTER INSERT ON cloud_v2_workspace_pins
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_pins_delete AFTER DELETE ON cloud_v2_workspace_pins
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_catalog_row();
CREATE TRIGGER catalog_pins_update AFTER UPDATE ON cloud_v2_workspace_pins
  FOR EACH ROW WHEN (ROW(NEW.workspace_id,NEW.user_id) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.user_id))
  EXECUTE FUNCTION notify_cloud_v2_catalog_row();
