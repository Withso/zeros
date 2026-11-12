-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces ADD COLUMN sync_context_boot_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(sync_context_boot_ids)<=2);
GRANT UPDATE(sync_context_boot_ids) ON cloud_v2_workspaces TO zeros_app;
CREATE INDEX execution_person_tickets ON cloud_v2_tokens(user_id,workspace_id) WHERE execution_authority IS NOT NULL;

ALTER TABLE cloud_v2_execution_contexts
  ADD COLUMN sync_device_id uuid,
  ADD COLUMN sync_registration_id uuid,
  ADD COLUMN sync_instance_id uuid,
  ADD COLUMN sync_connected_at timestamptz,
  ADD CONSTRAINT execution_sync_binding CHECK (
    (sync_device_id IS NULL AND sync_registration_id IS NULL AND sync_instance_id IS NULL AND sync_connected_at IS NULL)
    OR (sync_device_id IS NOT NULL AND sync_registration_id IS NOT NULL AND sync_instance_id IS NOT NULL
      AND sync_connected_at IS NOT NULL AND kind='client' AND operation IS NULL AND parent_context_id IS NULL
      AND provider_session_id IS NOT NULL AND client_token_expires_at IS NOT NULL));
CREATE UNIQUE INDEX execution_sync_device_active ON cloud_v2_execution_contexts(workspace_id,user_id,sync_device_id)
  WHERE state='active' AND sync_device_id IS NOT NULL;

-- Keep the inputs of a v1 authority while its hash is still verifiable. The
-- new reader verifies that hash before comparing the person's current scope.
CREATE FUNCTION capture_cloud_execution_legacy_basis() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE workspace uuid; person uuid; authority jsonb; basis jsonb;
BEGIN
  IF TG_TABLE_NAME='cloud_v2_execution_contexts' THEN
    workspace := NEW.workspace_id; person := NEW.user_id; authority := NEW.authority;
  ELSIF TG_TABLE_NAME='cloud_v2_workspaces' THEN
    workspace := NEW.id; person := NEW.execution_initiator_user_id; authority := NEW.execution_intent_authority;
  ELSIF TG_TABLE_NAME='cloud_v2_prompt_outbox' THEN
    workspace := NEW.workspace_id; person := NEW.creator_user_id; authority := NEW.execution_authority;
  ELSE
    workspace := NEW.workspace_id; person := NEW.user_id; authority := NEW.execution_authority;
  END IF;
  IF authority IS NULL OR authority ? 'legacyBasis' OR coalesce(authority->>'signatureVersion','1')<>'1' THEN RETURN NEW; END IF;
  SELECT jsonb_build_object('permission',jsonb_build_array(w.id,w.org_id,person,w.creator_user_id,
      u.auth_revision::text,m.authorization_revision::text,m.created_at::text,o.authorization_revision::text,m.role,w.repository,
      coalesce((SELECT jsonb_agg(jsonb_build_object('repository',s.source_repository,'repositoryId',s.repository_id::text)
        ORDER BY s.source_repository) FROM public.cloud_v2_github_sources s WHERE s.workspace_id=w.id),'[]'::jsonb),
      jsonb_build_array((SELECT jsonb_build_array(g.selected_method,g.generation) FROM public.cloud_github_selections g
        WHERE g.org_id=w.org_id AND g.owner_user_id=person),
        (SELECT jsonb_agg(jsonb_build_array(g.id,g.method,g.generation,g.github_user_id) ORDER BY g.method)
          FROM public.cloud_github_credentials g WHERE g.org_id=w.org_id AND g.owner_user_id=person))),
      'policy',jsonb_build_array(o.is_personal,o.cloud_workspaces_allowed,o.deleted_at IS NULL),
      'accessEpoch',w.access_epoch::text,'stopGeneration',w.stop_generation::text,
      'bootId',CASE WHEN TG_TABLE_NAME='cloud_v2_execution_contexts' THEN w.worker_boot_id END,
      'workerTokenHash',CASE WHEN TG_TABLE_NAME='cloud_v2_execution_contexts' THEN encode(w.worker_token_hash,'hex') END) INTO basis
    FROM public.cloud_v2_workspaces w JOIN public.organizations o ON o.id=w.org_id
    JOIN public.organization_members m ON m.org_id=w.org_id AND m.user_id=person
    JOIN public.users u ON u.id=m.user_id WHERE w.id=workspace;
  IF basis IS NULL OR octet_length(basis::text)>65536 THEN RETURN NEW; END IF;
  authority := authority || jsonb_build_object('legacyBasis',basis);
  IF TG_TABLE_NAME='cloud_v2_execution_contexts' THEN NEW.authority := authority;
  ELSIF TG_TABLE_NAME='cloud_v2_workspaces' THEN NEW.execution_intent_authority := authority;
  ELSE NEW.execution_authority := authority;
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Trigger-only legacy signature capture
REVOKE ALL ON FUNCTION capture_cloud_execution_legacy_basis() FROM PUBLIC;
CREATE TRIGGER execution_legacy_context_basis BEFORE INSERT OR UPDATE OF authority ON cloud_v2_execution_contexts
  FOR EACH ROW EXECUTE FUNCTION capture_cloud_execution_legacy_basis();
CREATE TRIGGER execution_legacy_ticket_basis BEFORE INSERT OR UPDATE OF execution_authority ON cloud_v2_tokens
  FOR EACH ROW EXECUTE FUNCTION capture_cloud_execution_legacy_basis();
CREATE TRIGGER execution_legacy_prompt_basis BEFORE INSERT OR UPDATE OF execution_authority ON cloud_v2_prompt_outbox
  FOR EACH ROW EXECUTE FUNCTION capture_cloud_execution_legacy_basis();
CREATE TRIGGER execution_legacy_intent_basis BEFORE UPDATE OF execution_intent_authority ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION capture_cloud_execution_legacy_basis();

-- DDL locks last through these backfills. Refuse an oversized live set before
-- rewriting it; historical rows and v2 authorities need no compatibility copy.
DO $$
BEGIN
  IF (SELECT count(*) FROM (
    SELECT 1 FROM cloud_v2_execution_contexts WHERE state='active' AND expires_at>clock_timestamp()
      AND coalesce(authority->>'signatureVersion','1')='1' AND NOT authority ? 'legacyBasis'
    UNION ALL SELECT 1 FROM cloud_v2_tokens WHERE kind='connect' AND expires_at>clock_timestamp()
      AND execution_authority IS NOT NULL AND coalesce(execution_authority->>'signatureVersion','1')='1' AND NOT execution_authority ? 'legacyBasis'
    UNION ALL SELECT 1 FROM cloud_v2_prompt_outbox WHERE state IN ('queued','inboxed','dispatching','accepted')
      AND execution_authority IS NOT NULL AND coalesce(execution_authority->>'signatureVersion','1')='1' AND NOT execution_authority ? 'legacyBasis'
    UNION ALL SELECT 1 FROM cloud_v2_workspaces WHERE execution_mode='active' AND execution_intent_authority IS NOT NULL
      AND coalesce(execution_intent_authority->>'signatureVersion','1')='1' AND NOT execution_intent_authority ? 'legacyBasis'
    LIMIT 10001
  ) live) > 10000 THEN RAISE EXCEPTION 'cloud_execution_legacy_backfill_limit'; END IF;
END;
$$;
UPDATE cloud_v2_execution_contexts SET authority=authority WHERE state='active' AND expires_at>clock_timestamp()
  AND coalesce(authority->>'signatureVersion','1')='1' AND NOT authority ? 'legacyBasis';
UPDATE cloud_v2_tokens SET execution_authority=execution_authority WHERE execution_authority IS NOT NULL
  AND kind='connect' AND expires_at>clock_timestamp()
  AND coalesce(execution_authority->>'signatureVersion','1')='1' AND NOT execution_authority ? 'legacyBasis';
UPDATE cloud_v2_prompt_outbox SET execution_authority=execution_authority WHERE execution_authority IS NOT NULL
  AND state IN ('queued','inboxed','dispatching','accepted')
  AND coalesce(execution_authority->>'signatureVersion','1')='1' AND NOT execution_authority ? 'legacyBasis';
UPDATE cloud_v2_workspaces SET execution_intent_authority=execution_intent_authority
  WHERE execution_mode='active' AND execution_intent_authority IS NOT NULL
    AND coalesce(execution_intent_authority->>'signatureVersion','1')='1' AND NOT execution_intent_authority ? 'legacyBasis';

-- A cutoff commits with the membership/credential writer. Prompt cancellation
-- takes the workspace/chat lock order later; it cannot authorize another begin.
-- zeros-expand-exception: execution-person-cutoff Revoke only the affected person's material in an active workspace
CREATE FUNCTION fence_cloud_execution_person_resources() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.cloud_v2_tokens SET expires_at=least(expires_at,clock_timestamp())
    WHERE workspace_id=NEW.workspace_id AND (NEW.user_id IS NULL OR user_id=NEW.user_id) AND expires_at>clock_timestamp();
  UPDATE public.cloud_v2_connected_macs SET disconnected_at=clock_timestamp(),syncing=false,sync_wanted=false,is_latest_sender=false
    WHERE workspace_id=NEW.workspace_id AND (NEW.user_id IS NULL OR user_id=NEW.user_id) AND disconnected_at IS NULL;
  UPDATE public.cloud_v2_chat_sender_bindings SET retired=true
    WHERE workspace_id=NEW.workspace_id AND (NEW.user_id IS NULL OR user_id=NEW.user_id) AND NOT retired;
  UPDATE public.local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
    reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
    WHERE workspace_id=NEW.workspace_id AND (NEW.user_id IS NULL OR sender_user_id=NEW.user_id) AND phase IN ('pending','claimed');
  DELETE FROM public.cloud_v2_workspace_presence
    WHERE workspace_id=NEW.workspace_id AND (NEW.user_id IS NULL OR user_id=NEW.user_id);
  PERFORM pg_notify('zeros_cloud_v2_execution',json_build_object('workspaceId',NEW.workspace_id)::text);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Trigger-only personal cutoff
REVOKE ALL ON FUNCTION fence_cloud_execution_person_resources() FROM PUBLIC;
CREATE TRIGGER execution_person_cutoff AFTER INSERT ON cloud_v2_execution_invalidations
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_person_resources();

CREATE FUNCTION fence_cloud_execution_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='local_command_devices' THEN
    WITH target AS MATERIALIZED (SELECT c.id FROM public.cloud_v2_execution_contexts c
      WHERE c.user_id=OLD.user_id AND c.sync_device_id=OLD.device_id AND c.state='active'
        AND (NEW.revoked_at IS NOT NULL OR c.sync_registration_id IS DISTINCT FROM NEW.registration_id
          OR c.sync_instance_id IS DISTINCT FROM NEW.instance_id) ORDER BY c.id FOR UPDATE)
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'access_revoked'),
      revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id IN (SELECT id FROM target);
  ELSIF TG_OP='DELETE' THEN
    WITH target AS MATERIALIZED (SELECT c.id FROM public.cloud_v2_execution_contexts c
      WHERE c.workspace_id=OLD.workspace_id AND c.user_id=OLD.user_id AND c.sync_device_id=OLD.device_id
        AND c.state='active' ORDER BY c.id FOR UPDATE)
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'access_revoked'),
      revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id IN (SELECT id FROM target);
  ELSE
    WITH target AS MATERIALIZED (SELECT c.id FROM public.cloud_v2_execution_contexts c
      WHERE c.workspace_id=NEW.workspace_id AND c.user_id=NEW.user_id AND c.sync_device_id=NEW.device_id AND c.state='active'
        AND (NEW.disconnected_at IS NOT NULL OR c.sync_registration_id IS DISTINCT FROM NEW.registration_id
          OR c.sync_connected_at IS DISTINCT FROM NEW.connected_at) ORDER BY c.id FOR UPDATE)
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'access_revoked'),
      revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id IN (SELECT id FROM target);
  END IF;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Trigger-only sync binding fence
REVOKE ALL ON FUNCTION fence_cloud_execution_sync() FROM PUBLIC;
CREATE TRIGGER execution_sync_device AFTER UPDATE OF registration_id,instance_id,revoked_at ON local_command_devices
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_sync();
CREATE TRIGGER execution_sync_connection AFTER UPDATE OF disconnected_at,registration_id,connected_at OR DELETE ON cloud_v2_connected_macs
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_sync();

-- zeros-expand-exception: execution-person-revocation Personal loss no longer stops an activated organization VM
CREATE OR REPLACE FUNCTION revoke_cloud_v2_security_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'session.revoked' THEN
    -- Missing session identity is never authority to revoke sibling devices.
    -- The relay also reads auth_sessions for open clients and ticket admission.
    UPDATE public.cloud_v2_tokens t SET expires_at = least(t.expires_at, clock_timestamp())
      FROM public.cloud_v2_workspaces w
      WHERE t.workspace_id = w.id AND t.kind = 'connect' AND t.used_at IS NULL
        AND t.user_id = NEW.user_id AND t.provider_session_id = NEW.provider_session_id
        AND (NEW.org_id IS NULL OR w.org_id = NEW.org_id)
        AND (NEW.workspace_id IS NULL OR w.id = NEW.workspace_id);
    PERFORM pg_notify('zeros_security_event', '');
  ELSIF NEW.kind IN ('account.revoked', 'account.authorization_changed',
                    'organization.access_revoked', 'workspace.authorization_changed')
     AND (NEW.user_id IS NOT NULL OR NEW.org_id IS NOT NULL OR NEW.workspace_id IS NOT NULL) THEN
    WITH revoked AS (
      UPDATE public.cloud_v2_workspaces w
      SET access_epoch = access_epoch + 1, worker_token_hash = NULL,
          state = CASE WHEN state IN ('creating','starting','running') THEN 'stopping' ELSE state END,
          attempts = 0, next_attempt_at = NULL, updated_at = clock_timestamp()
      WHERE state <> 'deleted' AND (w.execution_mode<>'active' OR NEW.user_id IS NULL)
        AND (NEW.user_id IS NULL OR w.creator_user_id = NEW.user_id)
        AND (NEW.org_id IS NULL OR w.org_id = NEW.org_id)
        AND (NEW.workspace_id IS NULL OR w.id = NEW.workspace_id)
      RETURNING w.id
    ) UPDATE public.cloud_v2_tokens SET expires_at = least(expires_at, clock_timestamp())
      WHERE workspace_id IN (SELECT id FROM revoked);
    PERFORM pg_notify('zeros_security_event', '');
  END IF;
  RETURN NEW;
END;
$$;

-- zeros-expand-exception: execution-person-revocation Roster changes fence only people whose authority ended
CREATE OR REPLACE FUNCTION fence_cloud_execution_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid; organization uuid; cause text := 'access_revoked'; session text; held_only boolean := false;
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
    IF NEW.kind='organization.authorization_changed' THEN person := NULL; held_only := true; END IF;
    IF NEW.kind='session.revoked' THEN
      session := NEW.provider_session_id;
      IF person IS NULL OR session IS NULL THEN RETURN NULL; END IF;
    ELSIF NEW.workspace_id IS NOT NULL THEN
      INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
        SELECT NEW.workspace_id,person FROM public.cloud_v2_workspaces WHERE id=NEW.workspace_id AND execution_mode='active';
      WITH target AS MATERIALIZED (
        SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
        WHERE workspace_id=NEW.workspace_id AND state='active' AND (person IS NULL OR user_id=person) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
      )
      UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'access_revoked'),revoked_at=coalesce(revoked_at,clock_timestamp())
        WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME='users' THEN person := OLD.id;
  ELSIF TG_TABLE_NAME='organization_members' THEN
    IF TG_OP='INSERT' THEN organization := NEW.org_id; held_only := true;
    ELSE person := OLD.user_id; organization := OLD.org_id; END IF;
  ELSIF TG_TABLE_NAME='organizations' THEN
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
        AND public.organization_member_on_hold(c.org_id,c.user_id,10,5) ORDER BY c.id FOR UPDATE
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
      WHERE user_id=person AND org_id=organization AND state='active' AND agent=OLD.provider ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
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
      WHERE user_id=person AND state='active' AND (organization IS NULL OR org_id=organization) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,cause),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
  ELSIF organization IS NOT NULL THEN
    WITH target AS MATERIALIZED (
      SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
      WHERE org_id=organization AND state='active'
        AND (NOT held_only OR public.organization_member_on_hold(org_id,user_id,10,5)) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
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

CREATE TRIGGER execution_member_insert AFTER INSERT ON organization_members
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_organization_personal AFTER UPDATE OF is_personal ON organizations
  FOR EACH ROW WHEN (OLD.is_personal IS DISTINCT FROM NEW.is_personal) EXECUTE FUNCTION fence_cloud_execution_authority();
