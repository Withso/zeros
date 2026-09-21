-- Coalesce directory invalidations, not agent events. This independent outbox
-- intentionally has no foreign keys: a late trigger on a workspace must not
-- acquire an organization row after the workspace lock, nor lose removal
-- notifications when the workspace is physically erased. Publication takes
-- organization -> workspace -> outbox locks and verifies the scope afresh.
CREATE TABLE cloud_workspace_directory_outbox (
  workspace_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  owner_user_id uuid,
  guest_user_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(guest_user_ids)<=100),
  removed boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cloud_workspace_directory_pending ON cloud_workspace_directory_outbox(updated_at,workspace_id);
CREATE INDEX cloud_workspace_directory_org ON cloud_workspace_directory_outbox(org_id);
ALTER TABLE cloud_workspace_directory_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_directory_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_directory_system ON cloud_workspace_directory_outbox FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_directory_outbox TO zeros_app;

CREATE FUNCTION enqueue_cloud_workspace_directory_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE workspace cloud_workspaces%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.desired_state IS NOT DISTINCT FROM OLD.desired_state
      AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
      AND NEW.current_generation IS NOT DISTINCT FROM OLD.current_generation THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN workspace:=OLD; ELSE workspace:=NEW; END IF;
  INSERT INTO cloud_workspace_directory_outbox(workspace_id,org_id,owner_user_id,guest_user_ids,removed,revision)
    VALUES (workspace.id,workspace.org_id,workspace.owner_user_id,
      ARRAY(SELECT user_id FROM cloud_workspace_guest_grants WHERE workspace_id=workspace.id AND revoked_at IS NULL AND expires_at>now() ORDER BY user_id LIMIT 100),
      TG_OP='DELETE' OR workspace.deleted_at IS NOT NULL,workspace.version)
    ON CONFLICT (workspace_id) DO UPDATE SET org_id=excluded.org_id,owner_user_id=excluded.owner_user_id,
      guest_user_ids=CASE WHEN cloud_workspace_directory_outbox.removed THEN cloud_workspace_directory_outbox.guest_user_ids ELSE excluded.guest_user_ids END,
      removed=cloud_workspace_directory_outbox.removed OR excluded.removed,revision=excluded.revision,updated_at=now();
  -- Commit-scoped wake-up only. Streams still replay the durable publication.
  PERFORM pg_notify('zeros_security_event','');
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION enqueue_cloud_workspace_directory_change() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_directory_changed AFTER INSERT OR UPDATE OF status,desired_state,display_name,deleted_at,current_generation ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_workspace_directory_change();
CREATE TRIGGER cloud_workspace_directory_removed BEFORE DELETE ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION enqueue_cloud_workspace_directory_change();
