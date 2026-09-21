-- Managed compute credit is attached to an organization seat. Organization
-- membership does not pool another member's funds. Only the trusted billing
-- coordinator can grant, reserve or reconcile credit; provider usage, rather
-- than workload CPU counters, determines the debit.
CREATE TABLE managed_compute_credit_accounts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE managed_compute_credit_periods (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  granted_micro_usd bigint NOT NULL DEFAULT 0 CHECK (granted_micro_usd BETWEEN 0 AND 1000000000000),
  debited_micro_usd bigint NOT NULL DEFAULT 0 CHECK (debited_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  exposure_micro_usd bigint NOT NULL DEFAULT 0 CHECK (exposure_micro_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, user_id),
  UNIQUE (org_id, user_id, starts_at),
  FOREIGN KEY (org_id, user_id) REFERENCES managed_compute_credit_accounts(org_id, user_id) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '366 days'),
  CHECK (debited_micro_usd + reserved_micro_usd <= granted_micro_usd)
);
CREATE INDEX managed_compute_period_expiry ON managed_compute_credit_periods(org_id, user_id, ends_at);
CREATE TABLE managed_compute_credit_grants (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 1000000000000),
  policy_id text NOT NULL CHECK (policy_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, idempotency_key),
  FOREIGN KEY (period_id, org_id, user_id) REFERENCES managed_compute_credit_periods(id, org_id, user_id) ON DELETE RESTRICT
);
-- One immutable identity spans every period funded by the same provider lease.
-- A globally unique key closes a cross-account concurrent INSERT race.
CREATE TABLE managed_compute_reservation_scopes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL,
  billing_epoch bigint NOT NULL,
  policy_id text NOT NULL,
  seconds_per_dollar bigint NOT NULL,
  UNIQUE (id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar),
  FOREIGN KEY (org_id,user_id) REFERENCES managed_compute_credit_accounts(org_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,generation,org_id) REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,billing_epoch,org_id) REFERENCES workspace_billing_epochs(workspace_id,billing_epoch,org_id) ON DELETE RESTRICT
);
CREATE TABLE managed_compute_credit_reservations (
  id uuid NOT NULL,
  period_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  billing_epoch bigint NOT NULL CHECK (billing_epoch > 0),
  policy_id text NOT NULL CHECK (policy_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  seconds_per_dollar bigint NOT NULL CHECK (seconds_per_dollar BETWEEN 1 AND 1000000000000),
  meter_since timestamptz NOT NULL,
  meter_through timestamptz NOT NULL,
  covered_until timestamptz NOT NULL,
  billable_seconds bigint NOT NULL DEFAULT 0 CHECK (billable_seconds BETWEEN 0 AND 9007199254740991),
  authorized_micro_usd bigint NOT NULL CHECK (authorized_micro_usd BETWEEN 1 AND 1000000000000),
  actual_micro_usd bigint NOT NULL DEFAULT 0 CHECK (actual_micro_usd BETWEEN 0 AND 9007199254740991),
  debited_micro_usd bigint NOT NULL DEFAULT 0 CHECK (debited_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd >= 0),
  exposure_micro_usd bigint NOT NULL DEFAULT 0 CHECK (exposure_micro_usd >= 0),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'final')),
  final_reason text CHECK (final_reason IN ('allocation_stopped', 'allocation_deleted', 'never_allocated', 'period_ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_id),
  UNIQUE (id, period_id, org_id, user_id),
  FOREIGN KEY (period_id, org_id, user_id) REFERENCES managed_compute_credit_periods(id, org_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, generation, org_id) REFERENCES cloud_workspace_generations(workspace_id, generation, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, billing_epoch, org_id) REFERENCES workspace_billing_epochs(workspace_id, billing_epoch, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar)
    REFERENCES managed_compute_reservation_scopes(id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar) ON DELETE RESTRICT,
  CHECK (meter_through >= meter_since AND covered_until > meter_since),
  CHECK (actual_micro_usd = debited_micro_usd + exposure_micro_usd),
  CHECK (debited_micro_usd + reserved_micro_usd <= authorized_micro_usd),
  CHECK ((state = 'open' AND final_reason IS NULL) OR (state = 'final' AND final_reason IS NOT NULL AND reserved_micro_usd = 0))
);
CREATE INDEX managed_compute_reservations_workspace ON managed_compute_credit_reservations(workspace_id, generation);
CREATE TABLE managed_compute_credit_events (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reservation_id uuid,
  kind text NOT NULL CHECK (kind IN ('grant', 'reserve', 'debit', 'release', 'exposure')),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (period_id, org_id, user_id) REFERENCES managed_compute_credit_periods(id, org_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id, period_id, org_id, user_id) REFERENCES managed_compute_credit_reservations(id, period_id, org_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX managed_compute_events_period ON managed_compute_credit_events(period_id, created_at, id);

ALTER TABLE managed_compute_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_reservation_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_reservation_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_credit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_compute_accounts_system ON managed_compute_credit_accounts FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_periods_system ON managed_compute_credit_periods FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_grants_system ON managed_compute_credit_grants FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_scopes_system ON managed_compute_reservation_scopes FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_reservations_system ON managed_compute_credit_reservations FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_events_system ON managed_compute_credit_events FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
-- The deployment's default table privileges include UPDATE/DELETE. Remove
-- those explicitly; a narrower GRANT does not revoke inherited defaults.
REVOKE UPDATE, DELETE, TRUNCATE ON managed_compute_credit_grants, managed_compute_credit_events, managed_compute_reservation_scopes FROM zeros_app;
REVOKE DELETE, TRUNCATE ON managed_compute_credit_accounts, managed_compute_credit_periods, managed_compute_credit_reservations FROM zeros_app;
GRANT SELECT, INSERT ON managed_compute_credit_grants, managed_compute_credit_events, managed_compute_reservation_scopes TO zeros_app;
GRANT SELECT, INSERT, UPDATE ON managed_compute_credit_accounts, managed_compute_credit_periods, managed_compute_credit_reservations TO zeros_app;
