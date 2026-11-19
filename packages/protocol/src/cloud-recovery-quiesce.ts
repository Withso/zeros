import { z } from "zod";

// Prompt-free pull replies let workers fence and flush when the live route fails; only a matching cancellation reply releases the fence.
export const CLOUD_RECOVERY_QUIESCE_FEATURE = "recovery-quiesce-v1";
export const CLOUD_RECOVERY_BINDING_CHANGED = "recovery_binding_changed";

const id = z.string().uuid();
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CloudRecoveryHintSchema = z.object({ id }).strict();
export type CloudRecoveryHint = z.infer<typeof CloudRecoveryHintSchema>;
export const CloudRecoveryRequestSchema = z.object({ op: z.enum(["seal", "status"]), id, generation }).strict();
export type CloudRecoveryRequest = z.infer<typeof CloudRecoveryRequestSchema>;
export const CloudRecoveryReplySchema = z.object({ id, generation, status: z.enum(["pending", "sealed", "cancelled"]) }).strict();
export type CloudRecoveryReply = z.infer<typeof CloudRecoveryReplySchema>;
