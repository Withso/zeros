import { createHash, randomUUID } from "node:crypto";

import { audit } from "../audit.js";
import type { Tx } from "../db.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

/** Shared owner for wake replacements and retained-allocation transitions.
 * Keep organization -> workspace order, including before the unique active
 * transition check. The returned lock lasts for the caller's transaction. */
export async function lockCloudWorkspaceGenerationTransition(tx: Tx, input: {
  workspaceId: string; organizationId: string;
}): Promise<void> {
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
  await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [input.workspaceId,input.organizationId]);
}

type TransitionRow = {
  id: string;
  source_generation: number;
  candidate_generation: number;
  state: "draining" | "provisioning" | "setting_up" | "rolling_back";
  execution_mode: "replace_allocation" | "retain_allocation";
  operation?: "upgrade" | "rollback" | "recover";
};

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

/** Automatic wake candidates use ordinary transition rows and a durable
 * namespaced upgrade intent. Source rollback wakes must never upgrade again. */
export async function isAutomaticRuntimeWakeGeneration(tx: Tx, input: {
  workspaceId: string; organizationId: string; generation: number; includeSource?: boolean;
  engineInstanceId?: string;
}): Promise<boolean> {
  const result = await tx.query(`SELECT 1 FROM cloud_workspace_generation_transitions transition
    JOIN cloud_workspace_lifecycle_intents intent ON intent.id=transition.drain_intent_id
    WHERE transition.workspace_id=$1 AND transition.org_id=$2
      AND intent.idempotency_key LIKE 'runtime-upgrade:automatic-wake:%'
      AND ((transition.candidate_generation=$3 AND (transition.state IN ('draining','provisioning','setting_up')
        OR ($4::boolean AND transition.state='succeeded')))
        OR ($4::boolean AND transition.source_generation=$3
          AND transition.state IN ('rolling_back','rolled_back','cancelled')))
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM cloud_workspace_engine_instances engine
        WHERE engine.id=$5 AND engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3
          AND engine.registered_at>transition.created_at
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances earlier
            WHERE earlier.workspace_id=$1 AND earlier.org_id=$2 AND earlier.generation=$3
              AND earlier.registered_at>transition.created_at
              AND (earlier.registered_at,earlier.id)<(engine.registered_at,engine.id)))) LIMIT 1`,
  [input.workspaceId,input.organizationId,input.generation,input.includeSource === true,input.engineInstanceId ?? null]);
  return (result.rowCount ?? 0) > 0;
}

async function queueTransitionIntent(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    transitionId: string;
    operation: "create" | "wake" | "stop" | "delete";
    affectsWorkspace: boolean;
    delayMs?: number;
  },
): Promise<string> {
  const intentId = randomUUID();
  const key = `system:generation:${randomUUID()}`;
  await tx.query(
    `INSERT INTO cloud_workspace_lifecycle_intents (
       id, workspace_id, generation, org_id, requested_by, operation,
       idempotency_key, request_sha256, affects_workspace,
       generation_transition_id, next_attempt_at
     ) VALUES (
       $1, $2, $3, $4, NULL, $5, $6, $7, $8, $9,
       now() + ($10::bigint * interval '1 millisecond')
     )`,
    [
      intentId,
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.operation,
      key,
      requestDigest({
        operation: input.operation,
        workspaceId: input.workspaceId,
        generation: input.generation,
        generationTransitionId: input.transitionId,
        affectsWorkspace: input.affectsWorkspace,
      }),
      input.affectsWorkspace,
      input.transitionId,
      input.delayMs ?? 0,
    ],
  );
  return intentId;
}

/**
 * Restore the source generation after a candidate's provider or setup
 * qualification fails. The rejected provider resource is retired through its
 * own non-workspace-affecting delete intent; recovery of the source remains a
 * normal fenced wake + setup verification.
 */
export async function rollbackCloudWorkspaceGenerationTransition(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    candidateGeneration: number;
    errorCode: string;
    errorMessage: string;
  },
): Promise<boolean> {
  const selected = await tx.query<TransitionRow>(
    `SELECT gt.id, gt.source_generation, gt.candidate_generation, gt.state, gt.operation
     FROM cloud_workspace_generation_transitions gt
     JOIN cloud_workspaces cw
       ON cw.id = gt.workspace_id AND cw.org_id = gt.org_id
     WHERE gt.workspace_id = $1 AND gt.org_id = $2 AND gt.execution_mode='replace_allocation'
       AND gt.candidate_generation = $3
       AND (gt.state IN ('draining', 'provisioning', 'setting_up') OR (gt.operation='recover' AND gt.state='rolling_back'))
       AND cw.current_generation IN (gt.source_generation, gt.candidate_generation)
       AND (cw.desired_state = 'running' OR (gt.operation='recover' AND gt.state='rolling_back' AND cw.desired_state='stopped'))
       AND cw.deleted_at IS NULL
     FOR UPDATE OF gt, cw`,
    [input.workspaceId, input.organizationId, input.candidateGeneration],
  );
  const transition = selected.rows[0];
  if (!transition) return false;

  if (transition.operation === "recover") {
    // Recovery is entered because the source is suspect. Keep it available
    // for salvage, with no runtime authority; never roll a rejected candidate
    // back into that allocation. Ordinary upgrade rollback remains below.
    await retireCloudWorkspaceRuntimeAccess(tx, { ...input, generation: transition.candidate_generation, reason: "generation_candidate_rejected" });
    await retireCloudWorkspaceRuntimeAccess(tx, { ...input, generation: transition.source_generation, reason: "generation_candidate_rejected" });
    await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='rollback_failed',completed_at=now(),updated_at=now(),
      error_code=$2,error_message=$3 WHERE id=$1`, [transition.id,input.errorCode.slice(0,128),input.errorMessage.slice(0,2048)]);
    await tx.query(`UPDATE cloud_workspaces SET current_generation=$2,status='failed',desired_state='stopped',authority_epoch=authority_epoch+1,
      version=version+1,updated_at=now(),last_error_code=$4,last_error_message=$5
      WHERE id=$1 AND org_id=$3`, [input.workspaceId,transition.source_generation,input.organizationId,
      input.errorCode === "cloud_runtime_revoked" ? input.errorCode : "recovery_needed",
      input.errorCode === "cloud_runtime_revoked" ? "This workspace runtime was revoked. Request an explicit runtime upgrade to continue." : "Recovery did not complete. The source is preserved."]);
    await tx.query(`UPDATE cloud_workspace_restore_incidents SET state='recovery_needed',reason=$2,updated_at=now() WHERE transition_id=$1`,[transition.id,input.errorCode.slice(0,128)]);
    await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now()
      WHERE generation_transition_id=$1 AND state IN ('queued','observing')`,[transition.id]);
    await queueTransitionIntent(tx,{...input,generation:transition.candidate_generation,transitionId:transition.id,operation:"delete",affectsWorkspace:false});
    if(transition.state === "draining" || transition.state === "rolling_back") await queueTransitionIntent(tx,{...input,generation:transition.source_generation,transitionId:transition.id,operation:"stop",affectsWorkspace:false});
    return true;
  }

  await retireCloudWorkspaceRuntimeAccess(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.candidate_generation,
    reason: "generation_candidate_rejected",
  });
  await tx.query(
    `UPDATE cloud_workspace_generations
     SET retired_at = coalesce(retired_at, now())
     WHERE workspace_id = $1 AND generation = $2 AND org_id = $3`,
    [input.workspaceId, transition.candidate_generation, input.organizationId],
  );
  await tx.query(
    `UPDATE cloud_workspace_generation_transitions
     SET state = 'rolling_back', error_code = $2, error_message = $3,
         updated_at = now()
     WHERE id = $1`,
    [
      transition.id,
      input.errorCode.slice(0, 128),
      input.errorMessage.slice(0, 2048),
    ],
  );
  await tx.query(
    `UPDATE cloud_workspaces
     SET current_generation = $2, status = 'waking',
         authority_epoch = authority_epoch + 1,
         last_error_code = NULL, last_error_message = NULL,
         version = version + 1, updated_at = now()
     WHERE id = $1 AND org_id = $3
       AND current_generation IN ($2, $4)`,
    [
      input.workspaceId,
      transition.source_generation,
      input.organizationId,
      transition.candidate_generation,
    ],
  );
  await tx.query(
    `UPDATE cloud_workspace_lifecycle_intents
     SET state = 'superseded', completed_at = now(), updated_at = now(),
         error_code = 'generation_candidate_rejected',
         error_message = 'Generation candidate was rejected'
     WHERE workspace_id = $1 AND generation = $2 AND affects_workspace
       AND state IN ('queued', 'observing')`,
    [input.workspaceId, transition.candidate_generation],
  );
  // The source row already carries its immutable pins. The reconciler checks
  // those pins again before this wake; rollback never consults channel head.
  const wakeIntentId = await queueTransitionIntent(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.source_generation,
    transitionId: transition.id,
    operation: "wake",
    affectsWorkspace: true,
  });
  const cleanupIntentId = await queueTransitionIntent(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.candidate_generation,
    transitionId: transition.id,
    operation: "delete",
    affectsWorkspace: false,
    // Give recovery first claim without depending on transaction-stable
    // created_at ordering.
    delayMs: 1_000,
  });
  await audit(
    tx,
    input.organizationId,
    null,
    "cloud_workspace.generation_rollback_started",
    {
      workspaceId: input.workspaceId,
      transitionId: transition.id,
      sourceGeneration: transition.source_generation,
      candidateGeneration: transition.candidate_generation,
      wakeIntentId,
      cleanupIntentId,
      errorCode: input.errorCode,
    },
  );
  return true;
}

/** A replacement starts by stopping the source generation. Only a successful
 * provider stop (whose adapter revokes all SSH access first) may publish the
 * candidate create intent. */
export async function advanceCloudWorkspaceGenerationTransitionAfterDrain(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    sourceGeneration: number;
    transitionId: string;
  },
): Promise<boolean> {
  const selected = await tx.query<
    TransitionRow & { checkpoint_id: string }
  >(
    `SELECT gt.id, gt.source_generation, gt.candidate_generation, gt.state,
            checkpoint.id AS checkpoint_id
     FROM cloud_workspace_generation_transitions gt
     JOIN cloud_workspaces cw
       ON cw.id = gt.workspace_id AND cw.org_id = gt.org_id
     LEFT JOIN workspace_checkpoint_requests checkpoint_request
       ON checkpoint_request.lifecycle_intent_id = gt.drain_intent_id
      AND checkpoint_request.workspace_id = gt.workspace_id
      AND checkpoint_request.org_id = gt.org_id
      AND checkpoint_request.generation = gt.source_generation
      AND checkpoint_request.state = 'succeeded'
     JOIN cloud_workspace_generations candidate
       ON candidate.workspace_id = gt.workspace_id AND candidate.org_id = gt.org_id
      AND candidate.generation = gt.candidate_generation
     JOIN workspace_checkpoints checkpoint
       ON checkpoint.id = CASE WHEN candidate.recovery_checkpoint_id IS NOT NULL
         THEN candidate.recovery_checkpoint_id ELSE checkpoint_request.checkpoint_id END
      AND checkpoint.workspace_id = gt.workspace_id AND checkpoint.org_id = gt.org_id
      AND checkpoint.state = 'durable'
     WHERE gt.id = $1 AND gt.workspace_id = $2 AND gt.org_id = $3 AND gt.execution_mode='replace_allocation'
       AND gt.source_generation = $4 AND gt.state = 'draining'
       AND cw.current_generation = gt.source_generation
       AND cw.desired_state = 'running' AND cw.deleted_at IS NULL
     FOR UPDATE OF gt, cw`,
    [
      input.transitionId,
      input.workspaceId,
      input.organizationId,
      input.sourceGeneration,
    ],
  );
  const transition = selected.rows[0];
  if (!transition) return false;
  await retireCloudWorkspaceRuntimeAccess(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.source_generation,
    reason: "generation_replaced",
  });
  await tx.query(
    `UPDATE cloud_workspace_generations
     SET recovery_checkpoint_id = $4
     WHERE workspace_id = $1 AND generation = $2 AND org_id = $3`,
    [
      input.workspaceId,
      transition.candidate_generation,
      input.organizationId,
      transition.checkpoint_id,
    ],
  );
  await tx.query(
    `UPDATE cloud_workspaces
     SET current_generation = $2, status = 'provisioning',
         authority_epoch = authority_epoch + 1,
         version = version + 1, last_error_code = NULL,
         last_error_message = NULL, updated_at = now()
     WHERE id = $1 AND org_id = $3 AND current_generation = $4`,
    [
      input.workspaceId,
      transition.candidate_generation,
      input.organizationId,
      transition.source_generation,
    ],
  );
  const provisionIntentId = await queueTransitionIntent(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.candidate_generation,
    transitionId: transition.id,
    operation: "create",
    affectsWorkspace: true,
  });
  await tx.query(
    `UPDATE cloud_workspace_generation_transitions
     SET state = 'provisioning', provision_intent_id = $2,
         updated_at = now()
     WHERE id = $1 AND state = 'draining'`,
    [transition.id, provisionIntentId],
  );
  await audit(
    tx,
    input.organizationId,
    null,
    "cloud_workspace.generation_source_drained",
    {
      workspaceId: input.workspaceId,
      transitionId: transition.id,
      sourceGeneration: transition.source_generation,
      candidateGeneration: transition.candidate_generation,
      recoveryCheckpointId: transition.checkpoint_id,
      provisionIntentId,
    },
  );
  return true;
}

export async function rollbackCloudWorkspaceGenerationTransitionAfterDrainFailure(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    sourceGeneration: number;
    transitionId: string;
    errorCode: string;
    errorMessage: string;
  },
): Promise<boolean> {
  const selected = await tx.query<{ candidate_generation: number }>(
    `SELECT candidate_generation
     FROM cloud_workspace_generation_transitions
     WHERE id = $1 AND workspace_id = $2 AND org_id = $3
       AND source_generation = $4 AND state = 'draining'`,
    [
      input.transitionId,
      input.workspaceId,
      input.organizationId,
      input.sourceGeneration,
    ],
  );
  const candidate = selected.rows[0]?.candidate_generation;
  if (!candidate) return false;
  return rollbackCloudWorkspaceGenerationTransition(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    candidateGeneration: candidate,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  });
}

/** Mark a qualified candidate authoritative, or finish source recovery. */
export async function completeCloudWorkspaceGenerationTransition(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
  },
): Promise<"candidate_succeeded" | "rollback_succeeded" | null> {
  const selected = await tx.query<TransitionRow>(
    `SELECT id, source_generation, candidate_generation, state
     FROM cloud_workspace_generation_transitions
     WHERE workspace_id = $1 AND org_id = $2 AND execution_mode='replace_allocation'
       AND (
         (candidate_generation = $3 AND state IN ('provisioning', 'setting_up'))
         OR (source_generation = $3 AND state = 'rolling_back')
       )
     FOR UPDATE`,
    [input.workspaceId, input.organizationId, input.generation],
  );
  const transition = selected.rows[0];
  if (!transition) return null;

  if (transition.state === "rolling_back") {
    await tx.query(
      `UPDATE cloud_workspace_generation_transitions
       SET state = 'rolled_back', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [transition.id],
    );
    await audit(
      tx,
      input.organizationId,
      null,
      "cloud_workspace.generation_rolled_back",
      {
        workspaceId: input.workspaceId,
        transitionId: transition.id,
        sourceGeneration: transition.source_generation,
        candidateGeneration: transition.candidate_generation,
      },
    );
    return "rollback_succeeded";
  }

  await retireCloudWorkspaceRuntimeAccess(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.source_generation,
    reason: "generation_replaced",
  });
  await tx.query(
    `UPDATE cloud_workspace_generations
     SET retired_at = coalesce(retired_at, now())
     WHERE workspace_id = $1 AND generation = $2 AND org_id = $3`,
    [input.workspaceId, transition.source_generation, input.organizationId],
  );
  await tx.query(
    `UPDATE cloud_workspace_generation_transitions
     SET state = 'succeeded', completed_at = now(), updated_at = now(),
         error_code = NULL, error_message = NULL
     WHERE id = $1`,
    [transition.id],
  );
  await tx.query("UPDATE cloud_workspace_restore_incidents SET state='succeeded',updated_at=now() WHERE transition_id=$1",[transition.id]);
  const cleanupIntentId = await queueTransitionIntent(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.source_generation,
    transitionId: transition.id,
    operation: "delete",
    affectsWorkspace: false,
  });
  await audit(
    tx,
    input.organizationId,
    null,
    "cloud_workspace.generation_replaced",
    {
      workspaceId: input.workspaceId,
      transitionId: transition.id,
      sourceGeneration: transition.source_generation,
      candidateGeneration: transition.candidate_generation,
      cleanupIntentId,
    },
  );
  return "candidate_succeeded";
}

export async function failCloudWorkspaceGenerationRollback(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    sourceGeneration: number;
    errorCode: string;
    errorMessage: string;
  },
): Promise<boolean> {
  const failed = await tx.query<{ id: string; candidate_generation: number }>(
    `UPDATE cloud_workspace_generation_transitions
     SET state = 'rollback_failed', completed_at = now(), updated_at = now(),
         error_code = $4, error_message = $5
     WHERE workspace_id = $1 AND org_id = $2 AND execution_mode='replace_allocation' AND source_generation = $3
       AND state = 'rolling_back'
     RETURNING id, candidate_generation`,
    [
      input.workspaceId,
      input.organizationId,
      input.sourceGeneration,
      input.errorCode.slice(0, 128),
      input.errorMessage.slice(0, 2048),
    ],
  );
  const transition = failed.rows[0];
  if (!transition) return false;
  await audit(
    tx,
    input.organizationId,
    null,
    "cloud_workspace.generation_rollback_failed",
    {
      workspaceId: input.workspaceId,
      transitionId: transition.id,
      sourceGeneration: input.sourceGeneration,
      candidateGeneration: transition.candidate_generation,
      errorCode: input.errorCode,
    },
  );
  return true;
}

/**
 * Cancel an in-progress replacement before a user-requested stop/archive/delete.
 * The lifecycle route then applies that operation to the restored source while
 * this controller independently deletes the no-longer-authoritative candidate.
 */
export async function cancelCloudWorkspaceGenerationTransition(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    reason:
      | "workspace_stop_requested"
      | "workspace_archive_requested"
      | "workspace_delete_requested"
      | "paid_authority_revoked"
      | "provider_authority_revoked";
  },
): Promise<number | null> {
  const selected = await tx.query<
    TransitionRow & { current_generation: number }
  >(
    `SELECT gt.id, gt.source_generation, gt.candidate_generation, gt.state,gt.execution_mode,
            cw.current_generation
     FROM cloud_workspace_generation_transitions gt
     JOIN cloud_workspaces cw
       ON cw.id = gt.workspace_id AND cw.org_id = gt.org_id
     WHERE gt.workspace_id = $1 AND gt.org_id = $2
       AND gt.state IN ('draining', 'provisioning', 'setting_up', 'rolling_back')
     FOR UPDATE OF gt`,
    [input.workspaceId, input.organizationId],
  );
  const transition = selected.rows[0];
  if (!transition) return null;
  if (transition.execution_mode==='retain_allocation') {
    await retireCloudWorkspaceRuntimeAccess(tx,{...input,reason:input.reason});
    await tx.query(`UPDATE cloud_workspace_runtime_enrollments SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE transition_id=$1`,[transition.id]);
    await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE transition_id=$1`,[transition.id]);
    await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[transition.id]);
    return transition.current_generation;
  }

  await retireCloudWorkspaceRuntimeAccess(tx, {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: transition.candidate_generation,
    reason: input.reason,
  });
  await tx.query(
    `UPDATE cloud_workspace_generations
     SET retired_at = coalesce(retired_at, now())
     WHERE workspace_id = $1 AND generation = $2 AND org_id = $3`,
    [input.workspaceId, transition.candidate_generation, input.organizationId],
  );
  if (transition.current_generation === transition.candidate_generation) {
    await tx.query(
      `UPDATE cloud_workspaces
       SET current_generation = $2, authority_epoch = authority_epoch + 1,
           version = version + 1, updated_at = now()
       WHERE id = $1 AND org_id = $3 AND current_generation = $4`,
      [
        input.workspaceId,
        transition.source_generation,
        input.organizationId,
        transition.candidate_generation,
      ],
    );
  }
  await tx.query(
    `UPDATE cloud_workspace_generation_transitions
     SET state = 'cancelled', completed_at = now(), updated_at = now(),
         error_code = 'generation_transition_cancelled',
         error_message = 'Generation transition was cancelled by lifecycle request'
     WHERE id = $1`,
    [transition.id],
  );
  await tx.query(
    `UPDATE cloud_workspace_lifecycle_intents
     SET state = 'superseded', completed_at = now(), updated_at = now(),
         error_code = 'generation_transition_cancelled',
         error_message = 'Generation transition was cancelled by lifecycle request'
     WHERE workspace_id = $1 AND generation_transition_id = $2
       AND operation <> 'delete' AND state IN ('queued', 'observing')`,
    [input.workspaceId, transition.id],
  );
  const existingCleanup = await tx.query(
    `SELECT 1 FROM cloud_workspace_lifecycle_intents
     WHERE workspace_id = $1 AND generation = $2
       AND generation_transition_id = $3 AND operation = 'delete'
       AND NOT affects_workspace
       AND state IN ('queued', 'dispatching', 'observing', 'succeeded')`,
    [input.workspaceId, transition.candidate_generation, transition.id],
  );
  const cleanupIntentId =
    (existingCleanup.rowCount ?? 0) === 0
      ? await queueTransitionIntent(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: transition.candidate_generation,
          transitionId: transition.id,
          operation: "delete",
          affectsWorkspace: false,
        })
      : null;
  await audit(
    tx,
    input.organizationId,
    null,
    "cloud_workspace.generation_transition_cancelled",
    {
      workspaceId: input.workspaceId,
      transitionId: transition.id,
      sourceGeneration: transition.source_generation,
      candidateGeneration: transition.candidate_generation,
      cleanupIntentId,
      reason: input.reason,
    },
  );
  return transition.source_generation;
}
