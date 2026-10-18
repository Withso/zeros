-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- The engine turn journal (S2 turns.v1): one contiguous sequence per engine
-- instance and VM boot, which migration 0139 gives one local writer. realtime
-- inserts each transition once and acks it; a terminal transition notifies
-- the device streams in the same transaction. Rows carry no prompt content.
CREATE TABLE cloud_workspace_turn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  engine_instance_id uuid NOT NULL,
  boot_id uuid NOT NULL,
  journal_seq bigint NOT NULL CHECK (journal_seq > 0),
  chat_id text NOT NULL CHECK (chat_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  turn_id text NOT NULL CHECK (turn_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL CHECK (state IN ('started', 'completed', 'failed', 'needs_attention', 'interrupted')),
  at timestamptz NOT NULL,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engine_instance_id, boot_id, journal_seq),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_turn_events_turn
  ON cloud_workspace_turn_events(workspace_id, chat_id, turn_id);

ALTER TABLE cloud_workspace_turn_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_turn_events FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_turn_events
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON cloud_workspace_turn_events TO zeros_app;
