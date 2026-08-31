-- ──────────────────────────────────────────────────────────
-- 0026 — ordered durable record, content journal, and checkpoints
--
-- PostgreSQL owns ordering and bounded projections. Large transcript/file/
-- checkpoint bytes live in an encrypted object store and are referenced by
-- opaque tenant-scoped blob rows. A provider volume remains a cache, never the
-- sole recovery copy.
-- ──────────────────────────────────────────────────────────

CREATE TYPE workspace_record_entity_kind AS ENUM (
  'workspace', 'chat', 'message', 'turn', 'agent_session', 'run', 'terminal',
  'design_transaction', 'metadata'
);
CREATE TYPE workspace_record_event_operation AS ENUM ('upsert', 'tombstone');
CREATE TYPE workspace_blob_state AS ENUM (
  'pending_upload', 'available', 'quarantined', 'deleting', 'deleted'
);
CREATE TYPE workspace_checkpoint_state AS ENUM (
  'pending', 'uploading', 'durable', 'invalid', 'deleting', 'deleted'
);

CREATE TABLE workspace_record_heads (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  current_revision           bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  minimum_retained_revision  bigint NOT NULL DEFAULT 0 CHECK (
                               minimum_retained_revision >= 0
                               AND minimum_retained_revision <= current_revision
                             ),
  last_durable_at            timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id),
  UNIQUE (workspace_id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);

CREATE TABLE workspace_record_batches (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  engine_instance_id         uuid NOT NULL,
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                               AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
                             ),
  request_sha256             bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  first_revision             bigint NOT NULL CHECK (first_revision > 0),
  last_revision              bigint NOT NULL CHECK (last_revision >= first_revision),
  event_count                integer NOT NULL CHECK (event_count BETWEEN 1 AND 100),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id, org_id),
  UNIQUE (workspace_id, first_revision),
  UNIQUE (workspace_id, last_revision),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES workspace_record_heads(workspace_id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id)
    REFERENCES cloud_workspace_engine_instances(id) ON DELETE RESTRICT
);

CREATE TABLE workspace_record_events (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  revision                   bigint NOT NULL CHECK (revision > 0),
  event_id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_id                   uuid NOT NULL,
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
  actor_user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  occurred_at                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision),
  UNIQUE (event_id),
  UNIQUE (event_id, workspace_id, org_id),
  FOREIGN KEY (batch_id, workspace_id, org_id)
    REFERENCES workspace_record_batches(id, workspace_id, org_id)
    ON DELETE CASCADE,
  CHECK (
    (operation = 'upsert' AND document IS NOT NULL)
    OR (operation = 'tombstone' AND document IS NULL)
  )
);
CREATE INDEX workspace_record_events_catchup_idx
  ON workspace_record_events(workspace_id, revision);
CREATE INDEX workspace_record_events_entity_idx
  ON workspace_record_events(workspace_id, entity_kind, entity_id, revision DESC);

CREATE TABLE workspace_record_entities (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  entity_kind                workspace_record_entity_kind NOT NULL,
  entity_id                  text NOT NULL,
  revision                   bigint NOT NULL CHECK (revision > 0),
  schema_version             integer NOT NULL CHECK (schema_version > 0),
  document                   jsonb,
  tombstoned_at              timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_kind, entity_id),
  FOREIGN KEY (workspace_id, revision)
    REFERENCES workspace_record_events(workspace_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES workspace_record_heads(workspace_id, org_id) ON DELETE CASCADE,
  CHECK (
    (document IS NOT NULL AND tombstoned_at IS NULL
      AND jsonb_typeof(document) = 'object'
      AND octet_length(document::text) <= 524288)
    OR (document IS NULL AND tombstoned_at IS NOT NULL)
  )
);

CREATE TABLE workspace_content_heads (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  current_revision           bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  minimum_retained_revision  bigint NOT NULL DEFAULT 0 CHECK (
                               minimum_retained_revision >= 0
                               AND minimum_retained_revision <= current_revision
                             ),
  durable_revision           bigint NOT NULL DEFAULT 0 CHECK (
                               durable_revision >= 0
                               AND durable_revision <= current_revision
                             ),
  current_checkpoint_id      uuid,
  last_durable_at            timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id),
  UNIQUE (workspace_id, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);

ALTER TABLE cloud_workspace_engine_instances
  ADD CONSTRAINT cloud_workspace_engine_content_scope_unique
  UNIQUE (id, workspace_id, generation, org_id);

CREATE TABLE workspace_content_revisions (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  revision                   bigint NOT NULL CHECK (revision > 0),
  parent_revision            bigint CHECK (
                               parent_revision IS NULL OR parent_revision >= 0
                             ),
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  generation                 integer NOT NULL CHECK (generation > 0),
  engine_instance_id         uuid NOT NULL,
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                               AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
                             ),
  request_sha256             bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  git_base_commit            text CHECK (
                               git_base_commit IS NULL
                               OR git_base_commit ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
                             ),
  git_head_ref               text CHECK (
                               git_head_ref IS NULL OR char_length(git_head_ref) BETWEEN 1 AND 512
                             ),
  changed_entry_count        integer NOT NULL CHECK (
                               changed_entry_count BETWEEN 1 AND 10000
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, revision, org_id),
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES workspace_content_heads(workspace_id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_engine_instances(id, workspace_id, generation, org_id)
    ON DELETE RESTRICT,
  CHECK (
    (revision = 1 AND parent_revision = 0)
    OR (revision > 1 AND parent_revision = revision - 1)
  )
);

CREATE TABLE workspace_blobs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plaintext_sha256           bytea NOT NULL CHECK (octet_length(plaintext_sha256) = 32),
  ciphertext_sha256          bytea CHECK (
                               ciphertext_sha256 IS NULL OR octet_length(ciphertext_sha256) = 32
                             ),
  plaintext_bytes            bigint NOT NULL CHECK (
                               plaintext_bytes BETWEEN 0 AND 1073741824
                             ),
  ciphertext_bytes           bigint CHECK (
                               ciphertext_bytes IS NULL
                               -- AES-GCM stores the 16-byte authentication tag
                               -- separately, so an encrypted empty object has
                               -- a zero-byte ciphertext and is still valid.
                               OR ciphertext_bytes BETWEEN 0 AND 1073741824
                             ),
  object_key                 text NOT NULL CHECK (
                               char_length(object_key) BETWEEN 16 AND 1024
                               AND object_key !~ '[\u0000-\u001f\u007f]'
                             ),
  encryption_key_version     integer NOT NULL CHECK (encryption_key_version > 0),
  nonce                      bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag                   bytea CHECK (
                               auth_tag IS NULL OR octet_length(auth_tag) = 16
                             ),
  state                      workspace_blob_state NOT NULL DEFAULT 'pending_upload',
  reference_count            bigint NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  retention_until            timestamptz,
  legal_hold                 boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  available_at               timestamptz,
  deleted_at                 timestamptz,
  UNIQUE (id, org_id),
  UNIQUE (org_id, plaintext_sha256, encryption_key_version),
  UNIQUE (object_key),
  CHECK (
    (state = 'pending_upload' AND ciphertext_sha256 IS NULL
      AND ciphertext_bytes IS NULL AND auth_tag IS NULL
      AND available_at IS NULL AND deleted_at IS NULL)
    OR (state IN ('available', 'quarantined', 'deleting')
      AND ciphertext_sha256 IS NOT NULL AND ciphertext_bytes IS NOT NULL
      AND auth_tag IS NOT NULL AND available_at IS NOT NULL AND deleted_at IS NULL)
    OR (state = 'deleted' AND deleted_at IS NOT NULL)
  )
);
CREATE INDEX workspace_blobs_gc_idx
  ON workspace_blobs(state, reference_count, retention_until, created_at)
  WHERE state IN ('available', 'quarantined', 'deleting') AND NOT legal_hold;

CREATE TABLE workspace_file_events (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  revision                   bigint NOT NULL,
  sequence                   integer NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
  normalized_path            text NOT NULL CHECK (
                               char_length(normalized_path) BETWEEN 1 AND 4096
                               AND normalized_path !~ '[/\\\\]$'
                               AND normalized_path !~ '^[/\\\\]'
                               AND normalized_path !~ '(^|/)(\.|\.\.)($|/)'
                               AND normalized_path !~ '(^|/)\.git($|/)'
                               AND normalized_path !~ '[\u0000-\u001f\u007f\\\\]'
                             ),
  operation                  text NOT NULL CHECK (
                               operation IN ('upsert', 'delete')
                             ),
  entry_type                 text CHECK (
                               entry_type IS NULL OR entry_type IN ('file', 'symlink')
                             ),
  mode                       integer CHECK (
                               mode IS NULL OR mode IN (33188, 33261, 40960)
                             ),
  blob_id                    uuid,
  content_sha256             bytea CHECK (
                               content_sha256 IS NULL OR octet_length(content_sha256) = 32
                             ),
  size_bytes                 bigint CHECK (
                               size_bytes IS NULL OR size_bytes BETWEEN 0 AND 1073741824
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision, sequence),
  UNIQUE (workspace_id, revision, normalized_path),
  FOREIGN KEY (workspace_id, revision, org_id)
    REFERENCES workspace_content_revisions(workspace_id, revision, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'delete' AND entry_type IS NULL AND mode IS NULL
      AND blob_id IS NULL AND content_sha256 IS NULL AND size_bytes IS NULL)
    OR (operation = 'upsert' AND entry_type IS NOT NULL AND mode IS NOT NULL
      AND blob_id IS NOT NULL AND content_sha256 IS NOT NULL
      AND size_bytes IS NOT NULL)
  )
);
CREATE INDEX workspace_file_events_catchup_idx
  ON workspace_file_events(workspace_id, revision, sequence);

CREATE TABLE workspace_file_entries (
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  normalized_path            text NOT NULL,
  revision                   bigint NOT NULL,
  entry_type                 text,
  mode                       integer,
  blob_id                    uuid,
  content_sha256             bytea,
  size_bytes                 bigint,
  tombstoned_at              timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, normalized_path),
  FOREIGN KEY (workspace_id, revision, org_id)
    REFERENCES workspace_content_revisions(workspace_id, revision, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (tombstoned_at IS NULL AND entry_type IN ('file', 'symlink')
      AND mode IN (33188, 33261, 40960) AND blob_id IS NOT NULL
      AND octet_length(content_sha256) = 32 AND size_bytes IS NOT NULL)
    OR (tombstoned_at IS NOT NULL AND entry_type IS NULL AND mode IS NULL
      AND blob_id IS NULL AND content_sha256 IS NULL AND size_bytes IS NULL)
  )
);

CREATE TABLE workspace_checkpoints (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  org_id                     uuid NOT NULL,
  idempotency_key            text NOT NULL CHECK (
                               char_length(idempotency_key) BETWEEN 8 AND 128
                               AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
                             ),
  request_sha256             bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  content_revision           bigint NOT NULL CHECK (content_revision > 0),
  record_revision            bigint NOT NULL CHECK (record_revision >= 0),
  authority_epoch            bigint NOT NULL CHECK (authority_epoch > 0),
  generation                 integer NOT NULL CHECK (generation > 0),
  reason                     text NOT NULL CHECK (
                               reason IN (
                                 'periodic', 'before_stop', 'before_archive',
                                 'before_fork', 'before_rebuild', 'manual', 'recovery'
                               )
                             ),
  git_base_commit            text CHECK (
                               git_base_commit IS NULL
                               OR git_base_commit ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
                             ),
  git_head_ref               text CHECK (
                               git_head_ref IS NULL OR char_length(git_head_ref) BETWEEN 1 AND 512
                             ),
  manifest_blob_id           uuid NOT NULL,
  artifact_blob_id           uuid,
  inclusion_policy           jsonb NOT NULL CHECK (
                               jsonb_typeof(inclusion_policy) = 'object'
                               AND octet_length(inclusion_policy::text) <= 131072
                             ),
  file_count                 integer NOT NULL CHECK (file_count BETWEEN 0 AND 1000000),
  total_bytes                bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 10737418240),
  state                      workspace_checkpoint_state NOT NULL DEFAULT 'pending',
  integrity_sha256           bytea NOT NULL CHECK (octet_length(integrity_sha256) = 32),
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  durable_at                 timestamptz,
  invalidated_at             timestamptz,
  retention_until            timestamptz,
  legal_hold                 boolean NOT NULL DEFAULT false,
  UNIQUE (id, workspace_id, org_id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, content_revision, reason),
  FOREIGN KEY (workspace_id, content_revision, org_id)
    REFERENCES workspace_content_revisions(workspace_id, revision, org_id)
    ON DELETE CASCADE,
  FOREIGN KEY (manifest_blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('pending', 'uploading') AND durable_at IS NULL AND invalidated_at IS NULL)
    OR (state = 'durable' AND durable_at IS NOT NULL AND invalidated_at IS NULL)
    OR (state = 'invalid' AND invalidated_at IS NOT NULL)
    OR (state IN ('deleting', 'deleted'))
  )
);
CREATE INDEX workspace_checkpoints_recovery_idx
  ON workspace_checkpoints(workspace_id, content_revision DESC, created_at DESC)
  WHERE state = 'durable';

ALTER TABLE workspace_content_heads
  ADD CONSTRAINT workspace_content_current_checkpoint_fkey
  FOREIGN KEY (current_checkpoint_id, workspace_id, org_id)
  REFERENCES workspace_checkpoints(id, workspace_id, org_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE workspace_blob_references (
  blob_id                    uuid NOT NULL,
  org_id                     uuid NOT NULL,
  workspace_id               uuid NOT NULL,
  reference_kind             text NOT NULL CHECK (
                               reference_kind IN (
                                 'file_entry', 'file_event', 'checkpoint_manifest',
                                 'checkpoint_artifact', 'transcript_artifact', 'export'
                               )
                             ),
  reference_id               text NOT NULL CHECK (
                               char_length(reference_id) BETWEEN 1 AND 512
                             ),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blob_id, reference_kind, reference_id),
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, org_id)
    REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE
);

CREATE FUNCTION reject_immutable_workspace_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable workspace record cannot be mutated'
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER workspace_record_batches_immutable
  BEFORE UPDATE ON workspace_record_batches
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_workspace_record();
CREATE TRIGGER workspace_record_events_immutable
  BEFORE UPDATE ON workspace_record_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_workspace_record();
CREATE TRIGGER workspace_content_revisions_immutable
  BEFORE UPDATE ON workspace_content_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_workspace_record();
CREATE TRIGGER workspace_file_events_immutable
  BEFORE UPDATE ON workspace_file_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_workspace_record();
REVOKE ALL ON FUNCTION reject_immutable_workspace_record() FROM PUBLIC;

ALTER TABLE workspace_record_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_record_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_record_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_record_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_content_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_content_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_file_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_blob_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_record_heads_read ON workspace_record_heads FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_record_heads_system ON workspace_record_heads FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_record_batches_read ON workspace_record_batches FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_record_batches_system ON workspace_record_batches FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_record_events_read ON workspace_record_events FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_record_events_system ON workspace_record_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_record_entities_read ON workspace_record_entities FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_record_entities_system ON workspace_record_entities FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_content_heads_read ON workspace_content_heads FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_content_heads_system ON workspace_content_heads FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_content_revisions_read ON workspace_content_revisions FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_content_revisions_system ON workspace_content_revisions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_blobs_system ON workspace_blobs FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_file_events_read ON workspace_file_events FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_file_events_system ON workspace_file_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_file_entries_read ON workspace_file_entries FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_file_entries_system ON workspace_file_entries FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_checkpoints_read ON workspace_checkpoints FOR SELECT
  USING (app_is_system() OR org_id IN (SELECT app_user_org_ids()));
CREATE POLICY workspace_checkpoints_system ON workspace_checkpoints FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workspace_blob_references_system ON workspace_blob_references FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE workspace_record_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_record_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_record_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_record_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_content_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_content_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_blobs FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_file_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_file_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_blob_references FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspace_record_heads, workspace_record_batches, workspace_record_events,
  workspace_record_entities, workspace_content_heads,
  workspace_content_revisions, workspace_blobs, workspace_file_events,
  workspace_file_entries, workspace_checkpoints, workspace_blob_references
TO zeros_app;
