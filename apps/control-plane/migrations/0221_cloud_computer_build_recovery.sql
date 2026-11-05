-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

CREATE TABLE cloud_runtime_build_drain (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1 CHECK (version=1),
  lease_id uuid,
  run_id text CHECK (char_length(run_id) BETWEEN 1 AND 160),
  live_cp_sha text CHECK (live_cp_sha ~ '^[a-f0-9]{40}$'),
  prior_runtime_sha256 text CHECK (prior_runtime_sha256 ~ '^[a-f0-9]{64}$'),
  ttl_ms integer CHECK (ttl_ms BETWEEN 1000 AND 900000),
  expires_at timestamptz,
  ended_at timestamptz,
  CHECK ((lease_id IS NULL AND run_id IS NULL AND live_cp_sha IS NULL AND prior_runtime_sha256 IS NULL AND ttl_ms IS NULL AND expires_at IS NULL AND ended_at IS NULL)
    OR (lease_id IS NOT NULL AND run_id IS NOT NULL AND live_cp_sha IS NOT NULL AND prior_runtime_sha256 IS NOT NULL AND ttl_ms IS NOT NULL AND expires_at IS NOT NULL))
);
INSERT INTO cloud_runtime_build_drain(singleton) VALUES(true);
ALTER TABLE cloud_runtime_build_drain ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_build_drain FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_runtime_build_drain USING (app_is_system()) WITH CHECK (app_is_system());
-- zeros-expand-exception: new-table-privileges Only migration authority may write the new lease; no existing table privilege changes.
REVOKE ALL ON cloud_runtime_build_drain FROM PUBLIC, zeros_app;
GRANT SELECT ON cloud_runtime_build_drain TO zeros_app;

CREATE TABLE cloud_runtime_build_drain_runs (
  run_id text PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 160),
  version integer NOT NULL DEFAULT 1 CHECK (version=1),
  lease_id uuid NOT NULL UNIQUE,
  live_cp_sha text NOT NULL CHECK (live_cp_sha ~ '^[a-f0-9]{40}$'),
  prior_runtime_sha256 text NOT NULL CHECK (prior_runtime_sha256 ~ '^[a-f0-9]{64}$'),
  ttl_ms integer NOT NULL CHECK (ttl_ms BETWEEN 1000 AND 900000),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz
);
ALTER TABLE cloud_runtime_build_drain_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_runtime_build_drain_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_runtime_build_drain_runs USING (app_is_system()) WITH CHECK (app_is_system());
-- zeros-expand-exception: new-table-privileges Only migration authority may write the new run receipts; no existing table privilege changes.
REVOKE ALL ON cloud_runtime_build_drain_runs FROM PUBLIC, zeros_app;

ALTER TABLE cloud_v2_computer_builds
  ADD COLUMN retry_of uuid REFERENCES cloud_v2_computer_builds(id) ON DELETE SET NULL,
  ADD COLUMN retry_attempt integer NOT NULL DEFAULT 1 CHECK (retry_attempt BETWEEN 1 AND 3),
  ADD COLUMN automatic_base_build_id uuid REFERENCES cloud_v2_computer_builds(id) ON DELETE SET NULL,
  ADD COLUMN automatic_recipe_revision bigint CHECK (automatic_recipe_revision >= 0);
CREATE UNIQUE INDEX cloud_v2_computer_build_retry_once ON cloud_v2_computer_builds(retry_of) WHERE retry_of IS NOT NULL;

-- Old claim SQL and the release operator serialize on the same private row.
CREATE FUNCTION cloud_runtime_build_claim_allowed() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE drain public.cloud_runtime_build_drain%ROWTYPE;
BEGIN
  SELECT * INTO drain FROM public.cloud_runtime_build_drain WHERE singleton FOR UPDATE;
  IF NOT FOUND OR drain.version<>1 THEN
    RAISE EXCEPTION 'Runtime build drain is unavailable' USING ERRCODE='55000';
  END IF;
  RETURN drain.lease_id IS NULL OR drain.ended_at IS NOT NULL OR drain.expires_at<=clock_timestamp();
END;
$$;
-- zeros-expand-exception: privilege-tightening Withdraws default PUBLIC access only on the new claim guard.
REVOKE ALL ON FUNCTION cloud_runtime_build_claim_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_runtime_build_claim_allowed() TO zeros_app;

CREATE FUNCTION cloud_guard_computer_build_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state<>'building' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state='building' THEN RETURN NEW; END IF;
  IF NOT public.cloud_runtime_build_claim_allowed() THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Withdraws default PUBLIC access only on the new trigger function.
REVOKE ALL ON FUNCTION cloud_guard_computer_build_claim() FROM PUBLIC;
CREATE TRIGGER cloud_computer_build_claim_guard BEFORE INSERT OR UPDATE OF state ON cloud_v2_computer_builds
  FOR EACH ROW EXECUTE FUNCTION cloud_guard_computer_build_claim();

CREATE FUNCTION cloud_guard_runtime_handoff_drain() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('prepared','committed') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state=NEW.state AND OLD.id=NEW.id THEN RETURN NEW; END IF;
  IF NOT public.cloud_runtime_build_claim_allowed() THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Withdraws default PUBLIC access only on the new trigger function.
REVOKE ALL ON FUNCTION cloud_guard_runtime_handoff_drain() FROM PUBLIC;
CREATE TRIGGER cloud_runtime_handoff_drain_guard BEFORE INSERT OR UPDATE OF state ON cloud_worker_runtime_handoffs
  FOR EACH ROW EXECUTE FUNCTION cloud_guard_runtime_handoff_drain();
