-- ──────────────────────────────────────────────────────────
-- 0017 — Separate support recovery authority from developer access
-- ──────────────────────────────────────────────────────────
--
-- `developer` gates local/internal engineering surfaces. Account recovery is
-- a different trust domain: it can transfer a stable Zeros account to a new
-- WorkOS subject, so it requires the exact `support_admin` role. Staff roles
-- are intentionally not ranked and neither role implies the other.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'support_admin';

-- Owner-only, append-only operational evidence for the bootstrap command.
-- The application role receives no privileges on this table or its sequence;
-- only the database/migration owner can grant or revoke staff authority.
CREATE TABLE staff_role_changes (
  id                   bigserial PRIMARY KEY,
  subject_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_role        staff_role,
  next_role            staff_role,
  account_revision     bigint NOT NULL CHECK (account_revision > 0),
  deployment_channel   text NOT NULL CHECK (
    deployment_channel IN ('development', 'alpha', 'beta', 'production')
  ),
  target_fingerprint   text NOT NULL CHECK (
    target_fingerprint ~ '^[a-f0-9]{16}$'
  ),
  database_principal   text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  reason               text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_role IS DISTINCT FROM next_role)
);

CREATE INDEX staff_role_changes_subject_idx
  ON staff_role_changes (subject_user_id, created_at DESC);

CREATE FUNCTION reject_staff_role_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'staff_role_changes is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER staff_role_changes_append_only
  BEFORE UPDATE OR DELETE ON staff_role_changes
  FOR EACH ROW EXECUTE FUNCTION reject_staff_role_change_mutation();

CREATE TRIGGER staff_role_changes_no_truncate
  BEFORE TRUNCATE ON staff_role_changes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_staff_role_change_mutation();

REVOKE ALL ON staff_role_changes FROM zeros_app;
REVOKE ALL ON SEQUENCE staff_role_changes_id_seq FROM zeros_app;
REVOKE ALL ON FUNCTION reject_staff_role_change_mutation() FROM PUBLIC;
