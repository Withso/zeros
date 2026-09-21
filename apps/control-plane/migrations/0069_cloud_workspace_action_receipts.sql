-- Decisions and steering have an unavoidable provider-delivery boundary.
-- Persist intent first and never infer non-delivery from a lost reply.
CREATE TABLE cloud_workspace_action_receipts (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  conversation_id text NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 128),
  execution_id text NOT NULL CHECK (char_length(execution_id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('permission', 'question', 'steer')),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  generation integer NOT NULL CHECK (generation > 0),
  engine_instance_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatching', 'settled', 'uncertain')),
  outcome text CHECK (outcome IN ('delivered', 'queued', 'interrupted')),
  turn_id text CHECK (turn_id IS NULL OR char_length(turn_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id),
  UNIQUE (workspace_id, engine_instance_id, execution_id, kind, request_id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_engine_instances(id, workspace_id, generation, org_id) ON DELETE RESTRICT,
  CHECK ((state = 'dispatching' AND outcome IS NULL) OR
         (state = 'settled' AND outcome IS NOT NULL) OR
         (state = 'uncertain' AND outcome = 'interrupted'))
);
CREATE INDEX cloud_workspace_action_history ON cloud_workspace_action_receipts(workspace_id, conversation_id, created_at DESC, operation_id);
ALTER TABLE cloud_workspace_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_action_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_actions_system ON cloud_workspace_action_receipts
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_action_receipts TO zeros_app;

-- An engine can recover a lost claim response without claiming another job.
CREATE UNIQUE INDEX cloud_workspace_command_claim_identity
  ON cloud_workspace_commands(workspace_id, claim_id) WHERE claim_id IS NOT NULL;
