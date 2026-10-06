-- zeros-migration: expand
-- A capability asserted at registration by the exact attested engine. Existing
-- runtimes remain unknown; qualification mode or creation time is not evidence.
ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN agent_customization_version smallint
    CHECK (agent_customization_version IS NULL OR agent_customization_version = 3);
