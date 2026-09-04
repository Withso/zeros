-- ───────────────────────────────────────────────────────────
-- 0045 — authoritative cloud execution projection
--
-- A provider generation is not a second workspace identity. `workspace_executions`
-- is the durable projection of which immutable cloud generation currently owns
-- execution authority. Keep that projection transactionally aligned with the
-- workspace lifecycle instead of relying on every coordinator call site to
-- remember a second write.
-- ───────────────────────────────────────────────────────────

-- The previous key included authority_epoch, so an epoch bump allowed two
-- simultaneously-live rows for one workspace. Reconcile existing rows before
-- installing the workspace-wide invariant.
DROP INDEX workspace_one_live_execution_idx;

INSERT INTO workspace_executions (
  workspace_id, org_id, generation, authority_epoch, placement, state,
  started_at, ended_at
)
SELECT generation.workspace_id, generation.org_id, generation.generation,
       workspace.authority_epoch, 'cloud',
       CASE
         WHEN generation.retired_at IS NOT NULL THEN 'retired'
         WHEN generation.generation <> workspace.current_generation THEN 'retired'
         WHEN workspace.status IN ('ready', 'busy') THEN 'active'
         WHEN workspace.status IN (
           'requested', 'provisioning', 'setting_up', 'waking'
         ) THEN 'provisioning'
         WHEN workspace.status IN ('stopping', 'stopped') THEN 'stopped'
         WHEN workspace.status IN ('archiving', 'archived') THEN 'archived'
         WHEN workspace.status IN ('deleting', 'deleted') THEN 'deleted'
         ELSE 'failed'
       END,
       generation.created_at,
       CASE
         WHEN generation.retired_at IS NOT NULL THEN generation.retired_at
         WHEN generation.generation <> workspace.current_generation
           THEN workspace.updated_at
         WHEN workspace.status IN (
           'requested', 'provisioning', 'setting_up', 'waking', 'ready', 'busy'
         ) THEN NULL
         ELSE coalesce(workspace.deleted_at, workspace.updated_at)
       END
FROM cloud_workspace_generations generation
JOIN cloud_workspaces workspace
  ON workspace.id = generation.workspace_id
 AND workspace.org_id = generation.org_id
ON CONFLICT (workspace_id, generation) DO NOTHING;

UPDATE workspace_executions execution
SET authority_epoch = workspace.authority_epoch,
    state = CASE
      WHEN generation.retired_at IS NOT NULL THEN 'retired'
      WHEN generation.generation <> workspace.current_generation THEN 'retired'
      WHEN workspace.status IN ('ready', 'busy') THEN 'active'
      WHEN workspace.status IN (
        'requested', 'provisioning', 'setting_up', 'waking'
      ) THEN 'provisioning'
      WHEN workspace.status IN ('stopping', 'stopped') THEN 'stopped'
      WHEN workspace.status IN ('archiving', 'archived') THEN 'archived'
      WHEN workspace.status IN ('deleting', 'deleted') THEN 'deleted'
      ELSE 'failed'
    END,
    ended_at = CASE
      WHEN generation.retired_at IS NOT NULL
        THEN coalesce(execution.ended_at, generation.retired_at)
      WHEN generation.generation <> workspace.current_generation
        THEN coalesce(execution.ended_at, workspace.updated_at)
      WHEN workspace.status IN (
        'requested', 'provisioning', 'setting_up', 'waking', 'ready', 'busy'
      ) THEN NULL
      ELSE coalesce(execution.ended_at, workspace.deleted_at, workspace.updated_at)
    END
FROM cloud_workspace_generations generation
JOIN cloud_workspaces workspace
  ON workspace.id = generation.workspace_id
 AND workspace.org_id = generation.org_id
WHERE execution.workspace_id = generation.workspace_id
  AND execution.generation = generation.generation
  AND execution.org_id = generation.org_id;

CREATE UNIQUE INDEX workspace_one_live_execution_idx
  ON workspace_executions (workspace_id)
  WHERE ended_at IS NULL AND state IN ('provisioning', 'active');

CREATE FUNCTION sync_cloud_workspace_execution_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  projected_state text;
  projected_ended_at timestamptz;
BEGIN
  -- Close the displaced generation before opening the new one so the partial
  -- unique index is never transiently violated inside the statement trigger.
  UPDATE workspace_executions execution
  SET state = 'retired',
      ended_at = coalesce(execution.ended_at, now())
  WHERE execution.workspace_id = NEW.id
    AND execution.generation <> NEW.current_generation
    AND (
      execution.state <> 'retired'
      OR execution.ended_at IS NULL
    );

  SELECT CASE
           WHEN generation.retired_at IS NOT NULL THEN 'retired'
           WHEN NEW.status IN ('ready', 'busy') THEN 'active'
           WHEN NEW.status IN (
             'requested', 'provisioning', 'setting_up', 'waking'
           ) THEN 'provisioning'
           WHEN NEW.status IN ('stopping', 'stopped') THEN 'stopped'
           WHEN NEW.status IN ('archiving', 'archived') THEN 'archived'
           WHEN NEW.status IN ('deleting', 'deleted') THEN 'deleted'
           ELSE 'failed'
         END,
         CASE
           WHEN generation.retired_at IS NOT NULL
             THEN generation.retired_at
           WHEN NEW.status IN (
             'requested', 'provisioning', 'setting_up', 'waking',
             'ready', 'busy'
           ) THEN NULL
           ELSE coalesce(NEW.deleted_at, now())
         END
  INTO projected_state, projected_ended_at
  FROM cloud_workspace_generations generation
  WHERE generation.workspace_id = NEW.id
    AND generation.generation = NEW.current_generation
    AND generation.org_id = NEW.org_id;

  IF projected_state IS NULL THEN
    RAISE EXCEPTION 'current cloud workspace generation is missing'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO workspace_executions (
    workspace_id, org_id, generation, authority_epoch, placement, state,
    started_at, ended_at
  )
  SELECT NEW.id, NEW.org_id, generation.generation, NEW.authority_epoch,
         'cloud', projected_state, generation.created_at, projected_ended_at
  FROM cloud_workspace_generations generation
  WHERE generation.workspace_id = NEW.id
    AND generation.generation = NEW.current_generation
    AND generation.org_id = NEW.org_id
  ON CONFLICT (workspace_id, generation) DO UPDATE
  SET authority_epoch = EXCLUDED.authority_epoch,
      state = EXCLUDED.state,
      ended_at = EXCLUDED.ended_at;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_execution_projection_sync
  AFTER UPDATE OF status, desired_state, current_generation, authority_epoch,
                  deleted_at
  ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION sync_cloud_workspace_execution_projection();

CREATE FUNCTION retire_cloud_workspace_execution_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE workspace_executions
  SET state = 'retired', ended_at = coalesce(ended_at, NEW.retired_at)
  WHERE workspace_id = NEW.workspace_id
    AND generation = NEW.generation
    AND org_id = NEW.org_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_generation_execution_retirement
  AFTER UPDATE OF retired_at ON cloud_workspace_generations
  FOR EACH ROW
  WHEN (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
  EXECUTE FUNCTION retire_cloud_workspace_execution_projection();

REVOKE ALL ON FUNCTION sync_cloud_workspace_execution_projection()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION retire_cloud_workspace_execution_projection()
  FROM PUBLIC;
