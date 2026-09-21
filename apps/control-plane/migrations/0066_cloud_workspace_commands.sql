-- Workspace-owned command ordering survives devices and compute generations.
-- The current engine is the only dispatcher. A claimed command is never
-- automatically retried after losing that engine's authority.
CREATE TABLE cloud_workspace_conversation_controls (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  conversation_id text NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 128),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  paused boolean NOT NULL DEFAULT false,
  next_position bigint NOT NULL DEFAULT 1 CHECK (next_position > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id),
  UNIQUE (workspace_id, conversation_id, org_id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);

CREATE TABLE cloud_workspace_commands (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id text NOT NULL,
  user_message_id text NOT NULL CHECK (char_length(user_message_id) BETWEEN 1 AND 128),
  position bigint NOT NULL CHECK (position > 0),
  state text NOT NULL CHECK (state IN ('queued', 'dispatching', 'succeeded', 'failed', 'cancelled', 'uncertain')),
  payload jsonb CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144)),
  generation integer NOT NULL CHECK (generation > 0),
  engine_instance_id uuid,
  execution_id text CHECK (execution_id IS NULL OR char_length(execution_id) BETWEEN 1 AND 128),
  claim_id uuid,
  result_code text CHECK (result_code IS NULL OR result_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, conversation_id, position),
  UNIQUE (workspace_id, conversation_id, user_message_id),
  FOREIGN KEY (workspace_id, conversation_id, org_id)
    REFERENCES cloud_workspace_conversation_controls(workspace_id, conversation_id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_engine_instances(id, workspace_id, generation, org_id) ON DELETE RESTRICT,
  CHECK ((state IN ('queued', 'dispatching') AND payload IS NOT NULL) OR state NOT IN ('queued', 'dispatching')),
  CHECK (state <> 'dispatching' OR (engine_instance_id IS NOT NULL AND execution_id IS NOT NULL AND claim_id IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_workspace_command_one_dispatcher
  ON cloud_workspace_commands(workspace_id, conversation_id) WHERE state = 'dispatching';
CREATE INDEX cloud_workspace_command_queue
  ON cloud_workspace_commands(workspace_id, conversation_id, position) WHERE state = 'queued';

CREATE TABLE cloud_workspace_command_operations (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  conversation_id text NOT NULL,
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, conversation_id, org_id)
    REFERENCES cloud_workspace_conversation_controls(workspace_id, conversation_id, org_id) ON DELETE CASCADE
);

ALTER TABLE cloud_workspace_conversation_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_conversation_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_command_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_command_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_conversation_controls_system ON cloud_workspace_conversation_controls
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY cloud_commands_system ON cloud_workspace_commands
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY cloud_command_operations_system ON cloud_workspace_command_operations
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_conversation_controls,
  cloud_workspace_commands, cloud_workspace_command_operations TO zeros_app;
