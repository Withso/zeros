-- 0048 — bounded file/directory hierarchy validation
--
-- Content append serializes on workspace_content_heads and checks proposed
-- files against this live projection. The C-collated expression index makes a
-- portable-path prefix range deterministic and avoids a workspace-wide scan.

CREATE INDEX workspace_file_entries_portable_live_prefix_idx
  ON workspace_file_entries (
    workspace_id,
    (portable_path_key COLLATE "C") text_pattern_ops
  )
  WHERE tombstoned_at IS NULL;

CREATE INDEX workspace_fork_import_entries_portable_prefix_idx
  ON workspace_fork_import_entries (
    fork_intent_id,
    (portable_path_key COLLATE "C") text_pattern_ops
  )
  WHERE operation = 'upsert';
