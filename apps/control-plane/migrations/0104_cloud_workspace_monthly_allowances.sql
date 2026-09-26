SELECT set_config('app.system','on',true);
-- A durable activation anchor survives cancellation, regrant and staff/paid
-- transitions. Runtime workers can read it but cannot reset the billing clock.
CREATE TABLE managed_compute_pro_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  anchor_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE managed_compute_pro_allowance_queue (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_state text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE managed_compute_funding_receipts DROP CONSTRAINT managed_compute_funding_receipts_source_kind_check;
ALTER TABLE managed_compute_funding_receipts ADD CONSTRAINT managed_compute_funding_receipts_source_kind_check
  CHECK(source_kind IN ('operator','billing','pro_monthly_allowance'));
CREATE TABLE managed_compute_pro_allowances (
  user_id uuid NOT NULL REFERENCES managed_compute_pro_accounts(user_id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  period_id uuid NOT NULL UNIQUE,
  receipt_id uuid NOT NULL UNIQUE REFERENCES managed_compute_funding_receipts(id) ON DELETE RESTRICT,
  allowance_policy text NOT NULL CHECK(allowance_policy='pro-monthly-v1'),
  standard_seconds integer NOT NULL CHECK(standard_seconds=1800000),
  compute_policy_id text NOT NULL CHECK(length(compute_policy_id) BETWEEN 1 AND 128),
  seconds_per_dollar bigint NOT NULL CHECK(seconds_per_dollar BETWEEN 1 AND 1000000000000),
  entitlement_source text NOT NULL,
  entitlement_revision bigint NOT NULL,
  entitlement_valid_from timestamptz NOT NULL,
  entitlement_valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,starts_at),
  FOREIGN KEY(period_id,user_id) REFERENCES managed_compute_user_periods(id,user_id) ON DELETE RESTRICT,
  CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '32 days')
);
CREATE INDEX managed_compute_pro_allowance_due ON managed_compute_pro_allowance_queue(next_check_at,user_id);
ALTER TABLE managed_compute_pro_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_pro_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_pro_allowance_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_pro_allowance_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_pro_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_pro_allowances FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_compute_pro_accounts_system ON managed_compute_pro_accounts FOR SELECT USING(app_is_system());
CREATE POLICY managed_compute_pro_accounts_owner ON managed_compute_pro_accounts FOR ALL
  USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.managed_compute_pro_accounts'::regclass)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.managed_compute_pro_accounts'::regclass)));
CREATE POLICY managed_compute_pro_queue_system ON managed_compute_pro_allowance_queue FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY managed_compute_pro_queue_owner ON managed_compute_pro_allowance_queue FOR ALL
  USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.managed_compute_pro_allowance_queue'::regclass)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.managed_compute_pro_allowance_queue'::regclass)));
CREATE POLICY managed_compute_pro_allowances_system ON managed_compute_pro_allowances FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
REVOKE ALL ON managed_compute_pro_accounts,managed_compute_pro_allowance_queue,managed_compute_pro_allowances FROM PUBLIC,zeros_app;
GRANT SELECT ON managed_compute_pro_accounts TO zeros_app;
GRANT SELECT,INSERT,UPDATE ON managed_compute_pro_allowance_queue TO zeros_app;
GRANT SELECT,INSERT ON managed_compute_pro_allowances TO zeros_app;

CREATE FUNCTION enqueue_pro_monthly_allowance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE eligible boolean;
BEGIN
  IF TG_TABLE_NAME='staff_pro_benefits' THEN eligible:=NEW.revoked_at IS NULL;
  ELSE eligible:=NEW.plan='pro' AND NEW.cloud_workspaces_allowed; END IF;
  IF eligible THEN
    INSERT INTO managed_compute_pro_accounts(user_id,anchor_at) VALUES(NEW.user_id,NEW.valid_from)
      ON CONFLICT(user_id) DO NOTHING;
  END IF;
  INSERT INTO managed_compute_pro_allowance_queue(user_id) VALUES(NEW.user_id)
    ON CONFLICT(user_id) DO UPDATE SET next_check_at=clock_timestamp(),updated_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enqueue_pro_monthly_allowance() FROM PUBLIC;
CREATE TRIGGER account_pro_monthly_allowance AFTER INSERT OR UPDATE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION enqueue_pro_monthly_allowance();
CREATE TRIGGER staff_pro_monthly_allowance AFTER INSERT OR UPDATE ON staff_pro_benefits
  FOR EACH ROW EXECUTE FUNCTION enqueue_pro_monthly_allowance();
INSERT INTO managed_compute_pro_accounts(user_id,anchor_at)
  SELECT user_id,min(valid_from) FROM (
    SELECT user_id,valid_from FROM account_entitlements WHERE plan='pro'
    UNION ALL SELECT user_id,valid_from FROM staff_pro_benefits
  ) activations GROUP BY user_id;
INSERT INTO managed_compute_pro_allowance_queue(user_id) SELECT user_id FROM managed_compute_pro_accounts;

-- An automatic period is a fixed allowance, not an operator top-up bucket.
CREATE FUNCTION guard_pro_allowance_topup() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM managed_compute_pro_allowances WHERE period_id=NEW.period_id) THEN
    RAISE EXCEPTION 'Monthly allowance cannot be topped up' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_pro_allowance_topup() FROM PUBLIC;
CREATE TRIGGER managed_compute_pro_no_topup BEFORE INSERT ON managed_compute_funding_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_pro_allowance_topup();
