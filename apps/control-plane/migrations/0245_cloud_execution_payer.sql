-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces ADD COLUMN creator_agent_logins jsonb;

CREATE INDEX cloud_execution_payer_live ON cloud_v2_execution_contexts((selection#>>'{payer,userId}'),org_id)
  WHERE state='active' AND selection->>'version'='2';

-- A new turn chooses the current Creator. Renewal checks its pinned payer,
-- even after Reassign; an old actor-owned context keeps its original selection.
CREATE FUNCTION guard_cloud_execution_payer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE payer_id uuid; creator_id uuid; normalized jsonb;
BEGIN
  IF NEW.kind<>'turn' OR NEW.state<>'active' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.selection->>'version'='2' AND (NEW.selection IS DISTINCT FROM OLD.selection OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
      RAISE EXCEPTION 'cloud_execution_payer_changed' USING ERRCODE='23514';
    END IF;
    IF NOT NEW.selection ? 'version' THEN RETURN NEW; END IF;
  END IF;
  IF NEW.selection ? 'version' THEN
    IF (NEW.selection->'version'='2'::jsonb AND jsonb_typeof(NEW.selection->'payer')='object'
      AND NEW.selection#>>'{payer,userId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'cloud_execution_payer_required' USING ERRCODE='23514';
    END IF;
    payer_id := (NEW.selection#>>'{payer,userId}')::uuid;
    SELECT jsonb_build_object('userId',u.id::text,'accountRevision',u.auth_revision::text,
      'memberRevision',m.authorization_revision::text,'memberCreatedAt',m.created_at::text) INTO normalized
      FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
      WHERE m.org_id=NEW.org_id AND m.user_id=payer_id AND u.auth_status='active' AND u.deleted_at IS NULL
        AND NOT public.organization_member_on_hold(m.org_id,m.user_id,10,5);
    IF normalized IS NULL OR NEW.selection->'payer' IS DISTINCT FROM normalized THEN
      RAISE EXCEPTION 'cloud_execution_payer_changed' USING ERRCODE='23514';
    END IF;
    normalized := jsonb_build_object('version',2,'payer',normalized);
  ELSE
    payer_id := NEW.user_id; normalized := '{}'::jsonb;
  END IF;
  normalized := normalized || jsonb_build_object('source',NEW.selection->>'source','credentialId',NEW.selection->>'credentialId',
    'credentialRevision',NEW.selection->>'credentialRevision','connectionRevision',NEW.selection->>'connectionRevision');
  IF NEW.selection IS DISTINCT FROM normalized OR octet_length(NEW.selection::text)>1024
    OR (NEW.selection->>'source' IN ('personal','shared')) IS NOT TRUE THEN
    RAISE EXCEPTION 'cloud_execution_payer_required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT w.creator_user_id INTO creator_id FROM public.cloud_v2_workspaces w
      JOIN public.organization_members m ON m.org_id=w.org_id AND m.user_id=w.creator_user_id
      JOIN public.users u ON u.id=m.user_id WHERE w.id=NEW.workspace_id AND w.org_id=NEW.org_id AND w.execution_mode='active'
        AND u.auth_status='active' AND u.deleted_at IS NULL AND NOT public.organization_member_on_hold(m.org_id,m.user_id,10,5);
    IF creator_id IS NULL OR payer_id IS DISTINCT FROM creator_id THEN
      RAISE EXCEPTION 'cloud_execution_payer_required' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.selection->>'source'='personal' THEN
    IF NOT EXISTS(SELECT 1 FROM public.cloud_agent_organization_connections c JOIN public.cloud_agent_credentials k
      ON k.id=c.credential_id AND k.owner_user_id=c.owner_user_id
      WHERE c.org_id=NEW.org_id AND c.owner_user_id=payer_id AND c.provider=NEW.agent AND k.revoked_at IS NULL
        AND k.id=NEW.credential_id AND k.id::text=NEW.selection->>'credentialId' AND k.revision=c.credential_revision
        AND k.revision::text=NEW.selection->>'credentialRevision' AND c.revision::text=NEW.selection->>'connectionRevision') THEN
      RAISE EXCEPTION 'cloud_execution_payer_changed' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.credential_id IS NOT NULL THEN
    RAISE EXCEPTION 'cloud_execution_payer_changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Trigger-only payer admission and renewal guard
REVOKE ALL ON FUNCTION guard_cloud_execution_payer() FROM PUBLIC;
CREATE TRIGGER execution_payer_guard BEFORE INSERT OR UPDATE OF selection,user_id,org_id,workspace_id,kind,credential_id,agent,expires_at,material
  ON cloud_v2_execution_contexts FOR EACH ROW EXECUTE FUNCTION guard_cloud_execution_payer();

-- Payer loss revokes turns without creating actor-wide invalidations for their senders.
-- zeros-expand-exception: execution-payer-revocation Agent-login loss follows the recorded payer while other resource loss stays actor-scoped
CREATE OR REPLACE FUNCTION fence_cloud_execution_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid; organization uuid; cause text := 'access_revoked'; session text; held_only boolean := false; payer_loss boolean := false;
BEGIN
  -- Match request-side UUID order: account/session writers must never deadlock
  -- against a worker renewing or retiring more than one context.
  IF TG_TABLE_NAME='cloud_v2_workspaces' THEN
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE workspace_id=NEW.id AND state='active' AND (NEW.execution_mode<>'active' OR NEW.state NOT IN ('creating','starting','running')
        OR NEW.archived_at IS NOT NULL OR access_epoch<>NEW.access_epoch OR stop_generation<>NEW.stop_generation
        OR worker_boot_id IS DISTINCT FROM NEW.worker_boot_id OR worker_token_hash IS DISTINCT FROM NEW.worker_token_hash) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,
      CASE WHEN NEW.state IN ('stopping','stopped','deleting','deleted','failed') OR NEW.archived_at IS NOT NULL THEN 'cancelled'
           WHEN worker_boot_id IS DISTINCT FROM NEW.worker_boot_id THEN 'worker_changed' ELSE 'actor_changed' END),
      revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
    RETURN NULL;
  ELSIF TG_TABLE_NAME='cloud_github_source_verifications' THEN
    IF NEW.failure_status NOT IN (401,403,404) AND NEW.failure_code NOT IN
      ('github_connection_required','github_authorization_required','github_authorization_expired') OR NEW.failure_code IS NULL THEN RETURN NULL; END IF;
    WITH target AS MATERIALIZED (
      SELECT c.id FROM public.cloud_v2_execution_contexts c
      WHERE c.user_id=NEW.owner_user_id AND c.org_id=NEW.org_id AND c.state='active'
        AND EXISTS(SELECT 1 FROM public.cloud_v2_github_sources s WHERE s.workspace_id=c.workspace_id AND s.repository_id=NEW.repository_id) ORDER BY c.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts c SET state='revoked',reason=coalesce(reason,'access_revoked'),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE c.id IN (SELECT id FROM target);
    INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
      SELECT w.id,NEW.owner_user_id FROM public.cloud_v2_workspaces w
      WHERE w.org_id=NEW.org_id AND w.execution_mode='active' AND w.state<>'deleted'
        AND EXISTS(SELECT 1 FROM public.cloud_v2_github_sources s WHERE s.workspace_id=w.id AND s.repository_id=NEW.repository_id);
    IF FOUND THEN PERFORM pg_notify('zeros_cloud_v2_execution','{}'); END IF;
    RETURN NULL;
  ELSIF TG_TABLE_NAME='cloud_agent_credentials' THEN
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE credential_id=OLD.id AND state='active' ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'actor_changed'),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NULL;
  ELSIF TG_TABLE_NAME='auth_sessions' THEN
    IF NEW.status='active' AND NEW.revoked_at IS NULL THEN RETURN NULL; END IF;
    person := NEW.user_id; session := NEW.provider_session_id;
    IF NEW.provider<>'workos' THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='security_events' THEN
    IF NEW.kind NOT IN ('account.revoked','account.authorization_changed','session.revoked','organization.access_revoked',
      'organization.authorization_changed','workspace.authorization_changed') THEN RETURN NULL; END IF;
    person := NEW.user_id; organization := NEW.org_id;
    payer_loss := NEW.kind IN ('account.revoked','account.authorization_changed','organization.access_revoked','organization.authorization_changed');
    IF NEW.kind='organization.authorization_changed' THEN person := NULL; held_only := true; END IF;
    IF NEW.kind='session.revoked' THEN
      session := NEW.provider_session_id;
      IF person IS NULL OR session IS NULL THEN RETURN NULL; END IF;
    ELSIF NEW.workspace_id IS NOT NULL THEN
      INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
        SELECT NEW.workspace_id,person FROM public.cloud_v2_workspaces WHERE id=NEW.workspace_id AND execution_mode='active';
      WITH target AS MATERIALIZED (
        SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
        WHERE workspace_id=NEW.workspace_id AND state='active' AND (person IS NULL OR user_id=person
          OR (payer_loss AND selection->>'version'='2' AND selection#>>'{payer,userId}'=person::text)) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
      )
      UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'access_revoked'),revoked_at=coalesce(revoked_at,clock_timestamp())
        WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME='users' THEN person := OLD.id; payer_loss := true;
  ELSIF TG_TABLE_NAME='organization_members' THEN
    payer_loss := true;
    IF TG_OP='INSERT' THEN organization := NEW.org_id; held_only := true;
    ELSE person := OLD.user_id; organization := OLD.org_id; END IF;
  ELSIF TG_TABLE_NAME='organizations' THEN
    payer_loss := true;
    organization := OLD.id;
    held_only := NEW.deleted_at IS NULL AND NOT NEW.is_personal AND NEW.cloud_workspaces_allowed;
  ELSIF TG_TABLE_NAME IN ('account_entitlements','staff_pro_benefits') THEN
    IF NOT coalesce(public.app_is_system(),false) THEN
      PERFORM pg_notify('zeros_cloud_v2_execution','{}'); RETURN NULL;
    END IF;
    IF TG_OP='DELETE' THEN person := OLD.user_id; ELSE person := NEW.user_id; END IF;
    WITH target AS MATERIALIZED (
      SELECT c.id FROM public.cloud_v2_execution_contexts c
      WHERE c.org_id IN (SELECT org_id FROM public.organization_members WHERE user_id=person) AND c.state='active'
        AND (public.organization_member_on_hold(c.org_id,c.user_id,10,5)
          OR (c.selection->>'version'='2' AND public.organization_member_on_hold(c.org_id,(c.selection#>>'{payer,userId}')::uuid,10,5))) ORDER BY c.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts c SET state='revoked',reason=coalesce(reason,'access_revoked'),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE c.id IN (SELECT id FROM target);
    INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
      SELECT w.id,m.user_id FROM public.cloud_v2_workspaces w JOIN public.organization_members m ON m.org_id=w.org_id
      WHERE w.execution_mode='active' AND w.state<>'deleted'
        AND w.org_id IN (SELECT org_id FROM public.organization_members WHERE user_id=person)
        AND public.organization_member_on_hold(w.org_id,m.user_id,10,5);
    RETURN NULL;
  ELSIF TG_TABLE_NAME='cloud_agent_organization_connections' THEN
    person := OLD.owner_user_id; organization := OLD.org_id; cause := 'actor_changed';
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE org_id=organization AND state='active' AND agent=OLD.provider
        AND CASE WHEN selection->>'version'='2' THEN selection#>>'{payer,userId}'=person::text ELSE user_id=person END ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,cause),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
    RETURN NULL;
  ELSIF TG_TABLE_NAME IN ('cloud_github_selections','cloud_github_credentials') THEN
    person := OLD.owner_user_id; organization := OLD.org_id; cause := 'actor_changed';
  ELSIF TG_TABLE_NAME='organization_mcp_oauth' THEN
    person := OLD.owner_user_id; organization := OLD.org_id; cause := 'actor_changed';
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE user_id=person AND org_id=organization AND state='active' AND kind='turn' ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,cause),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
    RETURN NULL;
  ELSIF TG_TABLE_NAME='organization_extensions' THEN
    WITH target AS MATERIALIZED (
      SELECT c.id FROM public.cloud_v2_execution_contexts c
      WHERE c.org_id=OLD.org_id AND (OLD.owner_user_id IS NULL OR c.user_id=OLD.owner_user_id) AND c.state='active' AND c.kind='turn' ORDER BY c.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts c SET state='revoked',reason=coalesce(reason,'actor_changed'),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE c.id IN (SELECT id FROM target);
    RETURN NULL;
  END IF;
  IF held_only AND NOT coalesce(public.app_is_system(),false) THEN
    PERFORM pg_notify('zeros_cloud_v2_execution',json_build_object('organizationId',organization)::text);
    RETURN NULL;
  END IF;
  IF session IS NULL AND (person IS NOT NULL OR organization IS NOT NULL) THEN
    -- Defer prompt locks to workspace -> chat reconciliation. This durable
    -- cutoff also cancels accepted sends if the person leaves and rejoins
    -- before the listener recovers; restored access cannot replay old work.
    INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
      SELECT DISTINCT resource.workspace_id,resource.user_id FROM (
        SELECT workspace_id,user_id FROM public.cloud_v2_execution_contexts WHERE state='active'
        UNION ALL SELECT workspace_id,creator_user_id FROM public.cloud_v2_prompt_outbox WHERE state IN ('queued','inboxed','dispatching','accepted')
        UNION ALL SELECT workspace_id,user_id FROM public.cloud_v2_tokens WHERE execution_authority IS NOT NULL AND kind='connect' AND expires_at>clock_timestamp()
        UNION ALL SELECT workspace_id,user_id FROM public.cloud_v2_connected_macs WHERE disconnected_at IS NULL
        UNION ALL SELECT workspace_id,user_id FROM public.cloud_v2_chat_sender_bindings WHERE NOT retired
        UNION ALL SELECT workspace_id,user_id FROM public.cloud_v2_workspace_presence WHERE expires_at>clock_timestamp()
      ) resource JOIN public.cloud_v2_workspaces w ON w.id=resource.workspace_id
      WHERE w.execution_mode='active' AND resource.user_id IS NOT NULL AND (person IS NULL OR resource.user_id=person)
        AND (organization IS NULL OR w.org_id=organization)
        AND (NOT held_only OR public.organization_member_on_hold(w.org_id,resource.user_id,10,5));
    IF FOUND THEN PERFORM pg_notify('zeros_cloud_v2_execution','{}'); END IF;
  END IF;
  IF session IS NOT NULL THEN
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE user_id=person AND provider_session_id=session AND state='active' AND kind IN ('client','terminal') ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,cause),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
  ELSIF person IS NOT NULL THEN
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE (user_id=person OR (payer_loss AND selection->>'version'='2' AND selection#>>'{payer,userId}'=person::text))
        AND state='active' AND (organization IS NULL OR org_id=organization) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,cause),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
  ELSIF organization IS NOT NULL THEN
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE org_id=organization AND state='active'
        AND (NOT held_only OR public.organization_member_on_hold(org_id,user_id,10,5)
          OR (payer_loss AND selection->>'version'='2' AND public.organization_member_on_hold(org_id,(selection#>>'{payer,userId}')::uuid,10,5))) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,cause),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
  END IF;
  IF person IS NOT NULL OR organization IS NOT NULL THEN
    PERFORM pg_notify('zeros_cloud_v2_execution',json_build_object('userId',person,'organizationId',organization)::text);
  END IF;
  IF TG_WHEN='BEFORE' THEN RETURN OLD; END IF;
  RETURN NULL;
END;
$$;
