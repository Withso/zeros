-- Observation attempts have their own durable schedule. A failed provider
-- request cannot forge a successful observation or monopolize the sweep.
ALTER TABLE cloud_workspace_provider_bindings
  ADD COLUMN next_drift_check_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX cloud_workspace_provider_drift_schedule
  ON cloud_workspace_provider_bindings(next_drift_check_at, workspace_id, generation);
