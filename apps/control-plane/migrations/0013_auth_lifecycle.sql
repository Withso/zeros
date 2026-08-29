-- ──────────────────────────────────────────────────────────
-- 0013 — explicit account, identity, and provider-session lifecycle
-- ──────────────────────────────────────────────────────────
-- WorkOS proves an identity, while the stable Zeros account UUID owns product
-- data. Provider deletion therefore disables authentication without deleting
-- the product account. A later provider subject may be attached only through
-- the reviewed recovery workflow introduced in 0016.

CREATE TYPE account_auth_status AS ENUM (
  'active',
  'identity_disabled',
  'suspended',
  'deletion_pending',
  'deleted'
);

CREATE TYPE identity_lifecycle_status AS ENUM (
  'active',
  'provider_deleted',
  'superseded',
  'revoked'
);

CREATE TYPE auth_session_status AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE auth_client_kind AS ENUM (
  'unknown', 'web', 'desktop', 'ios', 'android', 'windows', 'linux'
);

ALTER TABLE users
  ADD COLUMN auth_status account_auth_status NOT NULL DEFAULT 'active',
  ADD COLUMN auth_revision bigint NOT NULL DEFAULT 1 CHECK (auth_revision > 0),
  ADD COLUMN auth_disabled_at timestamptz,
  ADD COLUMN auth_revoked_at timestamptz,
  ADD COLUMN auth_status_changed_at timestamptz NOT NULL DEFAULT now();

-- Preserve genuine Zeros product deletions. WorkOS user.deleted rows written by
-- 0011 are reclassified below so provider deletion no longer overloads the
-- product-data tombstone.
UPDATE users SET auth_status = 'deleted' WHERE deleted_at IS NOT NULL;

UPDATE users u
SET auth_status = 'identity_disabled',
    auth_disabled_at = COALESCE(u.deleted_at, lifecycle.processed_at, now()),
    auth_revoked_at = COALESCE(u.deleted_at, lifecycle.processed_at, now()),
    auth_status_changed_at = COALESCE(lifecycle.processed_at, now()),
    auth_revision = auth_revision + 1,
    deleted_at = NULL
FROM (
  SELECT user_id, max(processed_at) AS processed_at
  FROM identity_provider_events
  WHERE event_type = 'user.deleted' AND status = 'applied'
    AND user_id IS NOT NULL
  GROUP BY user_id
) lifecycle
WHERE u.id = lifecycle.user_id;

ALTER TABLE user_identities
  ADD COLUMN status identity_lifecycle_status NOT NULL DEFAULT 'active',
  ADD COLUMN email_at_link citext,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN last_provider_event_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN linked_via text NOT NULL DEFAULT 'jit' CHECK (
    linked_via IN ('jit', 'migration', 'operator_recovery')
  ),
  ADD COLUMN superseded_by_identity_id uuid;

UPDATE user_identities ui
SET email_at_link = u.email,
    email_verified_at = ui.created_at
FROM users u
WHERE u.id = ui.user_id;

ALTER TABLE user_identities ALTER COLUMN email_at_link SET NOT NULL;

UPDATE user_identities ui
SET status = 'provider_deleted',
    disabled_at = lifecycle.processed_at,
    last_provider_event_at = lifecycle.event_created_at
FROM (
  SELECT DISTINCT ON (provider_sub)
         provider_sub, processed_at, event_created_at
  FROM identity_provider_events
  WHERE provider = 'workos' AND event_type = 'user.deleted'
    AND status = 'applied'
  ORDER BY provider_sub, event_created_at DESC, event_id DESC
) lifecycle
WHERE ui.provider = 'workos'
  AND ui.provider_sub = lifecycle.provider_sub;

ALTER TABLE user_identities
  ADD CONSTRAINT user_identities_superseded_by_fkey
  FOREIGN KEY (superseded_by_identity_id)
  REFERENCES user_identities(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX one_active_identity_per_provider
  ON user_identities (user_id, provider)
  WHERE status = 'active';
CREATE INDEX user_identities_email_recovery_idx
  ON user_identities (email_at_link, provider, status);

-- Provider session metadata contains no bearer or refresh material. Revoked
-- tombstones may arrive before a client first presents the corresponding sid.
CREATE TABLE auth_sessions (
  provider                   text NOT NULL DEFAULT 'workos'
                             CHECK (provider = 'workos'),
  provider_session_id        text NOT NULL,
  provider_sub               text NOT NULL,
  user_id                    uuid REFERENCES users(id) ON DELETE SET NULL,
  client_kind                auth_client_kind NOT NULL DEFAULT 'unknown',
  status                     auth_session_status NOT NULL DEFAULT 'active',
  last_token_expires_at      timestamptz,
  provider_session_expires_at timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  last_seen_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  revocation_reason          text,
  last_provider_event_at     timestamptz,
  PRIMARY KEY (provider, provider_session_id),
  CHECK (char_length(provider_session_id) BETWEEN 1 AND 512),
  CHECK (char_length(provider_sub) BETWEEN 1 AND 512),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status <> 'active' AND revoked_at IS NOT NULL)
  ),
  CHECK (revocation_reason IS NULL OR char_length(revocation_reason) <= 128)
);
CREATE INDEX auth_sessions_user_live_idx
  ON auth_sessions (user_id, provider_session_id)
  WHERE status = 'active';
CREATE INDEX auth_sessions_subject_idx
  ON auth_sessions (provider_sub, status);

ALTER TABLE workos_browser_sessions
  ADD COLUMN account_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN account_revision bigint CHECK (
    account_revision IS NULL OR account_revision > 0
  );
CREATE INDEX workos_browser_sessions_account_idx
  ON workos_browser_sessions (account_user_id)
  WHERE kind = 'session';

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_system ON auth_sessions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions TO zeros_app;

-- 0007 intentionally narrowed users UPDATE privileges. Lifecycle transitions
-- are performed only by reviewed system paths, but those paths still execute as
-- zeros_app and therefore need these exact columns.
REVOKE UPDATE ON users FROM zeros_app;
GRANT UPDATE (
  email, display_name, avatar_url, deleted_at,
  auth_status, auth_revision, auth_disabled_at, auth_revoked_at,
  auth_status_changed_at
) ON users TO zeros_app;
