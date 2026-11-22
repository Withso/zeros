-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Retention follow-up to 0265: a connection's removal records its projects (cloud_v2_disconnected_projects) in its own
-- exception block, before and apart from retiring their copies. In 0265 both statements shared one block, so an error
-- in the retire also discarded the record the lifecycle's retireDisconnectedCopies lane needs to finish the job. Now a
-- failed retire leaves the record, and the lane retires those copies; a failed record still never fails the removal.
-- Same signature, owner, SECURITY DEFINER, search path and privileges (CREATE OR REPLACE keeps the 0265 REVOKE).
--
-- Down path (never run automatically): re-apply 0265's function body.
-- zeros-expand-exception: disconnect-record Same trigger function and signature; the record is written in its own exception block.
CREATE OR REPLACE FUNCTION cloud_v2_retire_disconnected_copies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  BEGIN
    INSERT INTO public.cloud_v2_disconnected_projects (project_id)
      SELECT DISTINCT r.project_id FROM public.cloud_project_repositories r WHERE r.connection = OLD.id
      ON CONFLICT (project_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the removal.
  END;
  BEGIN
    UPDATE public.cloud_v2_ready_copies SET state = CASE WHEN state = 'building' THEN 'failed' ELSE 'retired' END,
        failure_reason = CASE WHEN state = 'building' THEN 'connection_removed' ELSE failure_reason END, updated_at = clock_timestamp()
      WHERE id IN (SELECT c.id FROM public.cloud_v2_ready_copies c
        WHERE c.state IN ('building', 'ready') AND EXISTS (SELECT 1 FROM public.cloud_project_repositories r
          WHERE r.project_id = c.project_id AND r.connection = OLD.id)
        ORDER BY c.id FOR UPDATE SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the removal: the recorded projects' copies are retired by the lifecycle.
  END;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN OLD;
END;
$$;
