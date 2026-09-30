-- Only an exact, live engine can request inactivity shutdown. Ordinary user
-- Stop/Archive checkpoints retain their existing behavior.
ALTER TABLE workspace_checkpoint_requests ADD COLUMN idle_engine_instance_id uuid;
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT idle_stop_reason
  CHECK(idle_engine_instance_id IS NULL OR (reason='before_stop' AND lifecycle_intent_id IS NOT NULL));
