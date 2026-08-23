-- ──────────────────────────────────────────────────────────
-- 0011 — authenticated WorkOS user lifecycle event ledger
-- ──────────────────────────────────────────────────────────
-- The Cloudflare auth broker verifies WorkOS's webhook signature, then sends
-- only user.updated/user.deleted through a separate per-channel credential.
-- This table makes delivery idempotent and retains collisions/unlinked events
-- for operator-assisted recovery without storing a raw provider payload.

CREATE TABLE identity_provider_events (
  event_id          text PRIMARY KEY,
  provider          text NOT NULL DEFAULT 'workos' CHECK (provider = 'workos'),
  event_type        text NOT NULL CHECK (event_type IN ('user.updated', 'user.deleted')),
  event_created_at  timestamptz NOT NULL,
  provider_sub      text NOT NULL,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  email             citext NOT NULL,
  email_verified    boolean NOT NULL,
  display_name      text,
  avatar_url        text,
  status            text NOT NULL CHECK (status IN (
                      'received', 'applied', 'unlinked', 'email_conflict',
                      'ignored_unverified', 'ignored_deleted', 'stale'
                    )),
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  CHECK (char_length(event_id) BETWEEN 1 AND 512),
  CHECK (char_length(provider_sub) BETWEEN 1 AND 512),
  CHECK (char_length(email::text) BETWEEN 3 AND 254),
  CHECK (display_name IS NULL OR char_length(display_name) <= 500),
  CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048),
  CHECK (
    (status = 'received' AND processed_at IS NULL)
    OR (status <> 'received' AND processed_at IS NOT NULL)
  )
);

CREATE INDEX identity_provider_events_subject_idx
  ON identity_provider_events (provider, provider_sub, event_created_at DESC);
CREATE INDEX identity_provider_events_recovery_idx
  ON identity_provider_events (status, received_at DESC)
  WHERE status IN ('unlinked', 'email_conflict');

ALTER TABLE identity_provider_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_provider_events_system
  ON identity_provider_events FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());
ALTER TABLE identity_provider_events FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON identity_provider_events TO zeros_app;
