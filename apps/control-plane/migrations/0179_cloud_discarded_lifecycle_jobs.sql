-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Finish writers that used the old trigger before taking the backfill's
-- snapshot. Later recovery writes wait and use the replacement after commit.
LOCK TABLE cloud_workspace_final_save_recoveries IN SHARE ROW EXCLUSIVE MODE;

-- A committed owner discard can admit an existing lifecycle intent without
-- updating that intent. Its earlier blocked job may already have drained.
-- Commit a lifecycle wake with the discard, just as with proven final saves;
-- the ordinary worker still rechecks all exact dispatch and provider fences.
-- zeros-expand-exception: discarded-lifecycle-wake Add a queue hint for discarded recovery without changing dispatch authority
CREATE OR REPLACE FUNCTION cloud_final_save_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('proven','resolved','discarded') THEN
    INSERT INTO control_plane_jobs AS job(kind,dedupe_key,org_id,workspace_id,run_at)
      VALUES('cloud_final_save_recovery','workspace:'||NEW.workspace_id::text,NEW.org_id,NEW.workspace_id,NEW.next_attempt_at)
    ON CONFLICT (kind,dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
      payload='{}'::jsonb,
      run_at=CASE WHEN job.state='queued' THEN least(job.run_at,EXCLUDED.run_at) ELSE job.run_at END,
      rerun_at=CASE WHEN job.state='running' THEN least(job.rerun_at,EXCLUDED.run_at) END,updated_at=clock_timestamp()
    WHERE job.payload<>'{}'::jsonb OR (job.state='queued' AND EXCLUDED.run_at<job.run_at)
      OR (job.state='running' AND (job.rerun_at IS NULL OR EXCLUDED.run_at<job.rerun_at));
  ELSIF NEW.state IN ('proven','discarded') THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',NEW.workspace_id,NEW.org_id,clock_timestamp());
  END IF;
  RETURN NEW;
END $$;

-- Recover already committed, exact pending-Delete receipts whose lifecycle
-- wake was lost. Do not rewrite intent clocks, leases, receipts or save facts.
-- An early hint is safe: dispatching work retains its ordinary lease deadline.
SELECT set_config('app.system','on',true);
SELECT enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',intent.workspace_id,intent.org_id,clock_timestamp())
  FROM cloud_workspace_owner_existing_delete_receipts receipt
  JOIN cloud_workspace_lifecycle_intents intent
    ON intent.id=receipt.delete_intent_id AND intent.workspace_id=receipt.workspace_id AND intent.org_id=receipt.org_id
  WHERE receipt.kind='pending_delete' AND intent.operation='delete'
    AND intent.state IN ('queued','observing','dispatching')
    AND cloud_owner_existing_delete_current(intent.id);
SELECT set_config('app.system','',true);
