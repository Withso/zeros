-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Per-organization rollout flags for new cloud paths. An absent row means
-- off. Rows hold flag state only; the code registry
-- (apps/control-plane/src/rollout-flags.ts) owns which names exist and how
-- each behaves while its change feed is unavailable. Processes read an
-- in-memory snapshot refreshed by NOTIFY, never this table per request.
CREATE TABLE cloud_rollout_flags (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  flag text NOT NULL CHECK (flag ~ '^[a-z][a-z0-9_]{0,62}$'),
  enabled boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, flag)
);

-- Operator receipts: one row per executed change, keyed by the operation id
-- so a replay is recognized. Organization ids are kept without a foreign key
-- so the record survives organization deletion.
CREATE TABLE cloud_rollout_flag_changes (
  operation_id uuid PRIMARY KEY,
  change_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  org_id uuid NOT NULL,
  flag text NOT NULL CHECK (flag ~ '^[a-z][a-z0-9_]{0,62}$'),
  actor_user_id uuid NOT NULL,
  deployment_channel text NOT NULL CHECK (deployment_channel IN ('development','alpha','beta','production')),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  previous_enabled boolean,
  next_enabled boolean NOT NULL,
  next_revision bigint NOT NULL CHECK (next_revision > 0),
  database_principal text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_rollout_flag_changes_subject
  ON cloud_rollout_flag_changes(org_id, flag, change_sequence DESC);

CREATE FUNCTION reject_cloud_rollout_flag_change_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'cloud_rollout_flag_changes is append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER cloud_rollout_flag_changes_append_only
  BEFORE UPDATE OR DELETE ON cloud_rollout_flag_changes FOR EACH ROW
  EXECUTE FUNCTION reject_cloud_rollout_flag_change_mutation();
CREATE TRIGGER cloud_rollout_flag_changes_no_truncate
  BEFORE TRUNCATE ON cloud_rollout_flag_changes FOR EACH STATEMENT
  EXECUTE FUNCTION reject_cloud_rollout_flag_change_mutation();
REVOKE ALL ON FUNCTION reject_cloud_rollout_flag_change_mutation() FROM PUBLIC;

-- An empty, commit-bound hint (0134's function). Subscribers reload the whole
-- table, so one statement-level notification covers any number of rows,
-- including the cascade from an organization deletion.
CREATE TRIGGER cloud_rollout_flags_changed
  AFTER INSERT OR UPDATE OR DELETE ON cloud_rollout_flags
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_rollout_flags');

-- Runtime processes read in system context; only the migration owner (the
-- operator command) writes. The owner policy keeps FORCE RLS meaningful.
ALTER TABLE cloud_rollout_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_rollout_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_rollout_flags_system_read ON cloud_rollout_flags
  FOR SELECT USING (app_is_system());
CREATE POLICY cloud_rollout_flags_owner ON cloud_rollout_flags
  FOR ALL USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_rollout_flags'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_rollout_flags'::regclass)));
REVOKE ALL ON cloud_rollout_flags FROM PUBLIC, zeros_app;
GRANT SELECT ON cloud_rollout_flags TO zeros_app;

ALTER TABLE cloud_rollout_flag_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_rollout_flag_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_rollout_flag_changes_owner ON cloud_rollout_flag_changes
  FOR ALL USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_rollout_flag_changes'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_rollout_flag_changes'::regclass)));
REVOKE ALL ON cloud_rollout_flag_changes FROM PUBLIC, zeros_app;
