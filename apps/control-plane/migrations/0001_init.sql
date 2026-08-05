-- ──────────────────────────────────────────────────────────
-- 0001 — Orgs & Teams core schema (docs/orgs-and-teams.md Part D)
-- Shared-schema multi-tenancy: org_id on every tenant-owned row.
-- ──────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid on older PG

-- Identity mirror (JIT-provisioned from verified Supabase JWTs)
CREATE TABLE users (
  id           uuid PRIMARY KEY,           -- = Supabase auth user id (JWT `sub`)
  email        citext NOT NULL UNIQUE,
  display_name text,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz                 -- soft delete; row keeps FK integrity
);

-- Tenant root: the billing + policy + record anchor
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        citext NOT NULL UNIQUE,      -- url-safe; id is the identity, slug can change
  name        text   NOT NULL,
  is_personal boolean NOT NULL DEFAULT false,
  created_by  uuid   NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
-- Exactly one live personal org per user (the auto-created one).
CREATE UNIQUE INDEX one_personal_org_per_user
  ON organizations (created_by) WHERE is_personal AND deleted_at IS NULL;

CREATE TYPE org_role AS ENUM ('owner','admin','member');  -- 'billing','guest' later

CREATE TABLE organization_members (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  role       org_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,   -- the "Personal" team; undeletable
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE UNIQUE INDEX one_default_team_per_org ON teams (org_id) WHERE is_default;

CREATE TYPE team_role AS ENUM ('maintainer','member');

CREATE TABLE team_members (
  team_id    uuid NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role       team_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

-- Invitations: the raw token is NEVER stored — only its SHA-256.
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        org_role NOT NULL DEFAULT 'member',
  team_id     uuid REFERENCES teams(id) ON DELETE SET NULL,
  token_hash  bytea NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_invite
  ON invitations (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Org settings layer (engine resolve chain: user < ORG < repo < local < managed)
CREATE TABLE org_settings (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope      text NOT NULL DEFAULT '*',   -- '*' = org-wide, or a repo slug
  doc        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope)
);

-- Secrets vault: ciphertext only (envelope encryption; master key lives in the
-- backend service env, never in this database). Values are write-only via API.
CREATE TABLE org_secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT '*',
  name        text NOT NULL,
  ciphertext  bytea NOT NULL,
  key_version int  NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, scope, name)
);

-- Append-only audit trail
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     uuid NOT NULL,
  actor_id   uuid,                          -- null = system
  action     text NOT NULL,                 -- 'org.created', 'member.invited', …
  subject    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, created_at DESC);

-- Billing mirror (Stripe webhooks write; the app reads entitlements here only)
CREATE TABLE billing_customers (
  org_id             uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE
);
CREATE TABLE billing_subscriptions (
  id                 text PRIMARY KEY,      -- Stripe subscription id
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status             text NOT NULL,
  plan               text NOT NULL,
  seats              int  NOT NULL DEFAULT 1,
  current_period_end timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_subscriptions_org_idx ON billing_subscriptions (org_id);
