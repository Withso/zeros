-- Foreground receipts and native background lifetime are independent.
-- Old engines retain the default, command-scoped behavior during rollout.
ALTER TABLE cloud_agent_execution_leases
  ADD COLUMN background_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN background_conversation_id text CHECK(background_conversation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD COLUMN background_deadline timestamptz,
  ADD COLUMN background_phase text CHECK(background_phase IN ('foreground','background')),
  ADD CONSTRAINT cloud_agent_background_binding CHECK(
    (background_conversation_id IS NULL AND background_deadline IS NULL AND background_phase IS NULL) OR
    (background_enabled AND background_conversation_id IS NOT NULL AND background_deadline IS NOT NULL AND background_phase IS NOT NULL));

-- A replacement snapshot holds active tasks only, at most 64 rows worth of
-- metadata. The lease/actor/engine fences are always checked before reads.
CREATE TABLE cloud_agent_background_tasks (
  lease_id uuid PRIMARY KEY REFERENCES cloud_agent_execution_leases(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK(revision>0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cloud_agent_background_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_background_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_background_tasks_system ON cloud_agent_background_tasks FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_background_tasks TO zeros_app;
