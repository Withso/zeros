import { withSystemTx } from "../../db.js";
import type { CloudV2LifecycleWorkspace } from "../store.js";
import type { CloudExecutionContexts } from "./store.js";
import { actorChanged } from "./errors.js";
import { assertExecutionIntent } from "./authority.js";

export async function lifecycleExecution(contexts: CloudExecutionContexts, workspace: CloudV2LifecycleWorkspace,
  options?: { recoveryId: string }) {
  if (!await contexts.active(workspace.id)) {
    if (workspace.executionIntent) throw actorChanged();
    return null;
  }
  const intent = workspace.executionIntent;
  if (!intent?.id || !intent.userId) throw actorChanged();
  const fence = () => withSystemTx(contexts.pool, async tx => {
    if (!(await tx.query(`SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active'
      AND execution_intent_id=$2 AND execution_initiator_user_id=$3 AND access_epoch=$4 AND stop_generation=$5
      AND archived_at IS NULL
      AND (($7::uuid IS NULL AND state=$6 AND state IN ('creating','starting')) OR
        ($7::uuid=recovery_attempt_id AND state IN ('starting','running') AND EXISTS (
          SELECT 1 FROM cloud_v2_recovery_attempts a WHERE a.id=$7 AND a.workspace_id=cloud_v2_workspaces.id
            AND a.phase IN ('waiting','sealing','sealed','capturing','restoring','booting','verifying')
            AND a.execution_intent_id=$2 AND a.initiator_user_id=$3 AND a.access_epoch=$4 AND a.stop_generation=$5
            AND a.deadline_at>clock_timestamp())))`,
    [workspace.id, intent.id, intent.userId, intent.accessEpoch, workspace.stopGeneration, workspace.state, options?.recoveryId ?? null])).rowCount) throw actorChanged();
  });
  await fence();
  let proof = { ...await contexts.deps.authority.admit(workspace.id, intent.userId), runBound: false as const };
  assertExecutionIntent(intent.authority, proof);
  const person = proof.person;
  const check = async () => {
    await fence();
    // Hydration may outlive admission. Reverify the same intent/person; a
    // changed membership or permission revision cannot inherit it.
    if (proof.until <= Date.now()) {
      const renewed = await contexts.deps.authority.admit(workspace.id, intent.userId!);
      if (renewed.person.personSignature !== person.personSignature) throw actorChanged();
      proof = { ...renewed, runBound: false };
    }
    await contexts.deps.authority.assert(proof);
    await fence();
  };
  await check();
  return { userId: intent.userId, check };
}
