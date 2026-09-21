-- zeros:requires-controlled-downtime
-- Drain the old funding/allocator workers before applying. Historical receipts,
-- reservations and payers are never reinterpreted or credited a second time.
CREATE TABLE managed_compute_user_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE managed_compute_user_periods (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES managed_compute_user_accounts(user_id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  granted_micro_usd bigint NOT NULL DEFAULT 0 CHECK (granted_micro_usd BETWEEN 0 AND 1000000000000),
  allocated_micro_usd bigint NOT NULL DEFAULT 0 CHECK (allocated_micro_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,user_id),
  UNIQUE (user_id,starts_at),
  CHECK (allocated_micro_usd<=granted_micro_usd),
  CHECK (ends_at>starts_at AND ends_at<=starts_at+interval '366 days')
);
CREATE INDEX managed_compute_user_period_expiry ON managed_compute_user_periods(user_id,ends_at);
CREATE TABLE managed_compute_funding_receipts (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('operator','billing')),
  source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  line_item_id text NOT NULL CHECK (line_item_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 1000000000000),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind,source_id,line_item_id),
  FOREIGN KEY (period_id,user_id) REFERENCES managed_compute_user_periods(id,user_id) ON DELETE RESTRICT
);
ALTER TABLE managed_compute_credit_periods
  ADD COLUMN funding_mode text NOT NULL DEFAULT 'legacy_org' CHECK (funding_mode IN ('legacy_org','business','pro_user')),
  ADD COLUMN funding_period_id uuid,
  ADD COLUMN returned_micro_usd bigint NOT NULL DEFAULT 0 CHECK (returned_micro_usd>=0),
  ADD CONSTRAINT managed_compute_child_funding FOREIGN KEY (funding_period_id,user_id) REFERENCES managed_compute_user_periods(id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT managed_compute_child_funding_mode CHECK ((funding_mode='pro_user')=(funding_period_id IS NOT NULL)),
  ADD CONSTRAINT managed_compute_child_conservation CHECK (debited_micro_usd+reserved_micro_usd+returned_micro_usd<=granted_micro_usd),
  ADD CONSTRAINT managed_compute_child_funding_identity UNIQUE (id,user_id,funding_period_id);
CREATE INDEX managed_compute_funding_children ON managed_compute_credit_periods(funding_period_id,org_id) WHERE funding_period_id IS NOT NULL;
CREATE INDEX managed_compute_funding_available_children ON managed_compute_credit_periods(funding_period_id,org_id,id)
  WHERE funding_period_id IS NOT NULL AND granted_micro_usd-debited_micro_usd-reserved_micro_usd-returned_micro_usd>0;
CREATE TABLE managed_compute_funding_movements (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  user_id uuid NOT NULL,
  funding_period_id uuid NOT NULL,
  child_period_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('allocate','return')),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 1000000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (child_period_id,user_id,funding_period_id) REFERENCES managed_compute_credit_periods(id,user_id,funding_period_id) ON DELETE RESTRICT
);
CREATE INDEX managed_compute_funding_movement_history ON managed_compute_funding_movements(user_id,created_at,id);
CREATE FUNCTION managed_compute_funding_identity_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$ BEGIN
  IF ROW(NEW.user_id,NEW.org_id,NEW.starts_at,NEW.ends_at,NEW.funding_mode,NEW.funding_period_id)
    IS DISTINCT FROM ROW(OLD.user_id,OLD.org_id,OLD.starts_at,OLD.ends_at,OLD.funding_mode,OLD.funding_period_id)
  THEN RAISE EXCEPTION 'Compute period funding identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER managed_compute_funding_identity_immutable BEFORE UPDATE ON managed_compute_credit_periods
  FOR EACH ROW EXECUTE FUNCTION managed_compute_funding_identity_immutable();
REVOKE ALL ON FUNCTION managed_compute_funding_identity_immutable() FROM PUBLIC;
ALTER TABLE managed_compute_user_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_user_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_user_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_user_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_funding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_funding_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_funding_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_funding_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_compute_user_accounts_system ON managed_compute_user_accounts FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_user_periods_system ON managed_compute_user_periods FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_funding_receipts_system ON managed_compute_funding_receipts FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY managed_compute_funding_movements_system ON managed_compute_funding_movements FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
REVOKE UPDATE,DELETE,TRUNCATE ON managed_compute_funding_receipts,managed_compute_funding_movements FROM zeros_app;
REVOKE DELETE,TRUNCATE ON managed_compute_user_accounts,managed_compute_user_periods FROM zeros_app;
GRANT SELECT,INSERT ON managed_compute_funding_receipts,managed_compute_funding_movements TO zeros_app;
GRANT SELECT,INSERT,UPDATE ON managed_compute_user_accounts,managed_compute_user_periods TO zeros_app;
