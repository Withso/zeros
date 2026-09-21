-- Workspace events are exact-workspace authority. They never grant a guest
-- organization membership or expose private workspace IDs to other members.
ALTER TYPE security_event_kind ADD VALUE 'workspace.authorization_changed';
ALTER TABLE security_events ADD COLUMN workspace_id uuid;
ALTER TABLE security_events ADD CONSTRAINT security_events_workspace_scope
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE;
ALTER TABLE security_events ADD CONSTRAINT security_events_workspace_kind CHECK (
  (workspace_id IS NOT NULL)=(kind::text='workspace.authorization_changed')
  AND (workspace_id IS NULL OR org_id IS NOT NULL));
CREATE INDEX security_events_workspace_delivery ON security_events(workspace_id,delivery_sequence)
  WHERE workspace_id IS NOT NULL;

-- Read recovery is deliberately separate from paid run/edit eligibility.
CREATE FUNCTION cloud_workspace_read_role(target_workspace_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(cloud_workspace_actor_role(workspace.id,target_user_id),
    CASE WHEN workspace.owner_user_id=target_user_id AND EXISTS (
      SELECT 1 FROM users account
      JOIN organization_members member ON member.user_id=account.id AND member.org_id=workspace.org_id
      JOIN organizations organization ON organization.id=member.org_id AND organization.deleted_at IS NULL AND NOT organization.is_personal
      JOIN teams team ON team.id=workspace.team_id AND team.org_id=organization.id AND team.deleted_at IS NULL
      JOIN team_members team_member ON team_member.team_id=team.id AND team_member.org_id=organization.id AND team_member.user_id=account.id
      WHERE account.id=target_user_id AND account.auth_status='active' AND account.deleted_at IS NULL
    ) THEN 'owner' ELSE NULL END)
  FROM cloud_workspaces workspace WHERE workspace.id=target_workspace_id AND workspace.deleted_at IS NULL AND app_is_system()
$$;
REVOKE ALL ON FUNCTION cloud_workspace_read_role(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_read_role(uuid,uuid) TO zeros_app;

ALTER TABLE cloud_workspace_invitations
  ADD COLUMN idempotency_key text CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  ADD COLUMN request_sha256 bytea CHECK (octet_length(request_sha256)=32),
  ADD CONSTRAINT cloud_workspace_invitation_request_binding CHECK ((idempotency_key IS NULL)=(request_sha256 IS NULL));
CREATE UNIQUE INDEX cloud_workspace_invitation_idempotency
  ON cloud_workspace_invitations(workspace_id,invited_by,idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Recipient and bearer stay in a purpose-derived encrypted envelope; ordinary
-- invitation reads expose metadata only. Cascading erasure removes delivery PII.
CREATE TABLE cloud_workspace_invitation_deliveries (
  invitation_id uuid PRIMARY KEY REFERENCES cloud_workspace_invitations(id) ON DELETE CASCADE,
  key_version integer NOT NULL CHECK (key_version>0),
  nonce bytea CHECK (octet_length(nonce)=12),
  ciphertext bytea CHECK (octet_length(ciphertext) BETWEEN 1 AND 2048),
  auth_tag bytea CHECK (octet_length(auth_tag)=16),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','cancelled','dead')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  provider_message_id text CHECK (length(provider_message_id)<=256),
  last_error_code text CHECK (length(last_error_code)<=128),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK ((state='sending')=(lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((nonce IS NULL)=(ciphertext IS NULL) AND (nonce IS NULL)=(auth_tag IS NULL)),
  CHECK (state NOT IN ('queued','sending') OR ciphertext IS NOT NULL)
);
CREATE INDEX cloud_workspace_invitation_delivery_due ON cloud_workspace_invitation_deliveries(next_attempt_at,invitation_id)
  WHERE state IN ('queued','sending');
ALTER TABLE cloud_workspace_invitation_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_invitation_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_invitation_deliveries_system ON cloud_workspace_invitation_deliveries FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_invitation_deliveries TO zeros_app;
