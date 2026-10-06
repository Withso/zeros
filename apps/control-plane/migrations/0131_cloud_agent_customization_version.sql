-- zeros-migration: expand
-- Evidence from the exact attested engine: registration or v3 admission proves
-- optional customization; a rejected v1/v2 admission proves required-only.
-- NULL stays unknown; qualification mode or creation time is not evidence.
ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN agent_customization_version smallint
    CHECK (agent_customization_version IS NULL OR agent_customization_version IN (1, 2, 3));
