-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A durable, at-least-once job queue for control-plane workers. Rows carry
-- scheduling state and identifiers only: payloads never hold credentials or
-- authority, and handlers re-read and fence domain state before acting.
-- Completed jobs are deleted; only terminal failures are retained.
-- Scope columns deliberately have no foreign keys: an FK check takes a key
-- share lock on the parent, which would block enqueue behind lifecycle
-- claims that hold FOR UPDATE on the workspace row.
CREATE TABLE control_plane_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  org_id uuid,
  workspace_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 8192),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 1 AND 100),
  lease_owner text CHECK (lease_owner ~ '^[A-Za-z0-9:._-]{1,128}$'),
  lease_token uuid,
  locked_until timestamptz,
  -- A request that arrived while a run was in progress. Completion requeues
  -- the job at this time so the request is never absorbed by a stale run.
  rerun_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z_]{2,62}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK (attempts <= max_attempts),
  CHECK ((state = 'running') = (num_nonnulls(lease_owner, lease_token, locked_until) = 3)),
  CHECK (num_nonnulls(lease_owner, lease_token, locked_until) IN (0, 3)),
  CHECK ((state = 'failed') = (finished_at IS NOT NULL)),
  CHECK (rerun_at IS NULL OR state = 'running')
);

-- One active job per kind and key; terminal failures do not block a new one.
CREATE UNIQUE INDEX control_plane_jobs_active_key ON control_plane_jobs(kind, dedupe_key)
  WHERE state IN ('queued','running');
CREATE INDEX control_plane_jobs_due ON control_plane_jobs(kind, run_at) WHERE state = 'queued';
CREATE INDEX control_plane_jobs_leases ON control_plane_jobs(kind, locked_until) WHERE state = 'running';
CREATE INDEX control_plane_jobs_failed ON control_plane_jobs(finished_at) WHERE state = 'failed';

-- Empty, commit-bound hints only (0134's function). Future run_at values
-- wake too, so an idle runner learns about a new earliest deadline. Updates
-- that leave state and run_at unchanged, such as an idempotent re-enqueue,
-- stay silent.
CREATE TRIGGER control_plane_job_enqueued
  AFTER INSERT ON control_plane_jobs
  FOR EACH ROW WHEN (NEW.state = 'queued')
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_control_plane_job_work');

CREATE TRIGGER control_plane_job_requeued
  AFTER UPDATE OF state, run_at ON control_plane_jobs
  FOR EACH ROW WHEN (NEW.state = 'queued'
    AND (OLD.state IS DISTINCT FROM NEW.state OR OLD.run_at IS DISTINCT FROM NEW.run_at))
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_control_plane_job_work');

ALTER TABLE control_plane_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON control_plane_jobs FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON control_plane_jobs TO zeros_app;
