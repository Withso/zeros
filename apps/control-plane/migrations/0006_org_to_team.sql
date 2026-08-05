-- ──────────────────────────────────────────────────────────
-- 0006 — "Organization" becomes "Team" (product decision 2026-07-25).
--
-- The tenant root was called an Organization and CONTAINED a second,
-- nested "team" grouping. That two-level model is retired: there is now
-- ONE level, and it is called a Team. So this migration does two things
-- that must happen in this order —
--
--   1. DROP the nested sub-team concept (teams, team_members, team_role,
--      invitations.team_id). It frees the `teams` / `team_members` /
--      `team_role` names, which step 2 immediately reuses for the tenant
--      root. Sub-teams were UI-gated behind "org has ≥2 members" and
--      carried no data anything else referenced (team_members was never
--      read outside its own routes; invitations.team_id only steered the
--      post-accept sub-team placement that no longer exists).
--
--   2. RENAME the tenant root onto those freed names:
--        organizations        → teams
--        organization_members → team_members
--        org_settings         → team_settings
--        org_role             → team_role
--        org_id               → team_id   (6 tables)
--      plus the indexes, the implicitly-named constraints (a table rename
--      does NOT rename them), the RLS helper, and every policy.
--
-- Renames preserve OIDs, so grants to `zeros_app` (0004) and FORCE ROW
-- LEVEL SECURITY carry over untouched. The RLS helper does not: a
-- LANGUAGE sql function body is stored as TEXT, so app_user_org_ids()
-- would still say `FROM organization_members` after the rename. It is
-- recreated, not renamed — and every policy is dropped/recreated with it,
-- because a policy that references it pins the old function.
-- ──────────────────────────────────────────────────────────

-- ── 1. Retire the nested sub-team concept ────────────────
-- Order matters: the FK column goes first, then the tables (which take
-- their own policies + indexes with them), then the now-unused enum.

ALTER TABLE invitations DROP COLUMN IF EXISTS team_id;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TYPE  IF EXISTS team_role;

-- ── 2. Rename the tenant root onto the freed names ───────

ALTER TYPE org_role RENAME TO team_role;

ALTER TABLE organizations        RENAME TO teams;
ALTER TABLE organization_members RENAME TO team_members;
ALTER TABLE org_settings         RENAME TO team_settings;

ALTER TABLE team_members          RENAME COLUMN org_id TO team_id;
ALTER TABLE invitations           RENAME COLUMN org_id TO team_id;
ALTER TABLE team_settings         RENAME COLUMN org_id TO team_id;
ALTER TABLE audit_log             RENAME COLUMN org_id TO team_id;
ALTER TABLE billing_customers     RENAME COLUMN org_id TO team_id;
ALTER TABLE billing_subscriptions RENAME COLUMN org_id TO team_id;

-- IF EXISTS for the same reason the constraint block below is guarded: these
-- names came from 0001, and a database restored from a dump that reindexed —
-- or provisioned before a given index existed — must skip, not abort. An
-- abort here is a boot crash-loop, since runMigrations() runs before serve().
ALTER INDEX IF EXISTS organization_members_user_idx RENAME TO team_members_user_idx;
ALTER INDEX IF EXISTS audit_log_org_idx             RENAME TO audit_log_team_idx;
ALTER INDEX IF EXISTS billing_subscriptions_org_idx RENAME TO billing_subscriptions_team_idx;

-- Constraint names Postgres generated inline (organizations_pkey, …).
-- They survive a table rename unchanged, so rename them explicitly.
-- Guarded per-row: a database provisioned before a given constraint
-- existed (or with a hand-picked name) skips instead of aborting.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('teams',                 'organizations_pkey',                  'teams_pkey'),
      ('teams',                 'organizations_slug_key',              'teams_slug_key'),
      ('teams',                 'organizations_created_by_fkey',       'teams_created_by_fkey'),
      ('team_members',          'organization_members_pkey',           'team_members_pkey'),
      ('team_members',          'organization_members_org_id_fkey',    'team_members_team_id_fkey'),
      ('team_members',          'organization_members_user_id_fkey',   'team_members_user_id_fkey'),
      ('invitations',           'invitations_org_id_fkey',             'invitations_team_id_fkey'),
      ('team_settings',         'org_settings_pkey',                   'team_settings_pkey'),
      ('team_settings',         'org_settings_org_id_fkey',            'team_settings_team_id_fkey'),
      ('team_settings',         'org_settings_updated_by_fkey',        'team_settings_updated_by_fkey'),
      ('billing_customers',     'billing_customers_org_id_fkey',       'billing_customers_team_id_fkey'),
      ('billing_subscriptions', 'billing_subscriptions_org_id_fkey',   'billing_subscriptions_team_id_fkey')
    ) AS t(tbl, oldname, newname)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = r.oldname AND conrelid = r.tbl::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.oldname, r.newname
      );
    END IF;
  END LOOP;
END $$;

-- ── 3. RLS helper + policies ─────────────────────────────
-- Same contract as 0002's app_user_org_ids(): SECURITY DEFINER and owned
-- by the migration role, so it bypasses RLS by ownership and a policy on
-- team_members can query team_members without recursing.

CREATE FUNCTION app_user_team_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT team_id FROM team_members WHERE user_id = app_current_user()
$$;

-- IF EXISTS: same reasoning as the index/constraint guards. Dropping is also
-- mandatory before DROP FUNCTION below — a policy referencing
-- app_user_org_ids() pins it.
DROP POLICY IF EXISTS users_rw                  ON users;
DROP POLICY IF EXISTS organizations_rw          ON teams;
DROP POLICY IF EXISTS organization_members_rw   ON team_members;
DROP POLICY IF EXISTS invitations_rw            ON invitations;
DROP POLICY IF EXISTS org_settings_rw           ON team_settings;
DROP POLICY IF EXISTS audit_log_rw              ON audit_log;
DROP POLICY IF EXISTS billing_customers_rw      ON billing_customers;
DROP POLICY IF EXISTS billing_subscriptions_rw  ON billing_subscriptions;

-- users: you see yourself + members of teams you share (for member lists).
CREATE POLICY users_rw ON users
  USING (app_is_system() OR id = app_current_user()
         OR id IN (SELECT tm.user_id FROM team_members tm
                   WHERE tm.team_id IN (SELECT app_user_team_ids())))
  WITH CHECK (app_is_system() OR id = app_current_user());

CREATE POLICY teams_rw ON teams
  USING (app_is_system() OR id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system() OR created_by = app_current_user()
              OR id IN (SELECT app_user_team_ids()));

CREATE POLICY team_members_rw ON team_members
  USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system() OR team_id IN (SELECT app_user_team_ids()));

-- invitations: team members manage them; accepting is a system-path lookup
-- (the acceptor is not a member yet — accept runs via withSystemTx).
CREATE POLICY invitations_rw ON invitations
  USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system() OR team_id IN (SELECT app_user_team_ids()));

CREATE POLICY team_settings_rw ON team_settings
  USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system() OR team_id IN (SELECT app_user_team_ids()));

CREATE POLICY audit_log_rw ON audit_log
  USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system() OR team_id IN (SELECT app_user_team_ids()));

CREATE POLICY billing_customers_rw ON billing_customers
  USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system());

CREATE POLICY billing_subscriptions_rw ON billing_subscriptions
  USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))
  WITH CHECK (app_is_system());

DROP FUNCTION app_user_org_ids();

-- ── 4. Re-key the audit trail ────────────────────────────
-- audit_log.action holds free text, so history keeps whatever string was
-- written at the time. Two rewrites, and the ORDER is load-bearing: the
-- retired sub-team actions already occupy `team.*`, so they move out of
-- the way BEFORE the tenant-root actions move in. Reversing these two
-- statements would merge two different concepts under one name.

UPDATE audit_log SET action = 'subteam.' || substring(action from 6)
 WHERE action IN ('team.created', 'team.renamed', 'team.deleted',
                  'team.member_added', 'team.member_removed');

UPDATE audit_log SET action = 'team.' || substring(action from 5)
 WHERE action LIKE 'org.%';
