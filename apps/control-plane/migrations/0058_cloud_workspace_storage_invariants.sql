-- ─────────────────────────────────────────────────────────────────────────────
-- 0058 — Object-storage limit coherence compatibility fence
-- ─────────────────────────────────────────────────────────────────────────────
-- Fresh databases receive these constraints in 0055. Keep this forward step
-- for databases that recorded an earlier feature-branch draft of 0055 before
-- the coherence invariant was added.

ALTER TABLE cloud_workspace_object_storage_limits
  DROP CONSTRAINT IF EXISTS
    cloud_workspace_object_storage_limits_coherent_check,
  ADD CONSTRAINT cloud_workspace_object_storage_limits_coherent_check
    CHECK (max_workspace_bytes <= max_organization_bytes);

ALTER TABLE cloud_workspace_object_storage_limit_changes
  DROP CONSTRAINT IF EXISTS
    cloud_workspace_object_storage_limit_changes_coherent_check,
  ADD CONSTRAINT cloud_workspace_object_storage_limit_changes_coherent_check
    CHECK (next_workspace_bytes <= next_organization_bytes);
