-- ───────────────────────────────────────────────────────────
-- 0050 — canonical durable-path pagination order
--
-- Cloud content manifests are protocol documents. Their cursor order must not
-- change with the locale chosen by Railway, a customer-owned PostgreSQL
-- deployment, or a restored database. Back the explicit bytewise C collation
-- used by every path cursor with matching indexes.
-- ───────────────────────────────────────────────────────────

CREATE INDEX workspace_file_entries_canonical_path_idx
  ON workspace_file_entries (workspace_id, (normalized_path COLLATE "C"));

CREATE INDEX workspace_checkpoint_entries_canonical_path_idx
  ON workspace_checkpoint_entries (checkpoint_id, (normalized_path COLLATE "C"));

CREATE INDEX workspace_fork_import_entries_canonical_path_idx
  ON workspace_fork_import_entries (fork_intent_id, (normalized_path COLLATE "C"));
