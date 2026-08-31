-- ──────────────────────────────────────────────────────────
-- 0035 — bounded history retention and verified data deletion
--
-- Current entity/file tables are materialized projections, not journal rows.
-- Keeping a foreign key from each projection back to the event that last
-- changed it made an otherwise-expired journal prefix impossible to compact.
-- The projection continues to be scoped by its workspace head and the writer
-- updates both atomically; only the historical provenance edge is removed.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_record_entities
  DROP CONSTRAINT workspace_record_entities_workspace_id_revision_fkey;
ALTER TABLE workspace_file_entries
  DROP CONSTRAINT workspace_file_entries_workspace_id_revision_org_id_fkey;

-- An available export pins its source checkpoint. Once the capability has
-- expired, release that pin while retaining non-sensitive export audit data.
ALTER TABLE workspace_exports
  ALTER COLUMN checkpoint_id DROP NOT NULL,
  ADD CONSTRAINT workspace_exports_available_checkpoint_check CHECK (
    state <> 'available' OR checkpoint_id IS NOT NULL
  ) NOT VALID;
ALTER TABLE workspace_exports
  VALIDATE CONSTRAINT workspace_exports_available_checkpoint_check;

ALTER TABLE workspace_retention_policies
  ADD COLUMN last_applied_at timestamptz;

INSERT INTO workspace_retention_policies (workspace_id, org_id)
SELECT workspace.id, workspace.org_id
FROM cloud_workspaces workspace
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE workspace_deletion_jobs
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_started_at timestamptz,
  ADD CONSTRAINT workspace_deletion_jobs_id_org_unique UNIQUE (id, org_id);
ALTER TABLE workspace_deletion_jobs
  DROP CONSTRAINT workspace_deletion_jobs_check,
  ADD CONSTRAINT workspace_deletion_jobs_lease_shape_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  );
CREATE INDEX workspace_deletion_jobs_claim_v2_idx
  ON workspace_deletion_jobs(next_attempt_at, created_at, id)
  WHERE state IN ('waiting_for_provider', 'deleting_objects', 'deleting_records');

-- Keep the authority/billing/provider tombstone after tenant content is
-- erased. This timestamp distinguishes provider deletion from completed data
-- deletion and makes retries/audits unambiguous.
ALTER TABLE cloud_workspaces
  ADD COLUMN data_deleted_at timestamptz;

-- Snapshot the exact set of objects detached by a deletion. Shared objects
-- complete logically (another workspace still owns a reference); unshared
-- objects must be physically removed before the job advances to record purge.
CREATE TABLE workspace_deletion_blob_targets (
  job_id                     uuid NOT NULL,
  blob_id                    uuid NOT NULL,
  org_id                     uuid NOT NULL,
  requires_physical_delete   boolean NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  PRIMARY KEY (job_id, blob_id),
  FOREIGN KEY (job_id, org_id)
    REFERENCES workspace_deletion_jobs(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (blob_id, org_id)
    REFERENCES workspace_blobs(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX workspace_deletion_blob_targets_pending_idx
  ON workspace_deletion_blob_targets(job_id, created_at, blob_id)
  WHERE completed_at IS NULL;

ALTER TABLE workspace_deletion_blob_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_deletion_blob_targets_system
  ON workspace_deletion_blob_targets FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE workspace_deletion_blob_targets FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace_deletion_blob_targets TO zeros_app;
