-- zeros:requires-controlled-downtime
SELECT set_config('app.system','on',true);
-- Ten explicitly assigned writers (owner included), unlimited Pro viewers.
-- Historical Organization-funded workspaces keep their recorded policy.
ALTER TABLE cloud_workspaces ADD COLUMN pro_sharing_ready boolean NOT NULL DEFAULT true;
UPDATE cloud_workspaces workspace SET pro_sharing_ready=false,access_revision=access_revision+1
  FROM workspace_billing_epochs billing WHERE billing.workspace_id=workspace.id
    AND billing.billing_epoch=workspace.current_billing_epoch AND billing.entitlement_scope='account'
    AND NOT workspace.single_member_mode;

CREATE TABLE cloud_workspace_writer_slots (
  workspace_id uuid NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 10),
  assignment_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  invitation_id uuid REFERENCES cloud_workspace_invitations(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,slot),
  UNIQUE(workspace_id,user_id),
  UNIQUE(invitation_id),
  CHECK(user_id IS NOT NULL OR invitation_id IS NOT NULL),
  CHECK(slot<>1 OR (user_id IS NOT NULL AND invitation_id IS NULL))
);
ALTER TABLE cloud_workspace_writer_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_writer_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_writer_slots_system ON cloud_workspace_writer_slots FOR ALL
  USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_writer_slots TO zeros_app;

CREATE FUNCTION initialize_cloud_workspace_owner_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  INSERT INTO cloud_workspace_writer_slots(workspace_id,slot,user_id) VALUES(NEW.id,1,NEW.owner_user_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION initialize_cloud_workspace_owner_slot() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_owner_slot AFTER INSERT ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION initialize_cloud_workspace_owner_slot();
INSERT INTO cloud_workspace_writer_slots(workspace_id,slot,user_id)
  SELECT id,1,owner_user_id FROM cloud_workspaces;

CREATE FUNCTION cloud_workspace_writer_slot_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.slot=1 AND NOT EXISTS(SELECT 1 FROM cloud_workspaces WHERE id=NEW.workspace_id AND owner_user_id=NEW.user_id) THEN
    RAISE EXCEPTION 'Writer owner identity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.invitation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cloud_workspace_invitations WHERE id=NEW.invitation_id AND workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'Writer invitation scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cloud_workspace_writer_slot_owner() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_writer_slot_owner BEFORE INSERT OR UPDATE ON cloud_workspace_writer_slots
  FOR EACH ROW EXECUTE FUNCTION cloud_workspace_writer_slot_owner();

CREATE FUNCTION cloud_workspace_pro_sponsor_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id AND EXISTS(
    SELECT 1 FROM workspace_billing_epochs WHERE workspace_id=OLD.id AND billing_epoch=OLD.current_billing_epoch AND entitlement_scope='account'
  ) THEN RAISE EXCEPTION 'Pro workspace sponsor is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cloud_workspace_pro_sponsor_immutable() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_pro_sponsor_immutable BEFORE UPDATE OF owner_user_id ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_workspace_pro_sponsor_immutable();

CREATE FUNCTION public.cloud_workspace_legacy_actor_role(target_workspace_id uuid, target_user_id uuid)
 RETURNS text
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
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
    AND guest.revoked_at IS NULL AND guest.expires_at>clock_timestamp()
  WHERE workspace.id=target_workspace_id AND workspace.deleted_at IS NULL
    AND cloud_workspace_pilot_user_live(target_user_id)
    AND (
      (member.user_id IS NOT NULL AND entitlement.plan IN ('business','enterprise')
        AND entitlement.status IN ('active','trialing') AND entitlement.cloud_workspaces_allowed
        AND entitlement.valid_from<=clock_timestamp() AND (entitlement.valid_until IS NULL OR entitlement.valid_until>clock_timestamp())
        AND EXISTS (SELECT 1 FROM organization_seat_assignments seat WHERE seat.org_id=workspace.org_id
          AND seat.user_id=target_user_id AND seat.state='active')
        AND (SELECT count(*) FROM organization_seat_assignments seat WHERE seat.org_id=workspace.org_id
          AND seat.state='active')<=entitlement.seat_limit)
      OR ((member.user_id IS NULL OR entitlement.plan IS NULL OR entitlement.plan='pro')
        AND cloud_workspace_pro_user_live(target_user_id))
    )
$function$;

REVOKE ALL ON FUNCTION cloud_workspace_legacy_actor_role(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_legacy_actor_role(uuid,uuid) TO zeros_app;

-- Removing an Organization membership must not revive an older guest grant.
CREATE FUNCTION revoke_pro_workspace_guest_on_membership_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_system text:=current_setting('app.system',true);
BEGIN
  -- Trigger-only authority; restore the caller's context before returning.
  PERFORM set_config('app.system','on',true);
  UPDATE cloud_workspace_guest_grants guest SET revoked_at=clock_timestamp(),revision=revision+1
    FROM cloud_workspaces workspace JOIN workspace_billing_epochs billing
      ON billing.workspace_id=workspace.id AND billing.billing_epoch=workspace.current_billing_epoch
    WHERE guest.workspace_id=workspace.id AND guest.org_id=OLD.org_id AND guest.user_id=OLD.user_id
      AND guest.revoked_at IS NULL AND billing.entitlement_scope='account';
  UPDATE cloud_workspace_invitations invitation SET revoked_at=clock_timestamp()
    FROM cloud_workspaces workspace JOIN workspace_billing_epochs billing
      ON billing.workspace_id=workspace.id AND billing.billing_epoch=workspace.current_billing_epoch
    WHERE invitation.workspace_id=workspace.id AND invitation.org_id=OLD.org_id AND invitation.revoked_at IS NULL
      AND billing.entitlement_scope='account' AND (invitation.accepted_by=OLD.user_id OR invitation.recipient_email_sha256 IN (
        SELECT digest(lower(btrim(email_at_link)),'sha256') FROM user_identities WHERE user_id=OLD.user_id
      ));
  DELETE FROM cloud_workspace_writer_slots slot USING cloud_workspaces workspace,workspace_billing_epochs billing
    WHERE slot.workspace_id=workspace.id AND workspace.org_id=OLD.org_id AND slot.user_id=OLD.user_id AND slot.slot<>1
      AND billing.workspace_id=workspace.id AND billing.billing_epoch=workspace.current_billing_epoch AND billing.entitlement_scope='account';
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION revoke_pro_workspace_guest_on_membership_removal() FROM PUBLIC;
CREATE TRIGGER pro_workspace_guest_membership_removed AFTER DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION revoke_pro_workspace_guest_on_membership_removal();

CREATE OR REPLACE FUNCTION cloud_workspace_actor_role(target_workspace_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN billing.entitlement_scope='organization' THEN cloud_workspace_legacy_actor_role(workspace.id,target_user_id)
    WHEN NOT cloud_workspace_pro_user_live(target_user_id) THEN NULL
    WHEN workspace.owner_user_id=target_user_id THEN CASE
      WHEN member.user_id IS NOT NULL AND explicit_member.role='owner' AND EXISTS(
        SELECT 1 FROM team_members WHERE team_id=workspace.team_id AND org_id=workspace.org_id AND user_id=target_user_id
      ) THEN 'owner' ELSE NULL END
    WHEN workspace.single_member_mode OR NOT workspace.pro_sharing_ready THEN NULL
    WHEN (CASE WHEN member.user_id IS NOT NULL THEN explicit_member.role END) IS NOT NULL THEN
      CASE WHEN writer.user_id IS NOT NULL AND writer.invitation_id IS NULL THEN explicit_member.role ELSE 'viewer' END
    WHEN guest.user_id IS NOT NULL THEN
      CASE WHEN writer.user_id IS NOT NULL AND writer.invitation_id IS NULL THEN guest.role ELSE 'viewer' END
    WHEN member.user_id IS NOT NULL AND workspace.sharing_mode='organization' THEN 'viewer'
    ELSE NULL END
  FROM cloud_workspaces workspace
  JOIN organizations organization ON organization.id=workspace.org_id AND NOT organization.is_personal AND organization.deleted_at IS NULL
  JOIN teams team ON team.id=workspace.team_id AND team.org_id=workspace.org_id AND team.deleted_at IS NULL
  JOIN workspace_billing_epochs billing ON billing.workspace_id=workspace.id AND billing.billing_epoch=workspace.current_billing_epoch
  LEFT JOIN organization_members member ON member.org_id=workspace.org_id AND member.user_id=target_user_id
  LEFT JOIN cloud_workspace_members explicit_member ON explicit_member.workspace_id=workspace.id AND explicit_member.user_id=target_user_id AND explicit_member.org_id=workspace.org_id
  LEFT JOIN cloud_workspace_guest_grants guest ON guest.workspace_id=workspace.id AND guest.org_id=workspace.org_id AND guest.user_id=target_user_id
    AND guest.revoked_at IS NULL AND guest.expires_at>clock_timestamp()
  LEFT JOIN cloud_workspace_writer_slots writer ON writer.workspace_id=workspace.id AND writer.user_id=target_user_id
  WHERE workspace.id=target_workspace_id AND workspace.deleted_at IS NULL AND app_is_system()
$$;

CREATE OR REPLACE FUNCTION cloud_workspace_actor_fingerprint(target_workspace_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(digest(jsonb_build_array(workspace.access_revision,workspace.pro_sharing_ready,writer.assignment_id,writer.invitation_id,workspace.owner_user_id,
    workspace.team_id,team_member.created_at,
    account.auth_revision,account.staff_role,organization.authorization_revision,
    membership.authorization_revision,membership.role,membership.created_at,
    explicit_member.role,explicit_member.updated_at,guest.id,guest.revision,guest.role,
    account_entitlement.revision,account_entitlement.updated_at,
    org_entitlement.revision,org_entitlement.updated_at,seat.revision,seat.assigned_at)::text,'sha256'),'hex')
  FROM cloud_workspaces workspace
  LEFT JOIN cloud_workspace_writer_slots writer ON writer.workspace_id=workspace.id AND writer.user_id=target_user_id
  JOIN users account ON account.id=target_user_id
  JOIN organizations organization ON organization.id=workspace.org_id
  LEFT JOIN organization_members membership ON membership.org_id=workspace.org_id AND membership.user_id=account.id
  LEFT JOIN team_members team_member ON team_member.org_id=workspace.org_id AND team_member.team_id=workspace.team_id AND team_member.user_id=account.id
  LEFT JOIN cloud_workspace_members explicit_member ON explicit_member.workspace_id=workspace.id AND explicit_member.user_id=account.id
  LEFT JOIN cloud_workspace_guest_grants guest ON guest.workspace_id=workspace.id AND guest.user_id=account.id AND guest.revoked_at IS NULL
  LEFT JOIN account_entitlements account_entitlement ON account_entitlement.user_id=account.id
  LEFT JOIN organization_entitlements org_entitlement ON org_entitlement.org_id=workspace.org_id
  LEFT JOIN organization_seat_assignments seat ON seat.org_id=workspace.org_id AND seat.user_id=account.id
  WHERE workspace.id=target_workspace_id AND app_is_system()
$$;

-- Capture all deletion recipients without an unbounded array or publication
-- transaction. No user/tenant FK: capture must not acquire parent account locks
-- after the workspace lock. Account erasure explicitly scrubs these IDs.
CREATE TABLE cloud_workspace_directory_recipients (
  workspace_id uuid NOT NULL REFERENCES cloud_workspace_directory_outbox(workspace_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,user_id)
);
CREATE INDEX cloud_workspace_directory_recipient_user ON cloud_workspace_directory_recipients(user_id);
ALTER TABLE cloud_workspace_directory_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_directory_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_directory_recipients_system ON cloud_workspace_directory_recipients FOR ALL
  USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,DELETE ON cloud_workspace_directory_recipients TO zeros_app;

CREATE OR REPLACE FUNCTION enqueue_cloud_workspace_directory_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE workspace cloud_workspaces%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.desired_state IS NOT DISTINCT FROM OLD.desired_state
      AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
      AND NEW.current_generation IS NOT DISTINCT FROM OLD.current_generation THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN workspace:=OLD; ELSE workspace:=NEW; END IF;
  INSERT INTO cloud_workspace_directory_outbox(workspace_id,org_id,owner_user_id,guest_user_ids,removed,revision)
    VALUES (workspace.id,workspace.org_id,workspace.owner_user_id,
      ARRAY(SELECT user_id FROM cloud_workspace_guest_grants WHERE workspace_id=workspace.id AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY user_id LIMIT 100),
      TG_OP='DELETE' OR workspace.deleted_at IS NOT NULL,workspace.version)
    ON CONFLICT (workspace_id) DO UPDATE SET org_id=excluded.org_id,owner_user_id=excluded.owner_user_id,
      guest_user_ids=CASE WHEN cloud_workspace_directory_outbox.removed THEN cloud_workspace_directory_outbox.guest_user_ids ELSE excluded.guest_user_ids END,
      removed=cloud_workspace_directory_outbox.removed OR excluded.removed,revision=excluded.revision,updated_at=now();
  IF TG_OP='DELETE' OR workspace.deleted_at IS NOT NULL THEN
    INSERT INTO cloud_workspace_directory_recipients(workspace_id,user_id)
      SELECT workspace.id,user_id FROM cloud_workspace_guest_grants
      WHERE workspace_id=workspace.id AND revoked_at IS NULL AND expires_at>clock_timestamp()
      ON CONFLICT DO NOTHING;
  END IF;
  PERFORM pg_notify('zeros_security_event','');
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
