// Frozen lifecycle writes from c4895c03, before final-checkpoint/recovery
// fencing. Keep these independent of the new route/transition implementation:
// they model an older replica sharing the migrated database during rollout.
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

type Scope = { workspaceId: string; organizationId: string; userId: string };

export async function previousBackendWake(tx: Tx, scope: Scope): Promise<string> {
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
  const workspace = (await tx.query("SELECT current_generation,status,desired_state FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [scope.workspaceId])).rows[0];
  const satisfied = workspace.desired_state === "running" && ["provisioning", "setting_up", "ready", "busy"].includes(workspace.status);
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now(),
    error_code='superseded_by_newer_intent' WHERE workspace_id=$1 AND affects_workspace AND state IN ('queued','observing')`, [scope.workspaceId]);
  await tx.query(`UPDATE workspace_checkpoint_requests request SET state='cancelled',completed_at=now(),error_code='superseded_by_newer_intent'
    FROM cloud_workspace_lifecycle_intents intent WHERE request.lifecycle_intent_id=intent.id AND intent.workspace_id=$1
      AND intent.state='superseded' AND request.state IN ('queued','delivered')`, [scope.workspaceId]);
  const id = randomUUID();
  await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,state,completed_at)
    VALUES($1,$2,$3,$4,$5,'wake',$6,$7,$8::cloud_workspace_intent_state,CASE WHEN $8='succeeded' THEN now() ELSE NULL END)`,
  [id, scope.workspaceId, workspace.current_generation, scope.organizationId, scope.userId, randomUUID(), Buffer.alloc(32), satisfied ? "succeeded" : "queued"]);
  if (!satisfied) await tx.query(`UPDATE cloud_workspaces SET desired_state='running',status='waking',version=version+1,
    authority_epoch=authority_epoch+1,updated_at=now(),last_error_code=NULL,last_error_message=NULL WHERE id=$1`, [scope.workspaceId]);
  return id;
}

export async function previousBackendRecoveryRollback(tx: Tx, scope: Scope): Promise<void> {
  const transition = (await tx.query(`SELECT gt.* FROM cloud_workspace_generation_transitions gt JOIN cloud_workspaces cw ON cw.id=gt.workspace_id
    WHERE gt.workspace_id=$1 AND gt.state IN ('draining','provisioning','setting_up') AND cw.desired_state='running'
      AND cw.current_generation IN (gt.source_generation,gt.candidate_generation) FOR UPDATE OF gt,cw`, [scope.workspaceId])).rows[0];
  if (!transition) throw new Error("Missing recovery transition fixture");
  await retireCloudWorkspaceRuntimeAccess(tx, { ...scope, generation: transition.candidate_generation, reason: "generation_candidate_rejected" });
  await tx.query("UPDATE cloud_workspace_generations SET retired_at=coalesce(retired_at,now()) WHERE workspace_id=$1 AND generation=$2", [scope.workspaceId, transition.candidate_generation]);
  await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='rolling_back',error_code='setup_image_contract_invalid',error_message='fixture',updated_at=now() WHERE id=$1`, [transition.id]);
  await tx.query(`UPDATE cloud_workspaces SET current_generation=$2,status='waking',authority_epoch=authority_epoch+1,
    last_error_code=NULL,last_error_message=NULL,version=version+1,updated_at=now() WHERE id=$1 AND current_generation IN ($2,$3)`,
  [scope.workspaceId, transition.source_generation, transition.candidate_generation]);
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now(),error_code='generation_candidate_rejected'
    WHERE workspace_id=$1 AND generation=$2 AND affects_workspace AND state IN ('queued','observing')`, [scope.workspaceId, transition.candidate_generation]);
  for (const operation of ["wake", "delete"]) {
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace,generation_transition_id,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10::bigint*interval '1 millisecond'))`,
    [randomUUID(), scope.workspaceId, operation === "wake" ? transition.source_generation : transition.candidate_generation,
      scope.organizationId, operation, `system:generation:${randomUUID()}`, Buffer.alloc(32), operation === "wake", transition.id, operation === "wake" ? 0 : 1000]);
  }
}
