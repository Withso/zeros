-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Attribution survives source-chat deletion and worker mirror replacement;
-- it carries no authority and deliberately has no foreign key to that chat.
ALTER TABLE cloud_v2_workspaces ADD COLUMN created_by_session_id text;
ALTER TABLE cloud_v2_chats ADD COLUMN created_by_session_id text;
ALTER TABLE cloud_v2_prompt_outbox ADD COLUMN created_by_session_id text;
