-- ──────────────────────────────────────────────────────────
-- 0004 — Activate RLS as a real second lock.
--
-- 0002 defined the policies but they were dormant: the service connects
-- as Railway's `postgres` superuser, which BYPASSES RLS entirely (a
-- superuser is never subject to row policies, and a table owner bypasses
-- non-FORCEd RLS). So the policies were dead code and app-layer authz.ts
-- was the only lock.
--
-- This migration flips them on WITHOUT changing the Railway credential:
--   1. Create a NOLOGIN, NOBYPASSRLS `zeros_app` role that owns nothing.
--   2. db.ts now runs every request transaction under `SET LOCAL ROLE
--      zeros_app` — so the CURRENT role is non-superuser + non-owner and
--      RLS is enforced, even though the session still connects as postgres.
--      (SET LOCAL is transaction-scoped; the pooled connection reverts on
--      COMMIT/ROLLBACK, so nothing leaks across requests.)
--   3. FORCE ROW LEVEL SECURITY so RLS also binds a table's OWNER — belt
--      and suspenders if the connection role ever becomes a non-superuser
--      owner. (Superuser still bypasses; the real enforcement is #2.)
--
-- Migrations themselves keep running as postgres (runMigrations uses the
-- pool directly, not the tx helpers), so DDL is unaffected.
-- ──────────────────────────────────────────────────────────

-- 1. The unprivileged request role. Guarded so a manual pre-create or a
--    shared-cluster reuse doesn't abort the migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zeros_app') THEN
    CREATE ROLE zeros_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- 2. Exactly the DML the request paths need — no DDL, no superuser.
GRANT USAGE ON SCHEMA public TO zeros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zeros_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zeros_app;

-- Future tables/sequences created by the migration owner inherit the grants,
-- so a later migration doesn't silently lock zeros_app out of a new table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zeros_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO zeros_app;

-- Let the connecting role SET ROLE zeros_app. A superuser can do this
-- without membership, but granting it keeps the switch working if the
-- deploy ever moves to a non-superuser owner.
GRANT zeros_app TO CURRENT_USER;

-- 3. user_identities (added in 0003) never got RLS. Close the gap: a user
--    sees only their OWN identity rows; system paths (signup) see all.
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_identities_rw ON user_identities
  USING (app_is_system() OR user_id = app_current_user())
  WITH CHECK (app_is_system() OR user_id = app_current_user());

-- 4. FORCE on every RLS table (the 0002 set + user_identities).
ALTER TABLE users                 FORCE ROW LEVEL SECURITY;
ALTER TABLE user_identities        FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations         FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_members  FORCE ROW LEVEL SECURITY;
ALTER TABLE teams                 FORCE ROW LEVEL SECURITY;
ALTER TABLE team_members          FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations           FORCE ROW LEVEL SECURITY;
ALTER TABLE org_settings          FORCE ROW LEVEL SECURITY;
ALTER TABLE org_secrets           FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log             FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_customers     FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;
