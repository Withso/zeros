-- ──────────────────────────────────────────────────────────
-- 0002 — Row-Level Security: the second lock.
--
-- Model: the request middleware binds `app.user_id` per transaction
-- (db.ts withUserTx); system paths (JIT signup, webhooks) set
-- `app.system = on`. Policies key on those GUCs.
--
-- ACTIVATION: policies bind fully once the service connects as the
-- non-owner `zeros_app` role (table owners bypass non-FORCEd RLS, and
-- Railway's default user owns these tables). Until that switch, the
-- app-layer role checks in authz.ts are the enforcement — RLS here is
-- staged, not load-bearing. See backend/README.md § "RLS activation".
-- The recursion trap (a policy on organization_members querying
-- organization_members) is avoided with SECURITY DEFINER helpers owned
-- by the migration role, which bypass RLS by ownership.
-- ──────────────────────────────────────────────────────────

CREATE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.system', true) = 'on'
$$;

-- Owned by the migration role → bypasses RLS → no policy recursion.
CREATE FUNCTION app_user_org_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM organization_members WHERE user_id = app_current_user()
$$;

ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_secrets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;

-- users: you see yourself + members of orgs you share (for member lists).
CREATE POLICY users_rw ON users
  USING (app_is_system() OR id = app_current_user()
         OR id IN (SELECT om.user_id FROM organization_members om
                   WHERE om.org_id IN (SELECT app_user_org_ids())))
  WITH CHECK (app_is_system() OR id = app_current_user());

CREATE POLICY organizations_rw ON organizations
  USING (app_is_system() OR id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR created_by = app_current_user()
              OR id IN (SELECT app_user_org_ids()));

CREATE POLICY organization_members_rw ON organization_members
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY teams_rw ON teams
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY team_members_rw ON team_members
  USING (app_is_system() OR team_id IN
          (SELECT t.id FROM teams t WHERE t.org_id IN (SELECT app_user_org_ids())))
  WITH CHECK (app_is_system() OR team_id IN
          (SELECT t.id FROM teams t WHERE t.org_id IN (SELECT app_user_org_ids())));

-- invitations: org members manage them; accepting is a system-path lookup
-- (the acceptor is not a member yet — accept runs via withSystemTx).
CREATE POLICY invitations_rw ON invitations
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY org_settings_rw ON org_settings
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()))
  WITH CHECK (app_is_system() OR org_id IN (SELECT app_user_org_ids()));

CREATE POLICY org_secrets_rw ON org_secrets
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
