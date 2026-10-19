import { z } from "zod";

const sequence = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CompleteCheckpointSourceSchema = z.object({
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(),
  writerEpoch: z.string().uuid(), scopeRevision: z.number().int().positive().safe(),
  scopeSha256: digest, changeSequence: sequence, reconcileSequence: sequence,
}).strict();
export type CompleteCheckpointSource = z.infer<typeof CompleteCheckpointSourceSchema>;

export const CompleteCheckpointAttemptSchema = z.object({
  id: z.string().uuid(), source: CompleteCheckpointSourceSchema, startedAtMs: sequence, deadlineAtMs: sequence,
}).strict().refine(value => value.deadlineAtMs > value.startedAtMs);
export type CompleteCheckpointAttempt = z.infer<typeof CompleteCheckpointAttemptSchema>;

export const CompleteCheckpointReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal("complete-periodic"), attemptId: z.string().uuid(),
  source: CompleteCheckpointSourceSchema, manifestSha256: digest, inventorySha256: digest, nativeExportSha256: digest,
  cutAtMs: sequence, ackAtMs: sequence,
}).strict().refine(value => value.cutAtMs <= value.ackAtMs);
export type CompleteCheckpointReceipt = z.infer<typeof CompleteCheckpointReceiptSchema>;

export const CompleteCheckpointJournalStateSchema = z.object({
  version: z.literal(1), source: CompleteCheckpointSourceSchema, pending: CompleteCheckpointAttemptSchema.nullable(),
  lastComplete: CompleteCheckpointReceiptSchema.nullable(), lastStartedAtMs: sequence.nullable(), retryAtMs: sequence.nullable(),
}).strict();
export type CompleteCheckpointJournalState = z.infer<typeof CompleteCheckpointJournalStateSchema>;
export const CompleteCheckpointJournalReadSchema = z.object({
  revision: sequence, state: CompleteCheckpointJournalStateSchema.nullable(),
}).strict();

/** An adapter is never rebound across owners, generations, writers or scope
 * revisions. Change counters advance within this identity only. */
export const completeCheckpointScopeKey = (source: CompleteCheckpointSource): string => JSON.stringify([
  source.organizationId, source.workspaceId, source.generation, source.engineInstanceId,
  source.writerEpoch, source.scopeRevision, source.scopeSha256,
]);
export const sameCompleteCheckpointSource = (a: CompleteCheckpointSource, b: CompleteCheckpointSource): boolean =>
  completeCheckpointScopeKey(a) === completeCheckpointScopeKey(b)
  && a.changeSequence === b.changeSequence && a.reconcileSequence === b.reconcileSequence;
