-- ──────────────────────────────────────────────────────────
-- 0008 — GitHub App authorization and installation metadata
--
-- GitHub user/refresh tokens are never durable account data in Postgres.
-- They cross github_oauth_handoffs only for the browser→desktop handoff and
-- expire after 60 seconds; the desktop moves the pair into safeStorage. They
-- are stored sealed under a key derived from the client nonce, which this
-- database never holds, so backups and WAL archives carry no usable token.
-- OAuth state and PKCE verifiers expire after 10 minutes and are single-use.
--
-- An installation may be visible to several independently-authorized users,
-- so its GitHub id is not globally unique in this table. Each personal/team
-- owner gets an RLS-isolated metadata row. Team ownership is reserved for a
-- later sharing flow; Phase 2 creates personal rows only.
-- ──────────────────────────────────────────────────────────

CREATE TABLE github_oauth_states (
  state_hash       bytea PRIMARY KEY,
  owner_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_nonce     text NOT NULL,
  scheme           text NOT NULL,
  app_variant      text NOT NULL,
  flow_kind        text NOT NULL CHECK (flow_kind IN ('oauth', 'install')),
  pkce_verifier    text,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (scheme IN ('zeros', 'zeros-alpha', 'zeros-beta', 'zeros-dev')),
  CHECK (
    (flow_kind = 'oauth' AND pkce_verifier IS NOT NULL)
    OR (flow_kind = 'install' AND pkce_verifier IS NULL)
  )
);
CREATE INDEX github_oauth_states_expiry_idx
  ON github_oauth_states (expires_at);
CREATE UNIQUE INDEX github_oauth_states_owner_nonce_idx
  ON github_oauth_states (owner_user_id, client_nonce);

-- Keyed per owner, not globally: `nonce` is caller-supplied and validated for
-- shape only, so a global primary key let any authenticated user squat a fixed
-- value and make every other user's handoff insert fail.
CREATE TABLE github_oauth_handoffs (
  nonce_hash                bytea NOT NULL,
  owner_user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_variant               text NOT NULL,
  -- AES-256-GCM, keyed by HKDF over the client nonce. Only nonce_hash is
  -- stored, so these bytes are undecryptable from this database alone — a WAL
  -- segment, PITR window, or nightly pg_dump cannot yield a live GitHub token
  -- even though the plaintext row itself would have expired in 60 seconds.
  access_token_sealed       bytea NOT NULL,
  access_token_expires_at   timestamptz NOT NULL,
  refresh_token_sealed      bytea NOT NULL,
  refresh_token_expires_at  timestamptz NOT NULL,
  login                     text NOT NULL,
  installations             jsonb NOT NULL DEFAULT '[]'::jsonb,
  installations_complete    boolean NOT NULL,
  expires_at                timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, nonce_hash)
);
CREATE INDEX github_oauth_handoffs_expiry_idx
  ON github_oauth_handoffs (expires_at);

-- Non-secret binding between one Auth0 owner and the GitHub login they
-- authorized. Live refresh/revoke requests verify the supplied GitHub token
-- resolves to this login before mutating installation metadata or grants.
CREATE TABLE github_authorizations (
  owner_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_variant      text NOT NULL,
  github_login     text NOT NULL,
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, app_variant)
);

CREATE TABLE github_installations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_installation_id bigint NOT NULL CHECK (github_installation_id > 0),
  app_variant           text NOT NULL,
  owner_user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  team_id               uuid REFERENCES teams(id) ON DELETE CASCADE,
  account_login         text NOT NULL,
  account_type          text NOT NULL CHECK (account_type IN ('User', 'Organization')),
  target_type           text NOT NULL,
  repository_count      integer CHECK (repository_count IS NULL OR repository_count >= 0),
  all_repositories      boolean NOT NULL DEFAULT false,
  suspended_at          timestamptz,
  github_created_at     timestamptz,
  last_verified_at      timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (team_id IS NULL))
);
CREATE UNIQUE INDEX github_installations_personal_unique
  ON github_installations (app_variant, github_installation_id, owner_user_id)
  WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX github_installations_team_unique
  ON github_installations (app_variant, github_installation_id, team_id)
  WHERE team_id IS NOT NULL;
CREATE INDEX github_installations_owner_idx
  ON github_installations (owner_user_id, last_verified_at DESC);
CREATE INDEX github_installations_team_idx
  ON github_installations (team_id, last_verified_at DESC);

-- (No per-repository table yet. One was drafted here, but nothing reads or
-- writes it; a forward-only ladder should not carry schema without a reader.
-- The repository picker that needs it can add it in its own migration.)

-- Personal GitHub actions need an append-only trail even when the user belongs
-- to no Team. Keeping this separate avoids weakening audit_log.team_id's
-- existing NOT NULL invariant. Both owner columns CASCADE: the CHECK below
-- requires exactly one of them, so SET NULL would violate it, and an erasure
-- request must not be blocked by an audit row.
CREATE TABLE github_audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  team_id        uuid REFERENCES teams(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  action         text NOT NULL,
  subject        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (team_id IS NULL))
);
CREATE INDEX github_audit_owner_idx
  ON github_audit_log (owner_user_id, created_at DESC);
CREATE INDEX github_audit_team_idx
  ON github_audit_log (team_id, created_at DESC);

ALTER TABLE github_oauth_states       ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_oauth_handoffs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_authorizations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_audit_log          ENABLE ROW LEVEL SECURITY;

CREATE POLICY github_oauth_states_rw ON github_oauth_states
  USING (app_is_system() OR owner_user_id = app_current_user())
  WITH CHECK (app_is_system() OR owner_user_id = app_current_user());

CREATE POLICY github_oauth_handoffs_rw ON github_oauth_handoffs
  USING (app_is_system() OR owner_user_id = app_current_user())
  WITH CHECK (app_is_system() OR owner_user_id = app_current_user());

CREATE POLICY github_authorizations_rw ON github_authorizations
  USING (app_is_system() OR owner_user_id = app_current_user())
  WITH CHECK (app_is_system() OR owner_user_id = app_current_user());

CREATE POLICY github_installations_rw ON github_installations
  USING (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR team_id IN (SELECT app_user_team_ids())
  )
  WITH CHECK (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR team_id IN (SELECT app_user_team_ids())
  );

CREATE POLICY github_audit_log_rw ON github_audit_log
  USING (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR team_id IN (SELECT app_user_team_ids())
  )
  WITH CHECK (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR team_id IN (SELECT app_user_team_ids())
  );

ALTER TABLE github_oauth_states   FORCE ROW LEVEL SECURITY;
ALTER TABLE github_oauth_handoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE github_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE github_installations  FORCE ROW LEVEL SECURITY;
ALTER TABLE github_audit_log      FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON github_oauth_states, github_oauth_handoffs, github_authorizations,
     github_installations, github_audit_log
  TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE github_audit_log_id_seq TO zeros_app;
