-- ──────────────────────────────────────────────────────────
-- 0014 — WorkOS collaborative-organization projection and durable commands
-- ──────────────────────────────────────────────────────────
-- Personal remains Railway-only. Every collaborative Zeros organization is
-- correlated to WorkOS by the stable Zeros UUID as WorkOS external_id. WorkOS
-- membership events are mirrored separately before they become enforceable
-- organization_members rows, which permits pre-provisioned SCIM users whose
-- first Zeros login has not happened yet.

CREATE TYPE workos_sync_state AS ENUM (
  'provisioning', 'active', 'conflict', 'deleting', 'deleted'
);
CREATE TYPE workos_membership_state AS ENUM (
  'pending', 'active', 'inactive', 'deleted', 'quarantined'
);
CREATE TYPE workos_command_state AS ENUM (
  'queued', 'processing', 'succeeded', 'failed', 'dead'
);
CREATE TYPE workos_event_state AS ENUM (
  'received', 'applied', 'ignored', 'quarantined', 'dead'
);

ALTER TABLE organizations
  ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 1
    CHECK (authorization_revision > 0),
  ADD COLUMN data_revision bigint NOT NULL DEFAULT 1
    CHECK (data_revision > 0),
  ADD COLUMN workos_sync_revision bigint NOT NULL DEFAULT 1
    CHECK (workos_sync_revision > 0);

ALTER TABLE organization_members
  ADD COLUMN workos_membership_id text,
  ADD COLUMN membership_source text NOT NULL DEFAULT 'zeros' CHECK (
    membership_source IN ('zeros', 'workos', 'sso', 'scim', 'migration')
  ),
  ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 1
    CHECK (authorization_revision > 0),
  ADD COLUMN workos_sync_revision bigint NOT NULL DEFAULT 1
    CHECK (workos_sync_revision > 0);
CREATE UNIQUE INDEX organization_members_workos_membership_unique
  ON organization_members (workos_membership_id)
  WHERE workos_membership_id IS NOT NULL;

CREATE TABLE workos_organization_links (
  organization_id       uuid PRIMARY KEY
                        REFERENCES organizations(id) ON DELETE CASCADE,
  workos_organization_id text UNIQUE,
  external_id           text NOT NULL UNIQUE,
  state                 workos_sync_state NOT NULL DEFAULT 'provisioning',
  last_provider_event_at timestamptz,
  last_error_code       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (external_id = organization_id::text),
  CHECK (
    workos_organization_id IS NULL
    OR char_length(workos_organization_id) BETWEEN 1 AND 512
  ),
  CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 128)
);

CREATE FUNCTION reject_personal_workos_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM organizations
    WHERE id = NEW.organization_id AND is_personal
  ) THEN
    RAISE EXCEPTION 'Personal organizations cannot be linked to WorkOS';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workos_links_collaborative_only
  BEFORE INSERT OR UPDATE ON workos_organization_links
  FOR EACH ROW EXECUTE FUNCTION reject_personal_workos_link();

CREATE TABLE workos_membership_projections (
  workos_membership_id   text PRIMARY KEY,
  workos_organization_id text NOT NULL,
  workos_user_id         text NOT NULL,
  organization_id       uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  status                workos_membership_state NOT NULL,
  role                  text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  directory_managed     boolean NOT NULL DEFAULT false,
  last_provider_event_at timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(workos_membership_id) BETWEEN 1 AND 512),
  CHECK (char_length(workos_organization_id) BETWEEN 1 AND 512),
  CHECK (char_length(workos_user_id) BETWEEN 1 AND 512)
);
CREATE INDEX workos_membership_projection_org_idx
  ON workos_membership_projections (workos_organization_id, status);
CREATE INDEX workos_membership_projection_user_idx
  ON workos_membership_projections (workos_user_id, status);

CREATE TABLE workos_event_inbox (
  event_id              text PRIMARY KEY,
  event_type            text NOT NULL CHECK (event_type IN (
    'user.created', 'user.updated', 'user.deleted',
    'session.created', 'session.revoked',
    'organization.created', 'organization.updated', 'organization.deleted',
    'organization_membership.created',
    'organization_membership.updated',
    'organization_membership.deleted',
    'invitation.created', 'invitation.accepted', 'invitation.revoked',
    'invitation.resent'
  )),
  event_created_at      timestamptz NOT NULL,
  source                text NOT NULL CHECK (source IN ('webhook', 'events_api')),
  object_id             text,
  workos_organization_id text,
  workos_user_id        text,
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 65536
  ),
  state                 workos_event_state NOT NULL DEFAULT 'received',
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code       text,
  received_at           timestamptz NOT NULL DEFAULT now(),
  processed_at          timestamptz,
  CHECK (char_length(event_id) BETWEEN 1 AND 512),
  CHECK (object_id IS NULL OR char_length(object_id) <= 512),
  CHECK (
    workos_organization_id IS NULL
    OR char_length(workos_organization_id) <= 512
  ),
  CHECK (workos_user_id IS NULL OR char_length(workos_user_id) <= 512),
  CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 128),
  CHECK (
    (state = 'received' AND processed_at IS NULL)
    OR (state <> 'received' AND processed_at IS NOT NULL)
  )
);
CREATE INDEX workos_event_inbox_pending_idx
  ON workos_event_inbox (event_created_at, event_id)
  WHERE state = 'received';
CREATE INDEX workos_event_inbox_object_idx
  ON workos_event_inbox (event_type, object_id, event_created_at DESC);

CREATE TABLE workos_event_cursors (
  stream                text PRIMARY KEY CHECK (stream = 'environment'),
  cursor                text,
  last_event_created_at timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (cursor IS NULL OR char_length(cursor) <= 512)
);
INSERT INTO workos_event_cursors (stream) VALUES ('environment');

CREATE TABLE workos_command_outbox (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  operation             text NOT NULL CHECK (operation IN (
    'organization.create', 'organization.update', 'organization.delete',
    'membership.create', 'membership.update', 'membership.delete',
    'invitation.create', 'invitation.revoke',
    'session.revoke', 'sessions.revoke_all', 'user.external_id.update'
  )),
  idempotency_key       text NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  aggregate_key         text NOT NULL CHECK (
    char_length(aggregate_key) BETWEEN 3 AND 200
  ),
  ordering_key          text NOT NULL CHECK (
    char_length(ordering_key) BETWEEN 3 AND 200
  ),
  aggregate_revision    bigint NOT NULL CHECK (aggregate_revision > 0),
  organization_id       uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  provider_object_id    text,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536
  ),
  state                 workos_command_state NOT NULL DEFAULT 'queued',
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner           text,
  lease_expires_at      timestamptz,
  last_error_code       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  CHECK (provider_object_id IS NULL OR char_length(provider_object_id) <= 512),
  CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 255),
  CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 128),
  CHECK (
    (state IN ('succeeded', 'failed', 'dead') AND completed_at IS NOT NULL)
    OR (state IN ('queued', 'processing') AND completed_at IS NULL)
  )
);
CREATE UNIQUE INDEX workos_command_aggregate_revision_unique
  ON workos_command_outbox (aggregate_key, aggregate_revision);
CREATE INDEX workos_command_claim_idx
  ON workos_command_outbox (next_attempt_at, sequence)
  WHERE state = 'queued'
     OR (state = 'processing' AND lease_expires_at IS NOT NULL);

ALTER TABLE invitations
  ADD COLUMN workos_invitation_id text,
  ADD COLUMN workos_updated_at timestamptz,
  ADD COLUMN workos_sync_revision bigint NOT NULL DEFAULT 1
    CHECK (workos_sync_revision > 0),
  ADD COLUMN invitation_source text NOT NULL DEFAULT 'zeros' CHECK (
    invitation_source IN ('zeros', 'workos', 'migration')
  );
CREATE UNIQUE INDEX invitations_workos_id_unique
  ON invitations (workos_invitation_id)
  WHERE workos_invitation_id IS NOT NULL;

ALTER TABLE workos_organization_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE workos_membership_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workos_event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE workos_event_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE workos_command_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY workos_organization_links_system
  ON workos_organization_links FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workos_membership_projections_system
  ON workos_membership_projections FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workos_event_inbox_system
  ON workos_event_inbox FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workos_event_cursors_system
  ON workos_event_cursors FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workos_command_outbox_system
  ON workos_command_outbox FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE workos_organization_links FORCE ROW LEVEL SECURITY;
ALTER TABLE workos_membership_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE workos_event_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE workos_event_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE workos_command_outbox FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  workos_organization_links,
  workos_membership_projections,
  workos_event_inbox,
  workos_event_cursors,
  workos_command_outbox
TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE workos_command_outbox_sequence_seq TO zeros_app;
