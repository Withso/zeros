-- ───────────────────────────────────────────────────────────
-- 0049 — forked workspaces always receive a new identity
--
-- A local↔cloud copy retains its source. Reusing the source UUID for the
-- destination would make two independent workspaces appear to be one object
-- and could route chats, replica state, or later lifecycle actions to the
-- wrong authority. Keep the invariant below the HTTP layer as well.
-- ───────────────────────────────────────────────────────────

ALTER TABLE workspace_fork_intents
  ADD CONSTRAINT workspace_fork_intents_distinct_identity_check CHECK (
    (operation = 'local_to_cloud'
      AND source_local_workspace_id <> target_cloud_workspace_id)
    OR
    (operation = 'cloud_to_local'
      AND source_cloud_workspace_id <> target_local_workspace_id)
  ) NOT VALID;

-- NOT VALID is deliberate for forward upgrades: an early alpha may already
-- contain a completed ambiguous copy, and deleting or inventing either of its
-- persisted identities would corrupt audit history. PostgreSQL still enforces
-- this constraint for every new insert or update; operators can quarantine
-- historical violations before validating it in a later migration.
