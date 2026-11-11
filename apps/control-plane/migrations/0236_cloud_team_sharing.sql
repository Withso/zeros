-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
UPDATE cloud_v2_workspaces SET created_by_user_id=creator_user_id;
ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_v2_workspaces_id_org UNIQUE(id,org_id);
CREATE INDEX cloud_v2_workspaces_organization_page ON cloud_v2_workspaces(org_id,created_at DESC,id) WHERE state<>'deleted';

-- N-1 inserts omit the new provenance column. User erasure may null it; an
-- assignment or ordinary update must never rewrite the original Creator.
CREATE FUNCTION cloud_v2_original_creator() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.created_by_user_id IS NOT NULL AND NEW.created_by_user_id IS DISTINCT FROM NEW.creator_user_id THEN
      RAISE EXCEPTION 'original creator must match creator on insert';
    END IF;
    NEW.created_by_user_id := NEW.creator_user_id;
  ELSIF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NOT (
    NEW.created_by_user_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.users WHERE id=OLD.created_by_user_id)) THEN
    RAISE EXCEPTION 'original creator is immutable';
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new provenance guard
REVOKE ALL ON FUNCTION cloud_v2_original_creator() FROM PUBLIC;
CREATE TRIGGER cloud_v2_original_creator_insert BEFORE INSERT ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_v2_original_creator();
CREATE TRIGGER cloud_v2_original_creator_update BEFORE UPDATE OF created_by_user_id ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_v2_original_creator();

CREATE TABLE cloud_v2_workspace_followers (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,user_id) REFERENCES organization_members(org_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_v2_workspace_followers_person ON cloud_v2_workspace_followers(org_id,user_id,created_at DESC,workspace_id);
ALTER TABLE cloud_v2_workspace_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_followers FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_followers USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_workspace_followers TO zeros_app;

CREATE TABLE cloud_v2_workspace_pins (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,user_id) REFERENCES organization_members(org_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_v2_workspace_pins_person ON cloud_v2_workspace_pins(org_id,user_id,created_at DESC,workspace_id);
ALTER TABLE cloud_v2_workspace_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_pins USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_workspace_pins TO zeros_app;

CREATE TABLE cloud_v2_workspace_presence (
  connection_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider_session_id text NOT NULL CHECK(char_length(provider_session_id) BETWEEN 1 AND 512),
  access_epoch bigint NOT NULL CHECK(access_epoch>=0),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,user_id) REFERENCES organization_members(org_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_v2_workspace_presence_workspace ON cloud_v2_workspace_presence(workspace_id,expires_at);
CREATE INDEX cloud_v2_workspace_presence_expiry ON cloud_v2_workspace_presence(expires_at);
CREATE INDEX cloud_v2_workspace_presence_person ON cloud_v2_workspace_presence(user_id,expires_at,workspace_id);
CREATE INDEX cloud_v2_workspace_presence_session ON cloud_v2_workspace_presence(provider_session_id);
ALTER TABLE cloud_v2_workspace_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_presence USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_workspace_presence TO zeros_app;

-- Statement transition tables cover old and new writers, including replace
-- and cascades. Only UUIDs are read: no payload parse, row counter or workspace
-- UPDATE on the message hot path. PostgreSQL folds identical hints per tx.
CREATE FUNCTION notify_cloud_v2_team_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='cloud_v2_workspace_presence' THEN
    IF TG_OP='INSERT' THEN
      FOR target IN SELECT DISTINCT workspace_id FROM new_rows LOOP
        PERFORM pg_notify('zeros_cloud_v2_presence',target::text);
      END LOOP;
    ELSE
      FOR target IN SELECT DISTINCT workspace_id FROM old_rows LOOP
        PERFORM pg_notify('zeros_cloud_v2_presence',target::text);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME='cloud_v2_workspaces' THEN
    IF TG_OP='UPDATE' THEN
      FOR target IN SELECT n.id FROM new_rows n JOIN old_rows o USING(id)
        WHERE ROW(n.name,n.title,n.number,n.repository,n.branch,n.base_branch,n.state,n.error_code,n.archived_at,
          n.creator_user_id,n.created_by_user_id,n.created_by_session_id,n.boat_sandbox_id,n.computer_build_id,n.source_pending,
          n.setup_status,n.agent_cost_usd,n.agent_cost_turns,n.agent_cost_estimated_turns)
        IS DISTINCT FROM ROW(o.name,o.title,o.number,o.repository,o.branch,o.base_branch,o.state,o.error_code,o.archived_at,
          o.creator_user_id,o.created_by_user_id,o.created_by_session_id,o.boat_sandbox_id,o.computer_build_id,o.source_pending,
          o.setup_status,o.agent_cost_usd,o.agent_cost_turns,o.agent_cost_estimated_turns) LOOP
        PERFORM pg_notify('zeros_cloud_v2_team',target::text);
      END LOOP;
    ELSIF TG_OP='DELETE' THEN
      FOR target IN SELECT DISTINCT id FROM old_rows LOOP
        PERFORM pg_notify('zeros_cloud_v2_team',target::text);
      END LOOP;
    ELSE
      FOR target IN SELECT DISTINCT id FROM new_rows LOOP
        PERFORM pg_notify('zeros_cloud_v2_team',target::text);
      END LOOP;
    END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='cloud_v2_prompt_outbox' THEN
    FOR target IN SELECT DISTINCT n.workspace_id FROM new_rows n JOIN old_rows o USING(workspace_id,user_message_id)
      WHERE ROW(n.state,n.cancel_requested) IS DISTINCT FROM ROW(o.state,o.cancel_requested) LOOP
      PERFORM pg_notify('zeros_cloud_v2_team',target::text);
    END LOOP;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='cloud_v2_prompt_chats' THEN
    FOR target IN SELECT DISTINCT n.workspace_id FROM new_rows n JOIN old_rows o USING(workspace_id,chat_id)
      WHERE ROW(n.epoch,n.next_sequence,n.stop_acked_epoch) IS DISTINCT FROM ROW(o.epoch,o.next_sequence,o.stop_acked_epoch) LOOP
      PERFORM pg_notify('zeros_cloud_v2_team',target::text);
    END LOOP;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='cloud_v2_chat_edits' THEN
    FOR target IN SELECT DISTINCT n.workspace_id FROM new_rows n JOIN old_rows o USING(workspace_id,chat_id)
      WHERE n.version IS DISTINCT FROM o.version LOOP
      PERFORM pg_notify('zeros_cloud_v2_team',target::text);
    END LOOP;
  ELSIF TG_OP='UPDATE' THEN
    FOR target IN SELECT workspace_id FROM old_rows UNION SELECT workspace_id FROM new_rows LOOP
      PERFORM pg_notify('zeros_cloud_v2_team',target::text);
    END LOOP;
  ELSIF TG_OP='DELETE' THEN
    FOR target IN SELECT DISTINCT workspace_id FROM old_rows LOOP
      PERFORM pg_notify('zeros_cloud_v2_team',target::text);
    END LOOP;
  ELSE
    FOR target IN SELECT DISTINCT workspace_id FROM new_rows LOOP
      PERFORM pg_notify('zeros_cloud_v2_team',target::text);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new UUID invalidation function
REVOKE ALL ON FUNCTION notify_cloud_v2_team_rows() FROM PUBLIC;

CREATE TRIGGER team_workspaces_insert AFTER INSERT ON cloud_v2_workspaces
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspaces_update AFTER UPDATE ON cloud_v2_workspaces
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspaces_delete AFTER DELETE ON cloud_v2_workspaces
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_chats_insert AFTER INSERT ON cloud_v2_chats
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_chats_update AFTER UPDATE ON cloud_v2_chats
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_chats_delete AFTER DELETE ON cloud_v2_chats
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_messages_insert AFTER INSERT ON cloud_v2_messages
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_messages_update AFTER UPDATE ON cloud_v2_messages
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_messages_delete AFTER DELETE ON cloud_v2_messages
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_prompt_chats_insert AFTER INSERT ON cloud_v2_prompt_chats
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_prompt_chats_update AFTER UPDATE ON cloud_v2_prompt_chats
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_prompt_chats_delete AFTER DELETE ON cloud_v2_prompt_chats
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_prompt_outbox_insert AFTER INSERT ON cloud_v2_prompt_outbox
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_prompt_outbox_update AFTER UPDATE ON cloud_v2_prompt_outbox
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_prompt_outbox_delete AFTER DELETE ON cloud_v2_prompt_outbox
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_chat_edits_insert AFTER INSERT ON cloud_v2_chat_edits
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_chat_edits_update AFTER UPDATE ON cloud_v2_chat_edits
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_chat_edits_delete AFTER DELETE ON cloud_v2_chat_edits
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_github_workspaces_insert AFTER INSERT ON cloud_v2_github_workspaces
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_github_workspaces_update AFTER UPDATE ON cloud_v2_github_workspaces
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_github_workspaces_delete AFTER DELETE ON cloud_v2_github_workspaces
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_followers_insert AFTER INSERT ON cloud_v2_workspace_followers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_followers_update AFTER UPDATE ON cloud_v2_workspace_followers
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_followers_delete AFTER DELETE ON cloud_v2_workspace_followers
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_pins_insert AFTER INSERT ON cloud_v2_workspace_pins
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_pins_update AFTER UPDATE ON cloud_v2_workspace_pins
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_pins_delete AFTER DELETE ON cloud_v2_workspace_pins
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_presence_insert AFTER INSERT ON cloud_v2_workspace_presence
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
CREATE TRIGGER team_workspace_presence_delete AFTER DELETE ON cloud_v2_workspace_presence
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_v2_team_rows();
