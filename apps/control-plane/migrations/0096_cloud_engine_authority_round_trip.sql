-- Every engine request holds the workspace row lock for one database round
-- trip per statement. This runs the engine authority sequence server-side in
-- one round trip, with the same statements, row locks and order as the former
-- client-side sequence: organization share, workspace, engine, then one
-- recheck of the lease deadline and final-checkpoint fence after both locks.
-- Returns no row when the workspace or engine is not current; the caller
-- compares the heartbeat token hash and rejects a live=false or fenced row.
CREATE FUNCTION cloud_workspace_engine_authority_current(
  target_workspace_id uuid, target_org_id uuid, target_generation integer,
  target_engine_id uuid, require_workos boolean, exclusive boolean
) RETURNS TABLE (
  authority_epoch bigint, account_user_id uuid, heartbeat_token_hash bytea,
  live boolean, fenced boolean
) LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  workspace record;
  engine record;
BEGIN
  PERFORM 1 FROM organizations organization WHERE organization.id = target_org_id FOR SHARE;
  IF exclusive THEN
    SELECT w.current_generation, w.authority_epoch, w.desired_state, w.status
    INTO workspace FROM cloud_workspaces w
    WHERE w.id = target_workspace_id AND w.org_id = target_org_id AND w.deleted_at IS NULL
      AND cloud_workspace_generation_policy_current(w.id, target_generation, w.org_id)
    FOR UPDATE;
  ELSE
    SELECT w.current_generation, w.authority_epoch, w.desired_state, w.status
    INTO workspace FROM cloud_workspaces w
    WHERE w.id = target_workspace_id AND w.org_id = target_org_id AND w.deleted_at IS NULL
      AND cloud_workspace_generation_policy_current(w.id, target_generation, w.org_id)
    FOR SHARE;
  END IF;
  IF NOT FOUND OR workspace.current_generation <> target_generation
    OR workspace.desired_state <> 'running' OR workspace.status NOT IN ('setting_up', 'ready', 'busy') THEN
    RETURN;
  END IF;
  IF exclusive THEN
    SELECT instance.account_user_id, instance.heartbeat_token_hash INTO engine
    FROM cloud_workspace_engine_instances instance
    WHERE instance.id = target_engine_id AND instance.workspace_id = target_workspace_id
      AND instance.org_id = target_org_id AND instance.generation = target_generation
      AND instance.state = 'ready' AND instance.lease_expires_at > clock_timestamp()
      AND cloud_workspace_runtime_authority_live(
        instance.workspace_id, instance.generation, instance.account_user_id, require_workos)
    FOR UPDATE;
  ELSE
    SELECT instance.account_user_id, instance.heartbeat_token_hash INTO engine
    FROM cloud_workspace_engine_instances instance
    WHERE instance.id = target_engine_id AND instance.workspace_id = target_workspace_id
      AND instance.org_id = target_org_id AND instance.generation = target_generation
      AND instance.state = 'ready' AND instance.lease_expires_at > clock_timestamp()
      AND cloud_workspace_runtime_authority_live(
        instance.workspace_id, instance.generation, instance.account_user_id, require_workos)
    FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- SELECT ... FOR UPDATE may evaluate its predicate before waiting. Recheck
  -- the deadlines once both scope and engine locks are actually held.
  RETURN QUERY SELECT workspace.authority_epoch::bigint, engine.account_user_id, engine.heartbeat_token_hash,
    EXISTS (
      SELECT 1 FROM cloud_workspace_engine_instances instance
      WHERE instance.id = target_engine_id AND instance.lease_expires_at > clock_timestamp()
        AND cloud_workspace_runtime_authority_live(
          instance.workspace_id, instance.generation, instance.account_user_id, require_workos)
    ),
    EXISTS (
      SELECT 1
      FROM workspace_checkpoint_requests checkpoint_request
      JOIN cloud_workspace_lifecycle_intents intent
        ON intent.id = checkpoint_request.lifecycle_intent_id
      WHERE checkpoint_request.workspace_id = target_workspace_id
        AND checkpoint_request.org_id = target_org_id
        AND checkpoint_request.generation = target_generation
        AND checkpoint_request.state = 'succeeded'
        AND intent.state IN ('queued', 'observing', 'dispatching')
        AND intent.operation IN ('stop', 'archive', 'delete')
    );
END
$$;

REVOKE ALL ON FUNCTION cloud_workspace_engine_authority_current(uuid, uuid, integer, uuid, boolean, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_engine_authority_current(uuid, uuid, integer, uuid, boolean, boolean)
  TO zeros_app;
