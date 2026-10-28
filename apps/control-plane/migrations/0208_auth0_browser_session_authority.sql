-- zeros-migration: expand
-- Auth0 compatibility session authority. KV remains a cache for unrelated
-- web state, never the source of truth for session refresh or revocation.
CREATE TABLE auth0_browser_sessions (
  credential_hash bytea PRIMARY KEY CHECK (octet_length(credential_hash) = 32),
  sealed_data text,
  provider_sub text NOT NULL CHECK (char_length(provider_sub) BETWEEN 1 AND 512),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at timestamptz NOT NULL,
  refresh_lease_hash bytea CHECK (refresh_lease_hash IS NULL OR octet_length(refresh_lease_hash) = 32),
  refresh_deadline_at timestamptz,
  revoked_at timestamptz,
  browser_revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((refresh_lease_hash IS NULL) = (refresh_deadline_at IS NULL)),
  CHECK (sealed_data IS NULL OR char_length(sealed_data) <= 262144),
  CHECK (revoked_at IS NULL OR sealed_data IS NULL)
);
CREATE INDEX auth0_browser_sessions_expiry_idx ON auth0_browser_sessions(expires_at);
CREATE INDEX auth0_browser_sessions_subject_idx ON auth0_browser_sessions(provider_sub) WHERE revoked_at IS NULL;
ALTER TABLE auth0_browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth0_browser_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth0_browser_sessions_system ON auth0_browser_sessions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON auth0_browser_sessions TO zeros_app;

CREATE TABLE auth0_desktop_sessions (
  credential_hash bytea PRIMARY KEY CHECK (octet_length(credential_hash) = 32),
  source_hash bytea NOT NULL REFERENCES auth0_browser_sessions(credential_hash),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX auth0_desktop_sessions_source_idx ON auth0_desktop_sessions(source_hash);
CREATE TABLE auth0_handoff_tickets (
  ticket_hash bytea PRIMARY KEY CHECK (octet_length(ticket_hash) = 32),
  source_hash bytea NOT NULL REFERENCES auth0_browser_sessions(credential_hash),
  challenge text NOT NULL CHECK (char_length(challenge) = 43),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth0_handoff_tickets_source_idx ON auth0_handoff_tickets(source_hash);
ALTER TABLE auth0_desktop_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth0_desktop_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth0_desktop_sessions_system ON auth0_desktop_sessions FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE auth0_handoff_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth0_handoff_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY auth0_handoff_tickets_system ON auth0_handoff_tickets FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON auth0_desktop_sessions, auth0_handoff_tickets TO zeros_app;

CREATE TABLE auth0_session_revocations (
  provider_sub text PRIMARY KEY CHECK (char_length(provider_sub) BETWEEN 1 AND 512),
  revoked_before timestamptz NOT NULL
);
ALTER TABLE auth0_session_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth0_session_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY auth0_session_revocations_system ON auth0_session_revocations FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON auth0_session_revocations TO zeros_app;
