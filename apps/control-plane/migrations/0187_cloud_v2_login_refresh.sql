-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Settings changes and this revision commit together. NOTIFY is only a wake
-- hint; reconnect and heartbeat compare the retained revision after gaps.
ALTER TABLE cloud_v2_workspaces ADD COLUMN login_revision bigint NOT NULL DEFAULT 0;

CREATE FUNCTION cloud_v2_login_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  owner_id uuid;
  organization_id uuid;
  changed_credential_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN owner_id := OLD.owner_user_id;
  ELSE owner_id := NEW.owner_user_id; END IF;
  IF TG_TABLE_NAME = 'cloud_agent_organization_connections' THEN
    IF TG_OP = 'DELETE' THEN organization_id := OLD.org_id;
    ELSE organization_id := NEW.org_id; END IF;
    UPDATE public.cloud_v2_workspaces SET login_revision = login_revision + 1
      WHERE creator_user_id = owner_id AND org_id = organization_id AND state <> 'deleted';
  ELSE
    IF TG_OP = 'DELETE' THEN changed_credential_id := OLD.id;
    ELSE changed_credential_id := NEW.id; END IF;
    UPDATE public.cloud_v2_workspaces w SET login_revision = login_revision + 1
      WHERE w.creator_user_id = owner_id AND w.state <> 'deleted' AND EXISTS (
        SELECT 1 FROM public.cloud_agent_organization_connections c
        WHERE c.owner_user_id = owner_id AND c.org_id = w.org_id AND c.credential_id = changed_credential_id
      );
  END IF;
  IF FOUND THEN
    PERFORM pg_notify('zeros_cloud_v2_logins', json_build_object('ownerUserId', owner_id, 'organizationId', organization_id)::text);
  END IF;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_v2_login_changed() FROM PUBLIC;
CREATE TRIGGER cloud_v2_connection_changed AFTER INSERT OR UPDATE OR DELETE ON cloud_agent_organization_connections
FOR EACH ROW EXECUTE FUNCTION cloud_v2_login_changed();
CREATE TRIGGER cloud_v2_credential_changed AFTER UPDATE OF revision, current_version, revoked_at OR DELETE ON cloud_agent_credentials
FOR EACH ROW EXECUTE FUNCTION cloud_v2_login_changed();
