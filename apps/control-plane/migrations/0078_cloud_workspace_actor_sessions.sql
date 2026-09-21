-- v2 actor admission is separate from the exact-key v1 owner grant protocol.
-- A connected human is never the compute sponsor or engine identity.
CREATE TABLE cloud_workspace_actor_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL,
  engine_instance_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  device_key_version bigint NOT NULL CHECK (device_key_version>0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch>0),
  actor_fingerprint text NOT NULL CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$'),
  actor_role text NOT NULL CHECK (actor_role IN ('viewer','prompter','developer','manager','owner')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  admission_expires_at timestamptz NOT NULL,
  session_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  last_renewed_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (engine_instance_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_engine_instances(id,workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id,actor_user_id) REFERENCES devices(id,user_id) ON DELETE CASCADE,
  CHECK (admission_expires_at>created_at AND session_expires_at>=admission_expires_at),
  CHECK ((consumed_at IS NULL) = (last_renewed_at IS NULL))
);
CREATE INDEX cloud_workspace_actor_session_subject ON cloud_workspace_actor_sessions(workspace_id,actor_user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX cloud_workspace_actor_session_expiry ON cloud_workspace_actor_sessions(session_expires_at);
ALTER TABLE cloud_workspace_actor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_actor_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_actor_sessions_system ON cloud_workspace_actor_sessions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_actor_sessions TO zeros_app;

-- Immutable attribution survives socket closure. Queued work rechecks these
-- identities and credential consent without requiring its old socket to live.
ALTER TABLE cloud_workspace_commands
  ADD COLUMN actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN actor_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  ADD COLUMN actor_device_key_version bigint,
  ADD COLUMN actor_fingerprint text CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE cloud_workspace_command_operations
  ADD COLUMN actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN actor_device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE cloud_workspace_action_receipts
  ADD COLUMN actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN actor_device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
