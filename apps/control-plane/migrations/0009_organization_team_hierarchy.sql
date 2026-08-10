-- ──────────────────────────────────────────────────────────
-- 0009 — Restore Organization → Team and provision Personal
-- zeros:requires-controlled-downtime
--
-- Migration 0006 flattened the tenant root into `teams`. Product ownership is
-- now explicit again:
--
--   user → Personal (undeletable, local workspaces only)
--        → Organization (local + cloud-workspace eligible)
--             → Team (exactly one default team for now)
--                  → members
--
-- Existing flat-team ids are tenant ids that may already be persisted by a
-- desktop client, invitation, billing row, GitHub installation, or audit row.
-- They therefore become ORGANIZATION ids without changing value. A new default
-- team is created below each one. The HTTP layer keeps `/v1/teams` as a legacy
-- alias for the organization resource while released desktop clients migrate.
-- ──────────────────────────────────────────────────────────

-- Every policy below pins the old SECURITY DEFINER helper. Drop those
-- dependencies before replacing the helper and moving the tenant tables.
DROP POLICY IF EXISTS users_rw                 ON users;
DROP POLICY IF EXISTS teams_rw                 ON teams;
DROP POLICY IF EXISTS team_members_rw          ON team_members;
DROP POLICY IF EXISTS invitations_rw           ON invitations;
DROP POLICY IF EXISTS team_settings_rw         ON team_settings;
DROP POLICY IF EXISTS audit_log_rw             ON audit_log;
DROP POLICY IF EXISTS billing_customers_rw     ON billing_customers;
DROP POLICY IF EXISTS billing_subscriptions_rw ON billing_subscriptions;
DROP POLICY IF EXISTS github_installations_rw  ON github_installations;
DROP POLICY IF EXISTS github_audit_log_rw       ON github_audit_log;

DROP FUNCTION app_user_team_ids();

-- The flat Team role was always the tenant-wide role. Restore its semantic
-- name before creating the narrower, child-team role below.
ALTER TYPE team_role RENAME TO organization_role;

ALTER TABLE teams        RENAME TO organizations;
ALTER TABLE team_members RENAME TO organization_members;
ALTER TABLE team_settings RENAME TO organization_settings;

ALTER TABLE organization_members  RENAME COLUMN team_id TO org_id;
ALTER TABLE invitations           RENAME COLUMN team_id TO org_id;
ALTER TABLE organization_settings RENAME COLUMN team_id TO org_id;
ALTER TABLE audit_log              RENAME COLUMN team_id TO org_id;
ALTER TABLE billing_customers      RENAME COLUMN team_id TO org_id;
ALTER TABLE billing_subscriptions  RENAME COLUMN team_id TO org_id;
ALTER TABLE github_installations   RENAME COLUMN team_id TO org_id;
ALTER TABLE github_audit_log       RENAME COLUMN team_id TO org_id;

ALTER INDEX IF EXISTS team_members_user_idx
  RENAME TO organization_members_user_idx;
ALTER INDEX IF EXISTS audit_log_team_idx
  RENAME TO audit_log_org_idx;
ALTER INDEX IF EXISTS billing_subscriptions_team_idx
  RENAME TO billing_subscriptions_org_idx;
ALTER INDEX IF EXISTS github_installations_team_unique
  RENAME TO github_installations_org_unique;
ALTER INDEX IF EXISTS github_installations_team_idx
  RENAME TO github_installations_org_idx;
ALTER INDEX IF EXISTS github_audit_team_idx
  RENAME TO github_audit_org_idx;

-- PostgreSQL does not rename implicitly-named constraints with their table or
-- column. Keep the catalog legible without making restored/hand-reindexed
-- databases crash-loop: each rename is guarded independently.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('organizations',         'teams_pkey',                         'organizations_pkey'),
      ('organizations',         'teams_slug_key',                     'organizations_slug_key'),
      ('organizations',         'teams_created_by_fkey',              'organizations_created_by_fkey'),
      ('organization_members',  'team_members_pkey',                  'organization_members_pkey'),
      ('organization_members',  'team_members_team_id_fkey',          'organization_members_org_id_fkey'),
      ('organization_members',  'team_members_user_id_fkey',          'organization_members_user_id_fkey'),
      ('invitations',           'invitations_team_id_fkey',           'invitations_org_id_fkey'),
      ('organization_settings', 'team_settings_pkey',                 'organization_settings_pkey'),
      ('organization_settings', 'team_settings_team_id_fkey',         'organization_settings_org_id_fkey'),
      ('organization_settings', 'team_settings_updated_by_fkey',      'organization_settings_updated_by_fkey'),
      ('billing_customers',     'billing_customers_team_id_fkey',     'billing_customers_org_id_fkey'),
      ('billing_subscriptions', 'billing_subscriptions_team_id_fkey', 'billing_subscriptions_org_id_fkey'),
      ('github_installations',  'github_installations_team_id_fkey',  'github_installations_org_id_fkey'),
      ('github_audit_log',      'github_audit_log_team_id_fkey',      'github_audit_log_org_id_fkey')
    ) AS t(tbl, oldname, newname)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = r.oldname AND conrelid = r.tbl::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        r.tbl, r.oldname, r.newname
      );
    END IF;
  END LOOP;
END $$;

-- Personal is a permanent tenant shell, not a collaborative organization.
-- `cloud_workspaces_allowed` is capability metadata, not a paid entitlement:
-- billing/quota checks will still run before provisioning when cloud ships.
ALTER TABLE organizations
  ADD COLUMN is_personal boolean NOT NULL DEFAULT false;
ALTER TABLE organizations
  ADD COLUMN cloud_workspaces_allowed boolean NOT NULL DEFAULT true;
ALTER TABLE organizations
  ADD CONSTRAINT personal_organizations_are_local_only
  CHECK (NOT is_personal OR NOT cloud_workspaces_allowed);

CREATE UNIQUE INDEX one_personal_organization_per_user
  ON organizations (created_by)
  WHERE is_personal AND deleted_at IS NULL;

-- Every existing and future account owns exactly one Personal organization.
-- The preferred UUID-derived slug never depends on a mutable provider name; a
-- new-row UUID suffix preserves any legacy organization that already owns that
-- cosmetic slug. Display name is provider-backed when present, else Personal.
WITH personal_candidates AS MATERIALIZED (
  SELECT
    gen_random_uuid() AS id,
    u.id AS user_id,
    COALESCE(NULLIF(btrim(u.display_name), ''), 'Personal') AS name,
    'personal-' || replace(u.id::text, '-', '') AS preferred_slug
  FROM users u
  WHERE NOT EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.created_by = u.id AND o.is_personal AND o.deleted_at IS NULL
  )
)
INSERT INTO organizations (
  id, slug, name, logo, created_by, is_personal,
  cloud_workspaces_allowed
)
SELECT
  c.id,
  CASE
    -- A valid legacy flat Team may already own the deterministic Personal
    -- slug. Preserve that organization and suffix Personal with its own new
    -- UUID; the UUID is already the row's collision-resistant primary key.
    WHEN EXISTS (
      SELECT 1 FROM organizations occupied
      WHERE occupied.slug = c.preferred_slug
    )
      THEN c.preferred_slug || '-' || replace(c.id::text, '-', '')
    ELSE c.preferred_slug
  END,
  c.name,
  NULL,
  c.user_id,
  true,
  false
FROM personal_candidates c;

INSERT INTO organization_members (org_id, user_id, role)
SELECT o.id, o.created_by, 'owner'::organization_role
FROM organizations o
WHERE o.is_personal
ON CONFLICT (org_id, user_id) DO NOTHING;

-- Child teams are real persisted entities now, even though the product exposes
-- only the default team until multi-team controls ship.
CREATE TYPE team_role AS ENUM ('maintainer', 'member');

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug       citext NOT NULL,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX teams_live_slug_unique
  ON teams (org_id, slug)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX one_live_default_team_per_organization
  ON teams (org_id)
  WHERE is_default AND deleted_at IS NULL;
CREATE INDEX teams_org_idx ON teams (org_id, created_at);

-- org_id is intentionally duplicated into the membership row so composite
-- foreign keys enforce both invariants in SQL: the team belongs to this org,
-- and a team member is already an organization member.
CREATE TABLE team_members (
  team_id    uuid NOT NULL,
  org_id     uuid NOT NULL,
  user_id    uuid NOT NULL,
  role       team_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id, org_id)
    REFERENCES teams(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id)
    REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX team_members_user_idx ON team_members (user_id);
CREATE INDEX team_members_org_idx ON team_members (org_id, user_id);

INSERT INTO teams (org_id, slug, name, is_default, created_by)
SELECT o.id, 'default', 'Default', true, o.created_by
FROM organizations o
WHERE o.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM teams t
    WHERE t.org_id = o.id AND t.is_default AND t.deleted_at IS NULL
  );

INSERT INTO team_members (team_id, org_id, user_id, role)
SELECT
  t.id,
  om.org_id,
  om.user_id,
  CASE
    WHEN om.role IN ('owner'::organization_role, 'admin'::organization_role)
      THEN 'maintainer'::team_role
    ELSE 'member'::team_role
  END
FROM organization_members om
JOIN teams t ON t.org_id = om.org_id AND t.is_default AND t.deleted_at IS NULL
ON CONFLICT (team_id, user_id) DO NOTHING;

-- Preserve the semantic audit history across both product reversals. 0006 had
-- moved the retired nested-team events to `subteam.*`; those are Team events
-- again. Move current tenant-root events out of `team.*` first so the rewrites
-- cannot collide.
UPDATE audit_log
SET action = 'organization.' || substring(action from 6)
WHERE action IN (
  'team.created', 'team.renamed', 'team.deleted', 'team.logo_updated'
);

UPDATE audit_log
SET action = 'team.' || substring(action from 9)
WHERE action LIKE 'subteam.%';

INSERT INTO audit_log (org_id, actor_id, action, subject)
SELECT o.id, o.created_by, 'organization.personal_created', '{}'::jsonb
FROM organizations o
WHERE o.is_personal
  AND NOT EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.org_id = o.id AND a.action = 'organization.personal_created'
  );

-- RLS helper: SECURITY DEFINER avoids the recursion trap when the policy on
-- organization_members needs to read organization_members itself.
CREATE FUNCTION app_user_org_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT om.org_id
  FROM organization_members om
  JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL
  WHERE om.user_id = app_current_user()
$$;

CREATE POLICY users_rw ON users
  USING (
    app_is_system()
    OR id = app_current_user()
    OR id IN (
      SELECT om.user_id FROM organization_members om
      WHERE om.org_id IN (SELECT app_user_org_ids())
    )
  )
  WITH CHECK (app_is_system() OR id = app_current_user());

CREATE POLICY organizations_rw ON organizations
  USING (app_is_system() OR id IN (SELECT app_user_org_ids()))
  WITH CHECK (
    app_is_system()
    OR created_by = app_current_user()
    OR id IN (SELECT app_user_org_ids())
  );

CREATE POLICY organization_members_rw ON organization_members
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_rw ON teams
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_members_rw ON team_members
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY invitations_rw ON invitations
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY organization_settings_rw ON organization_settings
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY audit_log_rw ON audit_log
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY billing_customers_rw ON billing_customers
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system());

CREATE POLICY billing_subscriptions_rw ON billing_subscriptions
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system());

CREATE POLICY github_installations_rw ON github_installations
  USING (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR org_id IN (SELECT app_user_org_ids())
  )
  WITH CHECK (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR org_id IN (SELECT app_user_org_ids())
  );

CREATE POLICY github_audit_log_rw ON github_audit_log
  USING (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR org_id IN (SELECT app_user_org_ids())
  )
  WITH CHECK (
    app_is_system()
    OR owner_user_id = app_current_user()
    OR org_id IN (SELECT app_user_org_ids())
  );

ALTER TABLE organizations         FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
ALTER TABLE teams                 FORCE ROW LEVEL SECURITY;
ALTER TABLE team_members          FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO zeros_app;
