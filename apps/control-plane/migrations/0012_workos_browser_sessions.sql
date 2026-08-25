-- ──────────────────────────────────────────────────────────
-- 0012 — Railway-owned WorkOS browser flow/session state
-- ──────────────────────────────────────────────────────────
-- Browser cookies contain random 256-bit credentials. Only their SHA-256
-- digests are persisted. OAuth state is likewise stored only as a digest;
-- PKCE verifiers remain server-side and are erased when a flow becomes a
-- session. WorkOS sealed sessions are encrypted/authenticated by the
-- environment-specific WORKOS_COOKIE_PASSWORD before reaching this table.

CREATE TABLE workos_browser_sessions (
  credential_hash         bytea PRIMARY KEY,
  kind                    text NOT NULL CHECK (kind IN ('flow', 'session')),
  oauth_state_hash        bytea,
  pkce_verifier           text,
  return_path             text,
  redirect_uri            text,
  sealed_session          text,
  provider_session_id     text,
  provider_sub            text,
  email                   citext,
  display_name            text,
  access_token_expires_at timestamptz,
  expires_at              timestamptz NOT NULL,
  claimed_at              timestamptz,
  revision                bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(credential_hash) = 32),
  CHECK (oauth_state_hash IS NULL OR octet_length(oauth_state_hash) = 32),
  CHECK (pkce_verifier IS NULL OR char_length(pkce_verifier) BETWEEN 43 AND 128),
  CHECK (return_path IS NULL OR char_length(return_path) BETWEEN 1 AND 4096),
  CHECK (redirect_uri IS NULL OR char_length(redirect_uri) BETWEEN 1 AND 2048),
  CHECK (sealed_session IS NULL OR char_length(sealed_session) BETWEEN 1 AND 65536),
  CHECK (provider_session_id IS NULL OR char_length(provider_session_id) BETWEEN 1 AND 512),
  CHECK (provider_sub IS NULL OR char_length(provider_sub) BETWEEN 1 AND 512),
  CHECK (email IS NULL OR char_length(email::text) BETWEEN 3 AND 254),
  CHECK (display_name IS NULL OR char_length(display_name) <= 500),
  CHECK (revision >= 0),
  CHECK (
    (kind = 'flow'
      AND oauth_state_hash IS NOT NULL
      AND pkce_verifier IS NOT NULL
      AND return_path IS NOT NULL
      AND redirect_uri IS NOT NULL
      AND sealed_session IS NULL
      AND provider_session_id IS NULL
      AND provider_sub IS NULL
      AND email IS NULL
      AND display_name IS NULL
      AND access_token_expires_at IS NULL
      AND revision = 0)
    OR
    (kind = 'session'
      AND oauth_state_hash IS NULL
      AND pkce_verifier IS NULL
      AND return_path IS NULL
      AND redirect_uri IS NULL
      AND sealed_session IS NOT NULL
      AND provider_session_id IS NOT NULL
      AND provider_sub IS NOT NULL
      AND email IS NOT NULL
      AND access_token_expires_at IS NOT NULL
      AND claimed_at IS NULL
      AND revision >= 1)
  )
);

CREATE INDEX workos_browser_sessions_expiry_idx
  ON workos_browser_sessions (expires_at);
CREATE INDEX workos_browser_sessions_subject_idx
  ON workos_browser_sessions (provider_sub)
  WHERE kind = 'session';

ALTER TABLE workos_browser_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workos_browser_sessions_system
  ON workos_browser_sessions FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());
ALTER TABLE workos_browser_sessions FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON workos_browser_sessions TO zeros_app;
