-- Operator-attested provider absence for create journals whose outcome is
-- otherwise permanently unknown: historical untracked journals, and tracked
-- attempts whose refusal could not be certified. An attestation records
-- exhaustive provider-inventory evidence gathered by a staff operator. It
-- never erases or rewrites the attempts it covers, covers only dispatches up
-- to a recorded instant, and can close only an unallocated generation with no
-- active create/wake intent. It is append-only; the organization purge that
-- consumes its journal row removes it by cascade.

CREATE TABLE cloud_workspace_provider_absence_attestations (
  provider text NOT NULL,
  account_scope text NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL,
  id uuid NOT NULL UNIQUE,
  attested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  database_principal text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{16}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  inventory_sha256 bytea NOT NULL CHECK (octet_length(inventory_sha256) = 32),
  inventory_observed_at timestamptz NOT NULL,
  inventory_resource_count integer NOT NULL CHECK (inventory_resource_count >= 0),
  covers_dispatches_through timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, account_scope, workspace_id, generation),
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

-- Closure no longer requires a tracked journal by constraint; the guard below
-- requires either tracked, certified rejections or an attestation covering
-- every unrejected dispatch.
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
    IF NEW.resource_id IS NOT NULL OR NOT (
      NEW.create_attempts_tracked OR EXISTS (
        SELECT 1 FROM cloud_workspace_provider_absence_attestations
        WHERE provider = NEW.provider AND account_scope = NEW.account_scope
          AND workspace_id = NEW.workspace_id AND generation = NEW.generation
      )
    ) OR EXISTS (
      SELECT 1 FROM cloud_workspace_provider_create_attempts attempt
      WHERE attempt.provider = NEW.provider AND attempt.account_scope = NEW.account_scope
        AND attempt.workspace_id = NEW.workspace_id AND attempt.generation = NEW.generation
        AND attempt.rejected_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM cloud_workspace_provider_absence_attestations attestation
          WHERE attestation.provider = attempt.provider AND attestation.account_scope = attempt.account_scope
            AND attestation.workspace_id = attempt.workspace_id AND attestation.generation = attempt.generation
            AND attempt.dispatched_at <= attestation.covers_dispatches_through
        )
    ) OR EXISTS (
      SELECT 1 FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id = NEW.workspace_id AND generation = NEW.generation
        AND operation IN ('create', 'wake') AND state IN ('queued', 'dispatching', 'observing')
    ) THEN
      RAISE EXCEPTION 'Cloud provider allocation absence is not confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
