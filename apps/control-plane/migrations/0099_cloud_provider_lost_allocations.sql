-- Operator-attested loss of a bound provider allocation. A provider can lose
-- an allocation outright (host loss or provider-side deletion): its sandbox,
-- snapshot and usage meter are gone, so no deletion receipt or final meter can
-- ever be read. A database owner attests the loss from the provider account's
-- complete inventory and a not-found lookup of the exact resource. Lifecycle
-- then treats the allocation as absent: its owner can recover the durable
-- checkpoint into a new generation, and its compute reservations finalize at
-- the last provider meter. Attestations are append-only; the organization
-- purge that consumes their journal row removes them by cascade.

CREATE TABLE cloud_workspace_provider_loss_attestations (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  account_scope text NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL,
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
  attested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  database_principal text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{16}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  provider_account text NOT NULL CHECK (length(provider_account) BETWEEN 1 AND 256),
  inventory_sha256 bytea NOT NULL CHECK (octet_length(inventory_sha256) = 32),
  inventory_observed_at timestamptz NOT NULL,
  inventory_resource_count integer NOT NULL CHECK (inventory_resource_count >= 0),
  lookup_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, account_scope, workspace_id, generation),
  FOREIGN KEY (provider, account_scope, workspace_id, generation)
    REFERENCES cloud_workspace_provider_operations ON DELETE CASCADE
);
ALTER TABLE cloud_workspace_provider_loss_attestations ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_provider_loss_attestations_system
  ON cloud_workspace_provider_loss_attestations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_provider_loss_attestations FORCE ROW LEVEL SECURITY;
-- Only the database owner (the guarded operator) records attestations.
REVOKE ALL ON cloud_workspace_provider_loss_attestations FROM zeros_app;
GRANT SELECT ON cloud_workspace_provider_loss_attestations TO zeros_app;

CREATE FUNCTION guard_cloud_provider_loss_attestation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Evidence names the journal's exact bound resource, before any deletion.
    PERFORM 1 FROM cloud_workspace_provider_operations
      WHERE provider = NEW.provider AND account_scope = NEW.account_scope
        AND workspace_id = NEW.workspace_id AND generation = NEW.generation
        AND resource_id = NEW.resource_id AND deletion_requested_at IS NULL AND deleted_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cloud provider loss attestation target is not bound or is being deleted' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Only the cascade from its purged journal row may remove an attestation.
    PERFORM 1 FROM cloud_workspace_provider_operations
      WHERE provider = OLD.provider AND account_scope = OLD.account_scope
        AND workspace_id = OLD.workspace_id AND generation = OLD.generation;
    IF FOUND THEN
      RAISE EXCEPTION 'Cloud provider loss attestations are append-only' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Cloud provider loss attestations are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cloud_provider_loss_attestation_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_provider_loss_attestations
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_provider_loss_attestation();
CREATE TRIGGER cloud_provider_loss_attestation_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_provider_loss_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_provider_loss_attestation();
REVOKE ALL ON FUNCTION guard_cloud_provider_loss_attestation() FROM PUBLIC;

-- Set once, only for the attested bound resource, and only while Zeros has
-- not started deleting it. A lost allocation has nothing left to delete.
ALTER TABLE cloud_workspace_provider_operations ADD COLUMN lost_at timestamptz;

CREATE OR REPLACE FUNCTION guard_cloud_workspace_provider_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL AND OLD.create_closed_at IS NULL AND OLD.lost_at IS NULL THEN
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
     OR (OLD.lost_at IS NOT NULL AND NEW.lost_at IS DISTINCT FROM OLD.lost_at)
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
  IF OLD.lost_at IS NULL AND NEW.lost_at IS NOT NULL THEN
    IF NEW.resource_id IS NULL OR NEW.deletion_requested_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM cloud_workspace_provider_loss_attestations attestation
      WHERE attestation.provider = NEW.provider AND attestation.account_scope = NEW.account_scope
        AND attestation.workspace_id = NEW.workspace_id AND attestation.generation = NEW.generation
        AND attestation.resource_id = NEW.resource_id
    ) THEN
      RAISE EXCEPTION 'Cloud provider allocation loss is not attested';
    END IF;
  END IF;
  IF NEW.lost_at IS NOT NULL AND OLD.deletion_requested_at IS NULL AND NEW.deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'A lost cloud provider allocation has nothing to delete';
  END IF;
  RETURN NEW;
END;
$$;

-- The single rule compute settlement uses: the generation's bound resource is
-- exactly the journal's attested lost allocation.
CREATE FUNCTION cloud_provider_allocation_lost(
  target_workspace_id uuid, target_generation integer, target_org_id uuid, target_resource_id text
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_provider_bindings binding
    JOIN cloud_workspace_provider_operations operation
      ON operation.workspace_id = binding.workspace_id AND operation.generation = binding.generation
     AND operation.org_id = binding.org_id AND operation.resource_id = binding.provider_resource_id
    WHERE binding.workspace_id = target_workspace_id AND binding.generation = target_generation
      AND binding.org_id = target_org_id AND binding.provider_resource_id = target_resource_id
      AND operation.lost_at IS NOT NULL
  )
$$;
REVOKE ALL ON FUNCTION cloud_provider_allocation_lost(uuid, integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_provider_allocation_lost(uuid, integer, uuid, text) TO zeros_app;

-- A lost allocation's reservations finalize at the last provider meter.
ALTER TABLE managed_compute_credit_reservations
  DROP CONSTRAINT managed_compute_credit_reservations_final_reason_check,
  ADD CONSTRAINT managed_compute_credit_reservations_final_reason_check CHECK (
    final_reason IN ('allocation_stopped', 'allocation_deleted', 'allocation_lost', 'never_allocated', 'period_ended')
  );
