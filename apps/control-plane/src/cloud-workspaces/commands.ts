import { isCloudAgentAdmissionCode } from "./agent-admission-errors.js";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { assertCurrentCloudEngineAuthority, assertCloudEngineAuthorityDeadline } from "./engine-authority.js";
import { CloudActorProvenanceSchema, CloudAgentCredentialRunInfoSchema, CloudAgentBootScopeSchema } from "./agent-boot-contract.js";
import { CloudCompactControlEventSchema } from "./event-streams.js";
import { canonicalCloudHistoryJson as canonicalCloudLocalCommandHistoryJson, CloudLocalHistoryPartSchema as CloudLocalCommandHistoryPartSchema,
  CloudLocalHistoryWatermarkSchema as CloudLocalCommandHistorySchema, CloudMirroredHistoryHeadSchema as CloudLocalCommandHistoryHeadSchema } from "./history-local-contract.js";
import { HttpError } from "../authz.js";
import { assertCloudRequestActor, assertRecordedCloudActor, type CloudRecordedActor } from "./actor-sessions.js";
import { isAutomaticRuntimeWakeGeneration } from "./generation-transitions.js";
import { cloudRuntimeHandoffBlocksClaims, isAutomaticRetainedRuntimeEngine } from "./runtime-transition.js";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().safe().nonnegative();
const uuid = z.string().uuid();
// Mirrored reserved receipt vocabulary. Production CP never imports protocol;
// command-failure.test.ts keeps this closed set in parity with the engine.
export const CLOUD_COMMAND_FAILURE_STAGES = ["validation", "admission", "containment", "provider_start", "provider_prompt"] as const;
export const CLOUD_COMMAND_FAILURE_CATEGORIES = [
  "rejected", "authority_unavailable", "authority_timeout", "authority_transport", "authority_http_4xx", "authority_http_5xx",
  "authority_response_invalid", "canary_failed", "attestation_failed", "timeout", "auth_required", "verification_required",
  "cloud_credential_error", "subprocess_exited", "protocol_error", "transport_closed", "lifecycle_superseded", "rate_limited",
  "design_protection_failed", "session_expired",
  "executor_start_failed", "provider_login_failed", "environment_setup_failed", "environment_identity_mismatch", "environment_not_ready",
  "credential_refresh_invalid", "credential_refresh_timeout", "credential_refresh_unchanged", "credential_refresh_rejected", "lock_busy", "execution_limit",
  "customization_changed", "access_denied", "environment_revoked", "environment_runtime_required", "environment_unavailable", "lease_expired",
] as const;
const cloudFailureCodes = new Set(CLOUD_COMMAND_FAILURE_STAGES.flatMap(stage =>
  CLOUD_COMMAND_FAILURE_CATEGORIES.map(category => `cloud_${stage}_${category}`)));
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
const CloudClaudePreferencesSchema = z.object({
  autoMemoryEnabled: z.boolean(), idleCompactionEnabled: z.boolean(),
}).strict();
export const CloudQueuedPromptSchema = z.object({
  agentId: identity,
  userMessageId: identity,
  prompt: z.array(z.record(z.unknown())).min(1).max(128),
  bubble: z.record(z.unknown()).optional(),
  modeRevision: revision,
  permissionMode:z.string().min(1).max(32).optional(),
  agentCredentialGrantId:uuid.optional(),
  model:z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/).optional(),
  effort:z.enum(["low","medium","high","xhigh","max","ultracode"]).optional(),
  fast:z.boolean().optional(),
  claudePreferences: CloudClaudePreferencesSchema.optional(),
  operation: CloudNativeOperationSchema.optional(),
}).strict().superRefine((value,context)=>{
  if (value.claudePreferences && value.agentId !== "claude")
    context.addIssue({ code: "custom", message: "Claude preferences require the Claude provider" });
  if (value.operation && (!value.agentCredentialGrantId || !value.model ||
    (value.operation.kind !== "fork" && value.agentId !== "codex") ||
    (value.operation.kind === "fork" && value.operation.strategy === "native" && value.agentId !== "codex")))
    context.addIssue({code:"custom",message:"Native operations require explicit provider credential admission"});
  if(value.permissionMode !== undefined) {
    const modes:Record<string,readonly string[]> = {claude:["default","accept-edits","plan","auto","bypass"],codex:["ask","auto-edit","full-access","read-only"],cursor:["plan","auto","agent"]};
    if(!modes[value.agentId]?.includes(value.permissionMode)) context.addIssue({code:"custom",message:"Invalid provider permission mode"});
  }
  if(value.agentCredentialGrantId&&(!value.model||!["claude","cursor","codex"].includes(value.agentId)))
    context.addIssue({code:"custom",message:"Personal credential execution requires an explicit provider and model"});
});
export const CloudCommandMutationSchema = z.object({
  conversationId: identity,
  operationId: uuid,
  expectedRevision: revision,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enqueue"), commandId: uuid, payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("fork"), commandId: uuid, payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("edit"), commandId: uuid, payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("remove"), commandId: uuid }).strict(),
    z.object({ kind: z.literal("pause") }).strict(),
    z.object({ kind: z.literal("resume") }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const action = value.action;
  if (action.kind === "fork" && (action.payload.operation?.kind !== "fork" ||
      action.payload.operation.sourceConversationId === value.conversationId))
    context.addIssue({code:"custom",message:"Fork requires distinct source and destination conversations"});
  if ((action.kind === "enqueue" || action.kind === "edit") && action.payload.operation?.kind === "fork")
    context.addIssue({code:"custom",message:"Forks require the fork action"});
});
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
// Standalone mirror ingress contract. This does not enable local dispatch or
// import the desktop package; retained parity tests bind it to the shared wire.
const positiveSequence = revision.refine(value => value > 0);
const sequence = revision;
const intent = z.object({ userMessageId: identity, agentId: z.string().min(1).max(64) }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const CloudMirrorGoalSchema = CloudBootCommandSnapshotSchema.shape.nativeGoal.unwrap();
const CLOUD_LOCAL_COMMAND_MIRROR_MAX_BYTES = 1024 * 1024;
export const CloudLocalCommandMirrorChangeSchema = z.object({
  sequence: positiveSequence, conversationId: identity, revision: sequence, paused: z.boolean(),
  entry: CloudBootCommandEntrySchema.optional(), nativeGoal: CloudMirrorGoalSchema.optional(),
  originWriterEpoch: uuid.optional(), actor: CloudActorProvenanceSchema.optional(),
  // Retained after payload removal, even when terminal is the first mirror.
  intent: intent.optional(),
  credentialRun: CloudAgentCredentialRunInfoSchema.optional(),
  event: CloudCompactControlEventSchema.optional(),
  historyPart: CloudLocalCommandHistoryPartSchema.optional(),
  /** recordSequence=headRev() of the LOCAL record runtime; eventSequence is
   * the local live journal head. Outbox waits for confirmedLocalHead and
   * confirmed local event head. These are never CP global revisions. */
  history: CloudLocalCommandHistorySchema.optional(),
  historyHead: CloudLocalCommandHistoryHeadSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.nativeGoal && value.nativeGoal.conversationId !== value.conversationId)
    context.addIssue({ code: "custom", message: "Mirrored goal conversation is inconsistent" });
  if (value.event && "chatId" in value.event.frame && value.event.frame.chatId !== undefined &&
      value.event.frame.chatId !== value.conversationId)
    context.addIssue({ code: "custom", message: "Compact control conversation is inconsistent" });
  if (value.entry) {
    if (!value.originWriterEpoch || !value.intent)
      context.addIssue({ code: "custom", message: "Mirrored entry requires origin writer and durable intent" });
    const pending = value.entry.state === "queued" || value.entry.state === "dispatching";
    if (pending && (!value.entry.payload || !value.actor))
      context.addIssue({ code: "custom", message: "Mirrored pending entry requires payload and verified provenance" });
    if (value.entry.payload && (value.entry.payload.userMessageId !== value.intent?.userMessageId ||
        value.entry.payload.agentId !== value.intent?.agentId))
      context.addIssue({ code: "custom", message: "Mirrored prompt intent is inconsistent" });
    if (!pending && (value.entry.payload !== null || !value.history))
      context.addIssue({ code: "custom", message: "Mirrored terminal requires payload removal and history watermark" });
    if (value.actor && value.actor.scope.writerEpoch !== value.originWriterEpoch)
      context.addIssue({ code: "custom", message: "Mirrored actor origin is inconsistent" });
    if (value.credentialRun && (value.entry.state === "queued" || value.credentialRun.provider !== value.intent?.agentId ||
        value.credentialRun.writerEpoch !== value.originWriterEpoch ||
        (value.actor && (value.credentialRun.bootId !== value.actor.scope.bootId ||
          value.credentialRun.fundingOwnerUserId !== value.actor.scope.fundingOwnerUserId ||
          value.credentialRun.fundingOwnerEpoch !== value.actor.scope.fundingOwnerEpoch))))
      context.addIssue({ code: "custom", message: "Mirrored credential dispatch binding is inconsistent" });
    const terminal = value.entry.result?.terminal;
    if (terminal && (terminal.commandId !== value.entry.commandId || terminal.conversationId !== value.conversationId ||
        terminal.executionId !== value.entry.executionId || terminal.turnId !== value.intent?.userMessageId ||
        terminal.agentId !== value.intent?.agentId))
      context.addIssue({ code: "custom", message: "Mirrored terminal identity is inconsistent" });
    if (value.event && (value.event.executionId !== value.entry.executionId ||
        (value.event.commandId !== undefined && value.event.commandId !== value.entry.commandId) ||
        (value.event.turnId !== undefined && value.event.turnId !== value.intent?.userMessageId) ||
        value.event.frame.agentId !== value.intent?.agentId))
      context.addIssue({ code: "custom", message: "Mirrored control intent is inconsistent" });
    const head = value.historyHead;
    if (head?.source.kind === "command" && (head.originWriterEpoch !== value.originWriterEpoch ||
        head.source.commandId !== value.entry.commandId || head.source.executionId !== value.entry.executionId ||
        head.source.intent.userMessageId !== value.intent?.userMessageId || head.source.intent.agentId !== value.intent?.agentId ||
        (value.history && canonicalCloudLocalCommandHistoryJson(head.history) !== canonicalCloudLocalCommandHistoryJson(value.history))))
      context.addIssue({ code: "custom", message: "Current command history head is inconsistent" });
  } else if (value.credentialRun || value.intent) {
    context.addIssue({ code: "custom", message: "Mirrored credential run and intent require an entry" });
  }
  if (!value.entry && value.history)
    context.addIssue({ code: "custom", message: "Current history without a receipt requires an explicit head" });
  if (!value.entry && value.originWriterEpoch && value.historyHead && value.originWriterEpoch !== value.historyHead.originWriterEpoch)
    context.addIssue({ code: "custom", message: "Current history origin is inconsistent" });
});
export type CloudLocalCommandMirrorChange = z.infer<typeof CloudLocalCommandMirrorChangeSchema>;

export const CloudLocalCommandMirrorBatchSchema = z.object({
  version: z.literal(1), bootId: uuid, writerEpoch: uuid, batchId: uuid,
  after: sequence, through: sequence, changes: z.array(CloudLocalCommandMirrorChangeSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (value.through !== value.after + value.changes.length ||
      value.changes.some((change, index) => change.sequence !== value.after + index + 1))
    context.addIssue({ code: "custom", message: "Mirror sequence is not contiguous" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CLOUD_LOCAL_COMMAND_MIRROR_MAX_BYTES)
    context.addIssue({ code: "custom", message: "Mirror batch exceeds byte limit" });
  if (value.changes.some(change => change.entry &&
      (change.entry.state === "queued" || change.entry.state === "dispatching") &&
      (change.originWriterEpoch !== value.writerEpoch || change.actor?.scope.bootId !== value.bootId)))
    context.addIssue({ code: "custom", message: "Pending intent must belong to the active writer" });
});
export type CloudLocalCommandMirrorBatch = z.infer<typeof CloudLocalCommandMirrorBatchSchema>;
export const CloudLocalCommandMirrorAckSchema = z.object({
  version: z.literal(1), writerEpoch: uuid, batchId: uuid, through: sequence,
  /** Closed feedback for document parts supplied in this exact flight.
   * Receipts keep their original audit history; a limit publishes a separate
   * incomplete current head in the producer's FULL transaction. */
  historyLimits: z.array(z.object({ conversationId: identity, sha256: digest }).strict()).max(32)
    .refine(values => new Set(values.map(value => `${value.conversationId}\0${value.sha256}`)).size === values.length).optional(),
}).strict();
export type CloudLocalCommandMirrorAck = z.infer<typeof CloudLocalCommandMirrorAckSchema>;

// Independent CP seal mirror. The inventory digest belongs to the producer's
// private FULL ledger; this descriptor does not assert native/source retirement.
export const CloudLocalCommandWriterSealSchema = z.object({
  version: z.literal(1), scope: CloudAgentBootScopeSchema, sealId: uuid, sequence,
  recordSequence: sequence, eventSequence: sequence, inventorySha256: digest, sha256: digest,
}).strict();
export const CloudLocalCommandWriterSealAckSchema = z.object({
  version: z.literal(1), sealId: uuid, writerEpoch: uuid, sequence,
  recordSequence: sequence, eventSequence: sequence, inventorySha256: digest, sha256: digest,
}).strict();
export type CloudLocalCommandWriterSeal = z.infer<typeof CloudLocalCommandWriterSealSchema>;
export type CloudLocalCommandWriterSealAck = z.infer<typeof CloudLocalCommandWriterSealAckSchema>;


export const CloudCommandSettleSchema = z.object({
  commandId: uuid, claimId: uuid, state: z.enum(["succeeded", "failed", "cancelled"]),
  resultCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine(code =>
    !CLOUD_COMMAND_FAILURE_STAGES.some(stage => code.startsWith(`cloud_${stage}_`)) || cloudFailureCodes.has(code)).nullable(),
  result: CloudNativeResultSchema.optional(),
}).strict();
const CloudGoalConfirmationSchema=z.object({kind:z.literal("confirm-goal"),commandId:uuid,claimId:uuid,
  sequence:revision.refine(value=>value>0),goal:CloudNativeResultSchema.shape.goal.unwrap()}).strict();
const admissionErrorSchema = z.enum(["command_context_changed", "command_not_found"]).nullable();
export const CloudCommandRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), conversationId: identity }).strict(),
  z.object({ kind: z.literal("read"), commandId: uuid }).strict(),
  z.object({ kind: z.literal("mutate"), mutation: CloudCommandMutationSchema,
    admissionError: admissionErrorSchema.optional() }).strict(),
  z.object({ kind: z.literal("stop"), conversationId: identity, operationId: uuid }).strict(),
  z.object({ kind: z.literal("claim"), conversationId: identity, executionId: identity, claimId: uuid.optional() }).strict(),
  z.object({ kind: z.literal("settle"), result: CloudCommandSettleSchema }).strict(),
  CloudGoalConfirmationSchema,
]);
export function legacyCloudCommandResponse(value:unknown,nativeCommandsVersion?:1):unknown {
  if(!value||typeof value!=="object"||Array.isArray(value))return value;
  const native=nativeCommandsVersion===1;
  const {nativeGoal:_goal,...legacy}=value as Record<string,unknown>;
  const row=native?value as Record<string,unknown>:legacy;
  const entry=(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))return value;
    if(native){
      const row=value as Record<string,unknown>,result=row.result;
      if(!result||typeof result!=="object"||Array.isArray(result)||!("terminal" in result))return value;
      const {terminal:_terminal,...legacyResult}=result as Record<string,unknown>;
      return {...row,result:legacyResult};
    }
    const {result:_result,...rest}=value as Record<string,unknown>;
    return rest.payload&&typeof rest.payload==="object"&&"operation" in rest.payload?{...rest,payload:null}:rest;
  };
  return Array.isArray(row.pending)&&Array.isArray(row.receipts)
    ?{...row,pending:row.pending.map(entry),receipts:row.receipts.map(entry)}:entry(row);
}
/** Mirror the shared response projection for older strict worker payloads. */
export function withoutCloudClaudePreferences(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entry = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload) || !("claudePreferences" in row.payload)) return value;
    const { claudePreferences: _preferences, ...payload } = row.payload as Record<string, unknown>;
    return { ...row, payload };
  };
  const row = value as Record<string, unknown>;
  return Array.isArray(row.pending) && Array.isArray(row.receipts)
    ? { ...row, pending: row.pending.map(entry), receipts: row.receipts.map(entry) } : entry(row);
}

export type CloudCommandMutation = z.infer<typeof CloudCommandMutationSchema>;
export type CloudQueuedPrompt = z.infer<typeof CloudQueuedPromptSchema>;
export type CloudCommandEngineScope = {
  workspaceId: string; organizationId: string; generation: number;
  engineInstanceId: string; heartbeatToken: string;
  actorSessionId?: string;
};
export type CloudCommandState = "queued" | "dispatching" | "succeeded" | "failed" | "cancelled" | "uncertain";
export class CloudCommandError extends Error {
  constructor(readonly code: "invalid_command" | "command_conflict" | "command_context_changed" | "command_limit" | "command_not_found", message: string) {
    super(message); this.name = "CloudCommandError";
  }
}
type Control = { revision: string; paused: boolean; next_position: string };
type Command = { id: string; position: string; state: CloudCommandState; payload: CloudQueuedPrompt | null;
  generation: number; engine_instance_id: string | null; execution_id: string | null; claim_id: string | null;
  result: (z.infer<typeof CloudNativeResultSchema> & {goalRevision?:number;goalSequence?:number}) | null;
  result_code: string | null; created_at: Date; updated_at: Date;
  actor_user_id: string | null; actor_device_id: string | null;
  actor_device_key_version: string | null; actor_fingerprint: string | null;actor_source_session_id:string|null };
const MAX_OPERATION_RECEIPTS = 200000;
const MAX_RETAINED_PROMPT_BYTES = 64 * 1024 * 1024;

function safeInteger(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER)
    throw new CloudCommandError("command_limit", "Command revision is exhausted");
  return n;
}
function canonical(value: unknown, state = { nodes: 0 }, depth = 0): string {
  if (++state.nodes > 20000 || depth > 24) throw new CloudCommandError("invalid_command", "Command is too complex");
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, state, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new CloudCommandError("invalid_command", "Command contains unsupported data");
  return `{${Object.keys(value).sort().map(key => {
    if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 256)
      throw new CloudCommandError("invalid_command", "Command contains an invalid key");
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], state, depth + 1)}`;
  }).join(",")}}`;
}
function parseMutation(value: unknown): { mutation: CloudCommandMutation; hash: Buffer } {
  const parsed = CloudCommandMutationSchema.safeParse(value);
  if (!parsed.success) throw new CloudCommandError("invalid_command", "Invalid cloud command");
  const serialized = canonical(parsed.data);
  // Leave headroom for jsonb formatting and the bounded queue snapshot.
  if (Buffer.byteLength(serialized) > 192 * 1024)
    throw new CloudCommandError("command_limit", "Command is too large; use artifact references");
  return { mutation: parsed.data, hash: createHash("sha256").update(serialized).digest() };
}
function commandView(row: Command) {
  const {goalRevision:_revision,goalSequence:_sequence,...result}=row.result??{};
  return { commandId: row.id, position: safeInteger(row.position), state: row.state,
    payload: row.payload, executionId: row.execution_id, generation: row.generation,
    resultCode: row.result_code, ...(row.result ? {result} : {}), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function goalSnapshot(conversationId:string,result:Command["result"]) {
  return result?.goal!==undefined?{version:1 as const,conversationId,revision:result.goalRevision??0,goal:result.goal}:undefined;
}

type OperationActor = { actor_user_id: string | null; actor_device_id: string | null };
function sameOperationActor(row:OperationActor,actor:CloudRecordedActor|null):boolean {
  return row.actor_user_id===(actor?.actorUserId??null) && row.actor_device_id===(actor?.deviceId??null);
}

/** A complete immutable receipt audit does not own the current restore head.
 * The FULL producer pairs its terminal with a fresh staging fence in the
 * immediate next change of the same durable flight. */
function hasPairedMirrorStagingHead(receipt: CloudLocalCommandMirrorChange, next: CloudLocalCommandMirrorChange | undefined): boolean {
  const entry = receipt.entry, audit = receipt.history, head = next?.historyHead;
  if (!entry || !audit || !("manifestSha256" in audit) || !next || !head || head.source.kind !== "command" ||
      next.sequence !== receipt.sequence + 1 || next.conversationId !== receipt.conversationId || next.revision !== receipt.revision || next.paused !== receipt.paused ||
      next.entry || next.history || next.historyPart || next.event || next.nativeGoal || next.actor || next.intent || next.credentialRun || next.originWriterEpoch ||
      head.originWriterEpoch !== receipt.originWriterEpoch || head.deleted || !("incompleteReason" in head.history) ||
      head.history.incompleteReason !== "capture_unavailable" || head.history.restoreRevision + 1 !== audit.restoreRevision ||
      head.history.recordSequence !== audit.recordSequence || head.history.eventSequence !== audit.eventSequence) return false;
  const source = { kind: "command", commandId: entry.commandId, intent: receipt.intent!, executionId: entry.executionId,
    nativeResultSha256: entry.result == null ? null : createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(entry.result)).digest("hex") };
  return canonicalCloudLocalCommandHistoryJson(head.source) === canonicalCloudLocalCommandHistoryJson(source);
}

/** All methods take the live engine fence and lock workspace → engine → queue.
 * Client disconnects do not own queue state; old engines cannot claim or settle.
 * There is deliberately no timed lease that could replay a dispatched prompt. */
export class DatabaseCloudWorkspaceCommandService {
  constructor(private readonly options: { pool: pg.Pool; workosEnabled?: boolean }) {}

  /** Record the current writer's immutable drained descriptor independently
   * of lifecycle retirement. CP checks its projection, never private inventory
   * custody or process-domain proof; the existing stop path owns retirement. */
  async seal(scope: CloudCommandEngineScope, supplied: unknown): Promise<CloudLocalCommandWriterSealAck> {
    const parsed = CloudLocalCommandWriterSealSchema.safeParse(supplied);
    if (!parsed.success) throw new CloudCommandError("invalid_command", "Invalid cloud writer seal");
    const seal = parsed.data, { sha256, ...descriptor } = seal;
    if (createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(descriptor)).digest("hex") !== sha256)
      throw new CloudCommandError("command_conflict", "Cloud writer seal binding changed");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope, false);
      const { readCurrentCloudAgentBootBinding } = await import("./agent-boot-credentials.js");
      const current = await readCurrentCloudAgentBootBinding(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId });
      if (current.mode !== "boot-owner-v1" || current.binding.writerState !== "active")
        throw new CloudCommandError("command_context_changed", "Cloud seal writer is no longer active");
      const activeScope = { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        generation: scope.generation, engineInstanceId: scope.engineInstanceId, bootId: current.binding.bootId,
        writerEpoch: current.binding.writerEpoch, fundingOwnerUserId: current.binding.fundingOwnerUserId,
        fundingOwnerEpoch: current.binding.fundingOwnerEpoch };
      if (current.binding.generation !== scope.generation || current.binding.engineInstanceId !== scope.engineInstanceId ||
          canonicalCloudLocalCommandHistoryJson(activeScope) !== canonicalCloudLocalCommandHistoryJson(seal.scope))
        throw new CloudCommandError("command_context_changed", "Cloud seal scope changed");
      const writer = (await tx.query<{ mirrored_sequence: string; sealed_sequence: string | null;
        seal_record_sequence: string | null; seal_event_sequence: string | null; seal: unknown; seal_ack: unknown }>(
        `SELECT mirrored_sequence,sealed_sequence,seal_record_sequence,seal_event_sequence,seal,seal_ack
          FROM cloud_workspace_local_command_writers WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 AND state='active' FOR UPDATE`,
        [scope.workspaceId, scope.organizationId, seal.scope.writerEpoch])).rows[0];
      if (!writer) throw new CloudCommandError("command_context_changed", "Cloud seal writer is unavailable");
      const ack = CloudLocalCommandWriterSealAckSchema.parse({ version: 1, sealId: seal.sealId, writerEpoch: seal.scope.writerEpoch,
        sequence: seal.sequence, recordSequence: seal.recordSequence, eventSequence: seal.eventSequence,
        inventorySha256: seal.inventorySha256, sha256: seal.sha256 });
      if (writer.sealed_sequence !== null || writer.seal !== null || writer.seal_ack !== null) {
        const previous = CloudLocalCommandWriterSealSchema.safeParse(writer.seal), previousAck = CloudLocalCommandWriterSealAckSchema.safeParse(writer.seal_ack);
        if (!previous.success || !previousAck.success ||
            canonicalCloudLocalCommandHistoryJson(previous.data) !== canonicalCloudLocalCommandHistoryJson(seal) ||
            canonicalCloudLocalCommandHistoryJson(previousAck.data) !== canonicalCloudLocalCommandHistoryJson(ack) ||
            safeInteger(writer.mirrored_sequence) !== seal.sequence || writer.sealed_sequence !== String(seal.sequence) ||
            writer.seal_record_sequence !== String(seal.recordSequence) || writer.seal_event_sequence !== String(seal.eventSequence))
          throw new CloudCommandError("command_conflict", "Cloud writer seal retry changed");
        await assertCloudEngineAuthorityDeadline(tx, scope.engineInstanceId, this.options.workosEnabled === true);
        return previousAck.data;
      }
      if (safeInteger(writer.mirrored_sequence) !== seal.sequence)
        throw new CloudCommandError("command_conflict", "Cloud writer seal is not drained");
      const projection = (await tx.query<{ pending: boolean; record_sequence: string; event_sequence: string }>(
        `SELECT EXISTS(SELECT 1 FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3
            AND state IN ('queued','dispatching')) AS pending,
          coalesce(max(record_sequence),0)::text AS record_sequence,coalesce(max(event_sequence),0)::text AS event_sequence
          FROM (SELECT history_record_sequence AS record_sequence,history_event_sequence AS event_sequence
            FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3
            UNION ALL SELECT record_sequence,event_sequence FROM cloud_workspace_local_command_history_heads
              WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3
            UNION ALL SELECT NULL::bigint,local_sequence FROM cloud_workspace_local_agent_controls
              WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3) projected`,
        [scope.workspaceId, scope.organizationId, seal.scope.writerEpoch])).rows[0];
      if (!projection || projection.pending || safeInteger(projection.record_sequence) > seal.recordSequence || safeInteger(projection.event_sequence) > seal.eventSequence)
        throw new CloudCommandError("command_conflict", "Cloud writer seal projection is incomplete");
      await assertCloudEngineAuthorityDeadline(tx, scope.engineInstanceId, this.options.workosEnabled === true);
      await tx.query(`UPDATE cloud_workspace_local_command_writers SET sealed_sequence=$4,seal_record_sequence=$5,seal_event_sequence=$6,seal=$7,seal_ack=$8
        WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3`,
      [scope.workspaceId, scope.organizationId, seal.scope.writerEpoch, seal.sequence, seal.recordSequence, seal.eventSequence, JSON.stringify(seal), JSON.stringify(ack)]);
      return ack;
    });
  }

  /** Independent asynchronous projection of the authenticated FULL local
   * writer. This method cannot claim, admit or redispatch native work. Original
   * receipt audit and current restore authority commit in one private tx. */
  async mirror(scope: CloudCommandEngineScope, supplied: unknown): Promise<CloudLocalCommandMirrorAck> {
    const parsed = CloudLocalCommandMirrorBatchSchema.safeParse(supplied);
    if (!parsed.success) throw new CloudCommandError("invalid_command", "Invalid cloud mirror batch");
    const batch = parsed.data;
    let body: string;
    try { body = canonicalCloudLocalCommandHistoryJson(batch); }
    catch { throw new CloudCommandError("invalid_command", "Cloud mirror body is not bounded JSON"); }
    const requestHash = createHash("sha256").update(body).digest();
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope, false);
      const { readCurrentCloudAgentBootBinding } = await import("./agent-boot-credentials.js");
      const current = await readCurrentCloudAgentBootBinding(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId });
      if (current.mode !== "boot-owner-v1" || current.binding.writerState !== "active" ||
          current.binding.bootId !== batch.bootId || current.binding.writerEpoch !== batch.writerEpoch ||
          current.binding.generation !== scope.generation || current.binding.engineInstanceId !== scope.engineInstanceId)
        throw new CloudCommandError("command_context_changed", "Cloud mirror writer is no longer active");
      const writer = (await tx.query<{ mirrored_sequence: string; sealed_sequence: string | null }>(`SELECT mirrored_sequence,sealed_sequence FROM cloud_workspace_local_command_writers
        WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 AND state='active' FOR UPDATE`,
      [scope.workspaceId, scope.organizationId, batch.writerEpoch])).rows[0];
      if (!writer || writer.sealed_sequence !== null) throw new CloudCommandError("command_context_changed", "Cloud mirror writer is unavailable");
      const prior = (await tx.query<{ request_sha256: Buffer; after_sequence: string; through_sequence: string; ack: unknown }>(
        `SELECT request_sha256,after_sequence,through_sequence,ack FROM cloud_workspace_local_command_mirror_batches
          WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 AND batch_id=$4`,
        [scope.workspaceId, scope.organizationId, batch.writerEpoch, batch.batchId])).rows[0];
      if (prior) {
        const ack = CloudLocalCommandMirrorAckSchema.safeParse(prior.ack);
        if (!prior.request_sha256.equals(requestHash) || Number(prior.after_sequence) !== batch.after || Number(prior.through_sequence) !== batch.through ||
            !ack.success || ack.data.writerEpoch !== batch.writerEpoch || ack.data.batchId !== batch.batchId || ack.data.through !== batch.through ||
            (ack.data.historyLimits ?? []).some(pair => !batch.changes.some(change => change.conversationId === pair.conversationId && change.historyPart?.sha256 === pair.sha256)))
          throw new CloudCommandError("command_conflict", "Cloud mirror retry changed its immutable flight");
        await assertCloudEngineAuthorityDeadline(tx, scope.engineInstanceId, this.options.workosEnabled === true);
        return ack.data;
      }
      if (safeInteger(writer.mirrored_sequence) !== batch.after)
        throw new CloudCommandError("command_conflict", "Cloud mirror cursor is not contiguous");
      const { applyMirroredCloudAgentHistory } = await import("./history.js");
      const { applyCompactCloudAgentEvent, CloudEventError } = await import("./event-streams.js");
      const historyLimits: NonNullable<CloudLocalCommandMirrorAck["historyLimits"]> = [];
      const limited = new Set<string>();
      for (let changeIndex = 0; changeIndex < batch.changes.length; changeIndex++) {
        const change = batch.changes[changeIndex]!;
        const control = (await tx.query<{ revision: string; paused: boolean; native_goal: unknown }>(`SELECT revision,paused,native_goal
          FROM cloud_workspace_local_command_controls WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 AND conversation_id=$4 FOR UPDATE`,
        [scope.workspaceId, scope.organizationId, batch.writerEpoch, change.conversationId])).rows[0];
        if (control && (Number(control.revision) > change.revision || (Number(control.revision) === change.revision &&
            (control.paused !== change.paused || (change.nativeGoal !== undefined &&
              canonicalCloudLocalCommandHistoryJson(control.native_goal) !== canonicalCloudLocalCommandHistoryJson(change.nativeGoal))))))
          throw new CloudCommandError("command_conflict", "Cloud mirror conversation revision changed");
        await tx.query(`INSERT INTO cloud_workspace_local_command_controls(workspace_id,org_id,writer_epoch,conversation_id,revision,paused,native_goal)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,writer_epoch,conversation_id) DO UPDATE SET
            revision=EXCLUDED.revision,paused=EXCLUDED.paused,native_goal=coalesce(EXCLUDED.native_goal,cloud_workspace_local_command_controls.native_goal),updated_at=now()`,
        [scope.workspaceId, scope.organizationId, batch.writerEpoch, change.conversationId, change.revision, change.paused,
          change.nativeGoal === undefined ? null : JSON.stringify(change.nativeGoal)]);
        if (change.entry) await this.stageMirroredEntry(tx, scope, batch, change);
        if (change.event) {
          let commandId = change.entry?.commandId ?? change.event.commandId;
          if (!commandId) {
            const candidates = (await tx.query<{ id: string }>(`SELECT id FROM cloud_workspace_local_commands
              WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3 AND conversation_id=$4 AND execution_id=$5
                AND ($6::text IS NULL OR user_message_id=$6) LIMIT 2`,
            [scope.workspaceId, scope.organizationId, batch.writerEpoch, change.conversationId, change.event.executionId, change.event.turnId ?? null])).rows;
            if (candidates.length !== 1) throw new CloudCommandError("command_conflict", "Compact control has no exact command owner");
            commandId = candidates[0]!.id;
          }
          try { await applyCompactCloudAgentEvent(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
            writerEpoch: batch.writerEpoch, outboxSequence: change.sequence, conversationId: change.conversationId, commandId }, change.event); }
          catch (error) {
            if (error instanceof CloudEventError) throw new CloudCommandError(error.code === "invalid_event" ? "invalid_command" : "command_conflict", "Compact control projection was refused");
            throw error;
          }
        }
        if (change.historyPart) {
          const result = await applyMirroredCloudAgentHistory(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
            writerEpoch: batch.writerEpoch, outboxSequence: change.sequence }, { conversationId: change.conversationId, historyPart: change.historyPart });
          if (result.historyLimit) {
            const pair = { conversationId: change.conversationId, sha256: change.historyPart.sha256 };
            if (!historyLimits.some(item => item.conversationId === pair.conversationId && item.sha256 === pair.sha256)) historyLimits.push(pair);
            limited.add(change.conversationId);
          }
        }
        let head = change.historyHead;
        if (!head && change.entry && change.history) {
          if ("manifestSha256" in change.history) {
            if (!hasPairedMirrorStagingHead(change, batch.changes[changeIndex + 1]))
              throw new CloudCommandError("command_conflict", "Complete mirror audit has no exact current-head pair");
            // The next original change publishes the explicit R-1 fence.
            // Its audit R stays immutable and cannot occupy current revision R
            // before the later canonical parts and verified complete head.
          } else head = { originWriterEpoch: change.originWriterEpoch!, deleted: false,
            source: { kind: "command", commandId: change.entry.commandId, intent: change.intent!, executionId: change.entry.executionId,
              nativeResultSha256: change.entry.result == null ? null : createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(change.entry.result)).digest("hex") },
            history: change.history };
        }
        if (head) {
          if (limited.has(change.conversationId) && "manifestSha256" in head.history) head = { ...head, history: {
            restoreRevision: head.history.restoreRevision, recordSequence: head.history.recordSequence,
            eventSequence: head.history.eventSequence, incompleteReason: "history_limit" } };
          await applyMirroredCloudAgentHistory(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
            writerEpoch: batch.writerEpoch, outboxSequence: change.sequence }, { conversationId: change.conversationId, historyHead: head });
        }
      }
      const ack = CloudLocalCommandMirrorAckSchema.parse({ version: 1, writerEpoch: batch.writerEpoch, batchId: batch.batchId,
        through: batch.through, ...(historyLimits.length ? { historyLimits } : {}) });
      await assertCloudEngineAuthorityDeadline(tx, scope.engineInstanceId, this.options.workosEnabled === true);
      await tx.query(`INSERT INTO cloud_workspace_local_command_mirror_batches(workspace_id,org_id,writer_epoch,batch_id,
        request_sha256,after_sequence,through_sequence,ack) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [scope.workspaceId, scope.organizationId, batch.writerEpoch, batch.batchId, requestHash, batch.after, batch.through, JSON.stringify(ack)]);
      await tx.query(`UPDATE cloud_workspace_local_command_writers SET mirrored_sequence=$4
        WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3`, [scope.workspaceId, scope.organizationId, batch.writerEpoch, batch.through]);
      return ack;
    });
  }

  private async stageMirroredEntry(tx: Tx, scope: CloudCommandEngineScope, batch: CloudLocalCommandMirrorBatch, change: CloudLocalCommandMirrorChange): Promise<void> {
    const entry = change.entry!, origin = (await tx.query<{ generation: number; engine_instance_id: string; boot_id: string;
      writer_epoch: string; funding_owner_user_id: string; funding_owner_epoch: string; state: string }>(`SELECT generation,engine_instance_id,boot_id,
        writer_epoch,funding_owner_user_id,funding_owner_epoch,state FROM cloud_workspace_local_command_writers
      WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 FOR SHARE`,
    [scope.workspaceId, scope.organizationId, change.originWriterEpoch])).rows[0];
    const conflict = () => new CloudCommandError("command_conflict", "Cloud mirrored command identity changed");
    if (!origin || entry.generation !== origin.generation ||
        (origin.writer_epoch === batch.writerEpoch ? origin.state !== "active" : origin.state !== "retired")) throw conflict();
    const expectedScope = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: origin.generation,
      engineInstanceId: origin.engine_instance_id, bootId: origin.boot_id, writerEpoch: origin.writer_epoch,
      fundingOwnerUserId: origin.funding_owner_user_id, fundingOwnerEpoch: Number(origin.funding_owner_epoch) };
    if (change.actor && (canonicalCloudLocalCommandHistoryJson(change.actor.scope) !== canonicalCloudLocalCommandHistoryJson(expectedScope) ||
        change.actor.actor.role === "viewer" || change.actor.fundingConsentVersion !== 1 || !change.actor.fundingGrant)) throw conflict();
    const previous = (await tx.query<{ conversation_id: string; writer_epoch: string; user_message_id: string; agent_id: string; position: string;
      state: CloudCommandState; execution_id: string | null; generation: number; payload: unknown; actor_provenance: unknown;
      result_code: string | null; result: unknown; credential_run_info: unknown; created_at: Date; updated_at: Date;
      history_record_sequence: string | null; history_event_sequence: string | null; history_restore_revision: string | null;
      history_manifest_sha256: Buffer | null; history_incomplete_reason: string | null }>(
      "SELECT * FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2 AND id=$3 FOR UPDATE",
      [scope.workspaceId, scope.organizationId, entry.commandId])).rows[0];
    if (previous && (previous.conversation_id !== change.conversationId || previous.writer_epoch !== change.originWriterEpoch ||
        previous.user_message_id !== change.intent!.userMessageId || previous.agent_id !== change.intent!.agentId ||
        Number(previous.position) !== entry.position || previous.generation !== entry.generation ||
        previous.created_at.getTime() !== Date.parse(entry.createdAt) || (previous.execution_id !== null && previous.execution_id !== entry.executionId) ||
        (["succeeded", "failed", "cancelled", "uncertain"].includes(previous.state) &&
          (previous.state !== entry.state || previous.result_code !== entry.resultCode ||
            canonicalCloudLocalCommandHistoryJson(previous.result) !== canonicalCloudLocalCommandHistoryJson(entry.result ?? null) ||
            Number(previous.history_restore_revision) !== change.history?.restoreRevision ||
            previous.history_record_sequence !== (change.history?.recordSequence == null ? null : String(change.history.recordSequence)) ||
            previous.history_event_sequence !== (change.history?.eventSequence == null ? null : String(change.history.eventSequence)) ||
            previous.history_manifest_sha256?.toString("hex") !== (change.history && "manifestSha256" in change.history ? change.history.manifestSha256 : undefined) ||
            previous.history_incomplete_reason !== (change.history && "incompleteReason" in change.history ? change.history.incompleteReason : null))))) throw conflict();
    const provenance = change.actor ?? previous?.actor_provenance ?? null;
    if (entry.executionId !== null && !CloudActorProvenanceSchema.safeParse(provenance).success) throw conflict();
    if (previous?.execution_id !== null && previous?.execution_id !== undefined && change.actor &&
        canonicalCloudLocalCommandHistoryJson(previous.actor_provenance) !== canonicalCloudLocalCommandHistoryJson(change.actor)) throw conflict();
    if (previous && previous.state !== "queued" && entry.state === "queued") throw conflict();
    const terminal = entry.result?.terminal;
    if (terminal && ((entry.state === "succeeded" && terminal.status !== "completed") ||
        (entry.state === "failed" && terminal.status !== "failed") || (entry.state === "cancelled" && terminal.status !== "cancelled"))) throw conflict();
    if (change.credentialRun && (change.credentialRun.bootId !== origin.boot_id || change.credentialRun.fundingOwnerUserId !== origin.funding_owner_user_id ||
        change.credentialRun.fundingOwnerEpoch !== Number(origin.funding_owner_epoch))) throw conflict();
    if (previous?.credential_run_info && change.credentialRun && canonicalCloudLocalCommandHistoryJson(previous.credential_run_info) !== canonicalCloudLocalCommandHistoryJson(change.credentialRun)) throw conflict();
    const history = change.history;
    // Terminal-first rows are still private to this transaction. Do not invent
    // a pending prompt to satisfy CHECKs; failed helper/ACK rolls everything back.
    await tx.query(`INSERT INTO cloud_workspace_local_commands(workspace_id,org_id,id,conversation_id,writer_epoch,projection_epoch,
      user_message_id,agent_id,position,state,payload,actor_provenance,generation,execution_id,result_code,result,credential_run_info,
      history_record_sequence,history_event_sequence,history_restore_revision,history_manifest_sha256,history_incomplete_reason,
      mirror_sequence,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ON CONFLICT(workspace_id,id) DO UPDATE SET projection_epoch=EXCLUDED.projection_epoch,state=EXCLUDED.state,payload=EXCLUDED.payload,
        actor_provenance=EXCLUDED.actor_provenance,execution_id=EXCLUDED.execution_id,result_code=EXCLUDED.result_code,result=EXCLUDED.result,
        credential_run_info=coalesce(EXCLUDED.credential_run_info,cloud_workspace_local_commands.credential_run_info),
        history_record_sequence=EXCLUDED.history_record_sequence,history_event_sequence=EXCLUDED.history_event_sequence,
        history_restore_revision=EXCLUDED.history_restore_revision,history_manifest_sha256=EXCLUDED.history_manifest_sha256,
        history_incomplete_reason=EXCLUDED.history_incomplete_reason,mirror_sequence=EXCLUDED.mirror_sequence,updated_at=EXCLUDED.updated_at`,
    [scope.workspaceId, scope.organizationId, entry.commandId, change.conversationId, change.originWriterEpoch, batch.writerEpoch,
      change.intent!.userMessageId, change.intent!.agentId, entry.position, entry.state, entry.payload === null ? null : JSON.stringify(entry.payload),
      provenance === null ? null : JSON.stringify(provenance), entry.generation, entry.executionId, entry.resultCode, entry.result == null ? null : JSON.stringify(entry.result),
      change.credentialRun === undefined ? null : JSON.stringify(change.credentialRun), history?.recordSequence ?? null, history?.eventSequence ?? null,
      history?.restoreRevision ?? null, history && "manifestSha256" in history ? Buffer.from(history.manifestSha256, "hex") : null,
      history && "incompleteReason" in history ? history.incompleteReason : null, change.sequence, entry.createdAt, entry.updatedAt]);
  }

  private async authorize(tx: Tx, scope: CloudCommandEngineScope, mutable = true) {
    const authority = await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.options.workosEnabled === true });
    if (mutable) {
      const local = await tx.query<{ mode: string; activated: boolean }>(`SELECT workspace.agent_command_mode AS mode,
        EXISTS(SELECT 1 FROM cloud_workspace_local_command_writers writer
          WHERE writer.workspace_id=workspace.id AND writer.org_id=workspace.org_id AND writer.state='active') AS activated
        FROM cloud_workspaces workspace WHERE workspace.id=$1 AND workspace.org_id=$2`, [scope.workspaceId, scope.organizationId]);
      if (local.rows[0]?.mode !== "legacy" || local.rows[0].activated)
        throw new CloudCommandError("command_conflict", "The cloud command writer has changed");
    }
    return authority;
  }
  private async dispatchAuthority(tx:Tx,scope:CloudCommandEngineScope,row:Command) {
    try {
      if (!row.actor_fingerprint) {
        const {actorSessionId:_session,...engineScope}=scope;
        await assertCloudRequestActor(tx,engineScope,"run");
        return {};
      }
      if (!row.actor_user_id || !row.actor_device_id || !row.actor_device_key_version || !row.actor_source_session_id)
        return {dispatchAllowed:false as const};
      const actor={actorUserId:row.actor_user_id,deviceId:row.actor_device_id,
        deviceKeyVersion:Number(row.actor_device_key_version),fingerprint:row.actor_fingerprint,sourceSessionId:row.actor_source_session_id};
      const authority=await assertRecordedCloudActor(tx,{...scope,actorUserId:actor.actorUserId,actor,capability:"run"});
      return {dispatchAllowed:true as const,actor:{userId:actor.actorUserId,deviceId:actor.deviceId,
        deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint,role:authority.role}};
    } catch(error) {
      if (error instanceof HttpError) return {dispatchAllowed:false as const};
      throw error;
    }
  }
  private async control(tx: Tx, scope: CloudCommandEngineScope, conversationId: string): Promise<Control> {
    if (!identity.safeParse(conversationId).success) throw new CloudCommandError("invalid_command", "Invalid conversation identity");
    const existing = await tx.query<Control>(`SELECT revision, paused, next_position
      FROM cloud_workspace_conversation_controls WHERE workspace_id=$1 AND conversation_id=$2 FOR UPDATE`, [scope.workspaceId, conversationId]);
    if (existing.rows[0]) return existing.rows[0];
    const count = await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_conversation_controls WHERE workspace_id=$1`, [scope.workspaceId]);
    if (Number(count.rows[0]!.count) >= 10000) throw new CloudCommandError("command_limit", "Workspace conversation limit reached");
    return (await tx.query<Control>(`INSERT INTO cloud_workspace_conversation_controls(workspace_id,org_id,conversation_id)
      VALUES($1,$2,$3) RETURNING revision,paused,next_position`, [scope.workspaceId, scope.organizationId, conversationId])).rows[0]!;
  }
  private async bump(tx: Tx, scope: CloudCommandEngineScope, conversationId: string) {
    await tx.query(`UPDATE cloud_workspace_conversation_controls SET revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND conversation_id=$2`, [scope.workspaceId, conversationId]);
  }
  private async recover(tx: Tx, scope: CloudCommandEngineScope, conversationId: string) {
    const interrupted = await tx.query(`UPDATE cloud_workspace_commands SET state='uncertain',
      result_code='engine_interrupted',updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2
      AND state='dispatching' AND (engine_instance_id<>$3 OR generation<>$4) RETURNING id`,
    [scope.workspaceId, conversationId, scope.engineInstanceId, scope.generation]);
    const staleQueue = await tx.query(`SELECT 1 FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
      AND state='queued' AND (generation<>$3 OR engine_instance_id IS DISTINCT FROM $4::uuid) LIMIT 1`,
    [scope.workspaceId, conversationId, scope.generation, scope.engineInstanceId]);
    if (interrupted.rowCount || staleQueue.rowCount) {
      const automaticWake = !interrupted.rowCount && (await isAutomaticRuntimeWakeGeneration(tx, { ...scope, includeSource:true }) ||
        await isAutomaticRetainedRuntimeEngine(tx, scope));
      await tx.query(`UPDATE cloud_workspace_conversation_controls
        SET paused=CASE WHEN $4::boolean THEN paused ELSE true END,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND conversation_id=$2 AND (NOT paused OR $3::boolean OR $4::boolean)`,
      [scope.workspaceId, conversationId, Boolean(interrupted.rowCount), automaticWake]);
      // A verified automatic transition preserves saved queue intent.
      // Unknown dispatched outcomes and ordinary replacement engines
      // still pause; an explicit Resume accepts their undispatched entries.
      await tx.query(`UPDATE cloud_workspace_commands SET generation=$3,engine_instance_id=$4 WHERE workspace_id=$1 AND conversation_id=$2
        AND state='queued'`, [scope.workspaceId, conversationId, scope.generation, scope.engineInstanceId]);
    }
  }
  private async view(tx: Tx, scope: CloudCommandEngineScope, conversationId: string) {
    const control = await this.control(tx, scope, conversationId);
    const pending = await tx.query<Command>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
      AND state IN ('queued','dispatching') ORDER BY position LIMIT 33`, [scope.workspaceId, conversationId]);
    const receipts = await tx.query<Command>(`SELECT id,position,state,NULL::jsonb AS payload,generation,engine_instance_id,
      execution_id,claim_id,result_code,result,created_at,updated_at FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
      AND state NOT IN ('queued','dispatching') ORDER BY updated_at DESC,id LIMIT 50`, [scope.workspaceId, conversationId]);
    // Read the last confirmation independently of the bounded receipt window,
    // including a live command whose foreground outcome is still unknown.
    const latestGoal=(await tx.query<Pick<Command,"result">>(`SELECT result FROM cloud_workspace_commands
      WHERE workspace_id=$1 AND conversation_id=$2 AND result ? 'goal'
      ORDER BY (result->>'goalRevision')::bigint DESC NULLS LAST,updated_at DESC,id LIMIT 1`,[scope.workspaceId,conversationId])).rows[0];
    const nativeGoal=goalSnapshot(conversationId,latestGoal?.result??null);
    return { version: 1 as const, conversationId, revision: safeInteger(control.revision), paused: control.paused,
      ...(nativeGoal?{nativeGoal}:{}),
      pending: pending.rows.map(commandView), receipts: receipts.rows.map(row => commandView({ ...row, payload: null })) };
  }
  async snapshot(scope: CloudCommandEngineScope, conversationId: string) {
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope, false); await assertCloudRequestActor(tx,scope,"read");
      await this.control(tx, scope, conversationId);
      await this.recover(tx, scope, conversationId);
      return this.view(tx, scope, conversationId);
    });
  }
  /** Uncertain prompts are retained for explicit inspection, never replayed.
   * Read one exact command so a receipt list cannot amplify large payloads. */
  async read(scope: CloudCommandEngineScope, commandId: string) {
    if (!uuid.safeParse(commandId).success) throw new CloudCommandError("invalid_command", "Invalid command identity");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope, false);
      await assertCloudRequestActor(tx,scope,"read");
      const row = (await tx.query<Command & { conversation_id: string }>(`SELECT * FROM cloud_workspace_commands
        WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId, commandId])).rows[0];
      if (!row) throw new CloudCommandError("command_not_found", "Command is unavailable");
      await this.control(tx, scope, row.conversation_id);
      await this.recover(tx, scope, row.conversation_id);
      const current = (await tx.query<Command>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, commandId])).rows[0]!;
      return { ...commandView(current), conversationId: row.conversation_id };
    });
  }
  async mutate(scope: CloudCommandEngineScope, value: unknown,
    admissionError: "command_context_changed" | "command_not_found" | null = null) {
    const { mutation: m, hash: contentHash } = parseMutation(value);
    if (!admissionErrorSchema.safeParse(admissionError).success)
      throw new CloudCommandError("invalid_command", "Invalid command admission result");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      const actor=await assertCloudRequestActor(tx,scope,m.action.kind==="edit"?"edit":"run");
      const hash=actor?createHash("sha256").update(contentHash).update(canonical({actorUserId:actor.actorUserId,deviceId:actor.deviceId,
        deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint})).digest():contentHash;
      await this.control(tx, scope, m.conversationId);
      await this.recover(tx, scope, m.conversationId);
      const replay = (await tx.query<OperationActor & { request_sha256: Buffer; conversation_id: string }>(`SELECT request_sha256,conversation_id,actor_user_id,actor_device_id
        FROM cloud_workspace_command_operations WHERE workspace_id=$1 AND operation_id=$2`, [scope.workspaceId, m.operationId])).rows[0];
      if (replay) {
        if (!sameOperationActor(replay,actor) || replay.conversation_id !== m.conversationId || !timingSafeEqual(replay.request_sha256, hash))
          throw new CloudCommandError("command_conflict", "Command identity was already used with different content");
        return { ...(await this.view(tx, scope, m.conversationId)), replayed: true };
      }
      // The engine checks current mode/ownership, but a historical retry must
      // resolve its committed receipt before consulting today's authoring state.
      if (admissionError) throw new CloudCommandError(admissionError, "Conversation context changed");
      const control = await this.control(tx, scope, m.conversationId);
      if (safeInteger(control.revision) !== m.expectedRevision)
        throw new CloudCommandError("command_conflict", "Conversation control changed; read its current revision");
      const receiptCount = await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_command_operations WHERE workspace_id=$1`, [scope.workspaceId]);
      if (Number(receiptCount.rows[0]!.count) >= MAX_OPERATION_RECEIPTS)
        throw new CloudCommandError("command_limit", "Workspace command history capacity reached");
      const action = m.action;
      if (action.kind === "enqueue" || action.kind === "fork" || action.kind === "edit") {
        const retained = await tx.query<{ bytes: string }>(`SELECT coalesce(sum(octet_length(payload::text)),0) AS bytes
          FROM cloud_workspace_commands WHERE workspace_id=$1 AND payload IS NOT NULL`, [scope.workspaceId]);
        if (Number(retained.rows[0]!.bytes) + Buffer.byteLength(JSON.stringify(action.payload)) > MAX_RETAINED_PROMPT_BYTES)
          throw new CloudCommandError("command_limit", "Retained prompt capacity reached");
      }
      if (action.kind === "enqueue" || action.kind === "fork") {
        const count = (await tx.query<{ pending: string; total: string }>(`SELECT count(*) FILTER(WHERE state IN ('queued','dispatching')) AS pending,
          count(*) AS total FROM cloud_workspace_commands WHERE workspace_id=$1`, [scope.workspaceId])).rows[0]!;
        if (Number(count.pending) >= 32 || Number(count.total) >= 100000)
          throw new CloudCommandError("command_limit", "Workspace command limit reached");
        const inserted = await tx.query(`INSERT INTO cloud_workspace_commands(workspace_id,org_id,id,conversation_id,position,state,payload,generation,engine_instance_id,user_message_id,
          actor_user_id,actor_device_id,actor_device_key_version,actor_fingerprint,actor_source_session_id)
          VALUES($1,$2,$3,$4,$5,'queued',$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
        [scope.workspaceId, scope.organizationId, action.commandId, m.conversationId, safeInteger(control.next_position), JSON.stringify(action.payload), scope.generation, scope.engineInstanceId, action.payload.userMessageId,
          actor?.actorUserId??null,actor?.deviceId??null,actor?.deviceKeyVersion??null,actor?.fingerprint??null,actor?.sourceSessionId??null]);
        if (!inserted.rowCount) throw new CloudCommandError("command_conflict", "Command already exists");
        await tx.query(`UPDATE cloud_workspace_conversation_controls SET next_position=next_position+1 WHERE workspace_id=$1 AND conversation_id=$2`, [scope.workspaceId, m.conversationId]);
      } else if (action.kind === "pause" || action.kind === "resume") {
        // authorize holds the workspace lock also used by idle admission and
        // checkpoint completion. A sleeping queue must wait for cancellation
        // or a fresh engine; Resume cannot revive work during final capture.
        if (action.kind === "resume" && (await tx.query(`SELECT 1 FROM workspace_checkpoint_requests
          WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND idle_engine_instance_id IS NOT NULL
            AND (state IN ('queued','delivered') OR (state='succeeded' AND idle_engine_instance_id=$4)) LIMIT 1`,
        [scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId])).rowCount)
          throw new CloudCommandError("command_conflict", "Idle checkpoint is in progress; resume after the workspace wakes");
        await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=$3 WHERE workspace_id=$1 AND conversation_id=$2`,
        [scope.workspaceId, m.conversationId, action.kind === "pause"]);
      } else {
        const updated = await tx.query(`UPDATE cloud_workspace_commands SET
          state=$4,payload=$5::jsonb,result_code=$6,updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND state='queued'
          AND ($7::text IS NULL OR user_message_id=$7) RETURNING id`,
        [scope.workspaceId, m.conversationId, action.commandId, action.kind === "edit" ? "queued" : "cancelled",
          action.kind === "edit" ? JSON.stringify(action.payload) : null, action.kind === "remove" ? "removed_before_dispatch" : null,
          action.kind === "edit" ? action.payload.userMessageId : null]);
        if (!updated.rowCount) throw new CloudCommandError("command_conflict", "Only a queued command can be edited or removed");
        if (action.kind==="edit") await tx.query(`UPDATE cloud_workspace_commands SET actor_user_id=$3,actor_device_id=$4,
          actor_device_key_version=$5,actor_fingerprint=$6,actor_source_session_id=$7 WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId,action.commandId,actor?.actorUserId??null,actor?.deviceId??null,actor?.deviceKeyVersion??null,actor?.fingerprint??null,actor?.sourceSessionId??null]);
      }
      await this.bump(tx, scope, m.conversationId);
      const snapshot = await this.view(tx, scope, m.conversationId);
      await tx.query(`INSERT INTO cloud_workspace_command_operations(workspace_id,org_id,operation_id,conversation_id,request_sha256,revision,actor_user_id,actor_device_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.workspaceId, scope.organizationId, m.operationId, m.conversationId, hash, snapshot.revision,actor?.actorUserId??null,actor?.deviceId??null]);
      return { ...snapshot, replayed: false };
    });
  }
  /** Stop is monotonic and must not lose a race with completion or enqueue.
   * Unlike edit/resume it does not require the device's last queue revision. */
  async stop(scope: CloudCommandEngineScope, conversationId: string, operationId: string) {
    if (!identity.safeParse(conversationId).success || !uuid.safeParse(operationId).success)
      throw new CloudCommandError("invalid_command", "Invalid stop identity");
    const contentHash = createHash("sha256").update(canonical({ kind: "stop", conversationId })).digest();
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope); const actor=await assertCloudRequestActor(tx,scope,"run");
      const hash=actor?createHash("sha256").update(contentHash).update(canonical({actorUserId:actor.actorUserId,deviceId:actor.deviceId,
        deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint})).digest():contentHash;
      await this.control(tx, scope, conversationId);
      await this.recover(tx, scope, conversationId);
      const replay = (await tx.query<OperationActor & { request_sha256: Buffer }>(`SELECT request_sha256,actor_user_id,actor_device_id
        FROM cloud_workspace_command_operations WHERE workspace_id=$1 AND operation_id=$2`, [scope.workspaceId, operationId])).rows[0];
      if (replay) {
        if (!sameOperationActor(replay,actor) || !timingSafeEqual(hash, replay.request_sha256)) throw new CloudCommandError("command_conflict", "Stop identity was already used");
        return { ...(await this.view(tx, scope, conversationId)), replayed: true };
      }
      const count = await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_command_operations WHERE workspace_id=$1`, [scope.workspaceId]);
      if (Number(count.rows[0]!.count) >= MAX_OPERATION_RECEIPTS) {
        // Receipt exhaustion permanently rejects Resume/new mutations. Stop
        // can still monotonically pause work without unbounded receipt growth.
        await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=true,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND conversation_id=$2 AND NOT paused`, [scope.workspaceId, conversationId]);
        return { ...(await this.view(tx, scope, conversationId)), replayed: false };
      }
      await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=true,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND conversation_id=$2`, [scope.workspaceId, conversationId]);
      const snapshot = await this.view(tx, scope, conversationId);
      await tx.query(`INSERT INTO cloud_workspace_command_operations(workspace_id,org_id,operation_id,conversation_id,request_sha256,revision,actor_user_id,actor_device_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.workspaceId, scope.organizationId, operationId, conversationId, hash, snapshot.revision,actor?.actorUserId??null,actor?.deviceId??null]);
      return { ...snapshot, replayed: false };
    });
  }
  async claim(scope: CloudCommandEngineScope, conversationId: string, executionId: string, requestClaimId?: string, allowNative=true) {
    if (!identity.safeParse(executionId).success || (requestClaimId !== undefined && !uuid.safeParse(requestClaimId).success))
      throw new CloudCommandError("invalid_command", "Invalid execution or claim identity");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      if (await cloudRuntimeHandoffBlocksClaims(tx, scope)) return null;
      if (await isAutomaticRuntimeWakeGeneration(tx, { ...scope, includeSource:true }) &&
          !(await tx.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 AND status IN ('ready','busy')", [scope.workspaceId])).rowCount) return null;
      await this.control(tx, scope, conversationId);
      await this.recover(tx, scope, conversationId);
      if (requestClaimId) {
        const previous = (await tx.query<Command & { conversation_id: string }>(`SELECT * FROM cloud_workspace_commands
          WHERE workspace_id=$1 AND claim_id=$2`, [scope.workspaceId, requestClaimId])).rows[0];
        if (previous) {
          if (previous.conversation_id !== conversationId || previous.execution_id !== executionId ||
            previous.engine_instance_id !== scope.engineInstanceId || previous.generation !== scope.generation)
            throw new CloudCommandError("command_conflict", "Claim identity belongs to another dispatch");
          // Resolve an accepted claim even when Stop arrived after its commit.
          // The engine then settles it cancelled before entering the provider.
          if (previous.state !== "dispatching" || (!allowNative && previous.payload?.operation)) return null;
          return { commandId: previous.id, claimId: requestClaimId, conversationId, executionId, payload: previous.payload!,
            ...await this.dispatchAuthority(tx,scope,previous) };
        }
      }
      const control = await this.control(tx, scope, conversationId);
      const active = await tx.query(`SELECT 1 FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2 AND state='dispatching'`, [scope.workspaceId, conversationId]);
      if (active.rowCount) return null;
      const row = (await tx.query<Command>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
        AND state='queued' AND (NOT $3::boolean OR payload->'operation'->>'kind'='goal')
        AND ($4::boolean OR NOT (payload ? 'operation'))
        ORDER BY position LIMIT 1 FOR UPDATE`, [scope.workspaceId, conversationId,control.paused,allowNative])).rows[0];
      if (!row) return null;
      const claimId = requestClaimId ?? randomUUID();
      await tx.query(`UPDATE cloud_workspace_commands SET state='dispatching',engine_instance_id=$3,generation=$4,execution_id=$5,claim_id=$6,updated_at=now()
        WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId, row.id, scope.engineInstanceId, scope.generation, executionId, claimId]);
      await this.bump(tx, scope, conversationId);
      return { commandId: row.id, claimId, conversationId, executionId, payload: row.payload!,
        ...await this.dispatchAuthority(tx,scope,row) };
    });
  }
  async confirmGoal(scope:CloudCommandEngineScope,input:z.infer<typeof CloudGoalConfirmationSchema>) {
    input=CloudGoalConfirmationSchema.parse(input);
    return withSystemTx(this.options.pool,async tx=>{
      await this.authorize(tx,scope);
      const row=(await tx.query<Command & {conversation_id:string}>(`SELECT * FROM cloud_workspace_commands
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[scope.workspaceId,input.commandId])).rows[0];
      if(!row||row.claim_id!==input.claimId||row.engine_instance_id!==scope.engineInstanceId||row.generation!==scope.generation)
        throw new CloudCommandError("command_conflict","Goal dispatch authority changed");
      const previous=row.result?.goalSequence??0;
      if(input.sequence<=previous){
        if(input.sequence===previous&&canonical(row.result?.goal??null)!==canonical(input.goal))
          throw new CloudCommandError("command_conflict","Goal confirmation identity changed");
        return goalSnapshot(row.conversation_id,row.result)!;
      }
      if(row.state!=="dispatching"||row.payload?.agentId!=="codex"||(await this.dispatchAuthority(tx,scope,row)).dispatchAllowed===false)
        throw new CloudCommandError("command_conflict","Goal execution is no longer admitted");
      const control=await this.control(tx,scope,row.conversation_id);
      const result={...row.result,version:1 as const,goal:input.goal,goalSequence:input.sequence,goalRevision:safeInteger(control.revision)+1};
      await tx.query(`UPDATE cloud_workspace_commands SET result=$3::jsonb WHERE workspace_id=$1 AND id=$2`,[scope.workspaceId,input.commandId,JSON.stringify(result)]);
      await this.bump(tx,scope,row.conversation_id);
      return goalSnapshot(row.conversation_id,result)!;
    });
  }
  async settle(scope: CloudCommandEngineScope, input: z.infer<typeof CloudCommandSettleSchema>) {
    const valid = CloudCommandSettleSchema.safeParse(input);
    if (!valid.success) throw new CloudCommandError("invalid_command", "Invalid command result");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      const row = (await tx.query<Command & { conversation_id: string }>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [scope.workspaceId, input.commandId])).rows[0];
      if (!row || row.claim_id !== input.claimId || row.engine_instance_id !== scope.engineInstanceId || row.generation !== scope.generation)
        throw new CloudCommandError("command_conflict", "Command dispatch authority changed");
      // Older engines collapse a pre-provider admission refusal to a generic
      // failure. Keep the server's exact denial, including settlement replays.
      const admissionDenied=isCloudAgentAdmissionCode(row.result_code);
      const state=admissionDenied?"failed":input.state;
      const resultCode=admissionDenied?row.result_code:input.resultCode;
      let result:Command["result"]=row.result||input.result?{...row.result,...input.result,version:1,
        ...(row.result?.goalRevision!==undefined?{goal:row.result.goal,goalRevision:row.result.goalRevision,
          ...(row.result.goalSequence!==undefined?{goalSequence:row.result.goalSequence}:{})}:{})}:null;
      if (row.state !== "dispatching") {
        if (row.state !== state || row.result_code !== resultCode || canonical(row.result ?? null) !== canonical(result))
          throw new CloudCommandError("command_conflict", "Command result already settled");
        return { ...(await this.view(tx, scope, row.conversation_id)), replayed: true };
      }
      const control=await this.control(tx, scope, row.conversation_id);
      if(result&&"goal" in result&&result.goalRevision===undefined)result={...result,goalRevision:safeInteger(control.revision)+1};
      await tx.query(`UPDATE cloud_workspace_commands SET state=$3,result_code=$4,result=$5::jsonb,payload=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, input.commandId, state, resultCode, result ? JSON.stringify(result) : null]);
      await this.bump(tx, scope, row.conversation_id);
      return { ...(await this.view(tx, scope, row.conversation_id)), replayed: false };
    });
  }
}

type LocalWriterScope = CloudCommandEngineScope & { workosEnabled?: boolean };
type LocalWriter = {
  writer_epoch: string; boot_id: string; generation: number; engine_instance_id: string;
  funding_owner_user_id: string; funding_owner_epoch: string; state: "reserved" | "active" | "retired";
};

/** Called only inside the authenticated bootstrap transaction. Reservation is
 * metadata, never native permission or advertisement of an active dispatcher. */
export async function reserveLocalCloudCommandWriter(
  tx: Tx, scope: LocalWriterScope, bootId: string, fundingOwnerUserId: string, fundingOwnerEpoch: number,
): Promise<string> {
  if (!uuid.safeParse(bootId).success || !uuid.safeParse(fundingOwnerUserId).success ||
      !Number.isSafeInteger(fundingOwnerEpoch) || fundingOwnerEpoch < 1)
    throw new CloudCommandError("command_conflict", "Invalid cloud command boot binding");
  await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: scope.workosEnabled === true });
  const binding = (await tx.query<{ owner_user_id: string | null; agent_funding_owner_epoch: string; runtime_boot_id: string | null }>(
    `SELECT workspace.owner_user_id,workspace.agent_funding_owner_epoch,engine.runtime_boot_id
      FROM cloud_workspaces workspace JOIN cloud_workspace_engine_instances engine
        ON engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=workspace.current_generation
      WHERE workspace.id=$1 AND workspace.org_id=$2 AND engine.id=$3 AND engine.generation=$4`,
    [scope.workspaceId, scope.organizationId, scope.engineInstanceId, scope.generation])).rows[0];
  if (!binding || binding.owner_user_id !== fundingOwnerUserId || binding.runtime_boot_id !== bootId ||
      binding.agent_funding_owner_epoch !== String(fundingOwnerEpoch))
    throw new CloudCommandError("command_conflict", "Cloud command boot binding is no longer current");
  const existing = await tx.query<LocalWriter>(`SELECT writer_epoch,boot_id,generation,engine_instance_id,
    funding_owner_user_id,funding_owner_epoch,state FROM cloud_workspace_local_command_writers
    WHERE workspace_id=$1 AND org_id=$2 AND engine_instance_id=$3 FOR UPDATE`,
  [scope.workspaceId, scope.organizationId, scope.engineInstanceId]);
  if (existing.rows.length) {
    const writer = existing.rows[0]!;
    if (existing.rows.length !== 1 || writer.boot_id !== bootId || writer.generation !== scope.generation ||
        writer.funding_owner_user_id !== fundingOwnerUserId || writer.funding_owner_epoch !== String(fundingOwnerEpoch) || writer.state === "retired")
      throw new CloudCommandError("command_conflict", "Cloud command writer identity is immutable");
    return writer.writer_epoch;
  }
  const epoch = randomUUID();
  await tx.query(`INSERT INTO cloud_workspace_local_command_writers
    (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId, bootId, epoch, fundingOwnerUserId, fundingOwnerEpoch]);
  return epoch;
}

/** Private ledger cutover only. Its caller separately proves cache/local-ledger
 * readiness and native/source retirement before exposing the new mode. A
 * retired/missing predecessor is never inferred from lease expiry or a new
 * engine. The exact workspace pointer and mode commit in this SAME transaction. */
export async function activateLocalCloudCommandWriter(
  tx: Tx, scope: LocalWriterScope, binding: { bootId: string; writerEpoch: string },
): Promise<void> {
  if (!uuid.safeParse(binding.bootId).success || !uuid.safeParse(binding.writerEpoch).success)
    throw new CloudCommandError("command_conflict", "Invalid cloud command writer binding");
  await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: scope.workosEnabled === true });
  const writer = (await tx.query<LocalWriter>(`SELECT writer_epoch,boot_id,generation,engine_instance_id,
    funding_owner_user_id,funding_owner_epoch,state FROM cloud_workspace_local_command_writers
    WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 FOR UPDATE`,
  [scope.workspaceId, scope.organizationId, binding.writerEpoch])).rows[0];
  if (!writer || writer.boot_id !== binding.bootId || writer.engine_instance_id !== scope.engineInstanceId ||
      writer.generation !== scope.generation || writer.state === "retired")
    throw new CloudCommandError("command_conflict", "Cloud command writer is unavailable");
  // Recheck the actual current funding owner/epoch and persisted boot witness.
  await reserveLocalCloudCommandWriter(tx, scope, binding.bootId, writer.funding_owner_user_id, safeInteger(writer.funding_owner_epoch));
  const predecessor = await tx.query(`SELECT 1 FROM cloud_workspace_local_command_writers
    WHERE workspace_id=$1 AND org_id=$2 AND state='active' AND writer_epoch<>$3 LIMIT 1`,
  [scope.workspaceId, scope.organizationId, binding.writerEpoch]);
  const legacy = await tx.query(`SELECT 1 FROM cloud_workspace_commands
    WHERE workspace_id=$1 AND org_id=$2 AND state IN ('queued','dispatching') LIMIT 1`,
  [scope.workspaceId, scope.organizationId]);
  if (predecessor.rowCount || legacy.rowCount)
    throw new CloudCommandError("command_conflict", "Cloud command writer retirement is pending");
  if (writer.state === "reserved") await tx.query(`UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now()
    WHERE workspace_id=$1 AND writer_epoch=$2`, [scope.workspaceId, binding.writerEpoch]);
}
