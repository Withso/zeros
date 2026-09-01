-- ──────────────────────────────────────────────────────────
-- 0018 — recoverable account and organization deletion lifecycle
-- ──────────────────────────────────────────────────────────
-- WorkOS owns identity and provider sessions; Zeros owns product records.
-- A customer deletion request therefore revokes access immediately, keeps an
-- exact recoverable snapshot for 30 days, and reaches WorkOS hard deletion only
-- from the durable purge worker after the grace period. Provider/dashboard
-- deletion is never used as a product-data mutation API.

CREATE TYPE deletion_target_kind AS ENUM ('account', 'organization');
CREATE TYPE deletion_request_state AS ENUM (
  'scheduled', 'restored', 'purging', 'provider_deleting', 'purged', 'failed'
);
CREATE TYPE deletion_request_origin AS ENUM (
  'self_service', 'account_cascade', 'staff_operation'
);
CREATE TYPE organization_lifecycle_status AS ENUM (
  'active', 'scheduled', 'purging', 'provider_deleted', 'purged'
);

CREATE TABLE deletion_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code           text NOT NULL UNIQUE CHECK (
    public_code ~ '^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$'
  ),
  target_kind           deletion_target_kind NOT NULL,
  -- target_id is the durable, non-PII audit identity. Nullable FKs permit an
  -- organization row to be hard-deleted without erasing lifecycle evidence.
  target_id             uuid NOT NULL,
  target_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  target_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  requested_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_request_id     uuid REFERENCES deletion_requests(id) ON DELETE SET NULL,
  origin                deletion_request_origin NOT NULL DEFAULT 'self_service',
  state                 deletion_request_state NOT NULL DEFAULT 'scheduled',
  retention_policy      text NOT NULL DEFAULT 'customer-deletion-v1' CHECK (
    retention_policy = 'customer-deletion-v1'
  ),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  purge_after           timestamptz NOT NULL DEFAULT now() + interval '30 days',
  restored_at           timestamptz,
  restored_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  purge_started_at      timestamptz,
  purge_command_id      uuid REFERENCES workos_command_outbox(id) ON DELETE SET NULL,
  purged_at             timestamptz,
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner           text,
  lease_expires_at      timestamptz,
  last_error_code       text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (target_kind = 'account' AND target_organization_id IS NULL)
    OR (target_kind = 'organization' AND target_user_id IS NULL)
  ),
  CHECK (purge_after = requested_at + interval '30 days'),
  CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 128),
  CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 255),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state = 'scheduled' AND restored_at IS NULL AND purged_at IS NULL)
    OR (state = 'restored' AND restored_at IS NOT NULL AND purged_at IS NULL)
    OR (state IN ('purging', 'provider_deleting', 'failed')
        AND purge_started_at IS NOT NULL AND restored_at IS NULL AND purged_at IS NULL)
    OR (state = 'purged' AND purge_started_at IS NOT NULL
        AND restored_at IS NULL AND purged_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX one_live_deletion_request_per_target
  ON deletion_requests (target_kind, target_id)
  WHERE state IN ('scheduled', 'purging', 'provider_deleting', 'failed');
CREATE INDEX deletion_requests_due_idx
  ON deletion_requests (purge_after, requested_at, id)
  WHERE state IN ('scheduled', 'purging', 'provider_deleting', 'failed');
CREATE INDEX deletion_requests_requester_idx
  ON deletion_requests (requested_by_user_id, requested_at DESC);

ALTER TABLE users
  ADD COLUMN deletion_request_id uuid
    REFERENCES deletion_requests(id) ON DELETE SET NULL,
  ADD COLUMN deletion_scheduled_at timestamptz,
  ADD COLUMN purge_after timestamptz;

ALTER TABLE account_recovery_requests
  ADD COLUMN support_case_reference text CHECK (
    support_case_reference IS NULL
    OR char_length(support_case_reference) BETWEEN 6 AND 128
  ),
  ADD COLUMN ownership_verified_at timestamptz;

ALTER TABLE organizations
  ADD COLUMN lifecycle_status organization_lifecycle_status
    NOT NULL DEFAULT 'active',
  ADD COLUMN deletion_request_id uuid
    REFERENCES deletion_requests(id) ON DELETE SET NULL,
  ADD COLUMN deletion_scheduled_at timestamptz,
  ADD COLUMN purge_after timestamptz;

-- Historical soft-deleted rows predate recovery and must never become
-- unexpectedly recoverable merely because this migration was installed.
UPDATE organizations
SET lifecycle_status = 'purged'
WHERE deleted_at IS NOT NULL;

CREATE TABLE deletion_request_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deletion_request_id   uuid NOT NULL
                        REFERENCES deletion_requests(id) ON DELETE RESTRICT,
  actor_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  action                text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 80),
  support_case_reference text CHECK (
    support_case_reference IS NULL
    OR char_length(support_case_reference) BETWEEN 6 AND 128
  ),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
  ),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deletion_request_events_request_idx
  ON deletion_request_events (deletion_request_id, created_at, id);

CREATE FUNCTION reject_deletion_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'deletion_request_events is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER deletion_request_events_append_only
  BEFORE UPDATE OR DELETE ON deletion_request_events
  FOR EACH ROW EXECUTE FUNCTION reject_deletion_event_mutation();
CREATE TRIGGER deletion_request_events_no_truncate
  BEFORE TRUNCATE ON deletion_request_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_deletion_event_mutation();

-- Zeros has two standing staff identities: platform owners and developers.
-- Destructive customer-data operations are never implied by developer access;
-- a platform owner grants an exact, expiring capability for one request/case.
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'platform_owner';
CREATE TYPE staff_operation_capability AS ENUM (
  'deletion.read', 'deletion.restore', 'deletion.force_purge'
);
CREATE TABLE staff_operation_grants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_request_id   uuid NOT NULL
                        REFERENCES deletion_requests(id) ON DELETE RESTRICT,
  grantee_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_by_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  capability            staff_operation_capability NOT NULL,
  support_case_reference text NOT NULL CHECK (
    char_length(support_case_reference) BETWEEN 6 AND 128
  ),
  deployment_channel    text NOT NULL CHECK (
    deployment_channel IN ('development', 'alpha', 'production')
  ),
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (grantee_user_id <> granted_by_user_id),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '1 hour'),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX staff_operation_grants_live_idx
  ON staff_operation_grants (grantee_user_id, deletion_request_id, capability, expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- Add final provider erasure and lifecycle notification commands/templates.
ALTER TABLE workos_command_outbox
  DROP CONSTRAINT workos_command_outbox_operation_check;
ALTER TABLE workos_command_outbox
  ADD CONSTRAINT workos_command_outbox_operation_check CHECK (operation IN (
    'organization.create', 'organization.update', 'organization.delete',
    'membership.create', 'membership.update', 'membership.delete',
    'invitation.create', 'invitation.revoke',
    'session.revoke', 'sessions.revoke_all', 'user.external_id.update',
    'user.delete'
  ));

ALTER TABLE security_notification_outbox
  DROP CONSTRAINT security_notification_outbox_template_check;
ALTER TABLE security_notification_outbox
  ADD CONSTRAINT security_notification_outbox_template_check CHECK (template IN (
    'account_identity_disabled', 'account_recovered',
    'sessions_revoked', 'organization_access_revoked',
    'account_deletion_scheduled', 'account_deletion_restored',
    'account_deletion_completed', 'organization_deletion_scheduled',
    'organization_deletion_restored', 'organization_deletion_completed'
  ));

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_request_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_operation_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY deletion_requests_system ON deletion_requests FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY deletion_request_events_system ON deletion_request_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY staff_operation_grants_system ON staff_operation_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE deletion_request_events FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_operation_grants FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  deletion_requests, deletion_request_events, staff_operation_grants
TO zeros_app;
GRANT USAGE, SELECT ON SEQUENCE deletion_request_events_id_seq TO zeros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON deletion_request_events FROM zeros_app;
REVOKE ALL ON FUNCTION reject_deletion_event_mutation() FROM PUBLIC;

-- 0007/0013 deliberately restrict updates to users by column.
REVOKE UPDATE ON users FROM zeros_app;
GRANT UPDATE (
  email, display_name, avatar_url, deleted_at,
  auth_status, auth_revision, auth_disabled_at, auth_revoked_at,
  auth_status_changed_at, deletion_request_id,
  deletion_scheduled_at, purge_after
) ON users TO zeros_app;
