-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Keep the existing single active transition and immutable generation pins.
-- Retaining a VM is an explicit executor, never a fabricated stop/create.
ALTER TABLE cloud_workspace_generation_transitions
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'replace_allocation'
    CHECK (execution_mode IN ('replace_allocation','retain_allocation'));
ALTER TABLE cloud_workspace_generation_transitions
  ADD CONSTRAINT cloud_generation_transition_executor CHECK (
    (execution_mode='retain_allocation' AND operation='upgrade'
      AND drain_intent_id IS NULL AND provision_intent_id IS NULL)
    OR (execution_mode='replace_allocation'
      AND (num_nonnulls(drain_intent_id,provision_intent_id)>0)
      AND (state<>'draining' OR (num_nonnulls(drain_intent_id)=1 AND provision_intent_id IS NULL))
      AND (state NOT IN ('provisioning','setting_up','succeeded') OR num_nonnulls(provision_intent_id)=1))
  ) NOT VALID;
ALTER TABLE cloud_workspace_generation_transitions VALIDATE CONSTRAINT cloud_generation_transition_executor;

-- zeros-expand-exception: widen-check The validated executor check retains the old required-intent rule for every existing executor.
ALTER TABLE cloud_workspace_generation_transitions DROP CONSTRAINT cloud_workspace_generation_transitions_check3;
-- zeros-expand-exception: widen-check The validated executor check retains the old draining-intent rule for every existing executor.
ALTER TABLE cloud_workspace_generation_transitions DROP CONSTRAINT cloud_workspace_generation_transitions_check4;
-- zeros-expand-exception: widen-check The validated executor check retains the old provision-intent rule for every existing executor.
ALTER TABLE cloud_workspace_generation_transitions DROP CONSTRAINT cloud_workspace_generation_transitions_check5;

-- The reservation and provider's original allocation journal never change
-- identity. Only this audited association follows the live generation.
CREATE TABLE cloud_workspace_allocation_owners (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  provider_resource_id text NOT NULL CHECK (char_length(provider_resource_id) BETWEEN 1 AND 512),
  original_generation integer NOT NULL,
  current_generation integer NOT NULL,
  allocation_lease_id uuid UNIQUE REFERENCES managed_compute_allocation_leases(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,provider_resource_id),
  UNIQUE (workspace_id,org_id,provider_resource_id),
  FOREIGN KEY (workspace_id,original_generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,current_generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE
);

CREATE TABLE cloud_workspace_runtime_transitions (
  transition_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  source_engine_instance_id uuid NOT NULL REFERENCES cloud_workspace_engine_instances(id),
  provider_resource_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('bootstrap','engine')),
  phase text NOT NULL DEFAULT 'offered' CHECK (phase IN (
    'offered','staged','activated','enrolling','checking','healthy',
    'rolling_back','rollback_enrolling','rollback_checking','rolled_back','cancelled','recovery_required')),
  execution_fence uuid NOT NULL DEFAULT gen_random_uuid(),
  enrollment_sequence integer NOT NULL DEFAULT 0 CHECK (enrollment_sequence BETWEEN 0 AND 8),
  worker_id text CHECK (char_length(worker_id) BETWEEN 1 AND 128),
  worker_fence uuid,
  worker_expires_at timestamptz,
  activation_policy text CHECK (activation_policy ~ '^[a-z][a-z0-9_-]{0,63}$'),
  source_active jsonb NOT NULL CHECK (jsonb_typeof(source_active)='object' AND octet_length(source_active::text)<=4096),
  target_descriptor jsonb NOT NULL CHECK (jsonb_typeof(target_descriptor)='object' AND octet_length(target_descriptor::text)<=4096),
  controller_active jsonb CHECK (jsonb_typeof(controller_active)='object' AND octet_length(controller_active::text)<=4096),
  stage_deadline_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  activation_deadline_at timestamptz,
  rollback_deadline_at timestamptz,
  activated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,operation_id),
  UNIQUE (transition_id,workspace_id,org_id),
  FOREIGN KEY (transition_id,workspace_id,org_id)
    REFERENCES cloud_workspace_generation_transitions(id,workspace_id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,org_id,provider_resource_id)
    REFERENCES cloud_workspace_allocation_owners(workspace_id,org_id,provider_resource_id),
  CHECK (num_nonnulls(worker_id,worker_fence,worker_expires_at) IN (0,3)),
  CHECK (stage_deadline_at>created_at AND stage_deadline_at<=created_at+interval '16 minutes'),
  CHECK ((phase IN ('healthy','rolled_back','cancelled'))=(completed_at IS NOT NULL))
);
CREATE INDEX cloud_runtime_transition_pending ON cloud_workspace_runtime_transitions(updated_at)
  WHERE phase NOT IN ('healthy','rolled_back','cancelled');

CREATE TABLE cloud_workspace_allocation_transfers (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  provider_resource_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  transition_id uuid NOT NULL,
  source_generation integer NOT NULL,
  target_generation integer NOT NULL,
  engine_instance_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,provider_resource_id,revision),
  FOREIGN KEY (workspace_id,org_id,provider_resource_id)
    REFERENCES cloud_workspace_allocation_owners(workspace_id,org_id,provider_resource_id),
  FOREIGN KEY (transition_id,workspace_id,org_id)
    REFERENCES cloud_workspace_runtime_transitions(transition_id,workspace_id,org_id),
  FOREIGN KEY (workspace_id,source_generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,target_generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  CHECK (source_generation<>target_generation)
);

-- A process/HTTP timeout is not evidence that a destructive provider call has
-- finished. Unknown calls continue blocking transfer until reconciled.
CREATE TABLE cloud_workspace_allocation_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL,
  provider_resource_id text NOT NULL CHECK (char_length(provider_resource_id) BETWEEN 1 AND 512),
  operation text NOT NULL CHECK (operation IN ('start','stop','archive','delete')),
  state text NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','completed','uncertain')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id,generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  CHECK ((state='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX cloud_allocation_operation_pending ON cloud_workspace_allocation_operations(workspace_id,provider_resource_id)
  WHERE state<>'completed';

-- Runtime/base qualification does not prove reversible database/history
-- formats or controller/target compatibility. Publication is operator-owned.
CREATE TABLE cloud_runtime_transfer_qualifications (
  source_runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  target_runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  controller_runtime_id text NOT NULL REFERENCES cloud_runtime_bundles(runtime_id),
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts(base_compatibility_id),
  mode text NOT NULL CHECK (mode IN ('bootstrap','engine')),
  qualification_mode text NOT NULL CHECK (qualification_mode IN ('smoke','full')),
  enabled boolean NOT NULL DEFAULT false,
  qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256)=32),
  PRIMARY KEY (source_runtime_id,target_runtime_id,controller_runtime_id,base_compatibility_id,mode,qualification_mode)
);

-- Row-locking a qualification must not grant the runtime application the
-- ability to publish or alter that qualification.
CREATE FUNCTION cloud_runtime_transfer_qualified(source_id text,target_id text,controller_id text,
  compatibility_id text,execution_mode text,required_mode text)
RETURNS boolean LANGUAGE sql VOLATILE
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT EXISTS(SELECT 1 FROM cloud_runtime_transfer_qualifications
    WHERE app_is_system() AND source_runtime_id=source_id AND target_runtime_id=target_id
      AND controller_runtime_id=controller_id AND base_compatibility_id=compatibility_id
      AND mode=execution_mode AND enabled AND revoked_at IS NULL
      AND (qualification_mode='full' OR qualification_mode=required_mode) FOR SHARE)
$$;
-- Separate one-use enrollment capabilities: these are not setup grants and
-- cannot redeem repository/settings material. Legacy wire execution keys are
-- interpreted as this enrollment ID/sequence only by the transition endpoint.
CREATE TABLE cloud_workspace_runtime_enrollments (
  id uuid PRIMARY KEY,
  transition_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL,
  engine_instance_id uuid NOT NULL UNIQUE,
  account_user_id uuid NOT NULL REFERENCES users(id),
  execution_fence uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 8),
  direction text NOT NULL CHECK (direction IN ('target','rollback')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  active jsonb NOT NULL CHECK (jsonb_typeof(active)='object' AND octet_length(active::text)<=4096),
  controller_active jsonb NOT NULL CHECK (jsonb_typeof(controller_active)='object' AND octet_length(controller_active::text)<=4096),
  report_sha256 bytea NOT NULL CHECK (octet_length(report_sha256)=32),
  health_challenge_sha256 bytea CHECK (octet_length(health_challenge_sha256)=32),
  health_deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,workspace_id,generation,org_id),
  UNIQUE (transition_id,sequence),
  FOREIGN KEY (transition_id,workspace_id,org_id)
    REFERENCES cloud_workspace_runtime_transitions(transition_id,workspace_id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '4 minutes'),
  CHECK ((health_challenge_sha256 IS NULL)=(health_deadline_at IS NULL))
);

ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN runtime_transition_enrollment_id uuid,
  ADD CONSTRAINT cloud_engine_enrollment_kind CHECK (
    (runtime_transition_enrollment_id IS NULL AND num_nonnulls(setup_run_id,setup_execution_fence,registration_grant_id)=3)
    OR (num_nonnulls(runtime_transition_enrollment_id)=1 AND num_nonnulls(setup_run_id,setup_execution_fence,registration_grant_id)=0
      AND num_nonnulls(runtime_id)=1)
  ) NOT VALID,
  ADD CONSTRAINT cloud_engine_transition_enrollment_fkey FOREIGN KEY(runtime_transition_enrollment_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_runtime_enrollments(id,workspace_id,generation,org_id) ON DELETE CASCADE;
ALTER TABLE cloud_workspace_engine_instances VALIDATE CONSTRAINT cloud_engine_enrollment_kind;
-- zeros-expand-exception: nullable-enrollment The validated enrollment-kind check still requires setup_run_id for all old-shape engines.
ALTER TABLE cloud_workspace_engine_instances ALTER COLUMN setup_run_id DROP NOT NULL;
-- zeros-expand-exception: nullable-enrollment The validated enrollment-kind check still requires setup_execution_fence for all old-shape engines.
ALTER TABLE cloud_workspace_engine_instances ALTER COLUMN setup_execution_fence DROP NOT NULL;
-- zeros-expand-exception: nullable-enrollment The validated enrollment-kind check still requires registration_grant_id for all old-shape engines.
ALTER TABLE cloud_workspace_engine_instances ALTER COLUMN registration_grant_id DROP NOT NULL;
ALTER TABLE cloud_workspace_runtime_enrollments ADD CONSTRAINT cloud_runtime_enrollment_engine_fkey
  FOREIGN KEY(engine_instance_id) REFERENCES cloud_workspace_engine_instances(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION preserve_cloud_engine_enrollment_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NEW.runtime_transition_enrollment_id IS DISTINCT FROM OLD.runtime_transition_enrollment_id OR NEW.enrollment_order IS DISTINCT FROM OLD.enrollment_order THEN
    RAISE EXCEPTION 'engine enrollment identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_engine_enrollment_kind BEFORE UPDATE
  ON cloud_workspace_engine_instances FOR EACH ROW EXECUTE FUNCTION preserve_cloud_engine_enrollment_kind();

-- Existing setup enrollment keeps its complete original checks. Only the
-- separately bound transition capability takes the additional branch below.
-- zeros-expand-exception: enrollment-trigger The unchanged runtime guard still runs for every legacy row; the FK-bound enrollment branch has its own pin and capability guard.
DROP TRIGGER cloud_engine_runtime_binding ON cloud_workspace_engine_instances;
CREATE TRIGGER cloud_engine_runtime_binding BEFORE INSERT OR UPDATE ON cloud_workspace_engine_instances
  FOR EACH ROW WHEN (NEW.runtime_transition_enrollment_id IS NULL)
  EXECUTE FUNCTION enforce_cloud_engine_runtime_binding();
-- zeros-expand-exception: enrollment-trigger The unchanged setup-fence guard still runs for every legacy row; the immutable enrollment branch has a current-sequence fence.
DROP TRIGGER cloud_engine_current_setup_fence ON cloud_workspace_engine_instances;
CREATE TRIGGER cloud_engine_current_setup_fence
  BEFORE INSERT OR UPDATE OF state,setup_run_id,setup_execution_fence,workspace_id,generation,org_id
  ON cloud_workspace_engine_instances FOR EACH ROW WHEN (NEW.runtime_transition_enrollment_id IS NULL)
  EXECUTE FUNCTION enforce_cloud_engine_current_setup_fence();

CREATE FUNCTION enforce_cloud_engine_transition_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.account_user_id,
    NEW.runtime_id,NEW.runtime_manifest_sha256,NEW.runtime_base_image_id,NEW.runtime_base_compatibility_id,
    NEW.runtime_profile,NEW.runtime_engine_protocol_version,NEW.runtime_installer_receipt_sha256,NEW.runtime_boot_id,NEW.runtime_supervisor_session_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.account_user_id,
    OLD.runtime_id,OLD.runtime_manifest_sha256,OLD.runtime_base_image_id,OLD.runtime_base_compatibility_id,
    OLD.runtime_profile,OLD.runtime_engine_protocol_version,OLD.runtime_installer_receipt_sha256,OLD.runtime_boot_id,OLD.runtime_supervisor_session_id) THEN
    RAISE EXCEPTION 'transition engine identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.protocol_version IS DISTINCT FROM NEW.runtime_engine_protocol_version
    OR num_nonnulls(NEW.agent_runtime_profile,NEW.agent_runtime_contract_sha256)<>0
    OR NOT EXISTS(SELECT 1 FROM cloud_workspace_generations generation
      WHERE generation.workspace_id=NEW.workspace_id AND generation.org_id=NEW.org_id AND generation.generation=NEW.generation
        AND ROW(generation.runtime_id,generation.runtime_manifest_sha256,generation.runtime_base_image_id,
          generation.runtime_base_compatibility_id,generation.runtime_profile,generation.runtime_engine_protocol_version)
          = ROW(NEW.runtime_id,NEW.runtime_manifest_sha256,NEW.runtime_base_image_id,
            NEW.runtime_base_compatibility_id,NEW.runtime_profile,NEW.runtime_engine_protocol_version)) THEN
    RAISE EXCEPTION 'transition engine pin does not match its generation' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
    WHERE enrollment.id=NEW.runtime_transition_enrollment_id AND enrollment.engine_instance_id=NEW.id
      AND enrollment.workspace_id=NEW.workspace_id AND enrollment.org_id=NEW.org_id
      AND enrollment.generation=NEW.generation AND enrollment.account_user_id=NEW.account_user_id
      AND ROW(enrollment.active->>'runtimeId',enrollment.active->>'manifestSha256',enrollment.active->>'baseCompatibilityId',
        enrollment.active->>'installerReceiptSha256',(enrollment.active->>'bootId')::uuid,(enrollment.active->>'supervisorSessionId')::uuid)
        = ROW(NEW.runtime_id,NEW.runtime_manifest_sha256,NEW.runtime_base_compatibility_id,
          NEW.runtime_installer_receipt_sha256,NEW.runtime_boot_id,NEW.runtime_supervisor_session_id)) THEN
    RAISE EXCEPTION 'transition engine witness does not match its enrollment' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' OR (NEW.state='ready' AND OLD.state IS DISTINCT FROM 'ready') THEN
    IF (TG_OP='INSERT' AND NEW.state<>'starting') OR (TG_OP='UPDATE' AND OLD.state<>'starting') OR NOT EXISTS(
      SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
      JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
      JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
      WHERE enrollment.id=NEW.runtime_transition_enrollment_id AND enrollment.revoked_at IS NULL
        AND enrollment.expires_at>clock_timestamp() AND enrollment.execution_fence=runtime.execution_fence
        AND enrollment.sequence=runtime.enrollment_sequence
        AND ((enrollment.direction='target' AND enrollment.generation=transition.candidate_generation
          AND runtime.phase='enrolling' AND runtime.activation_deadline_at>clock_timestamp())
          OR (enrollment.direction='rollback' AND enrollment.generation=transition.source_generation
          AND runtime.phase='rollback_enrolling' AND runtime.rollback_deadline_at>clock_timestamp()))
        AND (NEW.state<>'ready' OR enrollment.consumed_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'transition enrollment capability is not current' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_engine_transition_binding BEFORE INSERT OR UPDATE ON cloud_workspace_engine_instances
  FOR EACH ROW WHEN (NEW.runtime_transition_enrollment_id IS NOT NULL)
  EXECUTE FUNCTION enforce_cloud_engine_transition_binding();

CREATE TABLE cloud_workspace_runtime_attestations (
  enrollment_id uuid NOT NULL REFERENCES cloud_workspace_runtime_enrollments(id) ON DELETE CASCADE,
  engine_instance_id uuid NOT NULL REFERENCES cloud_workspace_engine_instances(id),
  health_challenge_sha256 bytea NOT NULL CHECK(octet_length(health_challenge_sha256)=32),
  engine_health text NOT NULL CHECK(engine_health='ready'),
  durable_record_connected boolean NOT NULL CHECK(durable_record_connected),
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,health_challenge_sha256)
);

-- Monotonic enrollment ordering covers normal setup and retained launches,
-- including failed launches and same-transaction timestamp ties.
ALTER TABLE cloud_workspace_engine_instances ADD COLUMN enrollment_order bigserial;
GRANT USAGE,SELECT ON SEQUENCE cloud_workspace_engine_instances_enrollment_order_seq TO zeros_app;
CREATE UNIQUE INDEX cloud_engine_enrollment_order ON cloud_workspace_engine_instances(enrollment_order);

-- Allocation billing identities are immutable; authority follows the audited owner.
-- zeros-expand-exception: allocation-authority The new owner join is absent for old-code allocations, preserving every old join and all monetary identities.
CREATE OR REPLACE FUNCTION public.cloud_workspace_compute_authority_live(target_workspace_id uuid, target_generation integer)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_generations generation
    JOIN provider_connection_versions version ON version.connection_id=generation.provider_connection_id
      AND version.org_id=generation.org_id AND version.version=generation.provider_connection_version
    LEFT JOIN managed_compute_provider_requirements requirement ON requirement.provider=generation.provider
    WHERE generation.workspace_id=target_workspace_id AND generation.generation=target_generation
      AND (version.credential_source='delegated' OR NOT coalesce(requirement.require_credit,true) OR EXISTS (
        SELECT 1 FROM managed_compute_allocation_leases lease
        LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=lease.workspace_id AND owner.org_id=lease.org_id
          AND owner.provider_resource_id=lease.provider_resource_id AND owner.allocation_lease_id=lease.id
        JOIN cloud_workspaces workspace ON workspace.id=lease.workspace_id AND workspace.org_id=lease.org_id
          AND workspace.current_generation=coalesce(owner.current_generation,lease.generation) AND workspace.current_billing_epoch=lease.billing_epoch
          AND workspace.owner_user_id=lease.user_id
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=lease.workspace_id
          AND binding.org_id=lease.org_id AND binding.generation=coalesce(owner.current_generation,lease.generation)
          AND binding.provider_resource_id=lease.provider_resource_id
        JOIN managed_compute_credit_reservations reservation ON reservation.id=lease.id
          AND reservation.workspace_id=lease.workspace_id AND reservation.org_id=lease.org_id
          AND reservation.generation=lease.generation AND reservation.billing_epoch=lease.billing_epoch
          AND reservation.user_id=lease.user_id AND reservation.policy_id=lease.policy_id
          AND reservation.seconds_per_dollar=lease.seconds_per_dollar
        WHERE lease.workspace_id=generation.workspace_id AND lease.org_id=generation.org_id
          AND coalesce(owner.current_generation,lease.generation)=generation.generation AND lease.provider=generation.provider
          AND lease.state IN ('active','draining')
          AND lease.provider_expires_at > clock_timestamp() AND lease.funded_until > clock_timestamp()
          AND reservation.state='open' AND reservation.meter_since <= clock_timestamp()
          AND reservation.covered_until > clock_timestamp() AND reservation.reserved_micro_usd > 0
      ))
  )
$function$;

-- An allocation may only cross identical provider/base/resource identities.
-- Audit insertion and pointer publication are checked at commit, allowing the
-- unique provider binding to move without an observable intermediate owner.
CREATE FUNCTION enforce_cloud_allocation_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' AND (ROW(NEW.workspace_id,NEW.org_id,NEW.provider_resource_id,NEW.original_generation,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.provider_resource_id,OLD.original_generation,OLD.created_at)
    OR (NEW.current_generation=OLD.current_generation AND NEW.revision<>OLD.revision)
    OR (NEW.current_generation<>OLD.current_generation AND NEW.revision<>OLD.revision+1)) THEN
    RAISE EXCEPTION 'allocation identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM cloud_workspace_generations source JOIN cloud_workspace_generations target
    ON target.workspace_id=source.workspace_id AND target.org_id=source.org_id
    WHERE source.workspace_id=NEW.workspace_id AND source.org_id=NEW.org_id AND source.generation=NEW.original_generation
      AND target.generation=NEW.current_generation AND source.runtime_id IS NOT NULL
      AND ROW(source.provider,source.provider_connection_id,source.provider_connection_version,source.image_ref,source.sandbox_class,
        source.architecture,source.cpu_millicores,source.memory_mib,source.storage_mib,source.runtime_base_image_id,source.runtime_base_compatibility_id)
        IS NOT DISTINCT FROM ROW(target.provider,target.provider_connection_id,target.provider_connection_version,target.image_ref,target.sandbox_class,
        target.architecture,target.cpu_millicores,target.memory_mib,target.storage_mib,target.runtime_base_image_id,target.runtime_base_compatibility_id)) THEN
    RAISE EXCEPTION 'allocation compatibility mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.allocation_lease_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM managed_compute_allocation_leases lease
    WHERE lease.id=NEW.allocation_lease_id AND lease.workspace_id=NEW.workspace_id AND lease.org_id=NEW.org_id
      AND lease.provider_resource_id=NEW.provider_resource_id) THEN
    RAISE EXCEPTION 'allocation funding mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.allocation_lease_id IS DISTINCT FROM OLD.allocation_lease_id AND OLD.allocation_lease_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM managed_compute_allocation_leases WHERE id=OLD.allocation_lease_id AND state<>'settled') THEN
    RAISE EXCEPTION 'allocation funding remains unsettled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_allocation_owner_identity BEFORE INSERT OR UPDATE ON cloud_workspace_allocation_owners
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_allocation_owner();

CREATE FUNCTION verify_cloud_allocation_transfer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NEW.current_generation=OLD.current_generation THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM cloud_workspace_allocation_transfers evidence
    JOIN cloud_workspace_runtime_enrollments enrollment ON enrollment.engine_instance_id=evidence.engine_instance_id
      AND enrollment.transition_id=evidence.transition_id AND enrollment.workspace_id=evidence.workspace_id AND enrollment.org_id=evidence.org_id
      AND enrollment.generation=evidence.target_generation AND enrollment.consumed_at IS NOT NULL AND enrollment.revoked_at IS NULL
    JOIN cloud_workspace_engine_instances engine ON engine.id=enrollment.engine_instance_id AND engine.state='ready'
    JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=evidence.transition_id
      AND runtime.enrollment_sequence=enrollment.sequence AND runtime.phase IN ('checking','rollback_checking')
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=evidence.workspace_id AND binding.org_id=evidence.org_id
      AND binding.generation=evidence.target_generation AND binding.provider_resource_id=evidence.provider_resource_id
    JOIN cloud_workspaces workspace ON workspace.id=evidence.workspace_id AND workspace.org_id=evidence.org_id
      AND workspace.current_generation=evidence.target_generation
    WHERE evidence.workspace_id=NEW.workspace_id AND evidence.org_id=NEW.org_id AND evidence.provider_resource_id=NEW.provider_resource_id
      AND evidence.revision=NEW.revision AND evidence.source_generation=OLD.current_generation AND evidence.target_generation=NEW.current_generation) THEN
    RAISE EXCEPTION 'allocation transfer lacks atomic enrollment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cloud_allocation_transfer_atomic AFTER UPDATE ON cloud_workspace_allocation_owners
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_cloud_allocation_transfer();

CREATE FUNCTION enforce_cloud_runtime_enrollment_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['consumed_at','revoked_at','health_challenge_sha256','health_deadline_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','revoked_at','health_challenge_sha256','health_deadline_at'])
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'runtime enrollment identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_runtime_enrollment_identity BEFORE UPDATE ON cloud_workspace_runtime_enrollments
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_runtime_enrollment_identity();

CREATE FUNCTION verify_cloud_runtime_health_attestation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
    JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
    JOIN cloud_workspace_engine_instances engine ON engine.id=enrollment.engine_instance_id
    WHERE enrollment.id=NEW.enrollment_id AND enrollment.engine_instance_id=NEW.engine_instance_id
      AND enrollment.consumed_at IS NOT NULL AND enrollment.revoked_at IS NULL
      AND enrollment.sequence=runtime.enrollment_sequence AND enrollment.execution_fence=runtime.execution_fence
      AND enrollment.health_deadline_at>clock_timestamp() AND enrollment.health_challenge_sha256=NEW.health_challenge_sha256
      AND runtime.phase IN ('checking','rollback_checking') AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'runtime health proof is not current' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_runtime_health_attestation BEFORE INSERT OR UPDATE ON cloud_workspace_runtime_attestations
  FOR EACH ROW EXECUTE FUNCTION verify_cloud_runtime_health_attestation();

CREATE FUNCTION enforce_cloud_retained_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME='cloud_workspace_lifecycle_intents' THEN
    IF EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions WHERE id=NEW.generation_transition_id AND execution_mode='retain_allocation') THEN
      RAISE EXCEPTION 'retained transition cannot own a provider lifecycle intent' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
    RAISE EXCEPTION 'transition executor is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_retained_transition_intent BEFORE INSERT OR UPDATE ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_retained_transition();
CREATE TRIGGER cloud_retained_transition_executor BEFORE UPDATE ON cloud_workspace_generation_transitions
  FOR EACH ROW EXECUTE FUNCTION enforce_cloud_retained_transition();


ALTER TABLE cloud_workspace_allocation_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_allocation_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_allocation_owners FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_workspace_allocation_owners TO zeros_app;
CREATE POLICY system_insert ON cloud_workspace_allocation_owners FOR INSERT WITH CHECK(app_is_system());
GRANT INSERT ON cloud_workspace_allocation_owners TO zeros_app;
CREATE POLICY system_update ON cloud_workspace_allocation_owners FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
GRANT UPDATE ON cloud_workspace_allocation_owners TO zeros_app;

ALTER TABLE cloud_workspace_runtime_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_runtime_transitions FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_workspace_runtime_transitions TO zeros_app;
CREATE POLICY system_insert ON cloud_workspace_runtime_transitions FOR INSERT WITH CHECK(app_is_system());
GRANT INSERT ON cloud_workspace_runtime_transitions TO zeros_app;
CREATE POLICY system_update ON cloud_workspace_runtime_transitions FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
GRANT UPDATE ON cloud_workspace_runtime_transitions TO zeros_app;

ALTER TABLE cloud_workspace_allocation_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_allocation_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_allocation_transfers FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_workspace_allocation_transfers TO zeros_app;
CREATE POLICY system_insert ON cloud_workspace_allocation_transfers FOR INSERT WITH CHECK(app_is_system());
GRANT INSERT ON cloud_workspace_allocation_transfers TO zeros_app;

ALTER TABLE cloud_workspace_allocation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_allocation_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_allocation_operations FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_workspace_allocation_operations TO zeros_app;
CREATE POLICY system_insert ON cloud_workspace_allocation_operations FOR INSERT WITH CHECK(app_is_system());
GRANT INSERT ON cloud_workspace_allocation_operations TO zeros_app;
CREATE POLICY system_update ON cloud_workspace_allocation_operations FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
GRANT UPDATE ON cloud_workspace_allocation_operations TO zeros_app;

ALTER TABLE cloud_runtime_transfer_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_transfer_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_runtime_transfer_qualifications FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_runtime_transfer_qualifications TO zeros_app;

ALTER TABLE cloud_workspace_runtime_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_runtime_enrollments FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_workspace_runtime_enrollments TO zeros_app;
CREATE POLICY system_insert ON cloud_workspace_runtime_enrollments FOR INSERT WITH CHECK(app_is_system());
GRANT INSERT ON cloud_workspace_runtime_enrollments TO zeros_app;
CREATE POLICY system_update ON cloud_workspace_runtime_enrollments FOR UPDATE USING(app_is_system()) WITH CHECK(app_is_system());
GRANT UPDATE ON cloud_workspace_runtime_enrollments TO zeros_app;

ALTER TABLE cloud_workspace_runtime_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_runtime_attestations FOR SELECT USING(app_is_system());
GRANT SELECT ON cloud_workspace_runtime_attestations TO zeros_app;
CREATE POLICY system_insert ON cloud_workspace_runtime_attestations FOR INSERT WITH CHECK(app_is_system());
GRANT INSERT ON cloud_workspace_runtime_attestations TO zeros_app;

-- PostgreSQL requires UPDATE privilege to lock a selected qualification row;
-- SELECT-only RLS still forbids qualification publication by zeros_app.
GRANT UPDATE ON cloud_runtime_transfer_qualifications TO zeros_app;
CREATE POLICY system_lock ON cloud_runtime_transfer_qualifications FOR UPDATE USING(app_is_system()) WITH CHECK(false);

CREATE FUNCTION preserve_cloud_runtime_transition_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF ROW(NEW.transition_id,NEW.workspace_id,NEW.org_id,NEW.operation_id,NEW.source_engine_instance_id,NEW.provider_resource_id,
      NEW.mode,NEW.execution_fence,NEW.source_active,NEW.target_descriptor,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.transition_id,OLD.workspace_id,OLD.org_id,OLD.operation_id,OLD.source_engine_instance_id,OLD.provider_resource_id,
      OLD.mode,OLD.execution_fence,OLD.source_active,OLD.target_descriptor,OLD.created_at)
    OR NEW.stage_deadline_at>OLD.stage_deadline_at
    OR (OLD.activation_deadline_at IS NOT NULL AND (NEW.activation_deadline_at IS NULL OR NEW.activation_deadline_at>OLD.activation_deadline_at))
    OR (OLD.rollback_deadline_at IS NOT NULL AND (NEW.rollback_deadline_at IS NULL OR NEW.rollback_deadline_at>OLD.rollback_deadline_at))
    OR (OLD.controller_active IS NOT NULL AND NEW.controller_active IS DISTINCT FROM OLD.controller_active)
    OR NEW.enrollment_sequence<OLD.enrollment_sequence THEN
    RAISE EXCEPTION 'runtime transition identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_runtime_transition_identity BEFORE UPDATE ON cloud_workspace_runtime_transitions
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_runtime_transition_identity();

-- Legacy INSERT ... SELECT writers may carry the prior receipt's new column.
-- Always allocate ordering at the database boundary, never trust copied input.
CREATE FUNCTION stamp_cloud_engine_enrollment_order() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  NEW.enrollment_order:=nextval('cloud_workspace_engine_instances_enrollment_order_seq');
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_engine_enrollment_order BEFORE INSERT ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION stamp_cloud_engine_enrollment_order();
