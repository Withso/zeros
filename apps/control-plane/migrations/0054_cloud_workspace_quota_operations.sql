-- ───────────────────────────────────────────────────────────
-- 0054 — Audited operator provisioning for cloud workspace quotas
-- ───────────────────────────────────────────────────────────
-- Quotas are a paid-resource admission gate, not Organization-admin settings.
-- Retain an owner-only, append-only record for every operator-created or
-- operator-updated quota. The ordinary application role can read the current
-- quota through existing RLS, but cannot forge this operational evidence.

CREATE TABLE cloud_workspace_quota_changes (
  id                              bigserial PRIMARY KEY,
  org_id                          uuid NOT NULL
                                  REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id                   uuid NOT NULL
                                  REFERENCES users(id) ON DELETE RESTRICT,
  previous_max_workspaces         integer,
  previous_max_running_workspaces integer,
  previous_max_cpu_millicores     integer,
  previous_max_memory_mib         integer,
  previous_max_storage_mib        integer,
  next_max_workspaces             integer NOT NULL
                                  CHECK (next_max_workspaces > 0),
  next_max_running_workspaces     integer NOT NULL CHECK (
                                    next_max_running_workspaces > 0
                                    AND next_max_running_workspaces <= next_max_workspaces
                                  ),
  next_max_cpu_millicores         integer NOT NULL
                                  CHECK (next_max_cpu_millicores >= 250),
  next_max_memory_mib             integer NOT NULL
                                  CHECK (next_max_memory_mib >= 512),
  next_max_storage_mib            integer NOT NULL
                                  CHECK (next_max_storage_mib >= 1024),
  deployment_channel              text NOT NULL CHECK (
                                    deployment_channel IN (
                                      'development', 'alpha', 'beta', 'production'
                                    )
                                  ),
  target_fingerprint              text NOT NULL CHECK (
                                    target_fingerprint ~ '^[a-f0-9]{16}$'
                                  ),
  database_principal              text NOT NULL CHECK (
                                    length(database_principal) BETWEEN 1 AND 128
                                  ),
  reason                          text NOT NULL CHECK (
                                    length(reason) BETWEEN 16 AND 512
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      previous_max_workspaces IS NULL
      AND previous_max_running_workspaces IS NULL
      AND previous_max_cpu_millicores IS NULL
      AND previous_max_memory_mib IS NULL
      AND previous_max_storage_mib IS NULL
    ) OR (
      previous_max_workspaces IS NOT NULL
      AND previous_max_running_workspaces IS NOT NULL
      AND previous_max_cpu_millicores IS NOT NULL
      AND previous_max_memory_mib IS NOT NULL
      AND previous_max_storage_mib IS NOT NULL
      AND previous_max_workspaces > 0
      AND previous_max_running_workspaces > 0
      AND previous_max_running_workspaces <= previous_max_workspaces
      -- Migration 0010 historically accepted any positive resource limits.
      -- Preserve that exact prior state so this audited path can raise a
      -- legacy row to today's minimums instead of making it unchangeable.
      AND previous_max_cpu_millicores > 0
      AND previous_max_memory_mib > 0
      AND previous_max_storage_mib > 0
    )
  )
);

CREATE INDEX cloud_workspace_quota_changes_org_idx
  ON cloud_workspace_quota_changes (org_id, created_at DESC, id DESC);

CREATE FUNCTION reject_cloud_workspace_quota_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud_workspace_quota_changes is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER cloud_workspace_quota_changes_append_only
  BEFORE UPDATE OR DELETE ON cloud_workspace_quota_changes
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_quota_change_mutation();

CREATE TRIGGER cloud_workspace_quota_changes_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_quota_changes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_cloud_workspace_quota_change_mutation();

REVOKE ALL ON cloud_workspace_quota_changes FROM zeros_app;
REVOKE ALL ON SEQUENCE cloud_workspace_quota_changes_id_seq FROM zeros_app;
REVOKE ALL ON FUNCTION reject_cloud_workspace_quota_change_mutation()
  FROM PUBLIC;
