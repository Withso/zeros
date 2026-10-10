import { z } from "zod";

const sequence = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const CloudFinalCheckpointReceiptSchema = z.object({
  scope: z.object({ organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
    generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid() }).strict(),
  checkpoint: z.object({ requestId: z.string().uuid(), checkpointId: z.string().uuid(),
    contentRevision: sequence, manifestSha256: sha256,
    reason: z.enum(["before_stop", "before_archive", "before_delete", "before_rebuild"]) }).strict(),
}).strict();
export type CloudFinalCheckpointReceipt = z.infer<typeof CloudFinalCheckpointReceiptSchema>;

export const CloudEngineFinalCompletionSchema = CloudFinalCheckpointReceiptSchema.extend({
  version: z.literal(1), challenge: z.string().uuid(), phase: z.literal("committed"),
  mode: z.enum(["legacy", "boot-owner-v1"]),
  seal: z.object({ writerEpoch: z.string().uuid(), sealId: z.string().uuid(), sha256,
    inventorySha256: sha256, sequence, recordSequence: sequence, eventSequence: sequence }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.mode === "legacy") !== (value.seal === null))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["seal"], message: "final journal seal does not match mode" });
});
export type CloudEngineFinalCompletion = z.infer<typeof CloudEngineFinalCompletionSchema>;
export const MAX_CLOUD_FINAL_COMPLETION_BYTES = 4096;
