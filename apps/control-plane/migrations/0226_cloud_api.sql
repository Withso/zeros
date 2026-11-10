-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

CREATE TABLE cloud_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prefix text NOT NULL CHECK (prefix ~ '^zk_[A-Za-z0-9_-]{4}$'),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX cloud_api_keys_active_owner ON cloud_api_keys(org_id, owner_user_id, created_at, id) WHERE revoked_at IS NULL;
ALTER TABLE cloud_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_api_keys USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_api_keys TO zeros_app;

CREATE TABLE cloud_api_access_settings (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_api_access boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
ALTER TABLE cloud_api_access_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_api_access_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_api_access_settings USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_api_access_settings TO zeros_app;

CREATE INDEX cloud_v2_chats_api_id ON cloud_v2_chats(chat_id, workspace_id) WHERE deleted_at IS NULL;

ALTER TABLE cloud_v2_prompt_outbox
  ADD COLUMN session_name text CHECK (session_name IS NULL OR char_length(session_name) BETWEEN 1 AND 120);

-- Existing workspaces and old writers receive API access when a capable
-- worker is configured. New writers explicitly copy the creator's setting.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN api_access boolean NOT NULL DEFAULT true,
  ADD COLUMN restart_stop_generation bigint;

ALTER TABLE cloud_v2_tokens
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN api_stop_generation bigint,
  ADD COLUMN api_envelope jsonb;
CREATE UNIQUE INDEX cloud_v2_tokens_id ON cloud_v2_tokens(id);
CREATE UNIQUE INDEX cloud_v2_tokens_api_run ON cloud_v2_tokens(workspace_id, api_stop_generation) WHERE kind = 'api';
-- zeros-expand-exception: widen-check Preserve both released token kinds and admit the negotiated VM-run API token
ALTER TABLE cloud_v2_tokens DROP CONSTRAINT cloud_v2_tokens_kind_check;
ALTER TABLE cloud_v2_tokens ADD CONSTRAINT cloud_v2_tokens_kind_check CHECK (kind IN ('connect','proxy','api'));
ALTER TABLE cloud_v2_tokens ADD CONSTRAINT cloud_v2_tokens_api_material CHECK (
  kind <> 'api' OR (api_stop_generation IS NOT NULL AND api_stop_generation >= 0 AND api_envelope IS NOT NULL AND jsonb_typeof(api_envelope) = 'object')
);

-- A run's process environments outlive configuration refreshes. Lookup uses
-- only the hash; the existing credential envelope permits exact redelivery.
-- zeros-expand-exception: credential-erasure Revokes only the newly introduced API tokens at their existing workspace lifecycle boundary
CREATE FUNCTION fence_cloud_api_tokens() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('creating','starting','running') OR NEW.archived_at IS NOT NULL
    OR NEW.stop_generation IS DISTINCT FROM OLD.stop_generation THEN
    DELETE FROM public.cloud_v2_tokens WHERE workspace_id = NEW.id AND kind = 'api';
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the function introduced here
REVOKE ALL ON FUNCTION fence_cloud_api_tokens() FROM PUBLIC;
CREATE TRIGGER cloud_api_token_lifetime BEFORE UPDATE OF state, stop_generation, archived_at ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_api_tokens();
