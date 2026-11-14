-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE cloud_v2_chats
  ADD COLUMN history_digest text,
  ADD COLUMN history_replacement_boot_id uuid,
  ADD COLUMN history_replacement_sequence bigint,
  ADD COLUMN history_replacement_started boolean,
  ADD CONSTRAINT cloud_history_digest_format CHECK (char_length(history_digest)=64 AND history_digest ~ '^[0-9a-f]+$') NOT VALID,
  ADD CONSTRAINT cloud_history_replacement_sequence CHECK (history_replacement_sequence BETWEEN 1 AND 9007199254740991) NOT VALID,
  ADD CONSTRAINT cloud_history_replacement_pair CHECK (
    (history_replacement_boot_id IS NULL) = (history_replacement_sequence IS NULL)
    AND (history_replacement_boot_id IS NULL) = (history_replacement_started IS NULL)) NOT VALID,
  ADD CONSTRAINT cloud_history_digest_complete CHECK (history_digest IS NULL OR history_replacement_boot_id IS NULL) NOT VALID;

CREATE FUNCTION invalidate_cloud_chat_history_digest() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  NEW.history_digest := NULL;
  -- The first message frame updates only historyState. Its matching chat
  -- frame is still part of the same replacement; other content writes break it.
  IF TG_OP='UPDATE' AND current_setting('app.cloud_history_state',true)='on'
    AND OLD.workspace_id::text=current_setting('app.cloud_history_workspace',true)
    AND OLD.chat_id=current_setting('app.cloud_history_chat',true)
    AND OLD.history_replacement_boot_id::text=current_setting('app.cloud_history_boot',true)
    AND OLD.history_replacement_sequence::text=current_setting('app.cloud_history_previous',true)
    AND NEW.workspace_id=OLD.workspace_id AND NEW.chat_id=OLD.chat_id
    AND NEW.row-'historyState'=OLD.row-'historyState'
    AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    NEW.history_replacement_boot_id := OLD.history_replacement_boot_id;
    NEW.history_replacement_sequence := OLD.history_replacement_sequence;
    NEW.history_replacement_started := OLD.history_replacement_started;
    RETURN NEW;
  END IF;
  NEW.history_replacement_boot_id := NULL;
  NEW.history_replacement_sequence := NULL;
  NEW.history_replacement_started := NULL;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Revoke default PUBLIC execution on this new trigger-only function.
REVOKE ALL ON FUNCTION invalidate_cloud_chat_history_digest() FROM PUBLIC;

-- Metadata-only stamps must not clear themselves. A content UPDATE, even
-- one that assigns the same value, invalidates an older worker's stamp.
CREATE TRIGGER cloud_chat_history_digest
BEFORE INSERT OR UPDATE OF workspace_id,chat_id,row,deleted_at,updated_at OR DELETE ON cloud_v2_chats
FOR EACH ROW EXECUTE FUNCTION invalidate_cloud_chat_history_digest();

CREATE FUNCTION invalidate_cloud_message_history_digest() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  frame_workspace text := current_setting('app.cloud_history_workspace',true);
  frame_chat text := current_setting('app.cloud_history_chat',true);
  frame_boot text := current_setting('app.cloud_history_boot',true);
  frame_previous text := current_setting('app.cloud_history_previous',true);
  previous_protocol text := current_setting('app.cloud_execution_protocol',true);
BEGIN
  -- The normal history writers already hold the workspace first. This also
  -- fences an unaware message writer before the first chat row exists; a
  -- chat-only lock would miss that race. Recheck metadata in a fresh statement.
  -- Older writers can reach child history rows without the activation marker.
  -- It changes compatibility visibility only; the caller still needs system RLS.
  IF previous_protocol IS DISTINCT FROM '1' THEN PERFORM set_config('app.cloud_execution_protocol','1',true); END IF;
  PERFORM 1 FROM public.cloud_v2_workspaces w
  JOIN (SELECT DISTINCT workspace_id FROM digest_changed_messages) changed ON w.id=changed.workspace_id
  ORDER BY w.id FOR KEY SHARE OF w;
  IF previous_protocol IS DISTINCT FROM '1' THEN PERFORM set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true); END IF;
  UPDATE public.cloud_v2_chats h SET history_digest=NULL,
    history_replacement_boot_id=CASE WHEN h.workspace_id::text=frame_workspace AND h.chat_id=frame_chat
      AND h.history_replacement_boot_id::text=frame_boot AND h.history_replacement_sequence::text=frame_previous
      THEN h.history_replacement_boot_id ELSE NULL END,
    history_replacement_sequence=CASE WHEN h.workspace_id::text=frame_workspace AND h.chat_id=frame_chat
      AND h.history_replacement_boot_id::text=frame_boot AND h.history_replacement_sequence::text=frame_previous
      THEN h.history_replacement_sequence ELSE NULL END,
    history_replacement_started=CASE WHEN h.workspace_id::text=frame_workspace AND h.chat_id=frame_chat
      AND h.history_replacement_boot_id::text=frame_boot AND h.history_replacement_sequence::text=frame_previous
      THEN h.history_replacement_started ELSE NULL END
  FROM (SELECT DISTINCT workspace_id,chat_id FROM digest_changed_messages) changed
  WHERE h.workspace_id=changed.workspace_id AND h.chat_id=changed.chat_id
    AND (h.history_digest IS NOT NULL OR h.history_replacement_boot_id IS NOT NULL);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Revoke default PUBLIC execution on this new trigger-only function.
REVOKE ALL ON FUNCTION invalidate_cloud_message_history_digest() FROM PUBLIC;

CREATE TRIGGER cloud_message_history_digest_insert
AFTER INSERT ON cloud_v2_messages REFERENCING NEW TABLE AS digest_changed_messages
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_cloud_message_history_digest();

CREATE TRIGGER cloud_message_history_digest_delete
AFTER DELETE ON cloud_v2_messages REFERENCING OLD TABLE AS digest_changed_messages
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_cloud_message_history_digest();

CREATE FUNCTION invalidate_changed_cloud_message_history_digest() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  frame_workspace text := current_setting('app.cloud_history_workspace',true);
  frame_chat text := current_setting('app.cloud_history_chat',true);
  frame_boot text := current_setting('app.cloud_history_boot',true);
  frame_previous text := current_setting('app.cloud_history_previous',true);
  previous_protocol text := current_setting('app.cloud_execution_protocol',true);
BEGIN
  IF previous_protocol IS DISTINCT FROM '1' THEN PERFORM set_config('app.cloud_execution_protocol','1',true); END IF;
  PERFORM 1 FROM public.cloud_v2_workspaces w
  JOIN (SELECT workspace_id FROM digest_old_messages UNION SELECT workspace_id FROM digest_new_messages) changed ON w.id=changed.workspace_id
  ORDER BY w.id FOR KEY SHARE OF w;
  IF previous_protocol IS DISTINCT FROM '1' THEN PERFORM set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true); END IF;
  UPDATE public.cloud_v2_chats h SET history_digest=NULL,
    history_replacement_boot_id=CASE WHEN h.workspace_id::text=frame_workspace AND h.chat_id=frame_chat
      AND h.history_replacement_boot_id::text=frame_boot AND h.history_replacement_sequence::text=frame_previous
      THEN h.history_replacement_boot_id ELSE NULL END,
    history_replacement_sequence=CASE WHEN h.workspace_id::text=frame_workspace AND h.chat_id=frame_chat
      AND h.history_replacement_boot_id::text=frame_boot AND h.history_replacement_sequence::text=frame_previous
      THEN h.history_replacement_sequence ELSE NULL END,
    history_replacement_started=CASE WHEN h.workspace_id::text=frame_workspace AND h.chat_id=frame_chat
      AND h.history_replacement_boot_id::text=frame_boot AND h.history_replacement_sequence::text=frame_previous
      THEN h.history_replacement_started ELSE NULL END
  FROM (SELECT workspace_id,chat_id FROM digest_old_messages UNION SELECT workspace_id,chat_id FROM digest_new_messages) changed
  WHERE h.workspace_id=changed.workspace_id AND h.chat_id=changed.chat_id
    AND (h.history_digest IS NOT NULL OR h.history_replacement_boot_id IS NOT NULL);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Revoke default PUBLIC execution on this new trigger-only function.
REVOKE ALL ON FUNCTION invalidate_changed_cloud_message_history_digest() FROM PUBLIC;

CREATE TRIGGER cloud_message_history_digest_update
AFTER UPDATE ON cloud_v2_messages REFERENCING OLD TABLE AS digest_old_messages NEW TABLE AS digest_new_messages
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_changed_cloud_message_history_digest();
