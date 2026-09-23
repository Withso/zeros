-- Operator-attested provider absence for create journals whose outcome is
-- otherwise permanently unknown: historical untracked journals, and tracked
-- attempts whose refusal could not be certified. An attestation records
-- exhaustive provider-inventory evidence gathered by a staff operator. It
-- never erases or rewrites the attempts it covers, covers only dispatches up
-- to a recorded instant, and can close only an unallocated generation with no
-- active create, wake or generation transition. A later uncovered dispatch needs a later
-- attestation. Attestations are append-only; the organization purge that
-- consumes their journal row removes them by cascade.

CREATE TABLE cloud_workspace_provider_absence_attestations (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  account_scope text NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL,
  attested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  database_principal text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{16}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  provider_account text NOT NULL CHECK (length(provider_account) BETWEEN 1 AND 256),
  excused_resources text[] NOT NULL DEFAULT '{}' CHECK (cardinality(excused_resources) <= 64),
  inventory_sha256 bytea NOT NULL CHECK (octet_length(inventory_sha256) = 32),
  inventory_observed_at timestamptz NOT NULL,
  inventory_resource_count integer NOT NULL CHECK (inventory_resource_count >= 0),
  covers_dispatches_through timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, account_scope, workspace_id, generation, covers_dispatches_through),
  FOREIGN KEY (provider, account_scope, workspace_id, generation)
    REFERENCES cloud_workspace_provider_operations ON DELETE CASCADE,
  CHECK (covers_dispatches_through < inventory_observed_at)
);
ALTER TABLE cloud_workspace_provider_absence_attestations ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_provider_absence_attestations_system
  ON cloud_workspace_provider_absence_attestations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_provider_absence_attestations FORCE ROW LEVEL SECURITY;
-- Only the database owner (the guarded operator) records attestations. The
-- application may read them to decide closure; it can never create or change one.
REVOKE ALL ON cloud_workspace_provider_absence_attestations FROM zeros_app;
GRANT SELECT ON cloud_workspace_provider_absence_attestations TO zeros_app;

CREATE FUNCTION guard_cloud_provider_absence_attestation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the cascade from its purged journal row may remove an attestation.
    PERFORM 1 FROM cloud_workspace_provider_operations
      WHERE provider = OLD.provider AND account_scope = OLD.account_scope
        AND workspace_id = OLD.workspace_id AND generation = OLD.generation;
    IF FOUND THEN
      RAISE EXCEPTION 'Cloud provider absence attestations are append-only' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Cloud provider absence attestations are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cloud_provider_absence_attestation_append_only
  BEFORE UPDATE OR DELETE ON cloud_workspace_provider_absence_attestations
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_provider_absence_attestation();
CREATE FUNCTION reject_cloud_provider_absence_attestation_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Cloud provider absence attestations are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cloud_provider_absence_attestation_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_provider_absence_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_cloud_provider_absence_attestation_truncate();
REVOKE ALL ON FUNCTION guard_cloud_provider_absence_attestation() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_cloud_provider_absence_attestation_truncate() FROM PUBLIC;

-- Whether a create, wake or generation transition can still dispatch for the
-- generation. A transition that is rolling back abandons its candidate, which
-- its cleanup must be able to close. Shared by the closure rule and the
-- attestation operator.
CREATE FUNCTION cloud_provider_create_dispatch_active(target_workspace_id uuid, target_generation integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents intent
    WHERE intent.workspace_id = target_workspace_id AND intent.generation = target_generation
      AND intent.operation IN ('create', 'wake') AND intent.state IN ('queued', 'dispatching', 'observing')
  ) OR EXISTS (
    SELECT 1 FROM cloud_workspace_generation_transitions transition
    WHERE transition.workspace_id = target_workspace_id AND transition.candidate_generation = target_generation
      AND transition.state IN ('draining', 'provisioning', 'setting_up')
  )
$$;

-- The latest instant at which the generation's journal may have dispatched a
-- create: its own creation, every recorded dispatch and, for an untracked
-- journal that records none, the completion of every create/wake. An
-- attestation must cover this horizon.
CREATE FUNCTION cloud_provider_create_dispatch_horizon(
  target_provider text, target_account_scope text, target_workspace_id uuid,
  target_generation integer, attempts_tracked boolean
) RETURNS timestamptz LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT greatest(
    (SELECT operation.created_at FROM cloud_workspace_provider_operations operation
     WHERE operation.provider = target_provider AND operation.account_scope = target_account_scope
       AND operation.workspace_id = target_workspace_id AND operation.generation = target_generation),
    (SELECT max(attempt.dispatched_at) FROM cloud_workspace_provider_create_attempts attempt
     WHERE attempt.provider = target_provider AND attempt.account_scope = target_account_scope
       AND attempt.workspace_id = target_workspace_id AND attempt.generation = target_generation),
    CASE WHEN attempts_tracked THEN NULL ELSE (
      SELECT max(coalesce(intent.completed_at, intent.updated_at, intent.created_at))
      FROM cloud_workspace_lifecycle_intents intent
      WHERE intent.workspace_id = target_workspace_id AND intent.generation = target_generation
        AND intent.operation IN ('create', 'wake')
    ) END
  )
$$;

-- The single closure rule shared by the journal guard and the application:
-- nothing can still dispatch; every unrejected dispatch has a certified
-- rejection or attestation coverage; and an untracked journal, which records
-- no dispatches, has an attestation covering its whole dispatch horizon.
CREATE FUNCTION cloud_provider_create_absence_confirmed(
  target_provider text, target_account_scope text, target_workspace_id uuid,
  target_generation integer, attempts_tracked boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT
    NOT cloud_provider_create_dispatch_active(target_workspace_id, target_generation)
    AND NOT EXISTS (
      SELECT 1 FROM cloud_workspace_provider_create_attempts attempt
      WHERE attempt.provider = target_provider AND attempt.account_scope = target_account_scope
        AND attempt.workspace_id = target_workspace_id AND attempt.generation = target_generation
        AND attempt.rejected_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM cloud_workspace_provider_absence_attestations attestation
          WHERE attestation.provider = attempt.provider AND attestation.account_scope = attempt.account_scope
            AND attestation.workspace_id = attempt.workspace_id AND attestation.generation = attempt.generation
            AND attempt.dispatched_at <= attestation.covers_dispatches_through
        )
    )
    AND (attempts_tracked OR coalesce((
      SELECT max(attestation.covers_dispatches_through) FROM cloud_workspace_provider_absence_attestations attestation
      WHERE attestation.provider = target_provider AND attestation.account_scope = target_account_scope
        AND attestation.workspace_id = target_workspace_id AND attestation.generation = target_generation
    ) >= cloud_provider_create_dispatch_horizon(
      target_provider, target_account_scope, target_workspace_id, target_generation, attempts_tracked
    ), false))
$$;
REVOKE ALL ON FUNCTION cloud_provider_create_dispatch_active(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION cloud_provider_create_dispatch_horizon(text, text, uuid, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION cloud_provider_create_absence_confirmed(text, text, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_provider_create_dispatch_active(uuid, integer) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_provider_create_dispatch_horizon(text, text, uuid, integer, boolean) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_provider_create_absence_confirmed(text, text, uuid, integer, boolean) TO zeros_app;

-- Closure no longer requires a tracked journal by constraint; the guard below
-- applies the shared rule, which requires an attestation for untracked journals.
ALTER TABLE cloud_workspace_provider_operations
  DROP CONSTRAINT cloud_provider_create_closed_unallocated,
  ADD CONSTRAINT cloud_provider_create_closed_unallocated CHECK (
    create_closed_at IS NULL OR resource_id IS NULL
  );

CREATE OR REPLACE FUNCTION guard_cloud_workspace_provider_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL AND OLD.create_closed_at IS NULL THEN
      RAISE EXCEPTION 'Unconfirmed cloud provider operations must be retained';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.provider, NEW.account_scope, NEW.workspace_id, NEW.generation,
         NEW.org_id, NEW.idempotency_key, NEW.request_sha256, NEW.created_at,
         NEW.create_attempts_tracked)
     IS DISTINCT FROM
     ROW(OLD.provider, OLD.account_scope, OLD.workspace_id, OLD.generation,
         OLD.org_id, OLD.idempotency_key, OLD.request_sha256, OLD.created_at,
         OLD.create_attempts_tracked)
     OR (OLD.resource_id IS NOT NULL AND NEW.resource_id IS DISTINCT FROM OLD.resource_id)
     OR (OLD.deletion_requested_at IS NOT NULL AND NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at)
     OR (OLD.deletion_operation_id IS NOT NULL AND NEW.deletion_operation_id IS DISTINCT FROM OLD.deletion_operation_id)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     OR (OLD.create_closed_at IS NOT NULL AND NEW.create_closed_at IS DISTINCT FROM OLD.create_closed_at)
  THEN
    RAISE EXCEPTION 'Cloud provider operation identity and accepted evidence are immutable';
  END IF;
  IF OLD.create_closed_at IS NULL AND NEW.create_closed_at IS NOT NULL THEN
    IF NEW.resource_id IS NOT NULL OR NOT cloud_provider_create_absence_confirmed(
      NEW.provider, NEW.account_scope, NEW.workspace_id, NEW.generation, NEW.create_attempts_tracked
    ) THEN
      RAISE EXCEPTION 'Cloud provider allocation absence is not confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
