-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Generation and attested OS boot are different from funding-owner history.
-- A transfer back to A must never look like uninterrupted A authority.
ALTER TABLE cloud_workspaces
  ADD COLUMN agent_funding_owner_epoch bigint NOT NULL DEFAULT 1
    CHECK (agent_funding_owner_epoch BETWEEN 1 AND 9007199254740991),
  ADD COLUMN agent_command_mode text NOT NULL DEFAULT 'legacy'
    CHECK (agent_command_mode IN ('legacy','boot-owner-v1')),
  ADD COLUMN agent_boot_id uuid;

CREATE FUNCTION stamp_cloud_agent_funding_owner_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.agent_funding_owner_epoch<>1 THEN
      RAISE EXCEPTION 'initial funding owner epoch is database owned' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.agent_funding_owner_epoch IS DISTINCT FROM OLD.agent_funding_owner_epoch THEN
    RAISE EXCEPTION 'funding owner epoch is database owned' USING ERRCODE='23514';
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    IF OLD.agent_funding_owner_epoch>=9007199254740991 THEN
      RAISE EXCEPTION 'funding owner epoch exhausted' USING ERRCODE='23514';
    END IF;
    NEW.agent_funding_owner_epoch:=OLD.agent_funding_owner_epoch+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_funding_owner_epoch_guard BEFORE INSERT OR UPDATE ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION stamp_cloud_agent_funding_owner_epoch();

ALTER TABLE cloud_workspace_engine_instances ADD COLUMN cloud_local_commands_version integer CHECK(cloud_local_commands_version=1);

CREATE TABLE cloud_agent_boot_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  engine_instance_id uuid NOT NULL UNIQUE,
  boot_id uuid NOT NULL,
  writer_epoch uuid NOT NULL,
  funding_owner_user_id uuid NOT NULL,
  funding_owner_epoch bigint NOT NULL CHECK (funding_owner_epoch BETWEEN 1 AND 9007199254740991),
  mode text NOT NULL DEFAULT 'boot-owner-v1' CHECK (mode='boot-owner-v1'),
  funding_scope text NOT NULL DEFAULT 'workspace-roles-v1' CHECK (funding_scope='workspace-roles-v1'),
  cache_revision bigint NOT NULL DEFAULT 1 CHECK (cache_revision BETWEEN 1 AND 9007199254740991),
  desired_cache_revision bigint NOT NULL DEFAULT 1
    CHECK (desired_cache_revision BETWEEN cache_revision AND 9007199254740991),
  credentials_initialized boolean NOT NULL DEFAULT false,
  initial_adoptions jsonb NOT NULL DEFAULT '[{"provider":"claude","status":"unknown"},{"provider":"codex","status":"unknown"},{"provider":"cursor","status":"unknown"}]'
    CHECK (jsonb_typeof(initial_adoptions)='array' AND jsonb_array_length(initial_adoptions)=3 AND octet_length(initial_adoptions::text)<=2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (id,workspace_id,org_id),
  UNIQUE (workspace_id,writer_epoch),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_engine_instances(id,workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE
);

-- The pointer is a CP binding-row identity, never the caller's wire bootId.
ALTER TABLE cloud_workspaces ADD CONSTRAINT cloud_agent_boot_pointer
  FOREIGN KEY (agent_boot_id,id,org_id) REFERENCES cloud_agent_boot_bindings(id,workspace_id,org_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION preserve_cloud_agent_boot_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM cloud_workspaces workspace
      JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
      JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=workspace.id AND writer.org_id=workspace.org_id
      WHERE workspace.id=NEW.workspace_id AND workspace.org_id=NEW.org_id
        AND workspace.owner_user_id=NEW.funding_owner_user_id AND workspace.agent_funding_owner_epoch=NEW.funding_owner_epoch
        AND engine.id=NEW.engine_instance_id AND engine.generation=NEW.generation AND engine.runtime_boot_id=NEW.boot_id
        AND workspace.current_generation=NEW.generation AND workspace.deleted_at IS NULL
        AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp()
        AND writer.writer_epoch=NEW.writer_epoch AND writer.engine_instance_id=NEW.engine_instance_id
        AND writer.generation=NEW.generation AND writer.boot_id=NEW.boot_id
        AND writer.funding_owner_user_id=NEW.funding_owner_user_id AND writer.funding_owner_epoch=NEW.funding_owner_epoch
        AND writer.state='reserved'
    ) THEN
      RAISE EXCEPTION 'boot binding requires recorded authority' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.engine_instance_id,NEW.boot_id,NEW.writer_epoch,
      NEW.funding_owner_user_id,NEW.funding_owner_epoch,NEW.mode,NEW.funding_scope,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.engine_instance_id,OLD.boot_id,OLD.writer_epoch,
      OLD.funding_owner_user_id,OLD.funding_owner_epoch,OLD.mode,OLD.funding_scope,OLD.created_at)
    OR NEW.cache_revision<OLD.cache_revision OR NEW.desired_cache_revision<OLD.desired_cache_revision
    OR (OLD.credentials_initialized AND (NOT NEW.credentials_initialized OR NEW.initial_adoptions IS DISTINCT FROM OLD.initial_adoptions))
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'boot binding identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_boot_binding_identity BEFORE INSERT OR UPDATE ON cloud_agent_boot_bindings
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_boot_binding();

CREATE FUNCTION verify_cloud_agent_boot_pointer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.agent_command_mode='legacy' THEN
    IF NEW.agent_boot_id IS NOT NULL OR (TG_OP='UPDATE' AND OLD.agent_command_mode<>'legacy') THEN
      RAISE EXCEPTION 'local command authority cannot fall back to legacy' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM cloud_agent_boot_bindings binding
    JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
      AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
    WHERE binding.id=NEW.agent_boot_id AND binding.workspace_id=NEW.id AND binding.org_id=NEW.org_id
      AND binding.engine_instance_id=writer.engine_instance_id AND binding.generation=writer.generation
      AND binding.boot_id=writer.boot_id AND binding.funding_owner_user_id=writer.funding_owner_user_id
      AND binding.funding_owner_epoch=writer.funding_owner_epoch
      AND binding.credentials_initialized AND binding.cache_revision=binding.desired_cache_revision
      AND writer.state IN ('active','retired')
  ) THEN
    RAISE EXCEPTION 'activated local binding is required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_boot_pointer_guard BEFORE INSERT OR UPDATE OF agent_command_mode,agent_boot_id ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION verify_cloud_agent_boot_pointer();

ALTER TABLE cloud_agent_boot_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_boot_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_boot_bindings FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_boot_bindings FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_boot_bindings FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_boot_bindings FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_boot_bindings TO zeros_app;

-- A lost material-response ACK is still a potential holder. This nonsecret
-- journal is written BEFORE access leaves the CP, and retains old source IDs.
CREATE TABLE cloud_agent_boot_source_deliveries (
  binding_id uuid NOT NULL REFERENCES cloud_agent_boot_bindings(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('claude','codex','cursor')),
  credential_id uuid NOT NULL,
  connection_revision bigint NOT NULL DEFAULT 1 CHECK(connection_revision BETWEEN 1 AND 9007199254740991),
  cache_revision bigint NOT NULL DEFAULT 1 CHECK(cache_revision BETWEEN 1 AND 9007199254740991),
  first_delivered_at timestamptz NOT NULL DEFAULT now(),
  retired_proof_id uuid,
  PRIMARY KEY(binding_id,provider,credential_id,connection_revision)
);
CREATE FUNCTION preserve_cloud_agent_source_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM cloud_agent_boot_bindings WHERE id=NEW.binding_id FOR UPDATE;
    IF (SELECT count(*) FROM cloud_agent_boot_source_deliveries WHERE binding_id=NEW.binding_id)>=256 THEN
      RAISE EXCEPTION 'source delivery journal capacity exceeded' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF ROW(NEW.binding_id,NEW.provider,NEW.credential_id,NEW.connection_revision,NEW.cache_revision,NEW.first_delivered_at)
        IS DISTINCT FROM ROW(OLD.binding_id,OLD.provider,OLD.credential_id,OLD.connection_revision,OLD.cache_revision,OLD.first_delivered_at)
      OR (OLD.retired_proof_id IS NOT NULL AND NEW.retired_proof_id IS DISTINCT FROM OLD.retired_proof_id) THEN
      RAISE EXCEPTION 'source delivery identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM cloud_agent_boot_bindings WHERE id=OLD.binding_id) THEN
    RAISE EXCEPTION 'source delivery cannot be forgotten' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER cloud_agent_source_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_agent_boot_source_deliveries
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_source_delivery();

CREATE TABLE cloud_agent_credential_mutations (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=8192),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=16384),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  fence_epoch bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','awaiting-confirmation','removing','cancelling','removed','cancelled','expired','publishing','published')),
  decision text CHECK(decision IN ('remove','cancel','expire','publish')),
  decision_revision bigint,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('preparing','awaiting-confirmation') AND decision IS NULL AND decision_revision IS NULL)
    OR (state IN ('removing','removed') AND decision='remove' AND decision_revision>0)
    OR (state IN ('cancelling','cancelled','expired') AND decision IN ('cancel','expire') AND decision_revision>0)
    OR (state IN ('publishing','published') AND decision='publish' AND decision_revision>0))
);
CREATE INDEX cloud_agent_credential_mutations_owner ON cloud_agent_credential_mutations(owner_user_id,state);
CREATE TABLE cloud_agent_credential_mutation_decisions (
  mutation_id uuid NOT NULL REFERENCES cloud_agent_credential_mutations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('confirm','cancel')),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  PRIMARY KEY(mutation_id,request_id)
);
CREATE TABLE cloud_agent_credential_remote_removals (
  mutation_id uuid PRIMARY KEY REFERENCES cloud_agent_credential_mutations(id) ON DELETE CASCADE,
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=2048)
);
CREATE TABLE cloud_agent_credential_controls (
  id uuid PRIMARY KEY,
  mutation_id uuid NOT NULL REFERENCES cloud_agent_credential_mutations(id) ON DELETE CASCADE,
  -- Preserve the frozen identity even if an old engine is independently
  -- destroyed. Missing rows/lease expiry are never a retirement ACK.
  binding_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('pause-starts','publish-desired','retire','release')),
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 256),
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=32768),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  control_revision bigint NOT NULL DEFAULT 0 CHECK(control_revision BETWEEN 0 AND 9007199254740991),
  acknowledgement jsonb CHECK(acknowledgement IS NULL OR (jsonb_typeof(acknowledgement)='object' AND octet_length(acknowledgement::text)<=262144)),
  UNIQUE(mutation_id,binding_id,operation,attempt)
);
-- Independent CP proof that the entire recorded source no longer exists.
-- This is never a native ACK and cannot rewrite an immutable native receipt.
CREATE TABLE cloud_agent_credential_source_retirements (
  control_id uuid PRIMARY KEY REFERENCES cloud_agent_credential_controls(id) ON DELETE CASCADE,
  proof_kind text NOT NULL CHECK(proof_kind IN ('provider-lifecycle','resident-consumed')),
  proof_id uuid NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cloud_agent_credential_source_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_source_retirements FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_credential_source_retirements FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_credential_source_retirements FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_credential_source_retirements FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,DELETE ON cloud_agent_credential_source_retirements TO zeros_app;
CREATE FUNCTION preserve_cloud_agent_source_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'credential source retirement proof is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER cloud_agent_source_retirement_guard BEFORE UPDATE ON cloud_agent_credential_source_retirements
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_source_retirement();
CREATE FUNCTION preserve_cloud_agent_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.owner_user_id,NEW.target,NEW.source_snapshot,NEW.request_sha256,NEW.fence_epoch,NEW.expires_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.target,OLD.source_snapshot,OLD.request_sha256,OLD.fence_epoch,OLD.expires_at,OLD.created_at)
    OR NEW.revision<OLD.revision
    OR (OLD.decision IS NOT NULL AND ROW(NEW.decision,NEW.decision_revision) IS DISTINCT FROM ROW(OLD.decision,OLD.decision_revision))
    OR (OLD.state IN ('removed','cancelled','expired','published') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'credential mutation identity or decision is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_mutation_guard BEFORE UPDATE ON cloud_agent_credential_mutations
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_mutation();
CREATE FUNCTION preserve_cloud_agent_control() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.mutation_id,NEW.binding_id,NEW.operation,NEW.attempt,NEW.request,NEW.request_sha256)
      IS DISTINCT FROM ROW(OLD.id,OLD.mutation_id,OLD.binding_id,OLD.operation,OLD.attempt,OLD.request,OLD.request_sha256)
    OR NEW.control_revision<OLD.control_revision
    OR (NEW.control_revision=OLD.control_revision AND NEW.acknowledgement IS DISTINCT FROM OLD.acknowledgement)
    OR (OLD.acknowledgement IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'credential control identity or receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_control_guard BEFORE UPDATE ON cloud_agent_credential_controls
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_control();
ALTER TABLE cloud_agent_boot_source_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_boot_source_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_boot_source_deliveries FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_boot_source_deliveries FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_boot_source_deliveries FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_boot_source_deliveries FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_boot_source_deliveries TO zeros_app;

ALTER TABLE cloud_agent_credential_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_credential_mutations FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_credential_mutations FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_credential_mutations FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_credential_mutations FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_credential_mutations TO zeros_app;

ALTER TABLE cloud_agent_credential_mutation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_mutation_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_credential_mutation_decisions FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_credential_mutation_decisions FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_credential_mutation_decisions FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_credential_mutation_decisions FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_credential_mutation_decisions TO zeros_app;

ALTER TABLE cloud_agent_credential_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_credential_controls FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_credential_controls FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_credential_controls FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_credential_controls FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_credential_controls TO zeros_app;

ALTER TABLE cloud_agent_credential_remote_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_remote_removals FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_credential_remote_removals FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_credential_remote_removals FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_credential_remote_removals FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_credential_remote_removals FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_credential_remote_removals TO zeros_app;
GRANT USAGE,SELECT ON SEQUENCE cloud_agent_credential_mutations_fence_epoch_seq TO zeros_app;

-- Only the current ready projection exists. Desired publication clears ALL
-- obsolete access bytes atomically with the source mutation/epoch change.
CREATE TABLE cloud_agent_boot_credentials (
  binding_id uuid NOT NULL REFERENCES cloud_agent_boot_bindings(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('claude','codex','cursor')),
  metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=65536),
  key_version bigint CHECK(key_version BETWEEN 1 AND 9007199254740991),
  nonce bytea, ciphertext bytea, auth_tag bytea,
  PRIMARY KEY(binding_id,provider),
  CHECK ((metadata->>'status'='ready' AND key_version IS NOT NULL AND octet_length(nonce)=12
      AND octet_length(ciphertext) BETWEEN 1 AND 32768 AND octet_length(auth_tag)=16)
    OR (metadata->>'status'='unavailable' AND key_version IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL))
);
ALTER TABLE cloud_agent_boot_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_boot_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_boot_credentials FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_boot_credentials FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_boot_credentials FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_boot_credentials FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_boot_credentials TO zeros_app;

-- Persist actual policy/role source and issuer separately from frozen funding.
CREATE TABLE cloud_agent_funding_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,org_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('guest','member','owner','general')),source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 128),
 subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE,issuer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,owner_epoch bigint NOT NULL CHECK(owner_epoch>0),
 source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),role text NOT NULL CHECK(role IN ('owner','manager','developer','prompter','viewer')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),revoked_at timestamptz,
 UNIQUE(workspace_id,source_kind,source_key),FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
ALTER TABLE cloud_agent_funding_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_funding_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_funding_consents FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_funding_consents FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_funding_consents FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_funding_consents FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_funding_consents TO zeros_app;

-- Real actor contexts are independent of transport grants and legacy leases.
CREATE TABLE cloud_agent_boot_contexts (
  context_id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES cloud_agent_boot_bindings(id) ON DELETE CASCADE,
  actor_session_id uuid NOT NULL REFERENCES cloud_workspace_actor_sessions(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('claude','codex','cursor')),
  conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 128),
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 256),
  cwd text NOT NULL CHECK(length(cwd) BETWEEN 1 AND 2048),
  context_revision text NOT NULL CHECK(context_revision~'^[a-f0-9]{64}$'),
  binding jsonb NOT NULL CHECK(octet_length(binding::text)<=8192),
  organization_revision bigint NOT NULL CHECK(organization_revision>=0),
  member_revision bigint NOT NULL CHECK(member_revision>=0),
  repository_digest text NOT NULL CHECK(repository_digest~'^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
  key_version bigint NOT NULL CHECK(key_version>0),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 2097152),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),retired_at timestamptz
);
CREATE INDEX cloud_agent_boot_context_lookup ON cloud_agent_boot_contexts(binding_id,actor_session_id,provider,conversation_id,created_at);
ALTER TABLE cloud_agent_boot_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_boot_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_boot_contexts FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_boot_contexts FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_boot_contexts FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_boot_contexts FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_boot_contexts TO zeros_app;

-- Nonsecret original selection capture for refresh replay. Global OAuth has
-- its own durable fence; boot publication must never externally rotate again
-- after a lost/rolled-back boot write, or adopt a replaced connection.
CREATE TABLE cloud_agent_boot_refreshes (
  binding_id uuid NOT NULL REFERENCES cloud_agent_boot_bindings(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES cloud_agent_credentials(id) ON DELETE CASCADE,
  credential_revision bigint NOT NULL CHECK(credential_revision BETWEEN 1 AND 9007199254740991),
  expected_cache_revision bigint NOT NULL CHECK(expected_cache_revision BETWEEN 1 AND 9007199254740991),
  expected_material_version bigint NOT NULL CHECK(expected_material_version BETWEEN 1 AND 9007199254740991),
  connection_revision bigint NOT NULL CHECK(connection_revision BETWEEN 1 AND 9007199254740991),
  adoption_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(binding_id,credential_id,credential_revision,expected_cache_revision,expected_material_version)
);
ALTER TABLE cloud_agent_boot_refreshes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_boot_refreshes FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_boot_refreshes FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_boot_refreshes FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_boot_refreshes FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,DELETE ON cloud_agent_boot_refreshes TO zeros_app;

-- Presentation identity uses a private random scoped fingerprint key. A
-- database policy lock fences stale wrapping-root writers during rotation;
-- provider bytes and previous access epochs never enter the mapping table.
CREATE TABLE cloud_agent_adoption_key_policy (
  id smallint PRIMARY KEY CHECK(id=1),
  current_key_version bigint NOT NULL CHECK(current_key_version BETWEEN 1 AND 9007199254740991)
);
CREATE FUNCTION preserve_cloud_agent_adoption_key_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'adoption wrapping policy is persistent' USING ERRCODE='23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.current_key_version<OLD.current_key_version THEN
    RAISE EXCEPTION 'adoption wrapping policy cannot regress' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_adoption_key_policy_guard BEFORE UPDATE OR DELETE ON cloud_agent_adoption_key_policy
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_adoption_key_policy();
-- Account erasure anonymizes the users row. Keep a nonsecret lifecycle fence
-- so a delayed allocator cannot recreate fingerprints after erasure.
CREATE TABLE cloud_agent_adoption_retired_owners (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION preserve_cloud_agent_adoption_retired_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION 'adoption account retirement is persistent' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.user_id,NEW.retired_at) IS DISTINCT FROM ROW(OLD.user_id,OLD.retired_at) THEN
    RAISE EXCEPTION 'adoption account retirement is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_adoption_retired_owner_guard BEFORE UPDATE OR DELETE ON cloud_agent_adoption_retired_owners
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_adoption_retired_owner();
CREATE TABLE cloud_agent_adoption_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  funding_owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('claude','codex','cursor')),
  kind text NOT NULL CHECK(kind IN ('claude-api-key','claude-setup-token','codex-api-key','codex-chatgpt','cursor-api-key')),
  key_version bigint NOT NULL CHECK(key_version BETWEEN 1 AND 9007199254740991),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)=32),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,workspace_id,funding_owner_user_id,provider,kind),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  CHECK(split_part(kind,'-',1)=provider)
);
CREATE TABLE cloud_agent_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES cloud_agent_adoption_keys(id) ON DELETE CASCADE,
  fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(key_id,fingerprint)
);
CREATE FUNCTION preserve_cloud_agent_adoption_key() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- Missing key state is never repaired by assigning a new account alias.
    -- Actual parent lifecycle deletion owns cleanup through these FKs.
    IF EXISTS(SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id)
      AND EXISTS(SELECT 1 FROM users WHERE id=OLD.funding_owner_user_id)
      AND NOT EXISTS(SELECT 1 FROM cloud_agent_adoption_retired_owners WHERE user_id=OLD.funding_owner_user_id) THEN
      RAISE EXCEPTION 'adoption key belongs to parent lifecycle' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM cloud_agent_adoption_key_policy WHERE id=1 AND current_key_version=NEW.key_version) THEN
    RAISE EXCEPTION 'adoption wrapping writer is not current' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
    IF (SELECT count(*) FROM cloud_agent_adoption_keys WHERE workspace_id=NEW.workspace_id)>=32 THEN
      RAISE EXCEPTION 'adoption scope capacity exceeded' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.org_id,NEW.workspace_id,NEW.funding_owner_user_id,NEW.provider,NEW.kind,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.workspace_id,OLD.funding_owner_user_id,OLD.provider,OLD.kind,OLD.created_at)
    OR NEW.key_version<OLD.key_version THEN
    RAISE EXCEPTION 'adoption scope is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_adoption_key_guard BEFORE INSERT OR UPDATE OR DELETE ON cloud_agent_adoption_keys
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_adoption_key();
CREATE FUNCTION bound_cloud_agent_adoptions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM cloud_agent_adoption_keys WHERE id=NEW.key_id FOR UPDATE;
  IF (SELECT count(*) FROM cloud_agent_adoptions WHERE key_id=NEW.key_id)>=256 THEN
    RAISE EXCEPTION 'adoption mapping capacity exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_adoption_capacity BEFORE INSERT ON cloud_agent_adoptions
  FOR EACH ROW EXECUTE FUNCTION bound_cloud_agent_adoptions();
CREATE FUNCTION preserve_cloud_agent_adoption() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM cloud_agent_adoption_keys WHERE id=OLD.key_id) THEN
      RAISE EXCEPTION 'adoption mapping belongs to key lifecycle' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.key_id,NEW.fingerprint,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.key_id,OLD.fingerprint,OLD.created_at) THEN
    RAISE EXCEPTION 'adoption mapping is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_agent_adoption_identity BEFORE UPDATE OR DELETE ON cloud_agent_adoptions
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_agent_adoption();
ALTER TABLE cloud_agent_adoption_key_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoption_key_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoption_retired_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoption_retired_owners FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoption_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_adoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_agent_adoption_key_policy FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_adoption_key_policy FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_adoption_key_policy FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_read ON cloud_agent_adoption_retired_owners FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_adoption_retired_owners FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_read ON cloud_agent_adoption_keys FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_adoption_keys FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_update ON cloud_agent_adoption_keys FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_adoption_keys FOR DELETE USING(app_is_system());
CREATE POLICY system_read ON cloud_agent_adoptions FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_agent_adoptions FOR INSERT WITH CHECK(app_is_system());
CREATE POLICY system_delete ON cloud_agent_adoptions FOR DELETE USING(app_is_system());
GRANT SELECT,INSERT,UPDATE ON cloud_agent_adoption_key_policy TO zeros_app;
GRANT SELECT,INSERT ON cloud_agent_adoption_retired_owners TO zeros_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_adoption_keys TO zeros_app;
GRANT SELECT,INSERT,DELETE ON cloud_agent_adoptions TO zeros_app;

-- Provider vault, recorded contexts/consents and
-- durable D2 mutations are appended only with their retained real-DB controls.
-- Reserving metadata alone never activates the new command path.
