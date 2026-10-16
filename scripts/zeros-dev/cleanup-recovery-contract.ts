import { z } from "zod";

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CleanupRecoveryExecutionSchema = z.object({ workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  attempt: z.number().int().min(1).max(100), sourceSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict();

/** Separate custody for an explicitly approved operator DELETE. The failed
 * lifecycle entry and the original signed Actions artifact remain unchanged.
 * This reference is neither product authority nor a current retirement proof. */
export const CleanupRecoveryReferenceSchema = z.object({ version: z.literal(1), sha256: digest,
  sourceArtifactSha256: digest, sourceRunSha256: digest, sourceExecution: CleanupRecoveryExecutionSchema,
  runId: uuid, workspaceId: uuid, generation: z.number().int().positive().safe(),
  failedDeleteKey: uuid, approvalId: uuid }).strict();
export type CleanupRecoveryReference = z.infer<typeof CleanupRecoveryReferenceSchema>;

export function recoveryDeleteKey(reference: Pick<CleanupRecoveryReference, "approvalId" | "workspaceId">): string {
  return `operator-delete:${reference.approvalId}:${reference.workspaceId}`;
}

type RecoveryRun = {
  runId: string; source: { revision: string | null; dirty: boolean }; cleanupOnly?: unknown;
  create?: { result?: { id: string; generation: number } };
  lifecycle: { operation: string; key: string; generation: number; confirmed: boolean; settled?: unknown }[];
  hourly?: { workflowRunId: string; attempt: number; sourceSha: string };
};
export function recoveryMatchesRun(run: RecoveryRun, reference: CleanupRecoveryReference): boolean {
  const last = run.lifecycle.at(-1), source = reference.sourceExecution;
  return !run.cleanupOnly && run.runId === reference.runId && run.create?.result?.id === reference.workspaceId &&
    run.create.result.generation === reference.generation && last?.operation === "delete" &&
    last.key === reference.failedDeleteKey && last.generation === reference.generation && !last.confirmed && !last.settled &&
    !run.source.dirty && run.source.revision === source.sourceSha && run.hourly?.sourceSha === source.sourceSha &&
    run.hourly.workflowRunId === source.workflowRunId && run.hourly.attempt === source.attempt;
}
