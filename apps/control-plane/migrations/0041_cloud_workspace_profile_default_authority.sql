-- ───────────────────────────────────────────────────────────
-- 0041 — unambiguous placement-aware default profiles
--
-- `both` participates in both local and cloud resolution. The original
-- per-literal-placement unique index allowed a cloud default and a `both`
-- default simultaneously, while the resolver correctly failed that ambiguity.
-- Enforce one eligible default for each placement domain instead.
-- ───────────────────────────────────────────────────────────

WITH keep_both AS (
  SELECT DISTINCT ON (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) id, org_id, owner_kind, owner_user_id
  FROM environment_profiles
  WHERE is_default AND placement = 'both' AND deleted_at IS NULL
  ORDER BY org_id, owner_kind,
           coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
           updated_at DESC, id
)
UPDATE environment_profiles profile
SET is_default = false, updated_at = now()
FROM keep_both
WHERE profile.org_id = keep_both.org_id
  AND profile.owner_kind = keep_both.owner_kind
  AND profile.owner_user_id IS NOT DISTINCT FROM keep_both.owner_user_id
  AND profile.id <> keep_both.id
  AND profile.is_default AND profile.deleted_at IS NULL;

DROP INDEX environment_profiles_one_default_unique;

CREATE UNIQUE INDEX environment_profiles_one_cloud_default_unique
  ON environment_profiles (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) WHERE is_default AND deleted_at IS NULL
      AND placement IN ('cloud', 'both');

CREATE UNIQUE INDEX environment_profiles_one_local_default_unique
  ON environment_profiles (
    org_id, owner_kind,
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) WHERE is_default AND deleted_at IS NULL
      AND placement IN ('local', 'both');
