-- Released wake transactions lock the workspace, read the provider journal,
-- then upgrade their workspace lock for UPDATE. Do not take the FK's weaker
-- parent lock and later wait on that journal: acquire the strongest locks in
-- parent-first order before creating anything. Retry the atomic migration if
-- writers do not drain within this bounded acquisition window.
SET LOCAL lock_timeout='2s';
LOCK TABLE cloud_workspaces IN ACCESS EXCLUSIVE MODE;
LOCK TABLE cloud_workspace_provider_operations IN ACCESS EXCLUSIVE MODE;

-- Record the committed ready boundary on the row already being published.
-- Recovery of private evidence happens later, outside the ready transaction.
ALTER TABLE cloud_workspaces
  ADD COLUMN diagnostic_recovery_at timestamptz,
  ADD COLUMN diagnostic_recovery_generation integer CHECK(diagnostic_recovery_generation>0);

-- Incident evidence is independent of mutable workspace/lease error fields.
-- No arbitrary text, logs or provider bodies are accepted by its writer.
CREATE TABLE cloud_workspace_diagnostic_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  operation_kind text NOT NULL CHECK (operation_kind IN ('compute','setup','engine')),
  operation_id uuid NOT NULL,
  execution_fence bigint,
  reason text NOT NULL CHECK (reason IN ('budget_stop','safety_failure','engine_expired','image_integrity_rejected')),
  stop_initiated_at timestamptz,
  first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_cause jsonb NOT NULL CHECK (octet_length(first_cause::text) <= 4096),
  terminal_cause jsonb NOT NULL CHECK (octet_length(terminal_cause::text) <= 4096),
  events jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(events)='array' AND jsonb_array_length(events)<=16 AND octet_length(events::text)<=65536),
  recovered_at timestamptz,
  recovered_generation integer CHECK(recovered_generation>0),
  UNIQUE(workspace_id,generation,operation_kind,operation_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_diagnostics_retention ON cloud_workspace_diagnostic_incidents(last_at);
ALTER TABLE cloud_workspace_diagnostic_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_diagnostic_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_diagnostics_system ON cloud_workspace_diagnostic_incidents FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_diagnostic_incidents TO zeros_app;
CREATE TABLE cloud_workspace_diagnostic_cleanup (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  storage_failures bigint NOT NULL DEFAULT 0 CHECK(storage_failures>=0)
);
INSERT INTO cloud_workspace_diagnostic_cleanup(id) VALUES(true);
ALTER TABLE cloud_workspace_diagnostic_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_diagnostic_cleanup FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_diagnostic_cleanup_system ON cloud_workspace_diagnostic_cleanup FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_diagnostic_cleanup TO zeros_app;

-- Retry timestamps are not deletion progress. Released writers still advance
-- the initial requested/receipt/completed stages through this additive trigger.
ALTER TABLE cloud_workspace_provider_operations
  ADD COLUMN deletion_stage text CHECK(deletion_stage IN ('requested','receipt','pending','processing','blocked','waiting_for_uploads','kept_for_newer_snapshots','waiting_for_restore','deleting','completed','unknown')),
  ADD COLUMN deletion_progress_rank integer NOT NULL DEFAULT 0 CHECK(deletion_progress_rank BETWEEN 0 AND 8),
  ADD COLUMN deletion_progress_at timestamptz;
CREATE FUNCTION track_cloud_provider_deletion_progress() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stage_rank integer;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN NEW.deletion_stage='completed';
  ELSIF NEW.deletion_operation_id IS NOT NULL AND (NEW.deletion_stage IS NULL OR OLD.deletion_operation_id IS NULL) AND OLD.deletion_progress_rank<2 THEN NEW.deletion_stage='receipt';
  ELSIF NEW.deletion_stage IS NULL AND NEW.deletion_requested_at IS NOT NULL THEN NEW.deletion_stage='requested'; END IF;
  stage_rank=CASE NEW.deletion_stage WHEN 'completed' THEN 8 WHEN 'deleting' THEN 7
    WHEN 'waiting_for_uploads' THEN 5 WHEN 'kept_for_newer_snapshots' THEN 5 WHEN 'waiting_for_restore' THEN 5
    WHEN 'processing' THEN 4 WHEN 'pending' THEN 3 WHEN 'receipt' THEN 2 WHEN 'requested' THEN 1 ELSE 0 END;
  NEW.deletion_progress_rank=greatest(OLD.deletion_progress_rank,stage_rank);
  NEW.deletion_progress_at=CASE WHEN stage_rank>OLD.deletion_progress_rank THEN
    CASE WHEN OLD.deletion_progress_rank=0 THEN coalesce(NEW.deletion_requested_at,clock_timestamp()) ELSE clock_timestamp() END
    ELSE OLD.deletion_progress_at END;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_provider_deletion_progress BEFORE UPDATE ON cloud_workspace_provider_operations
  FOR EACH ROW EXECUTE FUNCTION track_cloud_provider_deletion_progress();

-- This trigger never reads or writes the diagnostic table. Even an exclusive
-- lock on that table cannot delay or cancel an old or new writer's publication.
-- The background retry uses this boundary, including after a subsequent stop,
-- and cannot mark incidents created after publication as recovered.
CREATE FUNCTION recover_cloud_workspace_diagnostics() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.status='ready' AND NEW.desired_state='running' AND
    (OLD.status IS DISTINCT FROM NEW.status OR OLD.current_generation IS DISTINCT FROM NEW.current_generation) THEN
    NEW.diagnostic_recovery_at=clock_timestamp();
    NEW.diagnostic_recovery_generation=NEW.current_generation;
  END IF;
  RETURN NEW;
END $$;
-- BEFORE row triggers execute in name order. Keep the ready-boundary writer
-- after 0113's cloud_workspace_quarantine_workspace: its final NEW values must
-- still be ready/running before recording successful publication. Future ready
-- guards must also precede this writer; rejected attempts preserve the boundary.
CREATE TRIGGER cloud_workspace_ready_diagnostic_recovery BEFORE UPDATE OF status,current_generation ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION recover_cloud_workspace_diagnostics();
