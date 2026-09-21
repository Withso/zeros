-- Management returns recent history, including removed/expired rows. The
-- live-only worker indexes cannot bound these pages. Globally unique workspace
-- IDs lead each index; every caller still checks organization and actor scope.
-- Apply during the planned writer-quiesced database migration. These are full
-- indexes, so an online rollout on an already-large installation must build
-- their equivalents concurrently before marking this migration applied.
CREATE INDEX workspace_replicas_actor_history_idx
  ON workspace_replicas(workspace_id,user_id,updated_at DESC,id);
CREATE INDEX port_forward_sessions_actor_history_idx
  ON port_forward_sessions(workspace_id,user_id,updated_at DESC,id);
CREATE INDEX workspace_checkpoint_requests_history_idx
  ON workspace_checkpoint_requests(workspace_id,created_at DESC,id DESC);
CREATE INDEX workspace_checkpoints_history_idx
  ON workspace_checkpoints(workspace_id,created_at DESC,id DESC);
CREATE INDEX workspace_exports_actor_history_idx
  ON workspace_exports(workspace_id,requested_by,created_at DESC,id DESC);
