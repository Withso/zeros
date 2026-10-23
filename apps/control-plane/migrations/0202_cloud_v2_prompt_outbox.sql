-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Durable explicit sends. The workspace row serializes enqueue, Stop, worker
-- claims and authority changes. Device/session sign-out is not this authority.
CREATE TABLE cloud_v2_prompt_chats (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 256),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  next_sequence bigint NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
  stop_acked_epoch bigint NOT NULL DEFAULT 0 CHECK (stop_acked_epoch >= 0),
  PRIMARY KEY (workspace_id, chat_id)
);

CREATE TABLE cloud_v2_prompt_outbox (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  user_message_id text NOT NULL CHECK (char_length(user_message_id) BETWEEN 1 AND 256),
  chat_id text NOT NULL,
  creator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  access_epoch bigint NOT NULL CHECK (access_epoch >= 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 9000000)),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 0 AND 8388608),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 4096),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','inboxed','dispatching','accepted','completed','failed','cancelled','interrupted')),
  delivery_id uuid,
  worker_boot_id uuid,
  lease_until timestamptz,
  dispatch_id uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  wake_after_stop boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminal_at timestamptz,
  PRIMARY KEY (workspace_id, user_message_id),
  UNIQUE (workspace_id, chat_id, sequence),
  FOREIGN KEY (workspace_id, chat_id) REFERENCES cloud_v2_prompt_chats(workspace_id, chat_id) ON DELETE CASCADE
);
CREATE INDEX cloud_v2_prompts_pending ON cloud_v2_prompt_outbox(workspace_id, chat_id, sequence)
  WHERE state IN ('queued','inboxed','dispatching','accepted');
CREATE INDEX cloud_v2_prompts_retention ON cloud_v2_prompt_outbox(terminal_at)
  WHERE payload IS NOT NULL AND terminal_at IS NOT NULL;

ALTER TABLE cloud_v2_prompt_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_prompt_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_prompt_chats USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_prompt_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_prompt_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_prompt_outbox USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_prompt_chats, cloud_v2_prompt_outbox TO zeros_app;

-- Additive triggers keep the existing revocation carriers unchanged. An epoch
-- gain also invalidates earlier work; only newly authorized sends may resume.
-- zeros-expand-exception: prompt-erasure Newly added prompt rows follow existing workspace authority and erasure; no existing data is deleted during migration
CREATE FUNCTION fence_cloud_v2_prompts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state = 'deleted' THEN
    DELETE FROM public.cloud_v2_prompt_chats WHERE workspace_id = NEW.id;
  ELSIF NEW.access_epoch <> OLD.access_epoch OR NEW.state = 'deleting' THEN
    UPDATE public.cloud_v2_prompt_outbox
      SET state = 'cancelled', cancel_requested = true, payload = NULL, payload_bytes = 0,
          terminal_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE workspace_id = NEW.id AND state IN ('queued','inboxed','dispatching','accepted');
  ELSIF NEW.state = 'stopping' THEN
    -- Existing explicit workspace Stop also fences sends accepted before it.
    -- A later send may request one wake after this stop finishes.
    UPDATE public.cloud_v2_prompt_chats c SET epoch = epoch + 1
      WHERE workspace_id = NEW.id AND EXISTS (SELECT 1 FROM public.cloud_v2_prompt_outbox p
        WHERE p.workspace_id = c.workspace_id AND p.chat_id = c.chat_id AND p.state IN ('queued','inboxed','dispatching','accepted'));
    UPDATE public.cloud_v2_prompt_outbox
      SET cancel_requested = true, wake_after_stop = false,
          state = CASE WHEN state IN ('queued','inboxed') THEN 'cancelled' ELSE state END,
          terminal_at = CASE WHEN state IN ('queued','inboxed') THEN clock_timestamp() ELSE terminal_at END,
          updated_at = clock_timestamp()
      WHERE workspace_id = NEW.id AND state IN ('queued','inboxed','dispatching','accepted');
  END IF;
  PERFORM pg_notify('zeros_cloud_v2_prompts', NEW.id::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from a function created in this migration
REVOKE ALL ON FUNCTION fence_cloud_v2_prompts() FROM PUBLIC;
CREATE TRIGGER cloud_v2_prompts_authority AFTER UPDATE OF access_epoch, state ON cloud_v2_workspaces
  FOR EACH ROW WHEN (NEW.access_epoch IS DISTINCT FROM OLD.access_epoch OR NEW.state IS DISTINCT FROM OLD.state)
  EXECUTE FUNCTION fence_cloud_v2_prompts();

-- zeros-expand-exception: chat-prompt-erasure Newly added prompt rows are erased only by an existing chat deletion; no existing data is deleted during migration
CREATE FUNCTION erase_cloud_v2_chat_prompts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.cloud_v2_prompt_chats WHERE workspace_id = OLD.workspace_id AND chat_id = OLD.chat_id;
    RETURN OLD;
  ELSIF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM public.cloud_v2_prompt_chats WHERE workspace_id = NEW.workspace_id AND chat_id = NEW.chat_id;
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from a function created in this migration
REVOKE ALL ON FUNCTION erase_cloud_v2_chat_prompts() FROM PUBLIC;
CREATE TRIGGER cloud_v2_prompts_chat_erasure AFTER INSERT OR UPDATE OF deleted_at OR DELETE ON cloud_v2_chats
  FOR EACH ROW EXECUTE FUNCTION erase_cloud_v2_chat_prompts();
