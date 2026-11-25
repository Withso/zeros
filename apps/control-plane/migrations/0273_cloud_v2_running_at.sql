-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- When a workspace last entered running. Activity (active_at) is no proof a workspace ever ran: queueing a message sets
-- it, a create's first message included, before any worker started. Recovery of a failed workspace needs a machine
-- that was once set up, and its auto-heal needs to know whether the current stop generation ran (its disk then holds
-- work the generation's backup does not cover). Existing rows that completed a stop or are past their create count as
-- having run, the side that protects their work.
ALTER TABLE cloud_v2_workspaces ADD COLUMN running_at timestamptz;
UPDATE cloud_v2_workspaces SET running_at = coalesce(active_at, updated_at)
WHERE stopped_at IS NOT NULL OR state IN ('running', 'stopping', 'stopped');

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
  ELSIF NEW.state = 'stopping' AND NOT (OLD.state = 'failed' AND NEW.stop_generation = OLD.stop_generation) THEN
    -- Existing explicit workspace Stop also fences sends accepted before it. A failed Stop finished again in its own
    -- generation was fenced when it began; what was sent while it ran keeps its wake.
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
