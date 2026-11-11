-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A bounded rolling budget survives chat erasure; no lifecycle clock changes
-- when this metadata is updated. N-1 writers preserve the default/array.
ALTER TABLE cloud_v2_workspaces ADD COLUMN notification_times timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[]
  CHECK (cardinality(notification_times) <= 30);

-- Receipts outlive delivery: a lost HTTP reply must not notify the person
-- again. Only the event text expires; chat/workspace erasure removes the receipt.
CREATE TABLE cloud_v2_notifications (
  workspace_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 256),
  user_message_id text NOT NULL CHECK (char_length(user_message_id) BETWEEN 1 AND 256),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  access_epoch bigint NOT NULL CHECK (access_epoch >= 0),
  stop_generation bigint NOT NULL CHECK (stop_generation >= 0),
  sender_user_id uuid,
  sender_message_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event text CHECK (event IS NULL OR octet_length(event) <= 32768),
  PRIMARY KEY (workspace_id, notification_id),
  UNIQUE (workspace_id, chat_id, user_message_id),
  FOREIGN KEY (workspace_id, chat_id) REFERENCES cloud_v2_chats(workspace_id, chat_id) ON DELETE CASCADE,
  CHECK ((sender_user_id IS NULL) = (sender_message_id IS NULL)),
  CHECK (event IS NULL OR sender_user_id IS NOT NULL)
);
CREATE INDEX cloud_v2_notifications_expiry ON cloud_v2_notifications(created_at) WHERE event IS NOT NULL;
ALTER TABLE cloud_v2_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_notifications USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_notifications TO zeros_app;

-- zeros-expand-exception: notification-erasure Erases only new notification receipts when an existing mirror chat is soft-deleted
CREATE FUNCTION erase_cloud_v2_notifications() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.cloud_v2_notifications WHERE workspace_id=NEW.workspace_id AND chat_id=NEW.chat_id;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new notification erasure function
REVOKE ALL ON FUNCTION erase_cloud_v2_notifications() FROM PUBLIC;
CREATE TRIGGER cloud_v2_notification_chat_erasure AFTER UPDATE OF deleted_at ON cloud_v2_chats
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION erase_cloud_v2_notifications();
