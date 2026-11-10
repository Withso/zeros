-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Keep the current boot and an authenticated runtime-adoption candidate;
-- an old control plane's new boot cannot inherit a capability it never sent.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN chat_edit_boot_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
    CHECK (cardinality(chat_edit_boot_ids) <= 2);

CREATE TABLE cloud_v2_chat_edits (
  workspace_id uuid NOT NULL,
  chat_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0 AND version < 9223372036854775807),
  acknowledged_version bigint NOT NULL DEFAULT 0 CHECK (acknowledged_version >= 0 AND acknowledged_version <= version),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  archived boolean,
  last_offered_boot_id uuid,
  last_offered_version bigint,
  last_offered_at timestamptz,
  PRIMARY KEY (workspace_id, chat_id),
  FOREIGN KEY (workspace_id, chat_id) REFERENCES cloud_v2_chats(workspace_id, chat_id) ON DELETE CASCADE,
  CHECK ((version = acknowledged_version AND title IS NULL AND archived IS NULL)
    OR (version > acknowledged_version AND (title IS NOT NULL OR archived IS NOT NULL)))
);
CREATE INDEX cloud_v2_chat_edits_pending ON cloud_v2_chat_edits(workspace_id, last_offered_at, chat_id)
  WHERE version > acknowledged_version;
ALTER TABLE cloud_v2_chat_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_chat_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_chat_edits USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_chat_edits TO zeros_app;
