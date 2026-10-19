-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Scheduling only: one coalesced stopped-observation request per allocation.
-- Deliberately no lease/owner FK: its implicit KEY SHARE would reverse the
-- workspace -> lease lock order when a compute transaction already owns the
-- lease. Producers resolve that exact identity without locking the lease.
CREATE TABLE cloud_workspace_compute_rechecks (
  allocation_lease_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  owner_revision bigint NOT NULL CHECK (owner_revision >= 0),
  observed_stopped boolean NOT NULL,
  requested_sequence bigint NOT NULL CHECK (requested_sequence >= 0),
  handled_sequence bigint NOT NULL DEFAULT 0 CHECK (handled_sequence BETWEEN 0 AND requested_sequence),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_compute_rechecks_workspace ON cloud_workspace_compute_rechecks(workspace_id,org_id);
ALTER TABLE cloud_workspace_compute_rechecks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_compute_rechecks FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_compute_rechecks
  USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_compute_rechecks TO zeros_app;

-- Same-transaction durable enqueue and empty notification as other lifecycle
-- sources. An early job re-reads live leases, error floors and transitions.
-- Old workers leave the sequence intact and retain their normal polling.
CREATE FUNCTION cloud_compute_recheck_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.requested_sequence=OLD.requested_sequence THEN RETURN NEW; END IF;
  IF NEW.requested_sequence>NEW.handled_sequence THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_compute_lease',NEW.workspace_id,NEW.org_id,NEW.requested_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_compute_recheck_jobs AFTER INSERT OR UPDATE OF requested_sequence
  ON cloud_workspace_compute_rechecks FOR EACH ROW EXECUTE FUNCTION cloud_compute_recheck_jobs();

-- Workspace erasure retains its billing tombstone. Purge scheduling data on
-- that existing boundary, including erasure performed by an older worker.
-- zeros-expand-exception: new-scheduling-purge Deletes only the new scheduling rows of the workspace whose existing erasure just completed
CREATE FUNCTION purge_cloud_compute_rechecks() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM cloud_workspace_compute_rechecks WHERE workspace_id=NEW.id AND org_id=NEW.org_id;
  RETURN NEW;
END $$;
CREATE TRIGGER purge_cloud_compute_rechecks AFTER UPDATE OF data_deleted_at ON cloud_workspaces
  FOR EACH ROW WHEN (OLD.data_deleted_at IS NULL AND NEW.data_deleted_at IS NOT NULL)
  EXECUTE FUNCTION purge_cloud_compute_rechecks();
