-- ─────────────────────────────────────────────────────────────────────────────
-- 0057 — Evidence-backed object lifecycle indexes
-- ─────────────────────────────────────────────────────────────────────────────
-- `collectGarbageOnce` physically deletes stale pending workspace_blobs. Every
-- referencing FK must therefore prove absence without scanning an unbounded
-- child table. Existing PKs already lead with blob_id on blob_references and
-- blob_rotation_jobs; the remaining referencing columns do not.

CREATE INDEX workspace_fork_intents_result_blob_fk_idx
  ON workspace_fork_intents (result_blob_id, org_id)
  WHERE result_blob_id IS NOT NULL;
CREATE INDEX workspace_file_events_blob_fk_idx
  ON workspace_file_events (blob_id, org_id);
CREATE INDEX workspace_file_entries_blob_fk_idx
  ON workspace_file_entries (blob_id, org_id);
CREATE INDEX workspace_checkpoints_artifact_blob_fk_idx
  ON workspace_checkpoints (artifact_blob_id, org_id)
  WHERE artifact_blob_id IS NOT NULL;
CREATE INDEX workspace_checkpoints_manifest_blob_fk_idx
  ON workspace_checkpoints (manifest_blob_id, org_id);
CREATE INDEX workspace_exports_export_blob_fk_idx
  ON workspace_exports (export_blob_id, org_id)
  WHERE export_blob_id IS NOT NULL;
CREATE INDEX workspace_setup_recovery_artifact_blob_fk_idx
  ON workspace_setup_recovery_grants (artifact_blob_id, org_id)
  WHERE artifact_blob_id IS NOT NULL;
CREATE INDEX workspace_setup_recovery_manifest_blob_fk_idx
  ON workspace_setup_recovery_grants (manifest_blob_id, org_id);
CREATE INDEX workspace_checkpoint_entries_blob_fk_idx
  ON workspace_checkpoint_entries (blob_id, org_id);
CREATE INDEX workspace_fork_import_entries_blob_fk_idx
  ON workspace_fork_import_entries (blob_id, org_id);
CREATE INDEX workspace_deletion_blob_targets_blob_fk_idx
  ON workspace_deletion_blob_targets (blob_id, org_id);
-- The trailing columns also serve the garbage collector's active-publication
-- exclusion while the leading pair protects the blob foreign key.
CREATE INDEX workspace_blob_storage_reservations_blob_fk_idx
  ON workspace_blob_storage_reservations (blob_id, org_id, state, expires_at);

-- Workspace teardown and retention both delete references by workspace.
CREATE INDEX workspace_blob_references_workspace_fk_idx
  ON workspace_blob_references (workspace_id, org_id, blob_id);

-- These two SKIP LOCKED claims had no index leading in their eligibility and
-- deterministic ordering columns. Other cloud workers already have dedicated
-- claim indexes and are intentionally unchanged.
CREATE INDEX workspace_blob_rotation_jobs_claim_idx
  ON workspace_blob_rotation_jobs (created_at, blob_id, target_key_version)
  INCLUDE (state, lease_expires_at)
  WHERE state IN ('queued', 'processing', 'cleanup_pending');
CREATE INDEX workspace_blobs_pending_gc_claim_idx
  ON workspace_blobs (created_at, id)
  INCLUDE (org_id, object_key)
  WHERE state = 'pending_upload' AND reference_count = 0;

-- `/healthz` bounds its durability probe by the workspace update age without
-- constraining desired_state, so the reconciler index cannot serve this scan.
CREATE INDEX cloud_workspaces_durability_health_idx
  ON cloud_workspaces (updated_at, id)
  WHERE status IN ('ready', 'busy');
