-- ──────────────────────────────────────────────────────────
-- 0031 — immutable checkpoint file projection
--
-- Recovery and receive-only replicas must never infer an old checkpoint from
-- the mutable current-file projection or trust paths supplied by a sandbox
-- manifest. Snapshot the exact server-validated projection at checkpoint
-- commit and retain direct blob references for its lifetime.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_blob_references
  DROP CONSTRAINT workspace_blob_references_reference_kind_check,
  ADD CONSTRAINT workspace_blob_references_reference_kind_check CHECK (
    reference_kind IN (
      'file_entry', 'file_event', 'checkpoint_manifest',
      'checkpoint_artifact', 'checkpoint_file', 'transcript_artifact',
      'export'
    )
  );

-- An empty repository still needs a durable revision/checkpoint. Revision 1
-- may therefore be an explicit zero-entry baseline; later no-op revisions are
-- prevented by the engine's exact-head comparison rather than an inability to
-- represent the empty state.
ALTER TABLE workspace_content_revisions
  DROP CONSTRAINT workspace_content_revisions_changed_entry_count_check,
  ADD CONSTRAINT workspace_content_revisions_changed_entry_count_check CHECK (
    changed_entry_count BETWEEN 0 AND 10000
  );

ALTER TABLE workspace_file_entries
  ADD COLUMN portable_path_key text GENERATED ALWAYS AS (
    lower(normalize(normalized_path, NFKC))
  ) STORED;
CREATE UNIQUE INDEX workspace_file_entries_portable_live_unique
  ON workspace_file_entries(workspace_id, portable_path_key)
  WHERE tombstoned_at IS NULL;

CREATE TABLE workspace_checkpoint_entries (
  checkpoint_id              uuid NOT NULL,
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  normalized_path            text NOT NULL CHECK (
                                char_length(normalized_path) BETWEEN 1 AND 4096
                                AND normalized_path !~ '[/\\]$'
                                AND normalized_path !~ '^[/\\]'
                                AND normalized_path !~ '(^|/)(\.|\.\.)($|/)'
                                AND normalized_path !~ '(^|/)\.git($|/)'
                                AND normalized_path !~ '[\u0000-\u001f\u007f\\]'
                              ),
  portable_path_key          text GENERATED ALWAYS AS (
                               lower(normalize(normalized_path, NFKC))
                             ) STORED,
  operation                  text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  entry_type                 text CHECK (entry_type IN ('file', 'symlink')),
  mode                       integer CHECK (mode IN (33188, 33261, 40960)),
  blob_id                    uuid,
  content_sha256             bytea CHECK (
                                content_sha256 IS NULL
                                OR octet_length(content_sha256) = 32
                              ),
  size_bytes                 bigint CHECK (
                                size_bytes IS NULL
                                OR size_bytes BETWEEN 0 AND 1073741824
                              ),
  PRIMARY KEY (checkpoint_id, normalized_path),
  FOREIGN KEY (checkpoint_id, workspace_id, org_id)
    REFERENCES workspace_checkpoints(id, workspace_id, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'delete' AND entry_type IS NULL AND mode IS NULL
      AND blob_id IS NULL AND content_sha256 IS NULL AND size_bytes IS NULL)
    OR
    (operation = 'upsert' AND blob_id IS NOT NULL
      AND content_sha256 IS NOT NULL AND size_bytes IS NOT NULL
      AND ((entry_type = 'symlink' AND mode = 40960)
        OR (entry_type = 'file' AND mode IN (33188, 33261))))
  )
);
CREATE INDEX workspace_checkpoint_entries_blob_idx
  ON workspace_checkpoint_entries(checkpoint_id, blob_id);
CREATE UNIQUE INDEX workspace_checkpoint_entries_portable_unique
  ON workspace_checkpoint_entries(checkpoint_id, portable_path_key);

ALTER TABLE workspace_checkpoint_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_checkpoint_entries_read
  ON workspace_checkpoint_entries FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_checkpoint_entries_system
  ON workspace_checkpoint_entries FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE workspace_checkpoint_entries FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_checkpoint_entries TO zeros_app;
