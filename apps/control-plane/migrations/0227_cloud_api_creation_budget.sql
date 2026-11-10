-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Deleting a workspace must not replenish an agent's creation budget.
CREATE INDEX cloud_v2_workspaces_creation_budget
  ON cloud_v2_workspaces (org_id, creator_user_id, created_at DESC);
