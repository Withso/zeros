-- ──────────────────────────────────────────────────────────
-- 0036 — lossless fork deltas and portable transcript identity
--
-- A local→cloud copy is based on a Git commit plus a working-tree overlay.
-- The overlay must be able to represent deletions, and copied conversations
-- must be a single final projection with no duplicate entity identities.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_fork_intents
  ADD COLUMN source_snapshot_sha256 bytea CHECK (
    source_snapshot_sha256 IS NULL OR octet_length(source_snapshot_sha256) = 32
  ),
  ADD COLUMN source_git_base_commit text CHECK (
    source_git_base_commit IS NULL
    OR source_git_base_commit ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  ADD COLUMN source_git_head_ref text CHECK (
    source_git_head_ref IS NULL
    OR (
      char_length(source_git_head_ref) BETWEEN 1 AND 512
      AND source_git_head_ref !~ '[\u0000-\u0020\u007f~^:?*\[\\]'
      AND source_git_head_ref !~ '(^|/)\.'
      AND source_git_head_ref !~ '\.lock($|/)'
      AND source_git_head_ref !~ '(^-|/$|\.\.|@\{|//)'
    )
  );

ALTER TABLE workspace_fork_import_entries
  ADD COLUMN operation text NOT NULL DEFAULT 'upsert' CHECK (
    operation IN ('upsert', 'delete')
  ),
  ALTER COLUMN entry_type DROP NOT NULL,
  ALTER COLUMN mode DROP NOT NULL,
  ALTER COLUMN blob_id DROP NOT NULL,
  ALTER COLUMN content_sha256 DROP NOT NULL,
  ALTER COLUMN size_bytes DROP NOT NULL,
  ADD CONSTRAINT workspace_fork_import_entry_operation_check CHECK (
    (
      operation = 'delete'
      AND entry_type IS NULL
      AND mode IS NULL
      AND blob_id IS NULL
      AND content_sha256 IS NULL
      AND size_bytes IS NULL
    )
    OR
    (
      operation = 'upsert'
      AND blob_id IS NOT NULL
      AND content_sha256 IS NOT NULL
      AND size_bytes IS NOT NULL
      AND (
        (entry_type = 'symlink' AND mode = 40960)
        OR (entry_type = 'file' AND mode IN (33188, 33261))
      )
    )
  );

CREATE UNIQUE INDEX workspace_fork_import_records_entity_unique
  ON workspace_fork_import_records(fork_intent_id, entity_kind, entity_id);
