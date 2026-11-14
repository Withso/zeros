import { HttpError } from "../authz.js";

// Evaluate after taking the workspace lock, shared by enqueue and the fence.
// A missing journal is not permission to dispatch from a fenced workspace.
export const CLOUD_RECOVERY_TURN_HOLD = `w.recovery_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM cloud_v2_recovery_attempts recovery WHERE recovery.id=w.recovery_attempt_id
    AND recovery.workspace_id=w.id AND recovery.phase='waiting')`;

export function assertRecoveryTurnReady(held: boolean | undefined): void {
  if (held) throw new HttpError(409, "workspace_starting", "The workspace is starting. Try again when it is ready.");
}
