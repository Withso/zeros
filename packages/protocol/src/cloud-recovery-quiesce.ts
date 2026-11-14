import { z } from "zod";

// recovery-quiesce-v1: before a fresh-checkpoint replacement, the control plane asks a worker whose live route is broken
// to fence and flush over its outbound path. The hint rides the prompts/pull reply (with no prompts); the worker answers
// on POST /v2/cloud/worker/recovery. Only an explicit matching `cancelled` reply releases a frozen worker.
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
