-- ──────────────────────────────────────────────────────────
-- 0015 — durable, revision-based authorization invalidation
-- ──────────────────────────────────────────────────────────
-- Clients use these rows to invalidate UI state promptly. They are not the
-- authorization boundary: every protected operation still reads current
-- account/session/membership state. pg_notify is a wake-up only; replay always
-- comes from this table.

CREATE TYPE security_event_kind AS ENUM (
  'account.revoked',
  'account.authorization_changed',
  'session.revoked',
  'organization.access_revoked',
  'organization.authorization_changed',
  'organization.data_changed'
);

CREATE TABLE security_events (
  sequence               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  kind                   security_event_kind NOT NULL,
  user_id                uuid REFERENCES users(id) ON DELETE CASCADE,
  org_id                 uuid REFERENCES organizations(id) ON DELETE CASCADE,
  provider_session_id    text,
  account_revision       bigint,
  authorization_revision bigint,
  data_revision          bigint,
  payload                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096
  ),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL DEFAULT now() + interval '30 days',
  CHECK (user_id IS NOT NULL OR org_id IS NOT NULL OR provider_session_id IS NOT NULL),
  CHECK (provider_session_id IS NULL OR char_length(provider_session_id) <= 512),
  CHECK (account_revision IS NULL OR account_revision > 0),
  CHECK (authorization_revision IS NULL OR authorization_revision > 0),
  CHECK (data_revision IS NULL OR data_revision > 0),
  CHECK (expires_at > created_at)
);
CREATE INDEX security_events_user_cursor_idx
  ON security_events (user_id, sequence) WHERE user_id IS NOT NULL;
CREATE INDEX security_events_org_cursor_idx
  ON security_events (org_id, sequence) WHERE org_id IS NOT NULL;
CREATE INDEX security_events_session_cursor_idx
  ON security_events (provider_session_id, sequence)
  WHERE provider_session_id IS NOT NULL;
CREATE INDEX security_events_expiry_idx ON security_events (expires_at);

CREATE FUNCTION notify_security_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('zeros_security_event', NEW.sequence::text);
  RETURN NEW;
END
$$;
CREATE TRIGGER security_events_notify_after_insert
  AFTER INSERT ON security_events
  FOR EACH ROW EXECUTE FUNCTION notify_security_event();

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_events_system ON security_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON security_events TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE security_events_sequence_seq TO zeros_app;

-- Bind short-lived cloud capabilities to the exact account and membership
-- revisions that authorized issuance. Existing grants are backfilled before
-- the columns become mandatory.
ALTER TABLE cloud_workspace_endpoint_grants
  ADD COLUMN account_revision bigint,
  ADD COLUMN authorization_revision bigint;

UPDATE cloud_workspace_endpoint_grants grant_row
SET account_revision = u.auth_revision,
    authorization_revision = om.authorization_revision
FROM users u, organization_members om
WHERE u.id = grant_row.account_user_id
  AND om.org_id = grant_row.org_id
  AND om.user_id = grant_row.account_user_id;

-- Any historical orphan that cannot be bound safely is revoked rather than
-- being grandfathered into the new authorization contract.
UPDATE cloud_workspace_endpoint_grants
SET revoked_at = COALESCE(revoked_at, now()),
    account_revision = COALESCE(account_revision, 1),
    authorization_revision = COALESCE(authorization_revision, 1)
WHERE account_revision IS NULL OR authorization_revision IS NULL;

ALTER TABLE cloud_workspace_endpoint_grants
  ALTER COLUMN account_revision SET NOT NULL,
  ALTER COLUMN authorization_revision SET NOT NULL,
  ADD CONSTRAINT cloud_workspace_grant_account_revision_positive
    CHECK (account_revision > 0),
  ADD CONSTRAINT cloud_workspace_grant_authorization_revision_positive
    CHECK (authorization_revision > 0);
