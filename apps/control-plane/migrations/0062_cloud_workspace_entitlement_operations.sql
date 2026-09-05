-- ───────────────────────────────────────────────────────────
-- 0062 — audited Organization cloud-entitlement activation
-- ───────────────────────────────────────────────────────────
-- Organization billing authority and paid seats are not inferred from a quota.
-- Preserve one database-owner, append-only record for every explicit operator
-- activation or update. Ordinary application code can consume the resulting
-- entitlement under existing RLS, but cannot forge the operator evidence.

CREATE TABLE cloud_workspace_entitlement_changes (
  id                              bigserial PRIMARY KEY,
  org_id                          uuid NOT NULL
                                  REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id                   uuid NOT NULL
                                  REFERENCES users(id) ON DELETE RESTRICT,

  previous_plan                   text CHECK (
                                    previous_plan IS NULL OR previous_plan IN (
                                      'pro', 'business', 'enterprise'
                                    )
                                  ),
  previous_status                 text CHECK (
                                    previous_status IS NULL OR previous_status IN (
                                      'active', 'trialing', 'past_due', 'paused',
                                      'cancelled', 'expired'
                                    )
                                  ),
  previous_cloud_workspaces_allowed boolean,
  previous_seat_limit             integer CHECK (
                                    previous_seat_limit IS NULL
                                    OR previous_seat_limit > 0
                                  ),
  previous_source                 text CHECK (
                                    previous_source IS NULL OR previous_source IN (
                                      'stripe', 'contract', 'operator', 'migration'
                                    )
                                  ),
  previous_source_reference       text CHECK (
                                    previous_source_reference IS NULL
                                    OR char_length(previous_source_reference) <= 512
                                  ),
  previous_valid_from             timestamptz,
  previous_valid_until            timestamptz,
  previous_revision               bigint CHECK (
                                    previous_revision IS NULL OR previous_revision > 0
                                  ),
  previous_active_seat_user_ids   uuid[] NOT NULL DEFAULT '{}'::uuid[],

  next_plan                       text NOT NULL CHECK (
                                    next_plan IN ('pro', 'business', 'enterprise')
                                  ),
  next_status                     text NOT NULL CHECK (
                                    next_status IN ('active', 'trialing')
                                  ),
  next_cloud_workspaces_allowed   boolean NOT NULL CHECK (
                                    next_cloud_workspaces_allowed
                                  ),
  next_seat_limit                 integer CHECK (
                                    next_seat_limit IS NULL OR next_seat_limit > 0
                                  ),
  next_source                     text NOT NULL CHECK (next_source = 'operator'),
  next_source_reference           text NOT NULL CHECK (
                                    char_length(next_source_reference) BETWEEN 1 AND 512
                                  ),
  next_valid_from                 timestamptz NOT NULL,
  next_valid_until                timestamptz,
  next_revision                   bigint NOT NULL CHECK (next_revision > 0),
  next_active_seat_user_ids       uuid[] NOT NULL,

  deployment_channel              text NOT NULL CHECK (
                                    deployment_channel IN (
                                      'development', 'alpha', 'beta', 'production'
                                    )
                                  ),
  target_fingerprint              text NOT NULL CHECK (
                                    target_fingerprint ~ '^[a-f0-9]{16}$'
                                  ),
  database_principal              text NOT NULL CHECK (
                                    char_length(database_principal) BETWEEN 1 AND 128
                                  ),
  reason                          text NOT NULL CHECK (
                                    char_length(reason) BETWEEN 16 AND 512
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (
      previous_plan IS NULL
      AND previous_status IS NULL
      AND previous_cloud_workspaces_allowed IS NULL
      AND previous_seat_limit IS NULL
      AND previous_source IS NULL
      AND previous_source_reference IS NULL
      AND previous_valid_from IS NULL
      AND previous_valid_until IS NULL
      AND previous_revision IS NULL
    ) OR (
      previous_plan IS NOT NULL
      AND previous_status IS NOT NULL
      AND previous_cloud_workspaces_allowed IS NOT NULL
      AND previous_source IS NOT NULL
      AND previous_valid_from IS NOT NULL
      AND previous_revision IS NOT NULL
    )
  ),
  CHECK (
    previous_valid_until IS NULL
    OR previous_valid_from IS NULL
    OR previous_valid_until > previous_valid_from
  ),
  CHECK (array_position(previous_active_seat_user_ids, NULL) IS NULL),
  CHECK (array_position(next_active_seat_user_ids, NULL) IS NULL),
  CHECK (next_valid_until IS NULL OR next_valid_until > next_valid_from),
  CHECK (
    (
      next_plan = 'pro'
      AND next_seat_limit IS NULL
      AND cardinality(next_active_seat_user_ids) = 0
    ) OR (
      next_plan IN ('business', 'enterprise')
      AND next_seat_limit IS NOT NULL
      AND cardinality(next_active_seat_user_ids) BETWEEN 1 AND next_seat_limit
    )
  )
);
CREATE INDEX cloud_workspace_entitlement_changes_org_idx
  ON cloud_workspace_entitlement_changes (org_id, created_at DESC, id DESC);

CREATE FUNCTION reject_cloud_workspace_entitlement_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Customer-data erasure removes Organization/user identifiers only after
  -- lifecycle state is irreversibly purging. Every other mutation, including
  -- TRUNCATE, remains forbidden even to the table owner.
  IF TG_OP = 'DELETE'
     AND public.app_is_system()
     AND EXISTS (
       SELECT 1 FROM public.organizations
       WHERE id = OLD.org_id AND lifecycle_status = 'purging'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cloud_workspace_entitlement_changes is append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER cloud_workspace_entitlement_changes_append_only
  BEFORE UPDATE OR DELETE ON cloud_workspace_entitlement_changes
  FOR EACH ROW EXECUTE FUNCTION reject_cloud_workspace_entitlement_change_mutation();
CREATE TRIGGER cloud_workspace_entitlement_changes_no_truncate
  BEFORE TRUNCATE ON cloud_workspace_entitlement_changes
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_cloud_workspace_entitlement_change_mutation();

REVOKE ALL ON cloud_workspace_entitlement_changes FROM zeros_app;
REVOKE ALL ON SEQUENCE cloud_workspace_entitlement_changes_id_seq FROM zeros_app;
REVOKE ALL ON FUNCTION reject_cloud_workspace_entitlement_change_mutation()
  FROM PUBLIC;

-- Extend the 0060 lifecycle boundary forward-only. Operator evidence is
-- append-only during tenant life but must not retain customer identifiers
-- after an Organization privacy purge.
CREATE OR REPLACE FUNCTION purge_cloud_workspace_operator_configuration(
  p_org_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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

  DELETE FROM public.cloud_workspace_usage_events WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_quota_changes WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_object_storage_limit_changes
  WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_object_storage_limits WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_object_rotation_retry_changes
  WHERE org_id = p_org_id;
  DELETE FROM public.cloud_workspace_entitlement_changes WHERE org_id = p_org_id;
END;
$$;
REVOKE ALL ON FUNCTION purge_cloud_workspace_operator_configuration(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_cloud_workspace_operator_configuration(uuid)
  TO zeros_app;

-- A corrupt Personal tenant must still fail physical-readiness checks before
-- provider erasure if it somehow acquired operator entitlement evidence.
CREATE OR REPLACE FUNCTION personal_organization_has_cloud_configuration(
  p_account_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
      SELECT change.org_id
      FROM public.cloud_workspace_entitlement_changes change
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
