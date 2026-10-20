// Standalone Zod 3 command receipt contracts. Keep this module independent of
// services: checkpoint history must initialize from any server entry point.
// Existing command and checkpoint parity suites bind these to the shared wire.
import { z } from "zod";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().safe().nonnegative();
const uuid = z.string().uuid();
export const CloudGoalUpdateSchema = z.object({
  objective: z.string().trim().min(1).max(32_768).optional(),
  status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).optional(),
  tokenBudget: z.number().int().safe().positive().nullable().optional(),
  /** Provider boundary only; a portable command cannot assert provenance. */
  origin: z.literal("user").optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== "origin"));
export const CloudNativeOperationSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("fork"), sourceConversationId: identity,
    strategy: z.enum(["native", "transcript"]) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("goal"), action: z.enum(["get", "set", "clear"]),
    update: CloudGoalUpdateSchema.refine(value => value.origin === undefined).optional() }).strict(),
]).refine(value => value.kind !== "goal" || (value.action === "set") === (value.update !== undefined));
// Standalone Zod 3 mirror of protocol/cloud-events CloudTurnOutcomeSchema.
// command-failure.test.ts verifies accept/reject and terminal-field parity.
const terminalAmount=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const terminalStopReason=z.enum(["end_turn","max_tokens","max_turn_requests","refusal","cancelled","budget_exhausted","blocking_limit","prompt_too_long"]);
const terminalUsage=z.object({accountingVersion:z.literal(1).optional(),revision:terminalAmount.int().optional(),costKind:z.enum(["estimated","reported"]).optional(),
  inputTokens:terminalAmount.optional(),outputTokens:terminalAmount.optional(),cacheReadTokens:terminalAmount.optional(),cacheWriteTokens:terminalAmount.optional(),
  reasoningTokens:terminalAmount.optional(),totalCostUsd:terminalAmount.optional(),perModel:z.array(z.object({model:z.string().min(1).max(256),
    inputTokens:terminalAmount.optional(),outputTokens:terminalAmount.optional(),cacheReadTokens:terminalAmount.optional(),cacheWriteTokens:terminalAmount.optional(),costUsd:terminalAmount.optional()}).strict()).max(32).optional()}).strict();
const cloudTurnOutcome=z.object({commandId:uuid.optional(),conversationId:identity,executionId:identity.nullable(),turnId:identity,agentId:z.string().min(1).max(64),
  status:z.enum(["completed","failed","cancelled"]),stopReason:terminalStopReason.nullable(),startedAt:terminalAmount.optional(),endedAt:terminalAmount.nullable().optional(),
  response:z.object({stopReason:terminalStopReason.optional(),usage:terminalUsage.optional(),effectiveModel:z.string().min(1).max(256).optional(),userMessageId:identity.optional()}).strict().optional(),
  error:z.string().max(8000).optional(),failure:z.object({
    kind:z.enum(["timeout","auth-required","verification-required","cloud-credentials-unavailable","subprocess-exited","protocol-error","transport-closed","lifecycle-superseded","rate-limited","design-protection-failed","session-expired"]),
    message:z.string().max(8000),agentId:z.string().max(64).optional(),advice:z.string().max(8000).optional(),
    stage:z.enum(["initialize","newSession","loadSession","forkSession","prompt","cancel","stopBackgroundTask","setMode"]).optional(),
    exit:z.object({code:z.number().int().safe().nullable(),signal:z.string().max(64).nullable(),stderrTail:z.string().max(8000)}).strict().optional(),
  }).strict().optional()}).strict();
export const CloudNativeResultSchema = z.object({ version: z.literal(1),
  terminal:cloudTurnOutcome.optional(),
  capabilities: z.object({version:z.literal(1),goals:z.boolean(),nativeFork:z.boolean(),transcriptFork:z.boolean(),
    nativeReview:z.boolean(),connectedApps:z.boolean(),multiAgent:z.boolean()}).strict().optional(),model:z.string().min(1).max(256).optional(),
  goal: z.object({ objective: z.string().max(32_768),
    status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
    tokenBudget: z.number().int().safe().nonnegative().nullable(), tokensUsed: revision,
    timeUsedSeconds: z.number().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
  }).strict().nullable().optional(),
}).strict();
// Standalone deployment mirror of the narrow shared preference contract.
export const CloudClaudePreferencesSchema = z.object({
  autoMemoryEnabled: z.boolean(), idleCompactionEnabled: z.boolean(),
}).strict();
// Standalone mirrors for the explicitly negotiated engine-local writer. These
// parsers grant no authority and do not alter the legacy admitted queue above.
const permissionModes: Record<string, readonly string[]> = {
  claude: ["default", "accept-edits", "plan", "auto", "bypass"],
  codex: ["ask", "auto-edit", "full-access", "read-only"], cursor: ["plan", "auto", "agent"],
};
export const CloudBootCommandPayloadSchema = z.object({
  agentId: z.enum(["claude", "cursor", "codex"]), userMessageId: identity,
  prompt: z.array(z.record(z.unknown())).min(1).max(128), bubble: z.record(z.unknown()).optional(),
  modeRevision: revision, permissionMode: z.string().min(1).max(32).optional(),
  model: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/),
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultracode"]).optional(),
  fast: z.boolean().optional(), claudePreferences: CloudClaudePreferencesSchema.optional(),
  operation: CloudNativeOperationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.claudePreferences && value.agentId !== "claude")
    context.addIssue({ code: "custom", message: "Claude preferences require the Claude provider" });
  if (value.permissionMode !== undefined && !permissionModes[value.agentId]?.includes(value.permissionMode))
    context.addIssue({ code: "custom", message: "Invalid provider permission mode" });
  if (value.operation && ((value.operation.kind !== "fork" && value.agentId !== "codex") ||
      (value.operation.kind === "fork" && value.operation.strategy === "native" && value.agentId !== "codex")))
    context.addIssue({ code: "custom", message: "Native operation requires an explicit qualified provider" });
});
export const CloudBootCommandEntrySchema = z.object({
  commandId: uuid, position: revision, state: z.enum(["queued", "dispatching", "succeeded", "failed", "cancelled", "uncertain"]),
  payload: CloudBootCommandPayloadSchema.nullable(), executionId: identity.nullable(), generation: revision,
  resultCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), result: CloudNativeResultSchema.nullable().optional(),
}).strict();
export const CloudBootCommandSnapshotSchema = z.object({
  version: z.literal(1), conversationId: identity, revision, paused: z.boolean(),
  pending: z.array(CloudBootCommandEntrySchema).max(32), receipts: z.array(CloudBootCommandEntrySchema).max(50),
  replayed: z.boolean().optional(), nativeGoal: z.object({ version: z.literal(1), conversationId: identity, revision,
    goal: CloudNativeResultSchema.shape.goal.unwrap() }).strict().optional(),
}).strict();
export type CloudBootCommandPayload = z.infer<typeof CloudBootCommandPayloadSchema>;
export type CloudBootCommandEntry = z.infer<typeof CloudBootCommandEntrySchema>;
export type CloudBootCommandSnapshot = z.infer<typeof CloudBootCommandSnapshotSchema>;
