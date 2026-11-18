-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Boat sometimes archives a VM seconds after a resume, with no stop from us (Alpha 2026-11-17/18). The control plane then
-- finishes the stop itself (src/cloud/provider-stop.ts): one row per detection, written in the same transaction as the
-- running -> stopped step. The rows are the measurement record and the durable cap on automatic wakes.
CREATE TABLE cloud_v2_provider_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  sandbox_id text NOT NULL,
  worker_boot_id uuid,
  stop_generation bigint NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('dial', 'suspect', 'wake_check')),
  mode text NOT NULL CHECK (mode IN ('observe', 'on')),
  provider_state text NOT NULL,
  provider_stopped_at timestamptz,
  rewake boolean NOT NULL DEFAULT false,
  -- What the step did: acted (stopped, rewake, capped past the wake cap), only recorded (observed), refused Boat's answer
  -- because it predates our resume or our worker was active after it (contradicted), or held back by the brake (braked).
  outcome text NOT NULL CHECK (outcome IN ('observed', 'contradicted', 'braked', 'stopped', 'rewake', 'capped')),
  -- Our own evidence at detection, for measuring how often Boat's answer was wrong.
  active_at timestamptz,
  lease_renewed_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_v2_provider_stops_workspace ON cloud_v2_provider_stops (workspace_id, worker_boot_id, outcome);
CREATE INDEX cloud_v2_provider_stops_recent ON cloud_v2_provider_stops (detected_at DESC);
ALTER TABLE cloud_v2_provider_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_provider_stops FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_provider_stops USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_provider_stops TO zeros_app;
