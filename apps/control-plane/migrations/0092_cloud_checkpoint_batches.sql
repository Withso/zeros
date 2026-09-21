-- Bounded checkpoint admission without per-file network round trips.
-- SECURITY INVOKER: callers retain the existing system transaction and engine
-- authority fence; this helper does not grant access to any additional rows.
CREATE FUNCTION reserve_workspace_blob_storage_batch(
  p_workspace_id uuid, p_org_id uuid, p_blob_ids uuid[], p_reserve_physical boolean
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  storage_limit cloud_workspace_object_storage_limits%ROWTYPE;
  organization_bytes bigint;
  workspace_bytes bigint;
  additional_bytes bigint;
BEGIN
  IF cardinality(p_blob_ids) NOT BETWEEN 1 AND 64
     OR cardinality(p_blob_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_blob_ids) id) THEN
    RETURN 'invalid_storage_reservation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-object-storage:' || p_org_id::text, 0));
  SELECT * INTO storage_limit FROM cloud_workspace_object_storage_limits WHERE org_id = p_org_id;
  IF NOT FOUND THEN RETURN 'object_storage_limit_not_configured'; END IF;
  PERFORM 1 FROM cloud_workspaces WHERE id = p_workspace_id AND org_id = p_org_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN 'invalid_storage_reservation'; END IF;
  PERFORM id FROM workspace_blobs WHERE org_id = p_org_id AND id = ANY(p_blob_ids)
    ORDER BY id FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM workspace_blobs WHERE org_id = p_org_id AND id = ANY(p_blob_ids)
      AND state IN ('pending_upload', 'available')) <> cardinality(p_blob_ids) THEN
    RETURN 'invalid_storage_reservation';
  END IF;
  IF p_reserve_physical THEN
    SELECT coalesce(sum(blob.plaintext_bytes) FILTER (WHERE blob.state IN (
      'pending_upload', 'available', 'quarantined', 'deleting')), 0)
      + coalesce((SELECT sum(reserved_bytes) FROM workspace_blob_rotation_jobs WHERE org_id = p_org_id), 0)
      + coalesce((SELECT sum(reserved_bytes) FROM workspace_blob_object_deletions WHERE org_id = p_org_id), 0)
    INTO organization_bytes FROM workspace_blobs blob WHERE blob.org_id = p_org_id;
    IF organization_bytes > storage_limit.max_organization_bytes THEN
      RETURN 'organization_object_storage_limit_exceeded';
    END IF;
  END IF;
  SELECT coalesce(sum(blob.plaintext_bytes), 0) INTO additional_bytes FROM workspace_blobs blob
    WHERE blob.org_id = p_org_id AND blob.id = ANY(p_blob_ids) AND NOT EXISTS (
      SELECT 1 FROM workspace_blob_storage_reservations reservation
      WHERE reservation.workspace_id = p_workspace_id AND reservation.blob_id = blob.id
    );
  IF additional_bytes > 0 THEN
    SELECT coalesce(sum(reserved_bytes), 0) INTO workspace_bytes
      FROM workspace_blob_storage_reservations WHERE workspace_id = p_workspace_id;
    IF workspace_bytes + additional_bytes > storage_limit.max_workspace_bytes THEN
      RETURN 'workspace_object_storage_limit_exceeded';
    END IF;
  END IF;
  INSERT INTO workspace_blob_storage_reservations (org_id, workspace_id, blob_id, reserved_bytes, state, expires_at)
    SELECT p_org_id, p_workspace_id, id, plaintext_bytes, 'uploading', now() + interval '24 hours'
    FROM workspace_blobs WHERE org_id = p_org_id AND id = ANY(p_blob_ids)
    ON CONFLICT (workspace_id, blob_id) DO UPDATE SET
      expires_at = CASE WHEN workspace_blob_storage_reservations.state = 'referenced' THEN NULL
        ELSE now() + interval '24 hours' END,
      updated_at = now();
  RETURN NULL;
END;
$$;

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

  -- Existing reference reservations cannot increase logical usage. Avoid a
  -- full ledger scan for every immutable event/current-entry reference.
  IF existing_bytes IS NULL THEN
    SELECT coalesce(sum(reserved_bytes), 0) INTO workspace_bytes
    FROM workspace_blob_storage_reservations
    WHERE workspace_id = p_workspace_id;
    IF workspace_bytes + blob_bytes > storage_limit.max_workspace_bytes THEN
      RETURN 'workspace_object_storage_limit_exceeded';
    END IF;
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
