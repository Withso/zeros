-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- When a workspace last entered running. Activity (active_at) is no proof a workspace ever ran: queueing a message sets
-- it, a create's first message included, before any worker started. Recovery of a failed workspace needs a machine
-- that was once set up, and its auto-heal needs to know whether the current stop generation ran (its disk then holds
-- work the generation's backup does not cover). Existing rows with evidence of a boot count as having run, the side
-- that protects their work: a completed stop, a state past the create, a live recovery (which begins only on a running
-- workspace), a finished setup (which runs on the checkout) or a worker's accepted hello (token delivery, and so the
-- hello, follows the checkout's preparation).
ALTER TABLE cloud_v2_workspaces ADD COLUMN running_at timestamptz;
-- Row security hides every workspace without system context, from a migration owner without BYPASSRLS too; a shared
-- workspace also needs the execution protocol marker.
SELECT set_config('app.system','on',true), set_config('app.cloud_execution_protocol','1',true);
UPDATE cloud_v2_workspaces w SET running_at = coalesce(w.active_at, w.updated_at)
WHERE w.stopped_at IS NOT NULL OR w.state IN ('running', 'stopping', 'stopped')
  OR EXISTS (SELECT 1 FROM cloud_v2_recovery_attempts a WHERE a.workspace_id = w.id)
  OR w.setup_status->>'state' = 'succeeded' OR w.worker_boot_id IS NOT NULL;
SELECT set_config('app.system','',true), set_config('app.cloud_execution_protocol','',true);

-- zeros-expand-exception: prompt-fence-reentry Finishing a failed Stop in its own generation keeps the sends its first entry accepted
CREATE OR REPLACE FUNCTION fence_cloud_v2_prompts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state = 'deleted' THEN
    DELETE FROM public.cloud_v2_prompt_chats WHERE workspace_id = NEW.id;
  ELSIF NEW.access_epoch <> OLD.access_epoch OR NEW.state = 'deleting' THEN
    UPDATE public.cloud_v2_prompt_outbox
      SET state = 'cancelled', cancel_requested = true, payload = NULL, payload_bytes = 0,
          terminal_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE workspace_id = NEW.id AND state IN ('queued','inboxed','dispatching','accepted');
  ELSIF NEW.state = 'stopping' AND OLD.state <> 'failed' THEN
    -- Existing explicit workspace Stop also fences sends accepted before it. Only recovery and the auto-heal move a
    -- failed workspace to stopping, never a person's Stop: what was sent before, during a Stop that failed included,
    -- keeps its wake.
    -- A later send may request one wake after this stop finishes.
    UPDATE public.cloud_v2_prompt_chats c SET epoch = epoch + 1
      WHERE workspace_id = NEW.id AND EXISTS (SELECT 1 FROM public.cloud_v2_prompt_outbox p
        WHERE p.workspace_id = c.workspace_id AND p.chat_id = c.chat_id AND p.state IN ('queued','inboxed','dispatching','accepted'));
    UPDATE public.cloud_v2_prompt_outbox
      SET cancel_requested = true, wake_after_stop = false,
          state = CASE WHEN state IN ('queued','inboxed') THEN 'cancelled' ELSE state END,
          terminal_at = CASE WHEN state IN ('queued','inboxed') THEN clock_timestamp() ELSE terminal_at END,
          updated_at = clock_timestamp()
      WHERE workspace_id = NEW.id AND state IN ('queued','inboxed','dispatching','accepted');
  END IF;
  PERFORM pg_notify('zeros_cloud_v2_prompts', NEW.id::text);
  RETURN NEW;
END;
$$;
