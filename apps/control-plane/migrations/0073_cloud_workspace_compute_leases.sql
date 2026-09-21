-- zeros:requires-controlled-downtime
-- Drain old lifecycle workers and stop existing hosted Boat allocations before
-- rollout. An older worker may create without a funded lease; it must not run
-- alongside this spending boundary. No historical credit is fabricated.
-- Hosted providers opt into compute billing at a deployment boundary. The
-- existing hosted Daytona path remains a compatibility contract; customer
-- delegated connections always use their own provider billing. New hosted
-- providers fail closed unless their execution has a funded finite lease.
CREATE TABLE managed_compute_provider_requirements (
  provider text PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  require_credit boolean NOT NULL DEFAULT true
);
INSERT INTO managed_compute_provider_requirements(provider,require_credit) VALUES ('boat',true),('daytona',false);

CREATE TABLE managed_compute_allocation_leases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  billing_epoch bigint NOT NULL CHECK (billing_epoch > 0),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lifecycle_intent_id uuid NOT NULL UNIQUE REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE RESTRICT,
  stop_intent_id uuid REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_resource_id text CHECK (char_length(provider_resource_id) BETWEEN 1 AND 512),
  policy_id text NOT NULL CHECK (policy_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  seconds_per_dollar bigint NOT NULL CHECK (seconds_per_dollar BETWEEN 1 AND 1000000000000),
  weight_numerator integer NOT NULL CHECK (weight_numerator BETWEEN 1 AND 16),
  weight_denominator integer NOT NULL CHECK (weight_denominator BETWEEN 1 AND 16),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 60 AND 3600),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  funded_until timestamptz,
  provider_expires_at timestamptz,
  stopped_observed_at timestamptz,
  state text NOT NULL CHECK (state IN ('funding','authorized','active','draining','settled')),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,127}$'),
  first_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  FOREIGN KEY (workspace_id,generation,org_id) REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,billing_epoch,org_id) REFERENCES workspace_billing_epochs(workspace_id,billing_epoch,org_id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (funded_until IS NULL OR funded_until > requested_at),
  CHECK (provider_expires_at IS NULL OR (funded_until IS NOT NULL AND provider_expires_at <= funded_until)),
  CHECK ((state='settled') = (settled_at IS NOT NULL)),
  CHECK (state NOT IN ('authorized','active') OR funded_until IS NOT NULL),
  CHECK (state <> 'active' OR (provider_resource_id IS NOT NULL AND provider_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX managed_compute_one_live_lease ON managed_compute_allocation_leases(workspace_id,generation) WHERE state <> 'settled';
CREATE INDEX managed_compute_lease_reconcile ON managed_compute_allocation_leases(next_check_at,id) WHERE state <> 'settled';
ALTER TABLE managed_compute_provider_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_provider_requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_allocation_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_allocation_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_compute_requirement_system ON managed_compute_provider_requirements FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_lease_system ON managed_compute_allocation_leases FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
REVOKE DELETE, TRUNCATE ON managed_compute_allocation_leases FROM zeros_app;
GRANT SELECT,INSERT,UPDATE ON managed_compute_allocation_leases TO zeros_app;
GRANT SELECT ON managed_compute_provider_requirements TO zeros_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON managed_compute_provider_requirements FROM zeros_app;

CREATE FUNCTION cloud_workspace_compute_authority_live(target_workspace_id uuid,target_generation integer)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_generations generation
    JOIN provider_connection_versions version ON version.connection_id=generation.provider_connection_id
      AND version.org_id=generation.org_id AND version.version=generation.provider_connection_version
    LEFT JOIN managed_compute_provider_requirements requirement ON requirement.provider=generation.provider
    WHERE generation.workspace_id=target_workspace_id AND generation.generation=target_generation
      AND (version.credential_source='delegated' OR NOT coalesce(requirement.require_credit,true) OR EXISTS (
        SELECT 1 FROM managed_compute_allocation_leases lease
        JOIN cloud_workspaces workspace ON workspace.id=lease.workspace_id AND workspace.org_id=lease.org_id
          AND workspace.current_generation=lease.generation AND workspace.current_billing_epoch=lease.billing_epoch
          AND workspace.owner_user_id=lease.user_id
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=lease.workspace_id
          AND binding.org_id=lease.org_id AND binding.generation=lease.generation
          AND binding.provider_resource_id=lease.provider_resource_id
        JOIN managed_compute_credit_reservations reservation ON reservation.id=lease.id
          AND reservation.workspace_id=lease.workspace_id AND reservation.org_id=lease.org_id
          AND reservation.generation=lease.generation AND reservation.billing_epoch=lease.billing_epoch
          AND reservation.user_id=lease.user_id AND reservation.policy_id=lease.policy_id
          AND reservation.seconds_per_dollar=lease.seconds_per_dollar
        WHERE lease.workspace_id=generation.workspace_id AND lease.org_id=generation.org_id
          AND lease.generation=generation.generation AND lease.provider=generation.provider
          AND lease.state IN ('active','draining')
          AND lease.provider_expires_at > now() AND lease.funded_until > now()
          AND reservation.state='open' AND reservation.meter_since <= now()
          AND reservation.covered_until > now() AND reservation.reserved_micro_usd > 0
      ))
  )
$$;
CREATE OR REPLACE FUNCTION cloud_workspace_runtime_authority_live(
  target_workspace_id uuid,target_generation integer,target_user_id uuid,require_workos boolean
) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cloud_workspace_paid_authority_live(target_workspace_id,target_user_id,require_workos)
    AND cloud_workspace_generation_provider_authority_live(target_workspace_id,target_generation,300)
    AND cloud_workspace_compute_authority_live(target_workspace_id,target_generation)
$$;
