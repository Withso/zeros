-- zeros-migration: expand
CREATE TABLE managed_compute_staff_allowance_receipts (
  id uuid PRIMARY KEY,
  funding_period_id uuid NOT NULL,
  user_id uuid NOT NULL,
  child_period_id uuid NOT NULL,
  allocation_lease_id uuid NOT NULL REFERENCES managed_compute_allocation_leases(id),
  allocation_claim_owner text NOT NULL CHECK (length(allocation_claim_owner) BETWEEN 1 AND 128),
  staff_revision bigint NOT NULL CHECK (staff_revision BETWEEN 1 AND 1000000000000),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 1000000000000),
  grant_after_micro_usd bigint NOT NULL CHECK (grant_after_micro_usd BETWEEN 1 AND 1000000000000),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (funding_period_id,grant_after_micro_usd),
  FOREIGN KEY (funding_period_id,user_id) REFERENCES managed_compute_user_periods(id,user_id),
  FOREIGN KEY (child_period_id,user_id,funding_period_id) REFERENCES managed_compute_credit_periods(id,user_id,funding_period_id)
);
ALTER TABLE managed_compute_staff_allowance_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_staff_allowance_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_compute_staff_receipts_read ON managed_compute_staff_allowance_receipts FOR SELECT USING (app_is_system());
CREATE POLICY managed_compute_staff_receipts_insert ON managed_compute_staff_allowance_receipts FOR INSERT WITH CHECK (
  app_is_system()
  AND EXISTS (
    SELECT 1 FROM staff_pro_benefits benefit JOIN users account ON account.id=benefit.user_id
    WHERE account.id=managed_compute_staff_allowance_receipts.user_id AND account.staff_role IN ('platform_owner','developer')
      AND account.auth_status='active' AND account.deleted_at IS NULL AND benefit.revoked_at IS NULL
      AND benefit.valid_from<=clock_timestamp() AND benefit.revision=managed_compute_staff_allowance_receipts.staff_revision
  )
  AND EXISTS (
    SELECT 1 FROM managed_compute_allocation_leases lease
    JOIN managed_compute_credit_periods child ON child.id=managed_compute_staff_allowance_receipts.child_period_id AND child.org_id=lease.org_id AND child.user_id=lease.user_id
    JOIN managed_compute_pro_allowances allowance ON allowance.period_id=child.funding_period_id AND allowance.user_id=lease.user_id
    JOIN managed_compute_user_periods root ON root.id=allowance.period_id
    WHERE lease.id=managed_compute_staff_allowance_receipts.allocation_lease_id AND lease.user_id=managed_compute_staff_allowance_receipts.user_id
      AND root.id=managed_compute_staff_allowance_receipts.funding_period_id
      AND lease.lease_owner=managed_compute_staff_allowance_receipts.allocation_claim_owner AND lease.lease_expires_at>clock_timestamp()
      AND lease.state IN ('funding','authorized','active') AND allowance.compute_policy_id=lease.policy_id
      AND allowance.seconds_per_dollar=lease.seconds_per_dollar
      AND managed_compute_staff_allowance_receipts.grant_after_micro_usd=root.granted_micro_usd+managed_compute_staff_allowance_receipts.amount_micro_usd
  )
);
