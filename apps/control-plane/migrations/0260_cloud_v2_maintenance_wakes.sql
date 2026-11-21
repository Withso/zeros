-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Retention S2 (CLOUD_V2_RETENTION_ENABLED, src/cloud/lifecycle.ts): every sleeping workspace's machine is woken for
-- about a minute every 10 days so Boat's 14-day deletion of a stopped disk never reaches it. A wake is invisible: it
-- never changes state, boat_sandbox_id, updated_at, active_at or tokens, and touches none of the columns the catalog
-- push trigger (0248) watches.
-- machine_stopped_at: Boat's stoppedAt after the latest maintenance wake (stopped_at stays the user's stop). The next
-- wake counts from whichever of the two is later.
-- maintenance_attempt/maintenance_phase/maintenance_started_at: the wake in flight. 'stopping' is set in the same
-- statement that checks state='stopped'; a user wake that finds it waits for it to clear or takes it over.
-- archive_wake_done_at: an archived workspace is woken exactly once per archive, 10 days after it.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN machine_stopped_at timestamptz,
  ADD COLUMN maintenance_attempt uuid,
  ADD COLUMN maintenance_phase text CHECK (maintenance_phase IN ('waking', 'stopping')),
  ADD COLUMN maintenance_started_at timestamptz,
  ADD COLUMN archive_wake_done_at timestamptz,
  -- A maintenance wake verified the worker service off for this stop generation (the stop itself may not have).
  ADD COLUMN worker_off_verified_generation bigint,
  ADD CONSTRAINT cloud_v2_maintenance_complete CHECK ((maintenance_attempt IS NULL) = (maintenance_phase IS NULL));

-- Each maintenance start of a machine (a wake, or a retention backup fork): the shared budget's count against Boat's
-- creation-request limits, and Zeros's own record of that machine time.
CREATE TABLE cloud_v2_maintenance_wakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  attempt uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('wake', 'backup_fork')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('stopped', 'adopted', 'gone', 'failed')),
  worker_found_running boolean NOT NULL DEFAULT false,
  -- When Boat is expected to delete the machine's disk: Boat's own dataExpiredAt when it reports one, else its
  -- stoppedAt + 14 days (an estimate; one Alpha machine outlived it).
  deadline_at timestamptz,
  -- What Boat reported at this wake's inspects.
  snapshot_available boolean,
  data_expired_at timestamptz,
  UNIQUE (attempt)
);
CREATE INDEX cloud_v2_maintenance_wakes_recent ON cloud_v2_maintenance_wakes (started_at DESC);
CREATE INDEX cloud_v2_maintenance_wakes_workspace ON cloud_v2_maintenance_wakes (workspace_id, started_at DESC);
ALTER TABLE cloud_v2_maintenance_wakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_maintenance_wakes FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_maintenance_wakes USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_maintenance_wakes TO zeros_app;
