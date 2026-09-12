-- ──────────────────────────────────────────────────────────
-- 0032 — copy/fork imports, authenticated exports, and device delivery
--
-- Local→cloud and cloud→local are copy operations. They never reuse a
-- workspace id or transfer authority. Imported history therefore needs an
-- explicit non-engine provenance, while background replica reads are bound to
-- a device key and replay-protected request nonce.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_content_revisions
  ALTER COLUMN engine_instance_id DROP NOT NULL,
  ADD COLUMN source_kind text NOT NULL DEFAULT 'engine' CHECK (
    source_kind IN ('engine', 'fork_import')
  ),
  ADD COLUMN fork_intent_id uuid REFERENCES workspace_fork_intents(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_content_revision_source_check CHECK (
    (source_kind = 'engine' AND engine_instance_id IS NOT NULL
      AND fork_intent_id IS NULL)
    OR
    (source_kind = 'fork_import' AND engine_instance_id IS NULL
      AND fork_intent_id IS NOT NULL)
  );

ALTER TABLE workspace_record_batches
  ALTER COLUMN engine_instance_id DROP NOT NULL,
  ADD COLUMN source_kind text NOT NULL DEFAULT 'engine' CHECK (
    source_kind IN ('engine', 'fork_import')
  ),
  ADD COLUMN fork_intent_id uuid REFERENCES workspace_fork_intents(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workspace_record_batch_source_check CHECK (
    (source_kind = 'engine' AND engine_instance_id IS NOT NULL
      AND fork_intent_id IS NULL)
    OR
    (source_kind = 'fork_import' AND engine_instance_id IS NULL
      AND fork_intent_id IS NOT NULL)
  );

ALTER TABLE workspace_blob_references
  DROP CONSTRAINT workspace_blob_references_reference_kind_check,
  ADD CONSTRAINT workspace_blob_references_reference_kind_check CHECK (
    reference_kind IN (
      'file_entry', 'file_event', 'checkpoint_manifest',
      'checkpoint_artifact', 'checkpoint_file', 'transcript_artifact',
      'fork_import', 'export'
    )
  );

ALTER TABLE workspace_checkpoint_requests
  ADD COLUMN fork_intent_id uuid UNIQUE
    REFERENCES workspace_fork_intents(id) ON DELETE CASCADE;
ALTER TABLE workspace_checkpoint_requests
  ADD CONSTRAINT workspace_checkpoint_request_owner_check CHECK (
    lifecycle_intent_id IS NULL OR fork_intent_id IS NULL
  );

ALTER TABLE workspace_exports
  ADD COLUMN fork_intent_id uuid UNIQUE
    REFERENCES workspace_fork_intents(id) ON DELETE CASCADE;

CREATE TABLE workspace_fork_import_entries (
  fork_intent_id             uuid NOT NULL,
  org_id                     uuid NOT NULL,
  target_workspace_id        uuid NOT NULL,
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
  entry_type                 text NOT NULL CHECK (entry_type IN ('file', 'symlink')),
  mode                       integer NOT NULL CHECK (mode IN (33188, 33261, 40960)),
  blob_id                    uuid NOT NULL,
  content_sha256             bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  size_bytes                 bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 1073741824),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fork_intent_id, normalized_path),
  UNIQUE (fork_intent_id, portable_path_key),
  FOREIGN KEY (fork_intent_id) REFERENCES workspace_fork_intents(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (entry_type = 'symlink' AND mode = 40960)
    OR (entry_type = 'file' AND mode IN (33188, 33261))
  )
);
CREATE INDEX workspace_fork_import_entries_blob_idx
  ON workspace_fork_import_entries(fork_intent_id, blob_id);

CREATE TABLE workspace_fork_import_records (
  fork_intent_id             uuid NOT NULL,
  ordinal                    bigint NOT NULL CHECK (ordinal >= 0),
  org_id                     uuid NOT NULL,
  target_workspace_id        uuid NOT NULL,
  entity_kind                workspace_record_entity_kind NOT NULL,
  entity_id                  text NOT NULL CHECK (
                                char_length(entity_id) BETWEEN 1 AND 255
                                AND entity_id !~ '[\u0000-\u001f\u007f]'
                              ),
  operation                  workspace_record_event_operation NOT NULL,
  schema_version             integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  document                   jsonb CHECK (
                               document IS NULL OR (
                                 jsonb_typeof(document) = 'object'
                                 AND octet_length(document::text) <= 524288
                               )
                             ),
  occurred_at                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fork_intent_id, ordinal),
  UNIQUE (fork_intent_id, entity_kind, entity_id, ordinal),
  FOREIGN KEY (fork_intent_id) REFERENCES workspace_fork_intents(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  CHECK (
    (operation = 'upsert' AND document IS NOT NULL)
    OR (operation = 'tombstone' AND document IS NULL)
  )
);

CREATE TABLE device_request_nonces (
  device_id                  uuid NOT NULL,
  user_id                    uuid NOT NULL,
  nonce_sha256               bytea NOT NULL CHECK (octet_length(nonce_sha256) = 32),
  requested_at               timestamptz NOT NULL,
  expires_at                 timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, nonce_sha256),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
    ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
CREATE INDEX device_request_nonces_expiry_idx
  ON device_request_nonces(expires_at, device_id);

CREATE TABLE workspace_export_grants (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id                  uuid NOT NULL,
  fork_intent_id             uuid NOT NULL,
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                  uuid NOT NULL,
  device_key_version         bigint NOT NULL CHECK (device_key_version > 0),
  token_sha256               bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  issued_at                  timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz NOT NULL,
  revoked_at                 timestamptz,
  last_used_at               timestamptz,
  FOREIGN KEY (export_id, org_id) REFERENCES workspace_exports(id, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (fork_intent_id) REFERENCES workspace_fork_intents(id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
    ON DELETE CASCADE,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX workspace_export_grants_live_idx
  ON workspace_export_grants(export_id, expires_at DESC, id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER workspace_fork_import_entries_immutable
  BEFORE UPDATE ON workspace_fork_import_entries
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();
CREATE TRIGGER workspace_fork_import_records_immutable
  BEFORE UPDATE ON workspace_fork_import_records
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_cloud_record_mutation();

ALTER TABLE workspace_fork_import_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_fork_import_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_export_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_fork_import_entries_system
  ON workspace_fork_import_entries FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_fork_import_records_system
  ON workspace_fork_import_records FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY device_request_nonces_system ON device_request_nonces FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_export_grants_system ON workspace_export_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE workspace_fork_import_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_fork_import_records FORCE ROW LEVEL SECURITY;
ALTER TABLE device_request_nonces FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_export_grants FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspace_fork_import_entries, workspace_fork_import_records,
  device_request_nonces, workspace_export_grants
TO zeros_app;
