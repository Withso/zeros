-- ─────────────────────────────────────────────────────────────────────────────
-- 0055 — Durable object-storage admission and reservation accounting
-- ─────────────────────────────────────────────────────────────────────────────
-- Provider `storage_mib` quotas bound sandbox disks. These limits separately
-- bound the coordinator-owned encrypted object volume. Admission is serialized
-- on one Organization limit row before an object can be published.

CREATE TABLE cloud_workspace_object_storage_limits (
  org_id                    uuid PRIMARY KEY
                            REFERENCES organizations(id) ON DELETE RESTRICT,
  max_organization_bytes    bigint NOT NULL CHECK (
                              max_organization_bytes BETWEEN 1 AND 9007199254740991
                            ),
  max_workspace_bytes       bigint NOT NULL CHECK (
                              max_workspace_bytes BETWEEN 1 AND 9007199254740991
                            ),
  updated_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cloud_workspace_object_storage_limits_coherent_check
    CHECK (max_workspace_bytes <= max_organization_bytes)
);

CREATE TABLE cloud_workspace_object_storage_limit_changes (
  id                         bigserial PRIMARY KEY,
  org_id                     uuid NOT NULL
                             REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id              uuid NOT NULL
                             REFERENCES users(id) ON DELETE RESTRICT,
  previous_organization_bytes bigint,
  previous_workspace_bytes   bigint,
  next_organization_bytes    bigint NOT NULL CHECK (
                               next_organization_bytes BETWEEN 1 AND 9007199254740991
                             ),
  next_workspace_bytes       bigint NOT NULL CHECK (
                               next_workspace_bytes BETWEEN 1 AND 9007199254740991
                             ),
  deployment_channel         text NOT NULL CHECK (
                               deployment_channel IN (
                                 'development', 'alpha', 'beta', 'production'
                               )
                             ),
  target_fingerprint         text NOT NULL CHECK (
                               target_fingerprint ~ '^[a-f0-9]{16}$'
                             ),
  database_principal         text NOT NULL CHECK (
                               length(database_principal) BETWEEN 1 AND 128
                             ),
  reason                     text NOT NULL CHECK (
                               length(reason) BETWEEN 16 AND 512
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (previous_organization_bytes IS NULL AND previous_workspace_bytes IS NULL)
    OR (
      previous_organization_bytes BETWEEN 1 AND 9007199254740991
      AND previous_workspace_bytes BETWEEN 1 AND 9007199254740991
      AND previous_workspace_bytes <= previous_organization_bytes
    )
  ),
  CONSTRAINT cloud_workspace_object_storage_limit_changes_coherent_check
    CHECK (next_workspace_bytes <= next_organization_bytes)
);
CREATE INDEX cloud_workspace_object_storage_limit_changes_org_idx
  ON cloud_workspace_object_storage_limit_changes
    (org_id, created_at DESC, id DESC);

CREATE TABLE workspace_blob_storage_reservations (
  org_id                     uuid NOT NULL,
  workspace_id               uuid NOT NULL,
  blob_id                    uuid NOT NULL,
  reserved_bytes             bigint NOT NULL CHECK (
                               reserved_bytes BETWEEN 0 AND 67108864
                             ),
  state                      text NOT NULL CHECK (state IN ('uploading', 'referenced')),
  expires_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, blob_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE CASCADE,
  CHECK (
    (state = 'uploading' AND expires_at IS NOT NULL)
    OR (state = 'referenced' AND expires_at IS NULL)
  )
);
CREATE INDEX workspace_blob_storage_reservations_org_idx
  ON workspace_blob_storage_reservations (org_id, workspace_id, blob_id);
CREATE INDEX workspace_blob_storage_reservations_expiry_idx
  ON workspace_blob_storage_reservations (expires_at, workspace_id, blob_id)
  WHERE state = 'uploading';

ALTER TABLE workspace_blob_rotation_jobs
  ADD COLUMN reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (
    reserved_bytes BETWEEN 0 AND 67108864
  );

-- Existing immutable references become the initial logical workspace ledger.
-- Existing unreferenced blobs remain part of Organization physical usage and
-- are reclaimed by the established pending/orphan garbage collector.
INSERT INTO workspace_blob_storage_reservations (
  org_id, workspace_id, blob_id, reserved_bytes, state, expires_at
)
SELECT reference.org_id, reference.workspace_id, reference.blob_id,
       blob.plaintext_bytes, 'referenced', NULL
FROM workspace_blob_references reference
JOIN workspace_blobs blob
  ON blob.id = reference.blob_id AND blob.org_id = reference.org_id
GROUP BY reference.org_id, reference.workspace_id, reference.blob_id,
         blob.plaintext_bytes;

CREATE FUNCTION reserve_workspace_blob_storage(
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
  -- State transitions take NO KEY UPDATE, which fences garbage collection but
  -- remains compatible with the KEY SHARE lock acquired by this blob's FK.
  -- FOR UPDATE here would turn concurrent reference admission into a lock
  -- upgrade cycle against the Organization advisory lock.
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

CREATE FUNCTION reserve_workspace_blob_rotation_storage(
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
  -- The Organization advisory lock serializes capacity accounting. Lock only
  -- the mutable job row: a blob FK check may already hold KEY SHARE on the
  -- immutable blob row before waiting for this advisory lock.
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

CREATE FUNCTION account_workspace_blob_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rejection text;
BEGIN
  rejection := reserve_workspace_blob_storage(
    NEW.workspace_id, NEW.org_id, NEW.blob_id, false, 'referenced'
  );
  IF rejection IS NOT NULL THEN
    RAISE EXCEPTION 'workspace blob reference admission rejected: %', rejection
      USING ERRCODE = 'P0001', DETAIL = rejection;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION release_workspace_blob_reference_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The Organization advisory lock serializes ledger mutation with new
  -- upload/reference admission. Maintenance also repairs a conservative stale
  -- row if a prior workflow stopped before releasing it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-object-storage:' || OLD.org_id::text, 0)
  );
  DELETE FROM workspace_blob_storage_reservations reservation
  WHERE reservation.workspace_id = OLD.workspace_id
    AND reservation.blob_id = OLD.blob_id
    AND reservation.state = 'referenced'
    AND NOT EXISTS (
      SELECT 1 FROM workspace_blob_references reference
      WHERE reference.workspace_id = OLD.workspace_id
        AND reference.blob_id = OLD.blob_id
    );
  RETURN OLD;
END;
$$;

CREATE TRIGGER workspace_blob_references_account_insert
  AFTER INSERT ON workspace_blob_references
  FOR EACH ROW EXECUTE FUNCTION account_workspace_blob_reference();
CREATE TRIGGER workspace_blob_references_account_delete
  AFTER DELETE ON workspace_blob_references
  FOR EACH ROW EXECUTE FUNCTION release_workspace_blob_reference_reservation();

CREATE FUNCTION reject_cloud_workspace_object_storage_limit_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cloud_workspace_object_storage_limit_changes is append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cloud_workspace_object_storage_limit_changes_append_only
  BEFORE UPDATE OR DELETE ON cloud_workspace_object_storage_limit_changes
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_object_storage_limit_change_mutation();
CREATE TRIGGER cloud_workspace_object_storage_limit_changes_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_object_storage_limit_changes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_cloud_workspace_object_storage_limit_change_mutation();

ALTER TABLE cloud_workspace_object_storage_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_blob_storage_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_object_storage_limits_read
  ON cloud_workspace_object_storage_limits FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
-- FORCE RLS also binds a non-superuser migration owner. The policy makes the
-- owner CLI's explicit system context usable; zeros_app deliberately receives
-- no INSERT/UPDATE/DELETE table privilege, so runtime code still cannot mutate
-- limits even inside a system transaction.
CREATE POLICY cloud_workspace_object_storage_limits_owner_manage
  ON cloud_workspace_object_storage_limits FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_blob_storage_reservations_system
  ON workspace_blob_storage_reservations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_object_storage_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_blob_storage_reservations FORCE ROW LEVEL SECURITY;

-- Migration 0004 grants DML on future tables by default. Narrow this operator
-- table back to read-only before granting the one runtime capability it needs.
REVOKE ALL ON cloud_workspace_object_storage_limits FROM zeros_app;
GRANT SELECT ON cloud_workspace_object_storage_limits TO zeros_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace_blob_storage_reservations TO zeros_app;
GRANT EXECUTE ON FUNCTION reserve_workspace_blob_storage(
  uuid, uuid, uuid, boolean, text
) TO zeros_app;
GRANT EXECUTE ON FUNCTION reserve_workspace_blob_rotation_storage(
  uuid, uuid, integer
) TO zeros_app;
GRANT EXECUTE ON FUNCTION account_workspace_blob_reference() TO zeros_app;
GRANT EXECUTE ON FUNCTION release_workspace_blob_reference_reservation()
  TO zeros_app;

REVOKE ALL ON cloud_workspace_object_storage_limit_changes FROM zeros_app;
REVOKE ALL ON SEQUENCE cloud_workspace_object_storage_limit_changes_id_seq
  FROM zeros_app;
REVOKE ALL ON FUNCTION reserve_workspace_blob_storage(
  uuid, uuid, uuid, boolean, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_workspace_blob_rotation_storage(
  uuid, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION account_workspace_blob_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workspace_blob_reference_reservation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_cloud_workspace_object_storage_limit_change_mutation()
  FROM PUBLIC;
