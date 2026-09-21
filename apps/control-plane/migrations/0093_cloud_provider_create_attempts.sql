-- Legacy writers may already have dispatched a create without a receipt. Only
-- the new writer opts in, using a versioned local request digest that old
-- writers reject. Never backfill historical operations as fully tracked.
ALTER TABLE cloud_workspace_provider_operations
  ADD COLUMN create_attempts_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN create_closed_at timestamptz,
  ADD CONSTRAINT cloud_provider_create_closed_unallocated CHECK (
    create_closed_at IS NULL OR (create_attempts_tracked AND resource_id IS NULL)
  );

CREATE TABLE cloud_workspace_provider_create_attempts (
  provider text NOT NULL,
  account_scope text NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL,
  attempt_id uuid NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rejection_code text CHECK (rejection_code IN (
    'limit_reached', 'member_limit_reached', 'trial_compute_limit_reached'
  )),
  rejected_at timestamptz,
  PRIMARY KEY (provider, account_scope, workspace_id, generation, attempt_id),
  FOREIGN KEY (provider, account_scope, workspace_id, generation)
    REFERENCES cloud_workspace_provider_operations
    ON DELETE CASCADE,
  CHECK ((rejection_code IS NULL) = (rejected_at IS NULL))
);
CREATE INDEX cloud_provider_create_attempts_unknown_idx
  ON cloud_workspace_provider_create_attempts (provider, account_scope, workspace_id, generation)
  WHERE rejected_at IS NULL;
ALTER TABLE cloud_workspace_provider_create_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_provider_create_attempts_system
  ON cloud_workspace_provider_create_attempts FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_provider_create_attempts FORCE ROW LEVEL SECURITY;
-- Attempts can only be erased by the parent's terminal-evidence guarded purge.
GRANT SELECT, INSERT, UPDATE ON cloud_workspace_provider_create_attempts TO zeros_app;
REVOKE DELETE, TRUNCATE ON cloud_workspace_provider_create_attempts FROM zeros_app;

CREATE FUNCTION guard_cloud_provider_create_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM cloud_workspace_provider_operations
      WHERE provider = NEW.provider AND account_scope = NEW.account_scope
        AND workspace_id = NEW.workspace_id AND generation = NEW.generation
        AND create_closed_at IS NULL AND resource_id IS NULL
        AND deletion_requested_at IS NULL AND deleted_at IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cloud provider create generation is retired';
    END IF;
  ELSIF ROW(NEW.provider, NEW.account_scope, NEW.workspace_id, NEW.generation,
            NEW.attempt_id, NEW.dispatched_at)
          IS DISTINCT FROM
        ROW(OLD.provider, OLD.account_scope, OLD.workspace_id, OLD.generation,
            OLD.attempt_id, OLD.dispatched_at)
     OR (OLD.rejected_at IS NOT NULL AND
         ROW(NEW.rejection_code, NEW.rejected_at) IS DISTINCT FROM
         ROW(OLD.rejection_code, OLD.rejected_at)) THEN
    RAISE EXCEPTION 'Cloud provider create attempt evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_provider_create_attempt_immutable
  BEFORE INSERT OR UPDATE ON cloud_workspace_provider_create_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_provider_create_attempt();

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
    IF NOT NEW.create_attempts_tracked OR NEW.resource_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM cloud_workspace_provider_create_attempts
      WHERE provider = NEW.provider AND account_scope = NEW.account_scope
        AND workspace_id = NEW.workspace_id AND generation = NEW.generation
        AND rejected_at IS NULL
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
