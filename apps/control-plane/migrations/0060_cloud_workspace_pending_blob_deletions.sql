-- ─────────────────────────────────────────────────────────────────────────────
-- 0060 — Durable deletion identities for abandoned pending uploads
-- ─────────────────────────────────────────────────────────────────────────────
-- zeros:requires-controlled-downtime
-- A pending upload can outlive its database lease while an object-store call is
-- still in flight. Detach the blob identity before deletion so it can never be
-- published afterward, but retain the exact physical key until deletion is
-- confirmed. These tombstones remain part of Organization physical usage.

-- Retry budgeting and lease ownership are separate concerns. Every claim gets
-- a new monotonic fence even when provider polling does not consume an attempt.
ALTER TABLE deletion_requests
  ADD COLUMN lease_revision bigint NOT NULL DEFAULT 0 CHECK (lease_revision >= 0);

CREATE TABLE workspace_blob_object_deletions (
  object_key                 text PRIMARY KEY CHECK (
                               char_length(object_key) BETWEEN 16 AND 1024
                               AND object_key !~ '[\u0000-\u001f\u007f]'
                             ),
  org_id                     uuid NOT NULL
                             REFERENCES organizations(id) ON DELETE RESTRICT,
  blob_id                    uuid NOT NULL,
  reserved_bytes             bigint NOT NULL CHECK (
                               reserved_bytes BETWEEN 0 AND 67108864
                             ),
  attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  revision                   bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_attempt_at            timestamptz NOT NULL DEFAULT now(),
  last_error_code            text CHECK (
                               last_error_code IS NULL
                               OR last_error_code ~ '^[a-z][a-z0-9_]{2,127}$'
                             ),
  fenced_at                  timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (
    fenced_at IS NULL OR (reserved_bytes = 0 AND last_error_code IS NULL)
  )
);
CREATE INDEX workspace_blob_object_deletions_claim_idx
  ON workspace_blob_object_deletions (next_attempt_at, object_key);
CREATE INDEX workspace_blob_object_deletions_org_idx
  ON workspace_blob_object_deletions (org_id, object_key);
CREATE INDEX workspace_blobs_available_key_version_idx
  ON workspace_blobs (encryption_key_version DESC)
  WHERE state = 'available';

-- A deleted logical blob retains its immutable physical-key tombstone, but it
-- must not reserve that plaintext identity forever. A later upload of identical
-- content receives a fresh blob id/key while pending, available, quarantined,
-- and deleting rows remain uniquely deduplicated.
DROP INDEX workspace_blobs_org_plaintext_unique;
CREATE UNIQUE INDEX workspace_blobs_org_plaintext_unique
  ON workspace_blobs (org_id, plaintext_sha256)
  WHERE state <> 'deleted';

-- Pre-fence workers used plain object deletion. Queue every reconstructable
-- historical key for permanent fencing before readiness can pass. Grouping only
-- exact tenant/blob identities permits benign overlap; a cross-identity key
-- collision still fails closed on the primary key.
INSERT INTO workspace_blob_object_deletions (
  org_id, blob_id, object_key, reserved_bytes
)
SELECT candidate.org_id, candidate.blob_id, candidate.object_key,
       max(candidate.plaintext_bytes)::bigint
FROM (
  SELECT blob.org_id, blob.id AS blob_id, blob.object_key,
         blob.plaintext_bytes
  FROM workspace_blobs blob
  WHERE blob.state = 'deleted'
  UNION ALL
  SELECT job.org_id, job.blob_id, job.source_object_key AS object_key,
         blob.plaintext_bytes
  FROM workspace_blob_rotation_jobs job
  JOIN workspace_blobs blob
    ON blob.id = job.blob_id AND blob.org_id = job.org_id
  WHERE job.state = 'succeeded'
    AND job.source_object_key <> job.target_object_key
) candidate
GROUP BY candidate.org_id, candidate.blob_id, candidate.object_key;

-- A terminal rotation target must stay exclusively owned while its physical
-- key is fenced. A crashed cleanup lease can be reclaimed, but no writer may
-- return to publication for that key.
ALTER TABLE workspace_blob_rotation_jobs
  DROP CONSTRAINT workspace_blob_rotation_jobs_state_check,
  DROP CONSTRAINT workspace_blob_rotation_jobs_check;

-- A pre-fence control-plane could terminalize a failed rotation while target
-- bytes still existed. Conservatively retain one blob-sized reservation and
-- force every such target through the new owned fence/cleanup state before it
-- may become retryable.
UPDATE workspace_blob_rotation_jobs job
SET state = 'target_cleanup_pending',
    lease_owner = NULL,
    lease_expires_at = NULL,
    completed_at = NULL,
    reserved_bytes = greatest(job.reserved_bytes, blob.plaintext_bytes),
    error_code = coalesce(job.error_code, 'rotation_upgrade_cleanup')
FROM workspace_blobs blob
WHERE job.blob_id = blob.id
  AND job.org_id = blob.org_id
  AND job.state = 'failed';

ALTER TABLE workspace_blob_rotation_jobs
  ADD CONSTRAINT workspace_blob_rotation_jobs_state_check CHECK (
    state IN (
      'queued', 'processing', 'cleanup_pending', 'target_cleanup_pending',
      'succeeded', 'failed'
    )
  ),
  ADD CONSTRAINT workspace_blob_rotation_jobs_check CHECK (
    (
      (
        state = 'processing'
        AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL
      ) OR (
        state = 'target_cleanup_pending'
        AND (
          (lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        )
      ) OR (
        state NOT IN ('processing', 'target_cleanup_pending')
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
      )
    )
    AND (
      (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
      OR (state NOT IN ('succeeded', 'failed') AND completed_at IS NULL)
    )
    AND (state <> 'succeeded' OR reserved_bytes = 0)
  );

DROP INDEX workspace_blob_rotation_jobs_claim_idx;
CREATE INDEX workspace_blob_rotation_jobs_claim_idx
  ON workspace_blob_rotation_jobs (created_at, blob_id, target_key_version)
  INCLUDE (state, lease_expires_at)
  WHERE state IN (
    'queued', 'processing', 'cleanup_pending', 'target_cleanup_pending'
  );

ALTER TABLE workspace_blob_object_deletions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_blob_object_deletions_system
  ON workspace_blob_object_deletions FOR ALL
  USING (app_is_system())
  WITH CHECK (app_is_system());
ALTER TABLE workspace_blob_object_deletions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace_blob_object_deletions TO zeros_app;

-- Retrying a terminal key-rotation failure is a security-sensitive owner
-- operation, never an automatic worker transition. Preserve one append-only,
-- target-bound evidence row for every exact retry.
CREATE TABLE cloud_workspace_object_rotation_retry_changes (
  id                          bigserial PRIMARY KEY,
  org_id                      uuid NOT NULL
                              REFERENCES organizations(id) ON DELETE RESTRICT,
  blob_id                     uuid NOT NULL,
  actor_user_id               uuid NOT NULL
                              REFERENCES users(id) ON DELETE RESTRICT,
  target_key_version          integer NOT NULL CHECK (target_key_version > 0),
  source_key_version          integer NOT NULL CHECK (source_key_version > 0),
  prior_attempt_count         integer NOT NULL CHECK (prior_attempt_count > 0),
  prior_error_code            text NOT NULL CHECK (
                                prior_error_code ~ '^[a-z][a-z0-9_]{2,127}$'
                              ),
  prior_target_sha256         bytea NOT NULL CHECK (
                                octet_length(prior_target_sha256) = 32
                              ),
  next_target_sha256          bytea NOT NULL CHECK (
                                octet_length(next_target_sha256) = 32
                              ),
  fence_revision              bigint NOT NULL CHECK (fence_revision > 0),
  fence_fenced_at             timestamptz NOT NULL,
  job_snapshot_fingerprint    text NOT NULL CHECK (
                                job_snapshot_fingerprint ~ '^[a-f0-9]{32}$'
                              ),
  deployment_channel          text NOT NULL CHECK (
                                deployment_channel IN (
                                  'development', 'alpha', 'beta', 'production'
                                )
                              ),
  target_fingerprint          text NOT NULL CHECK (
                                target_fingerprint ~ '^[a-f0-9]{16}$'
                              ),
  database_principal          text NOT NULL CHECK (
                                char_length(database_principal) BETWEEN 1 AND 128
                              ),
  reason                      text NOT NULL CHECK (
                                char_length(reason) BETWEEN 16 AND 512
                              ),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, blob_id, target_key_version, job_snapshot_fingerprint)
);
CREATE INDEX cloud_workspace_object_rotation_retry_changes_org_idx
  ON cloud_workspace_object_rotation_retry_changes
    (org_id, created_at DESC, id DESC);

CREATE FUNCTION reject_cloud_workspace_object_rotation_retry_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.app_is_system()
     AND EXISTS (
       SELECT 1 FROM public.organizations
       WHERE id = OLD.org_id AND lifecycle_status = 'purging'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cloud_workspace_object_rotation_retry_changes is append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cloud_workspace_object_rotation_retry_changes_append_only
  BEFORE UPDATE OR DELETE ON cloud_workspace_object_rotation_retry_changes
  FOR EACH ROW
  EXECUTE FUNCTION reject_cloud_workspace_object_rotation_retry_change_mutation();
CREATE TRIGGER cloud_workspace_object_rotation_retry_changes_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_object_rotation_retry_changes
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_cloud_workspace_object_rotation_retry_change_mutation();
REVOKE ALL ON cloud_workspace_object_rotation_retry_changes FROM zeros_app;
REVOKE ALL ON SEQUENCE cloud_workspace_object_rotation_retry_changes_id_seq
  FROM zeros_app;
REVOKE ALL ON FUNCTION
  reject_cloud_workspace_object_rotation_retry_change_mutation() FROM PUBLIC;

-- Operator change logs are append-only during an Organization's lifetime, but
-- privacy purge must remove their tenant identifiers. Permit only the system
-- lifecycle while the parent row is already irreversibly in `purging`.
CREATE OR REPLACE FUNCTION reject_cloud_workspace_quota_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.app_is_system()
     AND EXISTS (
       SELECT 1 FROM public.organizations
       WHERE id = OLD.org_id AND lifecycle_status = 'purging'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cloud_workspace_quota_changes is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION reject_cloud_workspace_object_storage_limit_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.app_is_system()
     AND EXISTS (
       SELECT 1 FROM public.organizations
       WHERE id = OLD.org_id AND lifecycle_status = 'purging'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cloud_workspace_object_storage_limit_changes is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION reject_cloud_workspace_usage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.app_is_system()
     AND EXISTS (
       SELECT 1 FROM public.organizations
       WHERE id = OLD.org_id AND lifecycle_status = 'purging'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cloud workspace usage events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION purge_cloud_workspace_operator_configuration(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'system context required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations
  WHERE id = p_org_id AND lifecycle_status = 'purging'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization purge state mismatch' USING ERRCODE = '55000';
  END IF;

  -- Usage must precede workspace/provider-version deletion because its exact
  -- authority and billing FKs are deliberately RESTRICTing during tenant life.
  DELETE FROM public.cloud_workspace_usage_events WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_quota_changes WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_object_storage_limit_changes
  WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_object_storage_limits WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_object_rotation_retry_changes
  WHERE org_id = p_org_id;
END;
$$;
REVOKE ALL ON FUNCTION purge_cloud_workspace_operator_configuration(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_cloud_workspace_operator_configuration(uuid)
  TO zeros_app;

-- Account purge must fail before irreversible identity-provider deletion if a
-- legacy/corrupt Personal Organization owns any cloud-only row that would
-- block its local hard delete. Some operator evidence is intentionally not
-- selectable by the application role, so expose only this system-only boolean.
CREATE FUNCTION personal_organization_has_cloud_configuration(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'system context required' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM (
      SELECT workspace.org_id
      FROM public.cloud_workspaces workspace
      UNION ALL
      SELECT repository.org_id FROM public.repositories repository
      UNION ALL
      SELECT blob.org_id FROM public.workspace_blobs blob
      UNION ALL
      SELECT quota.org_id FROM public.cloud_workspace_quotas quota
      UNION ALL
      SELECT change.org_id FROM public.cloud_workspace_quota_changes change
      UNION ALL
      SELECT storage.org_id
      FROM public.cloud_workspace_object_storage_limits storage
      UNION ALL
      SELECT change.org_id
      FROM public.cloud_workspace_object_storage_limit_changes change
      UNION ALL
      SELECT deletion.org_id
      FROM public.workspace_blob_object_deletions deletion
      UNION ALL
      SELECT rotation.org_id
      FROM public.cloud_workspace_object_rotation_retry_changes rotation
    ) cloud
    JOIN public.organizations organization ON organization.id = cloud.org_id
    WHERE organization.created_by = p_account_id
      AND organization.is_personal
  );
END;
$$;
REVOKE ALL ON FUNCTION personal_organization_has_cloud_configuration(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION personal_organization_has_cloud_configuration(uuid)
  TO zeros_app;

CREATE OR REPLACE FUNCTION reserve_workspace_blob_storage(
  p_workspace_id uuid,
  p_org_id uuid,
  p_blob_id uuid,
  p_reserve_physical boolean,
  p_reference_state text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  storage_limit cloud_workspace_object_storage_limits%ROWTYPE;
  blob_bytes bigint;
  blob_state workspace_blob_state;
  existing_bytes bigint;
  organization_bytes bigint;
  workspace_bytes bigint;
BEGIN
  IF p_reference_state NOT IN ('uploading', 'referenced') THEN
    RETURN 'invalid_storage_reservation';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-object-storage:' || p_org_id::text, 0)
  );
  SELECT * INTO storage_limit
  FROM cloud_workspace_object_storage_limits
  WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN 'object_storage_limit_not_configured';
  END IF;

  PERFORM 1 FROM cloud_workspaces
  WHERE id = p_workspace_id AND org_id = p_org_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'invalid_storage_reservation';
  END IF;

  SELECT plaintext_bytes, state INTO blob_bytes, blob_state
  FROM workspace_blobs
  WHERE id = p_blob_id AND org_id = p_org_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR blob_state NOT IN ('pending_upload', 'available') THEN
    RETURN 'invalid_storage_reservation';
  END IF;

  SELECT reserved_bytes INTO existing_bytes
  FROM workspace_blob_storage_reservations
  WHERE workspace_id = p_workspace_id AND blob_id = p_blob_id;

  IF p_reserve_physical THEN
    SELECT
      coalesce(sum(blob.plaintext_bytes) FILTER (
        WHERE blob.state IN (
          'pending_upload', 'available', 'quarantined', 'deleting'
        )
      ), 0)
      + coalesce((
          SELECT sum(job.reserved_bytes)
          FROM workspace_blob_rotation_jobs job
          WHERE job.org_id = p_org_id AND job.reserved_bytes > 0
        ), 0)
      + coalesce((
          SELECT sum(deletion.reserved_bytes)
          FROM workspace_blob_object_deletions deletion
          WHERE deletion.org_id = p_org_id
        ), 0)
    INTO organization_bytes
    FROM workspace_blobs blob
    WHERE blob.org_id = p_org_id;
    IF organization_bytes > storage_limit.max_organization_bytes THEN
      RETURN 'organization_object_storage_limit_exceeded';
    END IF;
  END IF;

  SELECT coalesce(sum(reserved_bytes), 0) INTO workspace_bytes
  FROM workspace_blob_storage_reservations
  WHERE workspace_id = p_workspace_id;
  IF existing_bytes IS NULL
     AND workspace_bytes + blob_bytes > storage_limit.max_workspace_bytes THEN
    RETURN 'workspace_object_storage_limit_exceeded';
  END IF;

  INSERT INTO workspace_blob_storage_reservations (
    org_id, workspace_id, blob_id, reserved_bytes, state, expires_at
  ) VALUES (
    p_org_id, p_workspace_id, p_blob_id, blob_bytes, p_reference_state,
    CASE WHEN p_reference_state = 'uploading'
      THEN now() + interval '24 hours' ELSE NULL END
  )
  ON CONFLICT (workspace_id, blob_id) DO UPDATE
  SET state = CASE
        WHEN workspace_blob_storage_reservations.state = 'referenced'
          OR EXCLUDED.state = 'referenced' THEN 'referenced'
        ELSE 'uploading'
      END,
      expires_at = CASE
        WHEN workspace_blob_storage_reservations.state = 'referenced'
          OR EXCLUDED.state = 'referenced' THEN NULL
        ELSE now() + interval '24 hours'
      END,
      updated_at = now();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION reserve_workspace_blob_rotation_storage(
  p_blob_id uuid,
  p_org_id uuid,
  p_target_key_version integer
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  storage_limit cloud_workspace_object_storage_limits%ROWTYPE;
  blob_bytes bigint;
  current_reservation bigint;
  organization_bytes bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-object-storage:' || p_org_id::text, 0)
  );
  SELECT * INTO storage_limit
  FROM cloud_workspace_object_storage_limits
  WHERE org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN 'object_storage_limit_not_configured';
  END IF;

  SELECT blob.plaintext_bytes, job.reserved_bytes
  INTO blob_bytes, current_reservation
  FROM workspace_blob_rotation_jobs job
  JOIN workspace_blobs blob
    ON blob.id = job.blob_id AND blob.org_id = job.org_id
  WHERE job.blob_id = p_blob_id AND job.org_id = p_org_id
    AND job.target_key_version = p_target_key_version
    AND job.state = 'processing'
  FOR UPDATE OF job;
  IF NOT FOUND THEN
    RETURN 'invalid_storage_reservation';
  END IF;
  IF current_reservation = blob_bytes THEN
    RETURN NULL;
  END IF;

  SELECT
    coalesce(sum(blob.plaintext_bytes) FILTER (
      WHERE blob.state IN (
        'pending_upload', 'available', 'quarantined', 'deleting'
      )
    ), 0)
    + coalesce((
        SELECT sum(job.reserved_bytes)
        FROM workspace_blob_rotation_jobs job
        WHERE job.org_id = p_org_id
      ), 0)
    - current_reservation + blob_bytes
    + coalesce((
        SELECT sum(deletion.reserved_bytes)
        FROM workspace_blob_object_deletions deletion
        WHERE deletion.org_id = p_org_id
      ), 0)
  INTO organization_bytes
  FROM workspace_blobs blob
  WHERE blob.org_id = p_org_id;
  IF organization_bytes > storage_limit.max_organization_bytes THEN
    RETURN 'organization_object_storage_limit_exceeded';
  END IF;

  UPDATE workspace_blob_rotation_jobs
  SET reserved_bytes = blob_bytes
  WHERE blob_id = p_blob_id AND target_key_version = p_target_key_version;
  RETURN NULL;
END;
$$;
