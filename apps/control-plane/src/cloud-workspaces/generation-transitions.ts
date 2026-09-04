import { createHash, randomUUID } from "node:crypto";

import { audit } from "../audit.js";
import type { Tx } from "../db.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

type TransitionRow = {
  id: string;
  source_generation: number;
  candidate_generation: number;
  state: "draining" | "provisioning" | "setting_up" | "rolling_back";
};

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

async function queueTransitionIntent(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    transitionId: string;
    operation: "create" | "wake" | "delete";
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
    `SELECT gt.id, gt.source_generation, gt.candidate_generation, gt.state
     FROM cloud_workspace_generation_transitions gt
     JOIN cloud_workspaces cw
       ON cw.id = gt.workspace_id AND cw.org_id = gt.org_id
     WHERE gt.workspace_id = $1 AND gt.org_id = $2
       AND gt.candidate_generation = $3
       AND gt.state IN ('draining', 'provisioning', 'setting_up')
       AND cw.current_generation IN (gt.source_generation, gt.candidate_generation)
       AND cw.desired_state = 'running' AND cw.deleted_at IS NULL
     FOR UPDATE OF gt, cw`,
    [input.workspaceId, input.organizationId, input.candidateGeneration],
  );
  const transition = selected.rows[0];
  if (!transition) return false;

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
            checkpoint_request.checkpoint_id
     FROM cloud_workspace_generation_transitions gt
     JOIN cloud_workspaces cw
       ON cw.id = gt.workspace_id AND cw.org_id = gt.org_id
     JOIN workspace_checkpoint_requests checkpoint_request
       ON checkpoint_request.lifecycle_intent_id = gt.drain_intent_id
      AND checkpoint_request.workspace_id = gt.workspace_id
      AND checkpoint_request.org_id = gt.org_id
      AND checkpoint_request.generation = gt.source_generation
      AND checkpoint_request.state = 'succeeded'
     WHERE gt.id = $1 AND gt.workspace_id = $2 AND gt.org_id = $3
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
     WHERE workspace_id = $1 AND org_id = $2
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
     WHERE workspace_id = $1 AND org_id = $2 AND source_generation = $3
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
    `SELECT gt.id, gt.source_generation, gt.candidate_generation, gt.state,
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
