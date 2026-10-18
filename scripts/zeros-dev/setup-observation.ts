import { z } from "zod";
import { setupErrorCodes, setupEvidenceSchema } from "../../packages/protocol/src/cloud-setup-evidence";

// The CLI never forwards arbitrary server diagnostic strings, even when the
// server promises redaction. New codes remain unknown until reviewed here.
const SetupErrorSchema = z.enum(setupErrorCodes);
export const SetupObservationSchema = z.object({
  attempt: z.number().int().positive().safe(), claimCount: z.number().int().nonnegative().safe(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  errorCode: SetupErrorSchema.nullable(),
  evidence: setupEvidenceSchema.optional(),
}).strict();
export type SetupObservation = z.infer<typeof SetupObservationSchema>;

const ProgressSchema = SetupObservationSchema.extend({
  generation: z.number().int().positive().safe(), errorCode: z.unknown(),
});
export function readSetupProgress(value: unknown, generation: number, rawEvidence?: unknown, workspaceId?: string): SetupObservation | undefined {
  const parsed = ProgressSchema.safeParse(value);
  if (!parsed.success || parsed.data.generation !== generation) return undefined;
  const { attempt, claimCount, state, errorCode } = parsed.data;
  const evidence = setupEvidenceSchema.safeParse(rawEvidence);
  const bound = evidence.success && evidence.data.workspaceId === workspaceId && evidence.data.generation === generation &&
    evidence.data.attempt === attempt && evidence.data.claimCount === claimCount && evidence.data.state === state ? evidence.data : undefined;
  return { attempt, claimCount, state,
    errorCode: errorCode === null ? null : SetupErrorSchema.safeParse(errorCode).data ?? "unknown",
    ...(bound ? { evidence: bound } : {}) };
}
