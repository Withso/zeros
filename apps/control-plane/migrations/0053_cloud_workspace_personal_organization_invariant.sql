-- ──────────────────────────────────────────────────────────
-- 0053 — restore the permanent Personal local-only invariant
--
-- Before the main/cloud-workspace branches merged, the cloud migration now
-- named 0026 briefly removed the organization-level invariant and enabled the
-- coarse cloud capability for Personal. The migration runner recognizes those
-- old filenames so it does not replay their DDL; this final repair therefore
-- has to cover both fresh installs and databases that previously ran the
-- branch.
-- ──────────────────────────────────────────────────────────

-- There is no safe automatic owner for a legacy Personal cloud workspace.
-- Stop with a precise invariant violation rather than deleting or silently
-- reassigning durable workspace data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cloud_workspaces workspace
    JOIN organizations organization ON organization.id = workspace.org_id
    WHERE organization.is_personal
  ) THEN
    RAISE EXCEPTION 'Personal organizations are local-only; move legacy cloud workspaces to an Organization before migrating'
      USING ERRCODE = '23514',
            CONSTRAINT = 'cloud_workspaces_non_personal_organization';
  END IF;
END;
$$;

UPDATE organizations
SET cloud_workspaces_allowed = false
WHERE is_personal AND cloud_workspaces_allowed;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'organizations'::regclass
      AND conname = 'personal_organizations_are_local_only'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT personal_organizations_are_local_only
      CHECK (NOT is_personal OR NOT cloud_workspaces_allowed);
  END IF;
END;
$$;

ALTER TABLE organizations
  VALIDATE CONSTRAINT personal_organizations_are_local_only;
