-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- zeros-expand-exception: nullable-cloud-creator Only active organization workspaces may retain a NULL Creator after person loss
ALTER TABLE cloud_v2_workspaces ALTER COLUMN creator_user_id DROP NOT NULL;
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN creator_revision bigint NOT NULL DEFAULT 1 CHECK (creator_revision>0 AND creator_revision<9223372036854775807),
  ADD COLUMN creator_absent_reason text CHECK (creator_absent_reason IN ('left','hold','account_revoked')),
  ADD COLUMN creator_absent_at timestamptz,
  ADD CONSTRAINT cloud_creator_presence CHECK (
    (creator_user_id IS NOT NULL AND creator_absent_reason IS NULL AND creator_absent_at IS NULL) OR
    (execution_mode='active' AND creator_user_id IS NULL AND creator_absent_reason IS NOT NULL AND creator_absent_at IS NOT NULL)) NOT VALID;
CREATE INDEX cloud_team_current_creator ON cloud_v2_workspaces(creator_user_id,org_id,id)
  WHERE execution_mode='active' AND creator_user_id IS NOT NULL;

CREATE TABLE cloud_v2_reassignments (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  caller_user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  from_user_id uuid,
  to_user_id uuid NOT NULL,
  creator_revision bigint NOT NULL CHECK (creator_revision>0 AND creator_revision<9223372036854775807),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  PRIMARY KEY(workspace_id,caller_user_id,request_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_reassignments_expiry ON cloud_v2_reassignments(expires_at);
ALTER TABLE cloud_v2_reassignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_reassignments FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_reassignments USING(app_is_system()) WITH CHECK(app_is_system());

CREATE FUNCTION guard_cloud_creator_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.creator_user_id IS NULL THEN RAISE EXCEPTION 'cloud_creator_required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.creator_user_id IS NOT DISTINCT FROM OLD.creator_user_id THEN
    IF ROW(NEW.creator_revision,NEW.creator_absent_reason,NEW.creator_absent_at)
      IS DISTINCT FROM ROW(OLD.creator_revision,OLD.creator_absent_reason,OLD.creator_absent_at) THEN
      RAISE EXCEPTION 'cloud_creator_identity_unchanged' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.execution_mode<>'active' THEN RETURN NEW; END IF;
  IF coalesce(current_setting('app.cloud_team_ownership',true),'')<>'1' THEN
    RAISE EXCEPTION 'team_ownership_required' USING ERRCODE='23514';
  END IF;
  NEW.creator_revision := OLD.creator_revision+1;
  IF NEW.creator_user_id IS NULL THEN
    IF NEW.creator_absent_reason IS NULL THEN RAISE EXCEPTION 'cloud_creator_absence_required' USING ERRCODE='23514'; END IF;
    NEW.creator_absent_at := clock_timestamp();
    NEW.creator_agent_logins := '{}'::jsonb;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
      WHERE m.org_id=NEW.org_id AND m.user_id=NEW.creator_user_id AND u.auth_status='active' AND u.deleted_at IS NULL
        AND NOT public.organization_member_on_hold(m.org_id,m.user_id,10,5)) THEN
      RAISE EXCEPTION 'cloud_creator_ineligible' USING ERRCODE='23514';
    END IF;
    NEW.creator_absent_reason := NULL;
    NEW.creator_absent_at := NULL;
    SELECT coalesce(jsonb_object_agg(c.provider,true),'{}'::jsonb) INTO NEW.creator_agent_logins
      FROM public.cloud_agent_organization_connections c
      JOIN public.cloud_agent_credentials k ON k.id=c.credential_id AND k.owner_user_id=c.owner_user_id
      JOIN public.cloud_agent_credential_versions v ON v.credential_id=k.id AND v.version=k.current_version
      WHERE c.org_id=NEW.org_id AND c.owner_user_id=NEW.creator_user_id AND k.revoked_at IS NULL
        AND c.credential_revision=k.revision AND (v.material_mode IS NULL OR v.material_mode='local');
  END IF;
  -- An identical availability map still belongs to a different payer.
  NEW.login_revision := OLD.login_revision+1;
  PERFORM pg_notify('zeros_cloud_v2_logins',json_build_object('ownerUserId',NULL,'organizationId',NEW.org_id,'availabilityOnly',true)::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from the new Creator identity trigger
REVOKE ALL ON FUNCTION guard_cloud_creator_ownership() FROM PUBLIC;
CREATE TRIGGER cloud_creator_ownership_guard BEFORE INSERT OR UPDATE OF creator_user_id,creator_revision,creator_absent_reason,creator_absent_at
  ON cloud_v2_workspaces FOR EACH ROW EXECUTE FUNCTION guard_cloud_creator_ownership();

-- The same channel switch gates event-driven loss and clock-driven Hold.
-- No actor signature, VM token, activity clock or lifecycle state moves here.
-- zeros-expand-exception: cloud-creator-loss Clears only active ownership under the enabled channel switch while retaining every workspace resource
CREATE FUNCTION clear_cloud_creator_ownership(target_org uuid,target_user uuid,forced_reason text DEFAULT NULL,target_workspace uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE affected integer;
BEGIN
  IF coalesce(current_setting('app.cloud_team_ownership',true),'')<>'1' THEN RETURN 0; END IF;
  IF NOT coalesce(public.app_is_system(),false) THEN RETURN 0; END IF;
  IF forced_reason IS NOT NULL AND (forced_reason NOT IN ('left','account_revoked') OR target_user IS NULL) THEN
    RAISE EXCEPTION 'cloud_creator_loss_scope' USING ERRCODE='23514';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT w.id,coalesce(forced_reason,CASE
      WHEN NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.creator_user_id AND u.auth_status='active' AND u.deleted_at IS NULL)
        THEN 'account_revoked'
      WHEN NOT EXISTS(SELECT 1 FROM public.organization_members m WHERE m.org_id=w.org_id AND m.user_id=w.creator_user_id)
        THEN 'left' ELSE 'hold' END) AS reason
    FROM public.cloud_v2_workspaces w WHERE w.execution_mode='active' AND w.creator_user_id IS NOT NULL
      AND (target_org IS NULL OR w.org_id=target_org) AND (target_user IS NULL OR w.creator_user_id=target_user)
      AND (target_workspace IS NULL OR w.id=target_workspace)
      AND (forced_reason IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
        WHERE m.org_id=w.org_id AND m.user_id=w.creator_user_id AND u.auth_status='active' AND u.deleted_at IS NULL
          AND NOT public.organization_member_on_hold(m.org_id,m.user_id,10,5)))
    ORDER BY w.id FOR UPDATE
  )
  UPDATE public.cloud_v2_workspaces w SET creator_user_id=NULL,creator_absent_reason=c.reason
    FROM candidates c WHERE w.id=c.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from the explicitly scoped Creator loss function
REVOKE ALL ON FUNCTION clear_cloud_creator_ownership(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clear_cloud_creator_ownership(uuid,uuid,text,uuid) TO zeros_app;

CREATE FUNCTION fence_cloud_creator_loss() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid; organization uuid;
BEGIN
  IF coalesce(current_setting('app.cloud_team_ownership',true),'')<>'1' THEN
    IF TG_WHEN='BEFORE' THEN RETURN OLD; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='organization_members' THEN
    organization := CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
    IF TG_OP='DELETE' THEN PERFORM public.clear_cloud_creator_ownership(OLD.org_id,OLD.user_id,'left'); END IF;
    IF TG_OP='UPDATE' AND ROW(OLD.org_id,OLD.user_id) IS DISTINCT FROM ROW(NEW.org_id,NEW.user_id) THEN
      PERFORM public.clear_cloud_creator_ownership(OLD.org_id,OLD.user_id,'left');
      PERFORM public.clear_cloud_creator_ownership(OLD.org_id,NULL);
    END IF;
    PERFORM public.clear_cloud_creator_ownership(organization,NULL);
  ELSIF TG_TABLE_NAME='users' THEN
    person := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP='DELETE' OR NEW.auth_status<>'active' OR NEW.deleted_at IS NOT NULL THEN
      PERFORM public.clear_cloud_creator_ownership(NULL,person,'account_revoked');
    ELSIF NEW.staff_role IS DISTINCT FROM OLD.staff_role THEN
      FOR organization IN SELECT m.org_id FROM public.organization_members m WHERE m.user_id=person ORDER BY m.org_id LOOP
        PERFORM public.clear_cloud_creator_ownership(organization,NULL);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME IN ('account_entitlements','staff_pro_benefits') THEN
    person := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    FOR organization IN SELECT m.org_id FROM public.organization_members m WHERE m.user_id=person ORDER BY m.org_id LOOP
      PERFORM public.clear_cloud_creator_ownership(organization,NULL);
    END LOOP;
  ELSIF TG_TABLE_NAME='security_events' AND NEW.kind='account.revoked' AND NEW.user_id IS NOT NULL THEN
    PERFORM public.clear_cloud_creator_ownership(NEW.org_id,NEW.user_id,'account_revoked');
  END IF;
  IF TG_WHEN='BEFORE' THEN RETURN OLD; END IF;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from the new Creator loss event trigger
REVOKE ALL ON FUNCTION fence_cloud_creator_loss() FROM PUBLIC;
CREATE TRIGGER cloud_creator_member_loss AFTER INSERT OR UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_creator_loss();
CREATE TRIGGER cloud_creator_account_loss AFTER UPDATE OF auth_status,deleted_at,staff_role ON users
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_creator_loss();
CREATE TRIGGER cloud_creator_account_erasure BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_creator_loss();
CREATE TRIGGER cloud_creator_entitlement_loss AFTER INSERT OR UPDATE OR DELETE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_creator_loss();
CREATE TRIGGER cloud_creator_staff_loss AFTER INSERT OR UPDATE OR DELETE ON staff_pro_benefits
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_creator_loss();
CREATE TRIGGER cloud_creator_security_loss AFTER INSERT ON security_events
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_creator_loss();
