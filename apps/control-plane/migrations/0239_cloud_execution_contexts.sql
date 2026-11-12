-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Activation requires the separate drain/clean-boot rollout. An N-1 insert
-- remains legacy; advertising a worker feature cannot change this mode.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'legacy' CHECK (execution_mode IN ('legacy','prepared','active')),
  ADD COLUMN execution_initiator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN execution_intent_id uuid,
  ADD COLUMN execution_intent_authority jsonb CHECK (jsonb_typeof(execution_intent_authority)='object'),
  ADD COLUMN acting_user_boot_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(acting_user_boot_ids)<=2);
ALTER TABLE cloud_v2_prompt_chats
  ADD COLUMN acting_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN acting_generation bigint NOT NULL DEFAULT 0 CHECK (acting_generation BETWEEN 0 AND 9223372036854775806),
  ADD COLUMN active_context_id uuid;

-- Activated boots install personal environments per context after boot-clean.
-- The old global ready report remains required for legacy and prepared modes.
-- zeros-expand-exception: execution-environment-gate Preserve global environment readiness until explicit shared-execution activation.
CREATE OR REPLACE FUNCTION cloud_environment_ready_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.execution_mode<>'active' AND NEW.state='running' AND EXISTS (SELECT 1 FROM public.cloud_workspace_environment_pins p
    WHERE p.workspace_id=NEW.id AND (p.ready_boot_id IS NULL OR NEW.worker_boot_id IS NULL OR p.ready_boot_id IS DISTINCT FROM NEW.worker_boot_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cloud_environment_not_ready', CONSTRAINT='cloud_environment_ready';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE cloud_v2_execution_boots (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  boot_id uuid NOT NULL,
  access_epoch bigint NOT NULL,
  stop_generation bigint NOT NULL,
  worker_token_hash bytea NOT NULL CHECK (octet_length(worker_token_hash)=32),
  replaced_by uuid,
  retirement_id uuid,
  retirement_hash bytea CHECK (octet_length(retirement_hash)=32),
  retired_count integer CHECK (retired_count>=0),
  clean_at timestamptz,
  last_processes integer CHECK (last_processes>=0),
  first_failed_processes integer CHECK (first_failed_processes>0),
  first_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,boot_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  CHECK ((clean_at IS NULL)=(retired_count IS NULL)),
  CHECK (clean_at IS NULL OR (retirement_id IS NOT NULL AND retirement_hash IS NOT NULL AND last_processes=0)),
  CHECK (replaced_by IS DISTINCT FROM boot_id)
);
CREATE INDEX cloud_execution_replaced_boots ON cloud_v2_execution_boots(workspace_id,stop_generation,replaced_by);

-- A departed/erased person leaves a cleanup barrier. Cascading the context on
-- user or membership deletion would let another actor begin before retirement.
CREATE TABLE cloud_v2_execution_contexts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('turn','terminal','client','bootstrap')),
  chat_id text CHECK (char_length(chat_id) BETWEEN 1 AND 256),
  user_message_id text CHECK (char_length(user_message_id) BETWEEN 1 AND 256),
  dispatch_id uuid,
  generation bigint CHECK (generation BETWEEN 1 AND 9223372036854775806),
  chat_epoch bigint,
  client_id uuid,
  terminal_id text CHECK (char_length(terminal_id) BETWEEN 1 AND 256),
  request_id text CHECK (char_length(request_id) BETWEEN 1 AND 256),
  operation text CHECK (char_length(operation) BETWEEN 1 AND 128),
  parent_context_id uuid,
  intent_id uuid,
  client_token_expires_at timestamptz,
  request_fingerprint bytea CHECK (octet_length(request_fingerprint)=32),
  provider_session_id text CHECK (char_length(provider_session_id) BETWEEN 1 AND 512),
  access_epoch bigint NOT NULL,
  stop_generation bigint NOT NULL,
  worker_boot_id uuid NOT NULL,
  worker_token_hash bytea NOT NULL CHECK (octet_length(worker_token_hash)=32),
  authority jsonb NOT NULL CHECK (jsonb_typeof(authority)='object'),
  source_fingerprint text NOT NULL CHECK (char_length(source_fingerprint) BETWEEN 1 AND 4096),
  agent text CHECK (agent IN ('codex','claude','cursor')),
  selection jsonb CHECK (jsonb_typeof(selection)='object'),
  credential_id uuid REFERENCES cloud_agent_credentials(id) ON DELETE SET NULL,
  environment_repository_id bigint,
  environment_version_id uuid,
  mcp_fingerprint text,
  sender_device_id uuid,
  sender_registration_id uuid,
  sender_binding_generation bigint,
  material jsonb CHECK (jsonb_typeof(material)='object' AND octet_length(material::text)<=16777216),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','retired')),
  reason text CHECK (reason IN ('completed','cancelled','access_revoked','actor_changed','expired','worker_changed','client_closed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  retired_at timestamptz,
  retirement_id uuid,
  retirement_hash bytea CHECK (octet_length(retirement_hash)=32),
  UNIQUE(id,workspace_id,org_id),
  UNIQUE(id,workspace_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(parent_context_id,workspace_id,org_id) REFERENCES cloud_v2_execution_contexts(id,workspace_id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,user_id,environment_repository_id,environment_version_id)
    REFERENCES cloud_environment_versions(org_id,owner_user_id,repository_id,id) ON DELETE SET NULL (environment_version_id),
  CHECK (kind<>'turn' OR (chat_id IS NOT NULL AND user_message_id IS NOT NULL AND dispatch_id IS NOT NULL
    AND generation IS NOT NULL AND chat_epoch IS NOT NULL AND agent IS NOT NULL AND selection IS NOT NULL)),
  CHECK (kind<>'terminal' OR terminal_id IS NOT NULL),
  CHECK (kind<>'client' OR client_id IS NOT NULL),
  CHECK (kind<>'bootstrap' OR intent_id IS NOT NULL),
  CHECK ((retired_at IS NOT NULL)=(state='retired')),
  CHECK ((retirement_id IS NULL)=(retirement_hash IS NULL))
);
CREATE UNIQUE INDEX cloud_execution_dispatch ON cloud_v2_execution_contexts(workspace_id,user_message_id,dispatch_id) WHERE kind='turn';
CREATE UNIQUE INDEX cloud_execution_live_turn ON cloud_v2_execution_contexts(workspace_id,chat_id) WHERE kind='turn' AND state<>'retired';
CREATE UNIQUE INDEX cloud_execution_live_terminal ON cloud_v2_execution_contexts(workspace_id,worker_boot_id,terminal_id) WHERE kind='terminal' AND state<>'retired';
CREATE UNIQUE INDEX cloud_execution_client_request ON cloud_v2_execution_contexts(workspace_id,client_id,request_id) WHERE kind='client';
CREATE UNIQUE INDEX cloud_execution_terminal_request ON cloud_v2_execution_contexts(workspace_id,client_id,request_id) WHERE kind='terminal';
CREATE UNIQUE INDEX cloud_execution_bootstrap ON cloud_v2_execution_contexts(workspace_id,intent_id,worker_boot_id) WHERE kind='bootstrap';
CREATE INDEX cloud_execution_workspace_live ON cloud_v2_execution_contexts(workspace_id,id) WHERE state='active';
CREATE INDEX cloud_execution_person_live ON cloud_v2_execution_contexts(user_id,org_id,workspace_id) WHERE state='active';
CREATE INDEX cloud_execution_organization_live ON cloud_v2_execution_contexts(org_id,user_id) WHERE state='active';
CREATE INDEX cloud_execution_session_live ON cloud_v2_execution_contexts(user_id,provider_session_id) WHERE state='active' AND provider_session_id IS NOT NULL;
CREATE INDEX cloud_execution_credential_live ON cloud_v2_execution_contexts(credential_id) WHERE state='active' AND credential_id IS NOT NULL;
CREATE INDEX cloud_execution_expiry ON cloud_v2_execution_contexts(expires_at) WHERE state='active';
CREATE INDEX cloud_execution_environment_pin ON cloud_v2_execution_contexts(environment_version_id) WHERE environment_version_id IS NOT NULL;
CREATE INDEX cloud_execution_retirement ON cloud_v2_execution_contexts(workspace_id,retired_at) WHERE state='retired';
CREATE INDEX cloud_execution_pending_cleanup ON cloud_v2_execution_contexts(workspace_id,id) WHERE state='revoked';
CREATE INDEX cloud_execution_parent_context ON cloud_v2_execution_contexts(parent_context_id) WHERE parent_context_id IS NOT NULL;
CREATE INDEX cloud_execution_pending_sender ON cloud_v2_prompt_outbox(creator_user_id,workspace_id,created_at)
  WHERE state IN ('queued','inboxed','dispatching','accepted');

CREATE TABLE cloud_v2_execution_invalidations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_execution_invalidations_workspace ON cloud_v2_execution_invalidations(workspace_id,created_at);
ALTER TABLE cloud_v2_execution_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_invalidations USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_execution_invalidations TO zeros_app;
GRANT USAGE,SELECT ON SEQUENCE cloud_v2_execution_invalidations_id_seq TO zeros_app;

ALTER TABLE cloud_v2_tokens ADD COLUMN execution_authority jsonb CHECK (jsonb_typeof(execution_authority)='object');

ALTER TABLE cloud_v2_prompt_chats ADD CONSTRAINT cloud_prompt_active_context
  FOREIGN KEY(active_context_id,workspace_id) REFERENCES cloud_v2_execution_contexts(id,workspace_id) ON DELETE SET NULL(active_context_id);
ALTER TABLE cloud_v2_prompt_outbox
  ADD COLUMN execution_authority jsonb CHECK (jsonb_typeof(execution_authority)='object'),
  ADD COLUMN execution_context_id uuid,
  ADD COLUMN execution_parent_context_id uuid,
  ADD CONSTRAINT cloud_prompt_execution_context FOREIGN KEY(execution_context_id,workspace_id)
    REFERENCES cloud_v2_execution_contexts(id,workspace_id) ON DELETE SET NULL(execution_context_id),
  ADD CONSTRAINT cloud_prompt_parent_context FOREIGN KEY(execution_parent_context_id,workspace_id)
    REFERENCES cloud_v2_execution_contexts(id,workspace_id) ON DELETE SET NULL(execution_parent_context_id);

CREATE TABLE cloud_v2_execution_tokens (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  context_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api','proxy')),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(context_id,kind),
  FOREIGN KEY(context_id,workspace_id,org_id) REFERENCES cloud_v2_execution_contexts(id,workspace_id,org_id) ON DELETE CASCADE
);

CREATE TABLE cloud_v2_chat_sender_bindings (
  workspace_id uuid NOT NULL,
  chat_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9223372036854775806),
  access_epoch bigint NOT NULL,
  retired boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,chat_id,user_id),
  FOREIGN KEY(workspace_id,chat_id) REFERENCES cloud_v2_prompt_chats(workspace_id,chat_id) ON DELETE CASCADE
);
CREATE INDEX cloud_chat_binding_person ON cloud_v2_chat_sender_bindings(user_id,workspace_id);
ALTER TABLE local_command_requests ADD COLUMN context_id uuid,
  ADD CONSTRAINT local_command_execution_context FOREIGN KEY(context_id,workspace_id)
    REFERENCES cloud_v2_execution_contexts(id,workspace_id) ON DELETE CASCADE;
ALTER TABLE cloud_v2_notifications ADD COLUMN context_id uuid,
  ADD CONSTRAINT notification_execution_context FOREIGN KEY(context_id,workspace_id)
    REFERENCES cloud_v2_execution_contexts(id,workspace_id) ON DELETE CASCADE;
CREATE INDEX local_command_execution_context ON local_command_requests(context_id) WHERE context_id IS NOT NULL AND phase IN ('pending','claimed');

-- zeros-expand-exception: execution-sender-fence Preserve legacy enqueue fencing while activated requests bind the running context.
CREATE OR REPLACE FUNCTION fence_local_command_sender() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
    reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
    WHERE workspace_id=NEW.workspace_id AND chat_id=NEW.chat_id AND phase IN ('pending','claimed')
      AND (context_id IS NULL OR NEW.epoch IS DISTINCT FROM OLD.epoch);
  RETURN NEW;
END;
$$;

ALTER TABLE cloud_v2_execution_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_contexts USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_v2_execution_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_tokens USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_v2_chat_sender_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_chat_sender_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_chat_sender_bindings USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_v2_execution_boots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_boots FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_boots USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_execution_contexts,cloud_v2_execution_tokens,cloud_v2_chat_sender_bindings,cloud_v2_execution_boots TO zeros_app;

-- Context rows never lock a workspace or chat from a trigger. Request paths
-- hold workspace -> chat -> context; cleanup of prompt receipts uses that order.
-- zeros-expand-exception: execution-material-erasure Erases only the new execution-token rows when their context loses authority.
CREATE FUNCTION erase_cloud_execution_material() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_WHEN='BEFORE' THEN
    IF NEW.user_id IS NULL AND NEW.state='active' THEN
      NEW.state := 'revoked'; NEW.reason := coalesce(NEW.reason,'access_revoked');
      NEW.revoked_at := coalesce(NEW.revoked_at,clock_timestamp());
    END IF;
    IF NEW.state<>'active' THEN NEW.material := NULL; NEW.environment_version_id := NULL; END IF;
    RETURN NEW;
  END IF;
  DELETE FROM public.cloud_v2_execution_tokens WHERE context_id=NEW.id;
  UPDATE public.local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
    reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
    WHERE context_id=NEW.id AND phase IN ('pending','claimed');
  PERFORM pg_notify('zeros_cloud_v2_execution',json_build_object('workspaceId',NEW.workspace_id,'contextId',NEW.id)::text);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from the new execution-material erasure trigger
REVOKE ALL ON FUNCTION erase_cloud_execution_material() FROM PUBLIC;
CREATE TRIGGER execution_material_erase BEFORE UPDATE OF state,user_id ON cloud_v2_execution_contexts
  FOR EACH ROW EXECUTE FUNCTION erase_cloud_execution_material();
CREATE TRIGGER execution_context_revoked AFTER UPDATE OF state,user_id ON cloud_v2_execution_contexts
  FOR EACH ROW WHEN (OLD.state='active' AND NEW.state<>'active') EXECUTE FUNCTION erase_cloud_execution_material();

CREATE FUNCTION fence_cloud_execution_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid; organization uuid; cause text := 'access_revoked'; session text;
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
      WHERE c.user_id=NEW.owner_user_id AND c.org_id=NEW.org_id AND c.state='active' AND c.source_fingerprint=NEW.fingerprint
        AND EXISTS(SELECT 1 FROM public.cloud_v2_github_sources s WHERE s.workspace_id=c.workspace_id AND s.repository_id=NEW.repository_id) ORDER BY c.id FOR UPDATE
    )
    UPDATE public.cloud_v2_execution_contexts c SET state='revoked',reason=coalesce(reason,'access_revoked'),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE c.id IN (SELECT id FROM target);
    INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
      SELECT DISTINCT p.workspace_id,NEW.owner_user_id FROM public.cloud_v2_prompt_outbox p JOIN public.cloud_v2_workspaces w ON w.id=p.workspace_id
      WHERE p.creator_user_id=NEW.owner_user_id AND w.org_id=NEW.org_id AND w.execution_mode='active'
        AND p.state IN ('queued','inboxed','dispatching','accepted')
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
    IF NEW.kind='session.revoked' THEN
      session := NEW.provider_session_id;
      IF person IS NULL OR session IS NULL THEN RETURN NULL; END IF;
    ELSIF NEW.workspace_id IS NOT NULL THEN
      WITH target AS MATERIALIZED (
        SELECT cloud_v2_execution_contexts.id FROM public.cloud_v2_execution_contexts
        WHERE workspace_id=NEW.workspace_id AND state='active' AND (person IS NULL OR user_id=person) ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
      )
      UPDATE public.cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,'access_revoked'),revoked_at=coalesce(revoked_at,clock_timestamp())
        WHERE cloud_v2_execution_contexts.id IN (SELECT id FROM target);
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME='users' THEN person := OLD.id;
  ELSIF TG_TABLE_NAME='organization_members' THEN person := OLD.user_id; organization := OLD.org_id;
  ELSIF TG_TABLE_NAME='organizations' THEN organization := OLD.id;
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
  IF session IS NULL AND (person IS NOT NULL OR organization IS NOT NULL) THEN
    -- Defer prompt locks to workspace -> chat reconciliation. This durable
    -- cutoff also cancels accepted sends if the person leaves and rejoins
    -- before the listener recovers; restored access cannot replay old work.
    INSERT INTO public.cloud_v2_execution_invalidations(workspace_id,user_id)
      SELECT DISTINCT p.workspace_id,person FROM public.cloud_v2_prompt_outbox p JOIN public.cloud_v2_workspaces w ON w.id=p.workspace_id
      WHERE w.execution_mode='active' AND (person IS NULL OR p.creator_user_id=person) AND (organization IS NULL OR w.org_id=organization)
        AND p.state IN ('queued','inboxed','dispatching','accepted');
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
      WHERE org_id=organization AND state='active' ORDER BY cloud_v2_execution_contexts.id FOR UPDATE
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
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from the new execution-authority fencing trigger
REVOKE ALL ON FUNCTION fence_cloud_execution_authority() FROM PUBLIC;
CREATE TRIGGER execution_workspace_fence AFTER UPDATE OF state,archived_at,access_epoch,stop_generation,worker_boot_id,worker_token_hash,execution_mode ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_source_fence AFTER INSERT OR UPDATE OF failure_code,failure_status ON cloud_github_source_verifications
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_credential_delete BEFORE DELETE ON cloud_agent_credentials FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_credential_update AFTER UPDATE OF revision,revoked_at ON cloud_agent_credentials
  FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at) EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_session_fence AFTER INSERT OR UPDATE OF status,revoked_at ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_security_fence AFTER INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_user_fence AFTER UPDATE OF auth_revision,auth_status,deleted_at ON users
  FOR EACH ROW WHEN (OLD.auth_revision IS DISTINCT FROM NEW.auth_revision OR OLD.auth_status IS DISTINCT FROM NEW.auth_status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_member_delete AFTER DELETE ON organization_members FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_member_update AFTER UPDATE OF role,authorization_revision ON organization_members
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.authorization_revision IS DISTINCT FROM NEW.authorization_revision) EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_organization_update AFTER UPDATE OF authorization_revision,cloud_workspaces_allowed,deleted_at ON organizations
  FOR EACH ROW WHEN (OLD.authorization_revision IS DISTINCT FROM NEW.authorization_revision OR OLD.cloud_workspaces_allowed IS DISTINCT FROM NEW.cloud_workspaces_allowed OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_entitlement_fence AFTER INSERT OR UPDATE OR DELETE ON account_entitlements FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_staff_benefit_fence AFTER INSERT OR UPDATE OR DELETE ON staff_pro_benefits FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_connection_fence AFTER UPDATE OR DELETE ON cloud_agent_organization_connections FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_github_selection_fence AFTER UPDATE OF selected_method,generation OR DELETE ON cloud_github_selections FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_github_credential_fence AFTER UPDATE OF generation OR DELETE ON cloud_github_credentials FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_mcp_definition_fence AFTER UPDATE OR DELETE ON organization_extensions FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
CREATE TRIGGER execution_mcp_oauth_fence AFTER UPDATE OF sign_in_revision OR DELETE ON organization_mcp_oauth FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority();
