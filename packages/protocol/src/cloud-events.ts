import { z } from "zod";
import type { BridgeMessage } from "./messages";
import type { InitializeResponse, QuestionRequest, RequestPermissionRequest } from "./agent-events";
import { CloudAgentBootIdentitySchema, CloudAgentCredentialRunInfoSchema, type CloudAgentBootScope } from "./cloud-agent-bootstrap";
import type { CloudLocalCommandHistorySource } from "./cloud-local-mirror";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stopReason = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "budget_exhausted", "blocking_limit", "prompt_too_long"]);
const usage = z.object({ accountingVersion: z.literal(1).optional(), revision: amount.int().optional(), costKind: z.enum(["estimated", "reported"]).optional(),
  inputTokens: amount.optional(), outputTokens: amount.optional(), cacheReadTokens: amount.optional(), cacheWriteTokens: amount.optional(),
  reasoningTokens: amount.optional(), totalCostUsd: amount.optional(), perModel: z.array(z.object({ model: z.string().min(1).max(256),
    inputTokens: amount.optional(), outputTokens: amount.optional(), cacheReadTokens: amount.optional(), cacheWriteTokens: amount.optional(), costUsd: amount.optional() }).strict()).max(32).optional() }).strict();
/** A durable terminal is always tied to its native turn. Receipt readers also
 * require commandId/executionId to match the accepting command. */
export const CloudTurnOutcomeSchema = z.object({
  commandId: z.uuid().optional(), conversationId: identity, executionId: identity.nullable(), turnId: identity, agentId: z.string().min(1).max(64),
  status: z.enum(["completed", "failed", "cancelled"]), stopReason: stopReason.nullable(), startedAt: amount.optional(), endedAt: amount.nullable().optional(),
  response: z.object({ stopReason: stopReason.optional(), usage: usage.optional(), effectiveModel: z.string().min(1).max(256).optional(), userMessageId: identity.optional() }).strict().optional(),
  error: z.string().max(8000).optional(), failure: z.object({
    kind: z.enum(["timeout", "auth-required", "verification-required", "cloud-credentials-unavailable", "subprocess-exited", "protocol-error", "transport-closed", "lifecycle-superseded", "rate-limited", "design-protection-failed", "session-expired"]),
    message: z.string().max(8000), agentId: z.string().max(64).optional(), advice: z.string().max(8000).optional(),
    stage: z.enum(["initialize", "newSession", "loadSession", "forkSession", "prompt", "cancel", "stopBackgroundTask", "setMode"]).optional(),
    exit: z.object({ code: z.number().int().safe().nullable(), signal: z.string().max(64).nullable(), stderrTail: z.string().max(8000) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type CloudTurnOutcome = z.infer<typeof CloudTurnOutcomeSchema>;
/** Only original native-use observations enter this presentation state.
 * The first-use cursor is immutable even when a later ACK/replay arrives. */
export const CloudAgentCredentialActualUseSchema = z.object({
  version: z.literal(1), scope: CloudAgentBootIdentitySchema, conversationId: identity, commandId: z.uuid(),
  turnId: identity, executionId: identity, credentialRun: CloudAgentCredentialRunInfoSchema,
  nativeStage: z.enum(["native_write", "sdk_run_created", "native_acceptance_ack"]),
  firstUseSequence: z.number().int().positive().safe(), eventSequence: z.number().int().positive().safe(),
}).strict().superRefine((value, context) => {
  const run = value.credentialRun;
  if (value.firstUseSequence > value.eventSequence || run.bootId !== value.scope.bootId || run.writerEpoch !== value.scope.writerEpoch ||
      run.fundingOwnerUserId !== value.scope.fundingOwnerUserId || run.fundingOwnerEpoch !== value.scope.fundingOwnerEpoch)
    context.addIssue({ code: "custom", message: "Cloud credential use ownership is inconsistent" });
});
export type CloudAgentCredentialActualUse = z.infer<typeof CloudAgentCredentialActualUseSchema>;
/** Structured current-head authority. The renderer validates its bounded
 * exact-page schema and the independently admitted live boot before use. */
export interface CloudAgentHistoryRestoreMetadata {
  projection: CloudAgentBootScope & { version: 1; mode: "boot-owner-v1"; fundingScope: "workspace-roles-v1";
    mirroredSequence: number; sealedSequence: number | null; complete: boolean };
  historyHeads: Array<{ conversationId: string; originWriterEpoch: string; source: CloudLocalCommandHistorySource;
    restoreRevision: number; deleted: boolean; recordSequence: number | null; eventSequence: number | null;
    manifestSha256: string | null; incompleteReason: "capture_unavailable" | "capture_conflict" | "history_limit" | "recovery_uncertain" | null }>;
}
export interface CloudConversationSnapshot {
  version: 1;
  conversationId: string;
  agentId: string;
  executionId: string | null;
  session: Record<string, unknown> | null;
  initialize: InitializeResponse | null;
  messages: Array<{ msgId: string; kind: string; payload: string; createdAt: number }>;
  activeTurn: { turnId: string; startedAt: number } | null;
  latestTurn?: CloudTurnOutcome | null;
  cloudCredentialUses?: CloudAgentCredentialActualUse[];
  historyRestore?: CloudAgentHistoryRestoreMetadata;
  permissions: Array<{ permissionId: string; agentId: string; request: RequestPermissionRequest }>;
  questions: Array<{ questionId: string; agentId: string; request: QuestionRequest }>;
}

export const CLOUD_REPLAY_EVENT_TYPES = new Set([
  "AGENT_SESSION_UPDATE", "AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED",
  "AGENT_QUESTION_REQUEST", "AGENT_QUESTION_SETTLED", "AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED", "DB_CHANGED",
  "CLOUD_AGENT_CREDENTIAL_USED",
]);
const sequence = z.number().int().safe().nonnegative();
export const CloudEventCursorSchema = z.object({ streamId: z.uuid(), sequence }).strict();
export const CloudEventClientRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), conversationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
  z.object({ kind: z.literal("replay"), cursor: CloudEventCursorSchema }).strict(),
]);
export type CloudEventCursor = z.infer<typeof CloudEventCursorSchema>;
export type CloudStreamEvent = { sequence: number; frame: BridgeMessage };
export type CloudEventEngineRequest =
  { kind: "append"; batchId: string; events: CloudStreamEvent[] } |
  { kind: "replay"; streamId: string; after: number };
export const CloudEventAppendResultSchema = z.object({ streamId: z.uuid(), head: sequence, replayed: z.boolean() }).strict();
export const CloudEventReplayResultSchema = z.object({ streamId: z.uuid(), head: sequence, firstRetained: sequence,
  cursor: sequence, events: z.array(z.object({ sequence, frame: z.record(z.string(), z.unknown()) }).strict()).max(128) }).strict();

// New-mode CP history retains interaction controls, while deltas/replay stay in
// the VM. Preserve the native request/settlement envelopes; this schema grants
// no resolver, actor or execution authority. The engine supplies those owners.
const controlText = z.string().max(256 * 1024);
const controlId = z.string().min(1).max(8192);
const controlIdentity = z.string().min(1).max(128);
// z.json() rebuilds objects and drops the inert own key "__proto__". Compact
// history must retain the exact verified JSON value instead of changing bytes.
const compactJson = z.custom<z.infer<ReturnType<typeof z.json>>>(input => {
  const pending = [{ value: input, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 20_000 || item.depth > 32) return false;
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue;
    if (typeof item.value === "number") { if (!Number.isFinite(item.value)) return false; continue; }
    if (!item.value || typeof item.value !== "object" || !Array.isArray(item.value) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item.value))) return false;
    if (Array.isArray(item.value) && Object.keys(item.value).length !== item.value.length) return false;
    const keys = Object.keys(item.value), declared = new Set(keys), descriptors = Object.getOwnPropertyDescriptors(item.value);
    if (pending.length + nodes + keys.length > 20_000 || Reflect.ownKeys(item.value).some(key => typeof key !== "string" ||
        !(Array.isArray(item.value) && key === "length") && !declared.has(key))) return false;
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (!Object.hasOwn(descriptor, "value")) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return true;
});
const permissionKind = z.enum(["allow_once", "allow_always", "allow_always_project", "reject_once", "reject_always"]);
const compactTool = z.object({
  toolCallId: controlIdentity, title: controlText, nativeToolCallId: controlId.nullable().optional(),
  kind: z.enum(["read", "edit", "delete", "move", "search", "list", "web_search", "execute", "think", "fetch", "switch_mode",
    "subagent", "task", "mcp", "question", "skill", "tool_search", "task_create", "task_update", "background_task", "compaction",
    "model_switch", "budget_stop", "other"]).nullable().optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).nullable().optional(),
  content: z.array(compactJson).max(128).nullable().optional(),
  locations: z.array(z.object({ path: controlText, line: amount.optional() }).strict()).max(128).nullable().optional(),
  rawInput: compactJson.optional(), rawOutput: compactJson.optional(), mergeKey: controlId.nullable().optional(),
  parentToolId: controlId.nullable().optional(), at: amount.nullable().optional(),
}).strict();
const compactPermission = z.object({
  sessionId: controlIdentity, executionId: controlIdentity.optional(), toolCall: compactTool,
  options: z.array(z.object({ optionId: controlId, name: controlText, kind: permissionKind }).strict()).min(1).max(128),
  autoResolution: permissionKind.optional(), title: controlText.optional(), contextItems: z.array(controlText).max(128).optional(),
  useOptionNames: z.boolean().optional(), allowLocalPolicies: z.boolean().optional(), requiresExplicitApproval: z.boolean().optional(),
  nativeRequestId: controlId.optional(),
}).strict();
const compactQuestionOption = z.object({
  id: controlId, label: controlText, description: controlText.optional(), preview: controlText.optional(), exclusive: z.boolean().optional(),
  externalAction: z.object({ kind: z.literal("open-url"), url: controlId }).strict().optional(),
}).strict();
const compactQuestion = z.object({
  sessionId: controlIdentity, executionId: controlIdentity.optional(), questionId: controlIdentity, nativeRequestId: controlId,
  toolCallId: controlId.optional(), source: z.enum(["native_dialog", "native_rpc", "inferred_from_text"]), blocking: z.boolean(),
  allowDecline: z.boolean().optional(), expiresAt: amount.optional(),
  questions: z.array(z.object({
    id: controlId, prompt: controlText, header: controlText.optional(), multiSelect: z.boolean().optional(),
    options: z.array(compactQuestionOption).max(128), allowOther: z.boolean(), defaultOptionIds: z.array(controlId).max(128).optional(),
    defaultFreeText: controlText.optional(), allowEmptyFreeText: z.boolean().optional(), preserveFreeText: z.boolean().optional(),
    secret: z.boolean().optional(), presentation: z.literal("one_click_approval").optional(), approvalPrompt: controlText.optional(),
    approvalKind: z.enum(["browser_origin", "tool"]).optional(), approvalTarget: controlId.optional(),
  }).strict()).min(1).max(128),
}).strict();
const compactQuestionOutcome = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("answered"), answers: z.array(z.object({ questionId: controlId,
    selectedOptionIds: z.array(controlId).max(128), freeText: controlText.optional() }).strict()).max(128) }).strict(),
  z.object({ outcome: z.literal("declined") }).strict(), z.object({ outcome: z.literal("dismissed") }).strict(),
]);
const compactBase = { id: controlIdentity, timestamp: z.number().finite(), source: z.literal("engine"), agentId: z.string().min(1).max(64),
  chatId: identity.optional(), cloudStream: CloudEventCursorSchema.extend({ sequence: sequence.positive(), requiresSnapshot: z.literal(true).optional() }).optional() };
const compactFrame = z.discriminatedUnion("type", [
  z.object({ ...compactBase, type: z.literal("AGENT_PERMISSION_REQUEST"), permissionId: controlIdentity, request: compactPermission }).strict(),
  z.object({ ...compactBase, type: z.literal("AGENT_PERMISSION_SETTLED"), permissionId: controlIdentity,
    sessionId: controlIdentity, executionId: controlIdentity.optional() }).strict(),
  z.object({ ...compactBase, type: z.literal("AGENT_QUESTION_REQUEST"), questionId: controlIdentity, request: compactQuestion }).strict(),
  z.object({ ...compactBase, type: z.literal("AGENT_QUESTION_SETTLED"), questionId: controlIdentity, outcome: compactQuestionOutcome }).strict(),
]);
export const CloudCompactControlFrameSchema = z.preprocess((value, context) => {
  // Bound complexity before recursive JSON parsing. Native/tool data is still
  // untrusted; invalid/oversized controls require an explicit failure/snapshot.
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 20_000 || current.depth > 32) {
      context.addIssue({ code: "custom", message: "Compact control is too complex" }); return z.NEVER;
    }
    if (current.value && typeof current.value === "object") {
      if (!Array.isArray(current.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))) {
        context.addIssue({ code: "custom", message: "Compact control is not JSON" }); return z.NEVER;
      }
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    } else if (typeof current.value === "function" || typeof current.value === "symbol" || typeof current.value === "bigint") {
      context.addIssue({ code: "custom", message: "Compact control is not JSON" }); return z.NEVER;
    }
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      context.addIssue({ code: "custom", message: "Compact control exceeds byte limit" }); return z.NEVER;
    }
  } catch { context.addIssue({ code: "custom", message: "Compact control is not JSON" }); return z.NEVER; }
  return value;
}, compactFrame);
export type CloudCompactControlFrame = z.infer<typeof CloudCompactControlFrameSchema>;

/** Explicit opt-in inspection only. Stage producers own the command mapping
 * and sample one engine monotonic clock; native callbacks supply no metadata. */
export const CloudNativePromptStageSchema = z.enum(["native_write", "native_acceptance_ack", "sdk_run_created"]);
export type CloudNativePromptStage = z.infer<typeof CloudNativePromptStageSchema>;
export const CloudAgentTurnDependencySchema = z.enum([
  "commands.mutate", "commands.claim", "credentials.admit", "credentials.validate", "records.settle_barrier",
]);
export type CloudAgentTurnDependency = z.infer<typeof CloudAgentTurnDependencySchema>;
const timingRecord = z.object({
  sequence: sequence.positive(), commandId: z.uuid(), conversationId: identity, turnId: identity,
  executionId: identity.nullable(), provider: z.enum(["claude", "codex", "cursor"]),
  stage: z.enum(["engine_received", "accepted", "dispatch_committed", "native_write", "native_acceptance_ack", "sdk_run_created",
    "first_delta", "typed_auth_failure", "terminal_committed", "cp_request_started", "cp_request_finished"]),
  atMs: amount, dependency: CloudAgentTurnDependencySchema.optional(), outputKind: z.enum(["text", "tool"]).optional(),
}).strict().superRefine((value, context) => {
  const cp = value.stage === "cp_request_started" || value.stage === "cp_request_finished";
  if (cp !== (value.dependency !== undefined))
    context.addIssue({ code: "custom", message: "Turn dependency stage is inconsistent" });
  if (value.outputKind !== undefined && value.stage !== "first_delta")
    context.addIssue({ code: "custom", message: "Native output classification requires a first output stage" });
});
export type CloudAgentTurnTimingRecord = z.infer<typeof timingRecord>;
export const CloudAgentTurnTimingsSchema = z.object({
  version: z.literal(1), organizationId: z.uuid(), workspaceId: z.uuid(), generation: sequence.positive(), engineInstanceId: z.uuid(),
  conversationId: identity, mode: z.enum(["legacy", "boot-owner-v1"]), bootId: z.uuid().nullable(), writerEpoch: z.uuid().nullable(),
  clockId: z.uuid(), sampledAtMs: amount,
  coverage: z.object({ truncated: z.boolean(), retired: z.boolean(), unknown: z.boolean() }).strict(),
  records: z.array(timingRecord).max(32),
}).strict().superRefine((value, context) => {
  if (value.mode === "legacy" ? value.bootId !== null || value.writerEpoch !== null : value.bootId === null || value.writerEpoch === null)
    context.addIssue({ code: "custom", message: "Turn timing boot binding is inconsistent" });
  if (value.records.some((row, index) => row.conversationId !== value.conversationId || row.atMs > value.sampledAtMs ||
      index > 0 && row.sequence <= value.records[index - 1]!.sequence))
    context.addIssue({ code: "custom", message: "Turn timing record ownership or cursor is inconsistent" });
});
export type CloudAgentTurnTimingsPacket = z.infer<typeof CloudAgentTurnTimingsSchema>;

export const CLOUD_AGENT_TURN_ORIGIN_HEADER = "x-zeros-agent-turn-origin";
export const CLOUD_AGENT_TURN_ORIGIN_MAX_BYTES = 2048;
export const CloudAgentTurnRequestOperationSchema = z.enum([
  "commands.mutate", "commands.snapshot", "commands.read", "commands.conversation", "commands.claim", "commands.stop",
  "commands.settle", "commands.confirm-goal", "commands.mirror", "credentials.admit", "credentials.validate",
  "credentials.refresh-codex", "actors.confirm", "actors.renew", "boot.credentials", "boot.refresh", "boot.activate",
  "events.append", "events.replay", "records.sync", "controls.exchange",
]);
export type CloudAgentTurnRequestOperation = z.infer<typeof CloudAgentTurnRequestOperationSchema>;
export const CloudAgentTurnRequestIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), commandId: z.uuid(), conversationId: identity, turnId: identity,
    executionId: identity.nullable() }).strict(),
  // The actual claim ID is unknown until its validated CP response. It cannot
  // stand in for a guessed next command or confer execution authority.
  z.object({ kind: z.literal("claim"), claimId: z.uuid().nullable(), conversationId: identity, executionId: identity }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type CloudAgentTurnRequestIntent = z.infer<typeof CloudAgentTurnRequestIntentSchema>;
/** This metadata never authenticates a request. A CP service annotates it only
 * after independently proving current engine scope and the actual operation
 * and intent. Producer provenance is separate from per-turn wait dependencies. */
export const CloudAgentTurnRequestOriginSchema = z.object({
  version: z.literal(1), organizationId: z.uuid(), workspaceId: z.uuid(), generation: sequence.positive(), engineInstanceId: z.uuid(),
  mode: z.enum(["legacy", "boot-owner-v1"]), bootId: z.uuid().nullable(), writerEpoch: z.uuid().nullable(),
  clockId: z.uuid(), spanId: z.uuid(), flightId: z.uuid().nullable(), producer: z.enum(["foreground", "background", "unknown"]),
  operation: CloudAgentTurnRequestOperationSchema, intent: CloudAgentTurnRequestIntentSchema,
}).strict().superRefine((value, context) => {
  if (value.mode === "legacy" ? value.bootId !== null || value.writerEpoch !== null : value.bootId === null || value.writerEpoch === null)
    context.addIssue({ code: "custom", message: "Engine request origin boot binding is inconsistent" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CLOUD_AGENT_TURN_ORIGIN_MAX_BYTES)
    context.addIssue({ code: "custom", message: "Engine request origin exceeds byte limit" });
});
export type CloudAgentTurnRequestOrigin = z.infer<typeof CloudAgentTurnRequestOriginSchema>;
export function encodeCloudAgentTurnRequestOrigin(value: CloudAgentTurnRequestOrigin): string {
  return JSON.stringify(CloudAgentTurnRequestOriginSchema.parse(value));
}
export function parseCloudAgentTurnRequestOriginHeader(raw: string | undefined): CloudAgentTurnRequestOrigin | null {
  if (!raw || new TextEncoder().encode(raw).byteLength > CLOUD_AGENT_TURN_ORIGIN_MAX_BYTES) return null;
  try {
    const value = CloudAgentTurnRequestOriginSchema.parse(JSON.parse(raw));
    return encodeCloudAgentTurnRequestOrigin(value) === raw ? value : null;
  } catch { return null; }
}
