-- ──────────────────────────────────────────────────────────
-- 0016 — reviewed account recovery and security notifications
-- ──────────────────────────────────────────────────────────
-- A newly-created WorkOS subject is never linked to an existing Zeros account
-- by email alone. A fresh verified authentication can open a bounded request;
-- a freshly reauthenticated staff operator must approve the atomic identity
-- replacement. Collaborative memberships are intentionally not restored.

CREATE TYPE account_recovery_state AS ENUM (
  'pending', 'approved', 'consumed', 'rejected', 'expired'
);
CREATE TYPE security_notification_state AS ENUM (
  'queued', 'sending', 'sent', 'dead'
);

CREATE TABLE account_recovery_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code           text NOT NULL UNIQUE CHECK (
    public_code ~ '^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$'
  ),
  provider              text NOT NULL DEFAULT 'workos' CHECK (provider = 'workos'),
  candidate_provider_sub text NOT NULL,
  candidate_session_id  text NOT NULL,
  candidate_email       citext NOT NULL,
  candidate_auth_time   timestamptz NOT NULL,
  target_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_identity_id    uuid NOT NULL REFERENCES user_identities(id) ON DELETE CASCADE,
  state                 account_recovery_state NOT NULL DEFAULT 'pending',
  proof_type            text NOT NULL DEFAULT 'workos_reauthentication' CHECK (
    proof_type = 'workos_reauthentication'
  ),
  attempt_count         integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  reviewed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           timestamptz,
  consumed_at           timestamptz,
  rejection_reason      text,
  CHECK (char_length(candidate_provider_sub) BETWEEN 1 AND 512),
  CHECK (char_length(candidate_session_id) BETWEEN 1 AND 512),
  CHECK (char_length(candidate_email::text) BETWEEN 3 AND 254),
  CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  CHECK (expires_at > requested_at),
  CHECK (
    (state = 'pending' AND reviewed_at IS NULL AND consumed_at IS NULL)
    OR (state IN ('approved', 'rejected', 'expired')
        AND reviewed_at IS NOT NULL AND consumed_at IS NULL)
    OR (state = 'consumed' AND reviewed_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX one_pending_recovery_per_candidate
  ON account_recovery_requests (candidate_provider_sub)
  WHERE state = 'pending';
CREATE INDEX account_recovery_target_idx
  ON account_recovery_requests (target_user_id, requested_at DESC);
CREATE INDEX account_recovery_expiry_idx
  ON account_recovery_requests (expires_at)
  WHERE state = 'pending';

CREATE TABLE security_notification_outbox (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  destination_email     citext NOT NULL,
  template              text NOT NULL CHECK (template IN (
    'account_identity_disabled', 'account_recovered',
    'sessions_revoked', 'organization_access_revoked'
  )),
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096
  ),
  state                 security_notification_state NOT NULL DEFAULT 'queued',
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner           text,
  lease_expires_at      timestamptz,
  last_error_code       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  CHECK (char_length(destination_email::text) BETWEEN 3 AND 254),
  CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 255),
  CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 128),
  CHECK (
    (state = 'sending' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'sending' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state = 'sent' AND sent_at IS NOT NULL)
    OR (state <> 'sent' AND sent_at IS NULL)
  )
);
CREATE INDEX security_notification_claim_idx
  ON security_notification_outbox (next_attempt_at, created_at, id)
  WHERE state IN ('queued', 'sending');

ALTER TABLE account_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_notification_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_recovery_requests_system
  ON account_recovery_requests FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY security_notification_outbox_system
  ON security_notification_outbox FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE account_recovery_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE security_notification_outbox FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  account_recovery_requests, security_notification_outbox
TO zeros_app;
