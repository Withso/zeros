-- zeros-migration: expand
-- Match the workspace provider journal: certify each HTTP attempt separately.
-- Historical writers did not track attempts. A versioned request digest keeps
-- them from dispatching new tracked intents; never backfill legacy evidence.
ALTER TABLE cloud_builder_vm_operations
  ADD COLUMN create_attempts_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN create_closed_at timestamptz,
  ADD CONSTRAINT cloud_builder_create_closed_unallocated CHECK (
    create_closed_at IS NULL OR (create_attempts_tracked AND sandbox_id IS NULL)
  );

CREATE TABLE cloud_builder_vm_create_attempts (
  account_scope text NOT NULL,
  operation_key text NOT NULL,
  attempt_id uuid NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rejection_code text CHECK (rejection_code IN (
    'limit_reached', 'member_limit_reached', 'trial_compute_limit_reached'
  )),
  rejected_at timestamptz,
  PRIMARY KEY (account_scope, operation_key, attempt_id),
  FOREIGN KEY (account_scope, operation_key) REFERENCES cloud_builder_vm_operations,
  CHECK ((rejection_code IS NULL) = (rejected_at IS NULL))
);
CREATE INDEX cloud_builder_create_attempts_unknown ON cloud_builder_vm_create_attempts(account_scope, operation_key)
  WHERE rejected_at IS NULL;
ALTER TABLE cloud_builder_vm_create_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_builder_vm_create_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_builder_vm_create_attempts_system ON cloud_builder_vm_create_attempts
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

CREATE FUNCTION guard_cloud_builder_create_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'builder create attempts cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM cloud_builder_vm_operations
      WHERE account_scope=NEW.account_scope AND operation_key=NEW.operation_key
        AND create_closed_at IS NULL AND sandbox_id IS NULL AND state='creating'
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'builder create intent is retired' USING ERRCODE = '55000';
    END IF;
  ELSIF ROW(NEW.account_scope, NEW.operation_key, NEW.attempt_id, NEW.dispatched_at)
     IS DISTINCT FROM ROW(OLD.account_scope, OLD.operation_key, OLD.attempt_id, OLD.dispatched_at)
     OR (OLD.rejected_at IS NOT NULL AND ROW(NEW.rejection_code, NEW.rejected_at)
         IS DISTINCT FROM ROW(OLD.rejection_code, OLD.rejected_at)) THEN
    RAISE EXCEPTION 'builder create attempt evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_builder_create_attempt_immutable BEFORE INSERT OR UPDATE OR DELETE ON cloud_builder_vm_create_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_builder_create_attempt();

-- Keep the original identity/deletion guard; this additive guard fences
-- closure against both a late attempt and a late resource binding.
CREATE FUNCTION guard_cloud_builder_create_closure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.create_attempts_tracked IS DISTINCT FROM OLD.create_attempts_tracked
     OR (OLD.create_closed_at IS NOT NULL AND NEW.create_closed_at IS DISTINCT FROM OLD.create_closed_at)
     OR (OLD.create_closed_at IS NOT NULL AND NEW.create_dispatched_at IS DISTINCT FROM OLD.create_dispatched_at) THEN
    RAISE EXCEPTION 'builder create closure evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.create_closed_at IS NULL AND NEW.create_closed_at IS NOT NULL THEN
    IF NOT NEW.create_attempts_tracked OR NEW.sandbox_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM cloud_builder_vm_create_attempts
      WHERE account_scope=NEW.account_scope AND operation_key=NEW.operation_key AND rejected_at IS NULL
    ) THEN
      RAISE EXCEPTION 'builder allocation absence is not confirmed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_builder_create_closure_immutable BEFORE UPDATE ON cloud_builder_vm_operations
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_builder_create_closure();
