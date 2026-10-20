-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- NULL preserves the conservative attempt-based cadence of legacy workers
-- and rows. Only an accepted successful create/wake dispatch initializes this
-- counter; it never resets the original dispatched_at or any error deadline.
ALTER TABLE cloud_workspace_lifecycle_intents ADD COLUMN healthy_observation_count smallint
  CHECK (healthy_observation_count IS NULL OR
    (operation IN ('create','wake') AND healthy_observation_count BETWEEN 1 AND 3));

ALTER TABLE cloud_workspace_lifecycle_intents ADD CONSTRAINT cloud_lifecycle_intent_scope
  UNIQUE (id,workspace_id,org_id,generation);

-- One immutable scheduling edge, created only after the allocator refuses an
-- exact previous allocation. No FK to the monetary lease or allocation owner:
-- an implicit KEY SHARE there would invert workspace/lease lock order.
CREATE TABLE cloud_workspace_lifecycle_allocation_waits (
  lifecycle_intent_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  operation cloud_workspace_operation NOT NULL CHECK (operation IN ('create','wake')),
  owner_user_id uuid NOT NULL,
  billing_epoch bigint NOT NULL CHECK (billing_epoch>0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch>0),
  source_binding_id uuid,
  provider text NOT NULL,
  provider_connection_id uuid NOT NULL,
  provider_connection_version bigint NOT NULL CHECK (provider_connection_version>0),
  provider_resource_id text CHECK (char_length(provider_resource_id) BETWEEN 1 AND 512),
  resume_after_intent_id uuid,
  prerequisite_operation cloud_workspace_operation,
  prerequisite_request_id uuid,
  prerequisite_checkpoint_id uuid,
  allocation_lease_id uuid NOT NULL,
  allocation_generation integer NOT NULL CHECK (allocation_generation>0),
  allocation_lifecycle_intent_id uuid NOT NULL,
  allocation_user_id uuid NOT NULL,
  allocation_billing_epoch bigint NOT NULL CHECK (allocation_billing_epoch>0),
  allocation_resource_id text CHECK (char_length(allocation_resource_id) BETWEEN 1 AND 512),
  allocation_owner_present boolean NOT NULL,
  allocation_owner_revision bigint NOT NULL CHECK (allocation_owner_revision>=0),
  allocation_owner_original_generation integer,
  allocation_owner_current_generation integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved','retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (lifecycle_intent_id,workspace_id,org_id,generation)
    REFERENCES cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation) ON DELETE CASCADE,
  CHECK ((state='pending')=(resolved_at IS NULL)),
  CHECK (CASE WHEN resume_after_intent_id IS NULL THEN
      num_nonnulls(prerequisite_operation,prerequisite_request_id,prerequisite_checkpoint_id)=0
    WHEN prerequisite_operation IN ('stop','archive','delete') THEN num_nonnulls(prerequisite_request_id,prerequisite_checkpoint_id)=2
    ELSE prerequisite_operation IS NOT NULL AND num_nonnulls(prerequisite_request_id,prerequisite_checkpoint_id)=0 END),
  CHECK ((allocation_owner_present AND allocation_owner_original_generation>0 AND allocation_owner_current_generation=generation
      AND num_nonnulls(allocation_owner_original_generation,allocation_owner_current_generation)=2)
    OR (NOT allocation_owner_present AND allocation_owner_revision=0
      AND num_nonnulls(allocation_owner_original_generation,allocation_owner_current_generation)=0))
);
CREATE INDEX cloud_lifecycle_allocation_wait_active ON cloud_workspace_lifecycle_allocation_waits(workspace_id,org_id,lifecycle_intent_id)
  WHERE state IN ('pending','resolved');
CREATE INDEX cloud_lifecycle_allocation_wait_lease ON cloud_workspace_lifecycle_allocation_waits(allocation_lease_id,allocation_generation)
  WHERE state='pending';
CREATE INDEX cloud_lifecycle_allocation_wait_provider ON cloud_workspace_lifecycle_allocation_waits(provider_connection_id,provider_connection_version)
  WHERE state IN ('pending','resolved');
ALTER TABLE cloud_workspace_lifecycle_allocation_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_lifecycle_allocation_waits FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_lifecycle_allocation_waits USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_lifecycle_allocation_waits TO zeros_app;

-- Scheduling proof only. The ordinary runtime/provider/funding/claim checks
-- still run after this reader. Missing identity is invalid, never settlement.
-- No row locks here: settlement must never wait for a workspace/intent writer.
CREATE FUNCTION cloud_lifecycle_allocation_wait_status(target_intent uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE
    WHEN wait.state='retired' OR workspace.id IS NULL OR intent.id IS NULL OR generation.workspace_id IS NULL
      OR binding.workspace_id IS NULL OR lease.id IS NULL OR original.workspace_id IS NULL OR generation.retired_at IS NOT NULL
      OR connection.id IS NULL OR connection.state<>'active' OR version.connection_id IS NULL OR version.retired_at IS NOT NULL
      OR (version.credential_expires_at IS NOT NULL AND version.credential_expires_at<=clock_timestamp()+interval '5 minutes')
      OR ROW(workspace.owner_user_id,workspace.current_billing_epoch,workspace.authority_epoch,workspace.agent_boot_id,
        workspace.current_generation,workspace.desired_state,workspace.deleted_at)
        IS DISTINCT FROM ROW(wait.owner_user_id,wait.billing_epoch,wait.authority_epoch,wait.source_binding_id,
          wait.generation,'running'::cloud_workspace_desired_state,NULL::timestamptz)
      OR intent.operation<>wait.operation OR intent.state NOT IN ('queued','observing','dispatching')
      OR intent.resume_after_intent_id IS DISTINCT FROM wait.resume_after_intent_id
      OR ROW(generation.provider,generation.provider_connection_id,generation.provider_connection_version)
        IS DISTINCT FROM ROW(wait.provider,wait.provider_connection_id,wait.provider_connection_version)
      OR ROW(original.provider,original.provider_connection_id,original.provider_connection_version)
        IS DISTINCT FROM ROW(wait.provider,wait.provider_connection_id,wait.provider_connection_version)
      OR ROW(binding.provider,binding.provider_connection_id,binding.provider_connection_version,binding.provider_resource_id)
        IS DISTINCT FROM ROW(wait.provider,wait.provider_connection_id,wait.provider_connection_version,wait.provider_resource_id)
      OR ROW(lease.workspace_id,lease.org_id,lease.generation,lease.lifecycle_intent_id,lease.user_id,lease.billing_epoch,
        lease.provider,lease.provider_resource_id)
        IS DISTINCT FROM ROW(wait.workspace_id,wait.org_id,wait.allocation_generation,wait.allocation_lifecycle_intent_id,
          wait.allocation_user_id,wait.allocation_billing_epoch,wait.provider,wait.allocation_resource_id)
      OR (owner.workspace_id IS NOT NULL)<>wait.allocation_owner_present
      OR coalesce(owner.revision,0)<>wait.allocation_owner_revision
      OR owner.original_generation IS DISTINCT FROM wait.allocation_owner_original_generation
      OR owner.current_generation IS DISTINCT FROM wait.allocation_owner_current_generation
      OR (owner.workspace_id IS NOT NULL AND owner.allocation_lease_id IS DISTINCT FROM wait.allocation_lease_id)
      OR EXISTS (SELECT 1 FROM managed_compute_allocation_leases replacement
        WHERE replacement.workspace_id=wait.workspace_id AND replacement.org_id=wait.org_id AND replacement.state<>'settled'
          AND replacement.id NOT IN (wait.allocation_lease_id,wait.lifecycle_intent_id)
          AND coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners WHERE allocation_lease_id=replacement.id),replacement.generation)=wait.generation)
      OR (wait.resume_after_intent_id IS NOT NULL AND (prerequisite.id IS NULL
        OR prerequisite.workspace_id<>wait.workspace_id OR prerequisite.org_id<>wait.org_id
        OR prerequisite.generation<>wait.generation OR prerequisite.operation IS DISTINCT FROM wait.prerequisite_operation
        OR prerequisite.state IN ('failed','superseded')))
      -- A resolved wait may introduce its own new allocation. B's destructive
      -- dispatch proof intentionally stops matching that new latest allocation;
      -- retain and recheck the exact historical receipt accepted for this edge.
      -- No other replacement is allowed by the allocation/source fences above.
      OR (wait.prerequisite_checkpoint_id IS NOT NULL AND (recovery.lifecycle_intent_id IS NULL
        OR recovery.state NOT IN ('proven','resolved') OR saved_request.id IS NULL OR checkpoint.id IS NULL OR engine.id IS NULL
        OR ROW(recovery.proven_request_id,recovery.checkpoint_id,recovery.allocation_lease_id,recovery.provider_resource_id)
          IS DISTINCT FROM ROW(wait.prerequisite_request_id,wait.prerequisite_checkpoint_id,wait.allocation_lease_id,wait.provider_resource_id)
        OR saved_request.state<>'succeeded' OR saved_request.checkpoint_id IS DISTINCT FROM wait.prerequisite_checkpoint_id
        OR saved_request.reason NOT IN ('before_stop','before_archive','before_delete','before_rebuild')
        OR checkpoint.reason<>saved_request.reason OR checkpoint.state<>'durable' OR checkpoint.invalidated_at IS NOT NULL
        OR checkpoint.durable_at IS NULL OR checkpoint.authority_epoch<>recovery.authority_epoch
        OR engine.registered_at<>recovery.registered_at OR engine.heartbeat_token_hash<>recovery.registration_token_sha256
        OR engine.registered_at>checkpoint.durable_at OR engine.final_checkpoint_at IS NULL OR engine.registered_at>engine.final_checkpoint_at
        OR engine.runtime_id IS DISTINCT FROM recovery.runtime_id OR (recovery.boot_id IS NOT NULL AND engine.runtime_boot_id IS DISTINCT FROM recovery.boot_id)
        OR EXISTS (SELECT 1 FROM cloud_workspace_engine_instances newer WHERE newer.workspace_id=wait.workspace_id
          AND newer.org_id=wait.org_id AND newer.generation=wait.generation AND newer.enrollment_order>engine.enrollment_order)
        OR (coalesce(engine.cloud_local_commands_version,0)=1 AND NOT EXISTS (
          SELECT 1 FROM cloud_workspace_local_command_writers writer WHERE writer.workspace_id=wait.workspace_id AND writer.org_id=wait.org_id
            AND writer.generation=wait.generation AND writer.engine_instance_id=engine.id AND writer.boot_id=recovery.boot_id
            AND writer.writer_epoch=recovery.writer_epoch AND writer.funding_owner_user_id=recovery.funding_owner_user_id
            AND writer.funding_owner_epoch=recovery.funding_owner_epoch AND writer.activated_at IS NOT NULL
            AND writer.sealed_sequence IS NOT NULL AND writer.seal_ack IS NOT NULL))
        OR EXISTS (SELECT 1 FROM cloud_workspace_local_command_writers writer
          JOIN cloud_workspace_engine_instances writer_engine ON writer_engine.id=writer.engine_instance_id
          WHERE writer.workspace_id=wait.workspace_id AND writer.org_id=wait.org_id AND writer.generation=wait.generation
            AND writer.activated_at IS NOT NULL AND (writer.sealed_sequence IS NULL OR writer.seal_ack IS NULL
              OR (writer.writer_epoch IS DISTINCT FROM recovery.writer_epoch
                AND NOT (writer.state='retired' AND writer_engine.enrollment_order<engine.enrollment_order))))))
      THEN 'invalid'
    WHEN lease.state='settled' AND lease.settled_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM managed_compute_credit_reservations reservation WHERE reservation.id=lease.id AND reservation.state='open')
      AND (wait.resume_after_intent_id IS NULL OR (prerequisite.state='succeeded'
        AND (prerequisite.operation NOT IN ('stop','archive','delete') OR
          (wait.prerequisite_checkpoint_id IS NOT NULL AND (wait.state='resolved' OR cloud_final_save_proven(prerequisite.id))))))
      AND (wait.source_binding_id IS NULL OR EXISTS (SELECT 1 FROM cloud_agent_boot_bindings source
        WHERE source.id=wait.source_binding_id AND source.workspace_id=wait.workspace_id AND source.org_id=wait.org_id
          AND source.generation=wait.generation AND source.retired_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch
        WHERE dispatch.workspace_id=wait.workspace_id AND dispatch.org_id=wait.org_id AND dispatch.generation=wait.generation
          AND dispatch.settled_at IS NULL)
      THEN 'ready'
    ELSE 'pending' END
  FROM cloud_workspace_lifecycle_allocation_waits wait
  LEFT JOIN cloud_workspaces workspace ON workspace.id=wait.workspace_id AND workspace.org_id=wait.org_id
  LEFT JOIN cloud_workspace_lifecycle_intents intent ON intent.id=wait.lifecycle_intent_id AND intent.workspace_id=wait.workspace_id
    AND intent.org_id=wait.org_id AND intent.generation=wait.generation
  LEFT JOIN cloud_workspace_generations generation ON generation.workspace_id=wait.workspace_id AND generation.org_id=wait.org_id
    AND generation.generation=wait.generation
  LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=wait.workspace_id AND binding.org_id=wait.org_id
    AND binding.generation=wait.generation
  LEFT JOIN managed_compute_allocation_leases lease ON lease.id=wait.allocation_lease_id
  LEFT JOIN cloud_workspace_generations original ON original.workspace_id=lease.workspace_id AND original.org_id=lease.org_id
    AND original.generation=lease.generation
  LEFT JOIN provider_connections connection ON connection.id=wait.provider_connection_id AND connection.org_id=wait.org_id
    AND connection.provider=wait.provider
  LEFT JOIN provider_connection_versions version ON version.connection_id=connection.id AND version.org_id=connection.org_id
    AND version.version=wait.provider_connection_version
  LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=wait.workspace_id AND owner.org_id=wait.org_id
    AND owner.provider_resource_id=wait.allocation_resource_id
  LEFT JOIN cloud_workspace_lifecycle_intents prerequisite ON prerequisite.id=wait.resume_after_intent_id
  LEFT JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=prerequisite.id
    AND recovery.workspace_id=wait.workspace_id AND recovery.org_id=wait.org_id AND recovery.generation=wait.generation
  LEFT JOIN workspace_checkpoint_requests saved_request ON saved_request.id=wait.prerequisite_request_id
    AND saved_request.workspace_id=wait.workspace_id AND saved_request.org_id=wait.org_id AND saved_request.generation=wait.generation
  LEFT JOIN workspace_checkpoints checkpoint ON checkpoint.id=wait.prerequisite_checkpoint_id
    AND checkpoint.workspace_id=wait.workspace_id AND checkpoint.org_id=wait.org_id AND checkpoint.generation=wait.generation
  LEFT JOIN cloud_workspace_engine_instances engine ON engine.id=recovery.engine_instance_id
    AND engine.workspace_id=wait.workspace_id AND engine.org_id=wait.org_id AND engine.generation=wait.generation
  WHERE wait.lifecycle_intent_id=target_intent AND app_is_system()
$$;

CREATE FUNCTION preserve_cloud_lifecycle_allocation_wait() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','resolved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','resolved_at'])
    OR (OLD.state='retired' AND NEW.state<>'retired') OR (OLD.state='resolved' AND NEW.state='pending')
    OR (OLD.state='pending' AND NEW.state='resolved'
      AND cloud_lifecycle_allocation_wait_status(OLD.lifecycle_intent_id) IS DISTINCT FROM 'ready')
    OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
    RAISE EXCEPTION 'allocation wait identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_allocation_wait_immutable BEFORE UPDATE ON cloud_workspace_lifecycle_allocation_waits
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_lifecycle_allocation_wait();

-- Old workers may ignore UPDATE RETURNING. Reject the unsafe transition so
-- their transaction must roll back; never silently rewrite dispatching.
CREATE FUNCTION require_cloud_lifecycle_allocation_dependency() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wait cloud_workspace_lifecycle_allocation_waits;
BEGIN
  IF NEW.state='dispatching' AND NEW.operation IN ('create','wake') THEN
    SELECT * INTO wait FROM cloud_workspace_lifecycle_allocation_waits WHERE lifecycle_intent_id=NEW.id;
    IF FOUND AND (wait.state<>'resolved' OR cloud_lifecycle_allocation_wait_status(NEW.id) IS DISTINCT FROM 'ready'
      OR ROW(NEW.workspace_id,NEW.org_id,NEW.generation,NEW.operation,NEW.resume_after_intent_id)
        IS DISTINCT FROM ROW(wait.workspace_id,wait.org_id,wait.generation,wait.operation,wait.resume_after_intent_id)) THEN
      RAISE EXCEPTION 'allocation dependency is not resolved' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_allocation_dependency BEFORE INSERT OR UPDATE ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION require_cloud_lifecycle_allocation_dependency();

CREATE FUNCTION cloud_lifecycle_allocation_wait_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',NEW.workspace_id,NEW.org_id,clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_allocation_wait_jobs AFTER INSERT ON cloud_workspace_lifecycle_allocation_waits
  FOR EACH ROW EXECUTE FUNCTION cloud_lifecycle_allocation_wait_jobs();

-- This producer holds a monetary lease. It only writes the queue, never
-- locking or changing waiters/workspaces/intents. Always enqueue the exact
-- workspace, even if no wait is visible: a concurrent edge may commit and
-- drain its own enqueue before this transaction commits. The queue row
-- serializes both producers; one harmless hint without a waiter is bounded
-- to this lease's single settled transition.
CREATE FUNCTION cloud_lifecycle_allocation_settled_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',NEW.workspace_id,NEW.org_id,clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_allocation_settled_jobs AFTER UPDATE OF state ON managed_compute_allocation_leases
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state='settled')
  EXECUTE FUNCTION cloud_lifecycle_allocation_settled_jobs();

-- Changes to frozen scope only schedule re-evaluation. That reader retires
-- stale continuations under the usual parent/intent locks; no replacement
-- scope is adopted, and unchanged pending rows have no recurring due time.
CREATE FUNCTION cloud_lifecycle_allocation_scope_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope_workspace uuid; scope_org uuid; changed_row record;
  changed_connection uuid; changed_version bigint;
BEGIN
  IF TG_OP='DELETE' THEN changed_row=OLD; ELSE changed_row=NEW; END IF;
  IF TG_TABLE_NAME IN ('provider_connections','provider_connection_versions') THEN
    IF TG_TABLE_NAME='provider_connections' THEN changed_connection=changed_row.id;
    ELSE changed_connection=changed_row.connection_id; changed_version=changed_row.version; END IF;
    PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',matched.workspace_id,matched.org_id,clock_timestamp())
      FROM (SELECT DISTINCT wait.workspace_id,wait.org_id FROM cloud_workspace_lifecycle_allocation_waits wait
        WHERE wait.provider_connection_id=changed_connection AND (changed_version IS NULL OR wait.provider_connection_version=changed_version)
          AND wait.state IN ('pending','resolved')) matched;
  ELSE
    IF TG_TABLE_NAME='cloud_workspaces' THEN scope_workspace=changed_row.id; ELSE scope_workspace=changed_row.workspace_id; END IF;
    scope_org=changed_row.org_id;
    IF EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_allocation_waits wait
      WHERE wait.workspace_id=scope_workspace AND wait.org_id=scope_org AND wait.state IN ('pending','resolved')) THEN
      PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',scope_workspace,scope_org,clock_timestamp());
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_allocation_workspace_jobs AFTER UPDATE OF owner_user_id,current_billing_epoch,authority_epoch,
  agent_boot_id,current_generation,desired_state,deleted_at ON cloud_workspaces
  FOR EACH ROW WHEN (ROW(OLD.owner_user_id,OLD.current_billing_epoch,OLD.authority_epoch,OLD.agent_boot_id,OLD.current_generation,OLD.desired_state,OLD.deleted_at)
    IS DISTINCT FROM ROW(NEW.owner_user_id,NEW.current_billing_epoch,NEW.authority_epoch,NEW.agent_boot_id,NEW.current_generation,NEW.desired_state,NEW.deleted_at))
  EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_binding_jobs AFTER UPDATE OF provider,provider_connection_id,provider_connection_version,provider_resource_id
  ON cloud_workspace_provider_bindings FOR EACH ROW
  WHEN (ROW(OLD.provider,OLD.provider_connection_id,OLD.provider_connection_version,OLD.provider_resource_id)
    IS DISTINCT FROM ROW(NEW.provider,NEW.provider_connection_id,NEW.provider_connection_version,NEW.provider_resource_id))
  EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_owner_jobs AFTER INSERT OR UPDATE OF current_generation,allocation_lease_id,revision
  ON cloud_workspace_allocation_owners FOR EACH ROW EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_owner_removed AFTER DELETE ON cloud_workspace_allocation_owners
  FOR EACH ROW EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_lease_removed AFTER DELETE ON managed_compute_allocation_leases
  FOR EACH ROW EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_generation_jobs AFTER UPDATE OF retired_at ON cloud_workspace_generations
  FOR EACH ROW WHEN (OLD.retired_at IS DISTINCT FROM NEW.retired_at) EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_connection_jobs AFTER UPDATE OF state ON provider_connections
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_version_jobs AFTER UPDATE OF retired_at,credential_expires_at ON provider_connection_versions
  FOR EACH ROW WHEN (ROW(OLD.retired_at,OLD.credential_expires_at) IS DISTINCT FROM ROW(NEW.retired_at,NEW.credential_expires_at))
  EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_source_jobs AFTER UPDATE OF retired_at ON cloud_agent_boot_bindings
  FOR EACH ROW WHEN (OLD.retired_at IS DISTINCT FROM NEW.retired_at) EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_dispatch_settled AFTER UPDATE OF settled_at ON cloud_workspace_final_save_dispatches
  FOR EACH ROW WHEN (OLD.settled_at IS DISTINCT FROM NEW.settled_at) EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_checkpoint_jobs AFTER UPDATE OF state,invalidated_at ON workspace_checkpoints
  FOR EACH ROW WHEN (ROW(OLD.state,OLD.invalidated_at) IS DISTINCT FROM ROW(NEW.state,NEW.invalidated_at))
  EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_reservation_closed AFTER UPDATE OF state ON managed_compute_credit_reservations
  FOR EACH ROW WHEN (OLD.state='open' AND NEW.state<>'open') EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();
CREATE TRIGGER cloud_lifecycle_allocation_prerequisite_jobs AFTER UPDATE OF resume_after_intent_id ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (OLD.resume_after_intent_id IS DISTINCT FROM NEW.resume_after_intent_id) EXECUTE FUNCTION cloud_lifecycle_allocation_scope_jobs();

CREATE FUNCTION retire_cloud_lifecycle_allocation_wait() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE cloud_workspace_lifecycle_allocation_waits SET state='retired',resolved_at=coalesce(resolved_at,clock_timestamp())
    WHERE lifecycle_intent_id=NEW.id AND state<>'retired';
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_allocation_wait_retired AFTER UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('succeeded','failed','superseded'))
  EXECUTE FUNCTION retire_cloud_lifecycle_allocation_wait();

-- Only these new scheduling rows follow the existing erasure boundary.
-- zeros-expand-exception: new-scheduling-purge Deletes only new allocation scheduling rows when the workspace's existing erasure completes
CREATE FUNCTION purge_cloud_lifecycle_allocation_waits() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM cloud_workspace_lifecycle_allocation_waits WHERE workspace_id=NEW.id AND org_id=NEW.org_id;
  RETURN NEW;
END $$;
CREATE TRIGGER purge_cloud_lifecycle_allocation_waits AFTER UPDATE OF data_deleted_at ON cloud_workspaces
  FOR EACH ROW WHEN (OLD.data_deleted_at IS NULL AND NEW.data_deleted_at IS NOT NULL)
  EXECUTE FUNCTION purge_cloud_lifecycle_allocation_waits();

-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION cloud_lifecycle_allocation_wait_status(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION preserve_cloud_lifecycle_allocation_wait() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION require_cloud_lifecycle_allocation_dependency() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION cloud_lifecycle_allocation_wait_jobs() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION cloud_lifecycle_allocation_settled_jobs() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION cloud_lifecycle_allocation_scope_jobs() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION retire_cloud_lifecycle_allocation_wait() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Remove PUBLIC defaults only for newly created internal functions
REVOKE ALL ON FUNCTION purge_cloud_lifecycle_allocation_waits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_lifecycle_allocation_wait_status(uuid) TO zeros_app;
