-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Cloud workspace v2. One Boat VM per workspace, forked from its organization's
-- live Cloud Computer snapshot and run by a small worker that dials out to the
-- control plane. Only the control plane (system role) reads or writes these
-- tables; every route checks the creator and organization membership itself.

-- Every Cloud Computer build an organization made, kept as a reproducible
-- recipe. Only the active build exists as a Boat snapshot; re-activating an
-- older build rebuilds it from this recipe.
CREATE TABLE cloud_v2_computer_builds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object'),
  state text NOT NULL CHECK (state IN ('queued','building','succeeded','failed','cancelled')),
  builder_sandbox_id text,
  snapshot_id text,
  log text NOT NULL DEFAULT '' CHECK (octet_length(log) <= 1048576),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  -- Written every minute while a server runs the build; a stale one means the
  -- server stopped and the build is failed so the organization can retry.
  heartbeat_at timestamptz,
  finished_at timestamptz,
  UNIQUE (org_id, version)
);
CREATE INDEX cloud_v2_computer_builds_org ON cloud_v2_computer_builds (org_id, version DESC);

-- The organization's one live named snapshot.
CREATE TABLE cloud_v2_computers (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  active_build_id uuid REFERENCES cloud_v2_computer_builds(id),
  snapshot_name text UNIQUE CHECK (snapshot_name IS NULL OR char_length(snapshot_name) BETWEEN 1 AND 128),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE cloud_v2_workspaces (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  repository text NOT NULL CHECK (char_length(repository) BETWEEN 3 AND 512),
  branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 255),
  base_branch text NOT NULL CHECK (char_length(base_branch) BETWEEN 1 AND 255),
  state text NOT NULL CHECK (state IN ('creating','running','stopping','stopped','starting','deleting','deleted','failed')),
  computer_build_id uuid REFERENCES cloud_v2_computer_builds(id),
  boat_sandbox_id text UNIQUE,
  worker_token_hash bytea UNIQUE CHECK (worker_token_hash IS NULL OR octet_length(worker_token_hash) = 32),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  active_at timestamptz,
  -- Lifecycle retries for the transitional states; reset on every state change.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_v2_workspaces_pending ON cloud_v2_workspaces (next_attempt_at)
  WHERE state IN ('creating','starting','stopping','deleting');
CREATE INDEX cloud_v2_workspaces_creator ON cloud_v2_workspaces (org_id, creator_user_id, created_at DESC)
  WHERE state <> 'deleted';

-- History mirror, so the app can read chats while the VM sleeps. Rows are the
-- exact shape Local persists from the shared applyUpdate fold.
CREATE TABLE cloud_v2_chats (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 256),
  row jsonb NOT NULL CHECK (jsonb_typeof(row) = 'object'),
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, chat_id)
);

CREATE TABLE cloud_v2_messages (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 256),
  msg_id text NOT NULL CHECK (char_length(msg_id) BETWEEN 1 AND 256),
  ord bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (char_length(kind) <= 64),
  payload text NOT NULL CHECK (octet_length(payload) <= 1000000),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (workspace_id, chat_id, msg_id)
);
CREATE INDEX cloud_v2_messages_order ON cloud_v2_messages (workspace_id, chat_id, ord);

-- Short-lived bearer tokens, stored only as SHA-256: one-use app connect
-- tickets and worker model-proxy tokens. Shared by every control-plane process.
CREATE TABLE cloud_v2_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('connect','proxy')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_v2_tokens_expiry ON cloud_v2_tokens (expires_at);

ALTER TABLE cloud_v2_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_tokens USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_computer_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_computer_builds FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_computer_builds USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_computers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_computers FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_computers USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspaces USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_chats USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_messages USING (app_is_system()) WITH CHECK (app_is_system());

GRANT SELECT, INSERT, UPDATE ON cloud_v2_computer_builds, cloud_v2_computers, cloud_v2_workspaces TO zeros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_chats, cloud_v2_messages, cloud_v2_tokens TO zeros_app;
