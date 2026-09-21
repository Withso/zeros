-- Existing private/team rows retain their previous owner-only behavior. New
-- shared workspaces explicitly opt in, and require the actor-aware worker.
ALTER TABLE cloud_workspaces
  ADD COLUMN sharing_mode text NOT NULL DEFAULT 'private' CHECK (sharing_mode IN ('private','organization')),
  ADD COLUMN access_revision bigint NOT NULL DEFAULT 1 CHECK (access_revision > 0);
ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN actor_protocol_version integer NOT NULL DEFAULT 1 CHECK (actor_protocol_version IN (1,2));
CREATE INDEX cloud_workspaces_shared_list ON cloud_workspaces(org_id,created_at DESC,id DESC)
  WHERE deleted_at IS NULL AND sharing_mode='organization' AND NOT single_member_mode;

CREATE TABLE cloud_workspace_guest_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','prompter','developer')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (id,workspace_id,org_id,user_id),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_workspace_one_live_guest ON cloud_workspace_guest_grants(workspace_id,user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX cloud_workspace_guest_discovery ON cloud_workspace_guest_grants(user_id,workspace_id)
  WHERE revoked_at IS NULL;

CREATE TABLE cloud_workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  recipient_email_sha256 bytea NOT NULL CHECK (octet_length(recipient_email_sha256)=32),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  role text NOT NULL CHECK (role IN ('viewer','prompter','developer')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  inviter_fingerprint text NOT NULL CHECK (inviter_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  guest_grant_id uuid REFERENCES cloud_workspace_guest_grants(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_pending_invitations ON cloud_workspace_invitations(workspace_id,recipient_email_sha256)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE cloud_workspace_guest_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_guest_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_guests_system ON cloud_workspace_guest_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY cloud_workspace_invitations_system ON cloud_workspace_invitations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_guest_grants,cloud_workspace_invitations TO zeros_app;

-- Guests deliberately do not enter organization_members, team_members or
-- app_user_org_ids(). All shared data paths authorize their exact workspace.
CREATE FUNCTION cloud_workspace_actor_role(target_workspace_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN workspace.owner_user_id=target_user_id THEN
      CASE WHEN member.user_id IS NOT NULL AND explicit_member.role='owner'
        AND EXISTS (SELECT 1 FROM team_members team_member WHERE team_member.team_id=workspace.team_id
          AND team_member.org_id=workspace.org_id AND team_member.user_id=target_user_id)
      THEN 'owner' ELSE NULL END
    WHEN workspace.single_member_mode THEN NULL
    WHEN member.user_id IS NOT NULL AND workspace.sharing_mode='organization'
      AND member.role IN ('owner','admin') THEN 'manager'
    WHEN member.user_id IS NOT NULL AND explicit_member.role IS NOT NULL THEN explicit_member.role
    WHEN member.user_id IS NOT NULL AND workspace.sharing_mode='organization' THEN 'developer'
    ELSE guest.role
  END
  FROM cloud_workspaces workspace
  JOIN organizations organization ON organization.id=workspace.org_id
    AND organization.deleted_at IS NULL AND NOT organization.is_personal
  JOIN teams team ON team.id=workspace.team_id AND team.org_id=workspace.org_id AND team.deleted_at IS NULL
  LEFT JOIN organization_members member ON member.org_id=workspace.org_id AND member.user_id=target_user_id
  LEFT JOIN cloud_workspace_members explicit_member ON explicit_member.workspace_id=workspace.id
    AND explicit_member.org_id=workspace.org_id AND explicit_member.user_id=target_user_id
  LEFT JOIN organization_entitlements entitlement ON entitlement.org_id=workspace.org_id
  LEFT JOIN cloud_workspace_guest_grants guest ON guest.workspace_id=workspace.id
    AND guest.org_id=workspace.org_id AND guest.user_id=target_user_id
    AND guest.revoked_at IS NULL AND guest.expires_at>now()
  WHERE workspace.id=target_workspace_id AND workspace.deleted_at IS NULL
    AND cloud_workspace_pilot_user_live(target_user_id)
    AND (
      (member.user_id IS NOT NULL AND entitlement.plan IN ('business','enterprise')
        AND entitlement.status IN ('active','trialing') AND entitlement.cloud_workspaces_allowed
        AND entitlement.valid_from<=now() AND (entitlement.valid_until IS NULL OR entitlement.valid_until>now())
        AND EXISTS (SELECT 1 FROM organization_seat_assignments seat WHERE seat.org_id=workspace.org_id
          AND seat.user_id=target_user_id AND seat.state='active')
        AND (SELECT count(*) FROM organization_seat_assignments seat WHERE seat.org_id=workspace.org_id
          AND seat.state='active')<=entitlement.seat_limit)
      OR ((member.user_id IS NULL OR entitlement.plan IS NULL OR entitlement.plan='pro')
        AND cloud_workspace_pro_user_live(target_user_id))
    )
$$;
REVOKE ALL ON FUNCTION cloud_workspace_actor_role(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_actor_role(uuid,uuid) TO zeros_app;

-- A revoke/regrant of staff must not resurrect previously issued actor proofs.
CREATE FUNCTION cloud_actor_staff_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$ BEGIN
  IF NEW.staff_role IS DISTINCT FROM OLD.staff_role THEN
    NEW.auth_revision := greatest(NEW.auth_revision,OLD.auth_revision+1);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_actor_staff_revision BEFORE UPDATE OF staff_role ON users
  FOR EACH ROW EXECUTE FUNCTION cloud_actor_staff_revision();
REVOKE ALL ON FUNCTION cloud_actor_staff_revision() FROM PUBLIC;
