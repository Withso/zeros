import { withSystemTx } from "../../db.js";
import type { CloudV2LifecycleWorkspace } from "../store.js";
import type { CloudExecutionContexts } from "./store.js";
import { actorChanged } from "./errors.js";
import { assertExecutionIntent } from "./authority.js";

export async function lifecycleExecution(contexts: CloudExecutionContexts, workspace: CloudV2LifecycleWorkspace) {
  if (!await contexts.active(workspace.id)) {
    if (workspace.executionIntent) throw actorChanged();
    return null;
  }
  const intent = workspace.executionIntent;
  if (!intent?.id || !intent.userId) throw actorChanged();
  const fence = () => withSystemTx(contexts.pool, async tx => {
    if (!(await tx.query(`SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active'
      AND execution_intent_id=$2 AND execution_initiator_user_id=$3 AND access_epoch=$4 AND stop_generation=$5
      AND state=$6 AND state IN ('creating','starting') AND archived_at IS NULL`,
    [workspace.id, intent.id, intent.userId, intent.accessEpoch, workspace.stopGeneration, workspace.state])).rowCount) throw actorChanged();
  });
  await fence();
  const options = workspace.state === "starting" && workspace.checkpoint ? { sourceError: "github_access_required" as const } : {};
  let proof = { ...await contexts.deps.authority.admit(workspace.id, intent.userId, options), runBound: false as const };
  assertExecutionIntent(intent.authority, proof);
  const person = proof.person;
  const check = async () => {
    await fence();
    // Hydration may outlive admission. Reverify the same intent/person; a
    // newly selected connection or permission revision cannot inherit it.
    if (proof.until <= Date.now()) {
      const renewed = await contexts.deps.authority.admit(workspace.id, intent.userId!, options);
      if (renewed.person.personSignature !== person.personSignature || renewed.source.fingerprint !== proof.source.fingerprint) throw actorChanged();
      proof = { ...renewed, runBound: false };
    }
    await contexts.deps.authority.assert(proof);
    await fence();
  };
  await check();
  return { userId: intent.userId, check };
}
