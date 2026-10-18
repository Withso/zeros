-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Hourly compute metering compares each provider usage increment with the
-- allocation's weighted wall-clock time. A difference beyond the tolerance is
-- recorded here, once per metered window, and audited; billing still follows
-- the provider meter. Aggregate health reads it without tenant identifiers.
-- No foreign keys: a workspace or Organization purge never waits on it.
CREATE TABLE managed_compute_usage_disagreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL,
  period_id uuid NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  window_since timestamptz NOT NULL,
  window_until timestamptz NOT NULL CHECK (window_until > window_since),
  provider_seconds bigint NOT NULL CHECK (provider_seconds >= 0),
  expected_seconds bigint NOT NULL CHECK (expected_seconds >= 0),
  direction text NOT NULL CHECK (direction IN ('over', 'under')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, period_id, window_until)
);
CREATE INDEX managed_compute_usage_disagreements_detected
  ON managed_compute_usage_disagreements(detected_at);

ALTER TABLE managed_compute_usage_disagreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_compute_usage_disagreements FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON managed_compute_usage_disagreements
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON managed_compute_usage_disagreements TO zeros_app;
