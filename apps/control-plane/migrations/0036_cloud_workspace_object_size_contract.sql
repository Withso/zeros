-- Align durable storage with the engine, API, and object-ingress contract.
-- Earlier draft DDL admitted 1 GiB rows even though every production boundary
-- rejects an individual workspace file above 64 MiB. Keep the database as the
-- final fail-closed boundary so a bypassed service cannot create data that no
-- engine, fork, export, or replica is capable of restoring.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace_blobs
    WHERE plaintext_bytes > 67108864
       OR ciphertext_bytes > 67108864
  ) OR EXISTS (
    SELECT 1 FROM workspace_file_events WHERE size_bytes > 67108864
  ) OR EXISTS (
    SELECT 1 FROM workspace_file_entries WHERE size_bytes > 67108864
  ) OR EXISTS (
    SELECT 1 FROM workspace_checkpoint_entries WHERE size_bytes > 67108864
  ) OR EXISTS (
    SELECT 1 FROM workspace_fork_import_entries WHERE size_bytes > 67108864
  ) OR EXISTS (
    SELECT 1 FROM workspace_file_events
    WHERE operation = 'upsert' AND NOT (
      (entry_type = 'symlink' AND mode = 40960
        AND size_bytes BETWEEN 1 AND 4096)
      OR (entry_type = 'file' AND mode IN (33188, 33261)
        AND size_bytes BETWEEN 0 AND 67108864)
    )
  ) OR EXISTS (
    SELECT 1 FROM workspace_file_entries
    WHERE tombstoned_at IS NULL AND NOT (
      (entry_type = 'symlink' AND mode = 40960
        AND size_bytes BETWEEN 1 AND 4096)
      OR (entry_type = 'file' AND mode IN (33188, 33261)
        AND size_bytes BETWEEN 0 AND 67108864)
    )
  ) OR EXISTS (
    SELECT 1 FROM workspace_checkpoint_entries
    WHERE operation = 'upsert' AND entry_type = 'symlink'
      AND size_bytes NOT BETWEEN 1 AND 4096
  ) OR EXISTS (
    SELECT 1 FROM workspace_fork_import_entries
    WHERE entry_type = 'symlink'
      AND size_bytes NOT BETWEEN 1 AND 4096
  ) THEN
    RAISE EXCEPTION
      'cloud workspace data violates the supported file descriptor contract';
  END IF;
END
$$;

ALTER TABLE workspace_blobs
  DROP CONSTRAINT workspace_blobs_plaintext_bytes_check,
  DROP CONSTRAINT workspace_blobs_ciphertext_bytes_check,
  ADD CONSTRAINT workspace_blobs_plaintext_bytes_check
    CHECK (plaintext_bytes BETWEEN 0 AND 67108864) NOT VALID,
  ADD CONSTRAINT workspace_blobs_ciphertext_bytes_check
    CHECK (
      ciphertext_bytes IS NULL
      OR ciphertext_bytes BETWEEN 0 AND 67108864
    ) NOT VALID;

ALTER TABLE workspace_file_events
  DROP CONSTRAINT workspace_file_events_size_bytes_check,
  ADD CONSTRAINT workspace_file_events_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 67108864) NOT VALID;

ALTER TABLE workspace_file_entries
  ADD CONSTRAINT workspace_file_entries_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 67108864) NOT VALID;

ALTER TABLE workspace_checkpoint_entries
  DROP CONSTRAINT workspace_checkpoint_entries_size_bytes_check,
  ADD CONSTRAINT workspace_checkpoint_entries_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 67108864) NOT VALID;

ALTER TABLE workspace_fork_import_entries
  DROP CONSTRAINT workspace_fork_import_entries_size_bytes_check,
  ADD CONSTRAINT workspace_fork_import_entries_size_bytes_check
    CHECK (size_bytes BETWEEN 0 AND 67108864) NOT VALID;

ALTER TABLE workspace_file_events
  ADD CONSTRAINT workspace_file_events_descriptor_check CHECK (
    operation = 'delete'
    OR (entry_type = 'symlink' AND mode = 40960
      AND size_bytes BETWEEN 1 AND 4096)
    OR (entry_type = 'file' AND mode IN (33188, 33261)
      AND size_bytes BETWEEN 0 AND 67108864)
  ) NOT VALID;

ALTER TABLE workspace_file_entries
  ADD CONSTRAINT workspace_file_entries_descriptor_check CHECK (
    tombstoned_at IS NOT NULL
    OR (entry_type = 'symlink' AND mode = 40960
      AND size_bytes BETWEEN 1 AND 4096)
    OR (entry_type = 'file' AND mode IN (33188, 33261)
      AND size_bytes BETWEEN 0 AND 67108864)
  ) NOT VALID;

ALTER TABLE workspace_checkpoint_entries
  ADD CONSTRAINT workspace_checkpoint_entries_symlink_size_check CHECK (
    operation = 'delete' OR entry_type = 'file'
    OR (entry_type = 'symlink' AND size_bytes BETWEEN 1 AND 4096)
  ) NOT VALID;

ALTER TABLE workspace_fork_import_entries
  ADD CONSTRAINT workspace_fork_import_entries_symlink_size_check CHECK (
    entry_type = 'file'
    OR (entry_type = 'symlink' AND size_bytes BETWEEN 1 AND 4096)
  ) NOT VALID;

ALTER TABLE workspace_blobs
  VALIDATE CONSTRAINT workspace_blobs_plaintext_bytes_check,
  VALIDATE CONSTRAINT workspace_blobs_ciphertext_bytes_check;
ALTER TABLE workspace_file_events
  VALIDATE CONSTRAINT workspace_file_events_size_bytes_check;
ALTER TABLE workspace_file_entries
  VALIDATE CONSTRAINT workspace_file_entries_size_bytes_check;
ALTER TABLE workspace_checkpoint_entries
  VALIDATE CONSTRAINT workspace_checkpoint_entries_size_bytes_check;
ALTER TABLE workspace_fork_import_entries
  VALIDATE CONSTRAINT workspace_fork_import_entries_size_bytes_check;
ALTER TABLE workspace_file_events
  VALIDATE CONSTRAINT workspace_file_events_descriptor_check;
ALTER TABLE workspace_file_entries
  VALIDATE CONSTRAINT workspace_file_entries_descriptor_check;
ALTER TABLE workspace_checkpoint_entries
  VALIDATE CONSTRAINT workspace_checkpoint_entries_symlink_size_check;
ALTER TABLE workspace_fork_import_entries
  VALIDATE CONSTRAINT workspace_fork_import_entries_symlink_size_check;
