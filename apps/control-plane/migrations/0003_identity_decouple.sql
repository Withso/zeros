-- ──────────────────────────────────────────────────────────
-- 0003 — Decouple users.id from any single IdP's `sub` format
-- (Supabase → Auth0 swap; docs/orgs-and-teams.md Part C update).
--
-- users.id stays an internally-generated uuid — never again equal to
-- whatever the current auth provider calls `sub`. user_identities maps
-- (provider, provider_sub) -> users.id, so a future provider swap is a
-- new row shape here, not a schema change touching the 6 FK'd tables.
-- ──────────────────────────────────────────────────────────

CREATE TABLE user_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  provider_sub  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_sub)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid();
