import { z } from "zod";
import { CloudCommandActorSchema } from "./cloud-actors";
import { CloudNativeCapabilitiesSchema } from "./cloud-agent-execution";
import type { BridgeAgentFailure } from "./messages";

/** Safe diagnostics carried in the existing resultCode field. Never encode
 * provider prose, paths, HTTP bodies or credential material in a receipt. */
export const CLOUD_COMMAND_FAILURE_STAGES = ["validation", "admission", "containment", "provider_start", "provider_prompt"] as const;
export const CLOUD_COMMAND_FAILURE_CATEGORIES = [
  "rejected", "authority_unavailable", "authority_timeout", "authority_transport", "authority_http_4xx", "authority_http_5xx",
  "authority_response_invalid", "canary_failed", "attestation_failed", "timeout", "auth_required", "verification_required",
  "cloud_credential_error", "subprocess_exited", "protocol_error", "transport_closed", "lifecycle_superseded", "rate_limited",
  "design_protection_failed", "session_expired",
] as const;
export type CloudCommandFailureCause = {
  stage: typeof CLOUD_COMMAND_FAILURE_STAGES[number];
  category: typeof CLOUD_COMMAND_FAILURE_CATEGORIES[number];
};
export function encodeCloudCommandFailure(cause: CloudCommandFailureCause): string {
  const code = `cloud_${cause.stage}_${cause.category}`;
  if (!decodeCloudCommandFailure(code)) throw new Error("Invalid cloud command failure cause");
  return code;
}
export function decodeCloudCommandFailure(value: unknown): CloudCommandFailureCause | null {
  if (typeof value !== "string" || value.length > 64) return null;
  for (const stage of CLOUD_COMMAND_FAILURE_STAGES) {
    const prefix = `cloud_${stage}_`;
    if (!value.startsWith(prefix)) continue;
    const category = value.slice(prefix.length);
    if ((CLOUD_COMMAND_FAILURE_CATEGORIES as readonly string[]).includes(category))
      return { stage, category: category as CloudCommandFailureCause["category"] };
  }
  return null;
}
const cloudFailureKinds: Partial<Record<CloudCommandFailureCause["category"], BridgeAgentFailure["kind"]>> = {
  timeout: "timeout", auth_required: "auth-required", verification_required: "verification-required",
  cloud_credential_error: "cloud-credentials-unavailable", subprocess_exited: "subprocess-exited", protocol_error: "protocol-error",
  transport_closed: "transport-closed", lifecycle_superseded: "lifecycle-superseded", rate_limited: "rate-limited",
  design_protection_failed: "design-protection-failed", session_expired: "session-expired",
};
/** A receipt restores safe guidance when the richer native notice was lost. */
export function cloudCommandFailureFromCode(value: unknown, agentId?: string): BridgeAgentFailure | null {
  const cause = decodeCloudCommandFailure(value);
  if (!cause) return null;
  const stageLabel = { validation: "Cloud command validation", admission: "Cloud agent execution admission",
    containment: "Cloud agent containment", provider_start: "Cloud provider startup", provider_prompt: "Cloud provider prompt" }[cause.stage];
  const guidance = cause.category === "verification_required" ? "Account verification is required. Complete verification with the provider before retrying."
    : cause.category === "cloud_credential_error" ? "Cloud credentials are unavailable. Review the provider connection before retrying."
    : cause.category === "auth_required" ? "Connect the provider before retrying."
    : cause.category === "rate_limited" ? "The provider reached a usage limit. Retry after the limit resets."
    : cause.category === "canary_failed" ? "The runtime safety check failed. Review the workspace runtime before retrying."
    : cause.category === "attestation_failed" ? "The runtime attestation failed. Review the workspace runtime before retrying."
    : "Review the conversation before retrying.";
  return { kind: cloudFailureKinds[cause.category] ?? "protocol-error", agentId,
    stage: cause.stage === "provider_prompt" ? "prompt" : cause.stage === "provider_start" ? "newSession" : "initialize",
    message: `${stageLabel} failed (${cause.category}). ${guidance}` };
}
/** Native boundaries choose the stage; only closed native kinds may refine
 * it. An already typed inner cause keeps its original stage/category. */
export function cloudCommandFailureCode(error: unknown, stage: CloudCommandFailureCause["stage"]): string {
  const value = error && typeof error === "object" ? error as { code?: unknown; failure?: { kind?: unknown } } : null;
  if (decodeCloudCommandFailure(value?.code)) return value!.code as string;
  const kind = value?.failure?.kind;
  const category = Object.entries(cloudFailureKinds).find(([, candidate]) => candidate === kind)?.[0] as CloudCommandFailureCause["category"] | undefined;
  return encodeCloudCommandFailure({ stage, category: category ?? "rejected" });
}
export class CloudCommandFailureError extends Error {
  readonly code: string;
  readonly failure: BridgeAgentFailure;
  constructor(readonly diagnosis: CloudCommandFailureCause) {
    const code = encodeCloudCommandFailure(diagnosis);
    super(code);
    this.name = "CloudCommandFailureError";
    this.code = code;
    this.failure = cloudCommandFailureFromCode(code)!;
  }
}

/** Native permission vocabulary carried with each immutable queued command. */
export const CLOUD_AGENT_PERMISSION_MODES = {
  claude: ["default", "accept-edits", "plan", "auto", "bypass"],
  codex: ["ask", "auto-edit", "full-access", "read-only"],
  cursor: ["plan", "auto", "agent"],
} as const;
export function cloudPermissionMode(agentId: string, value: unknown = "auto"): string {
  const modes: readonly string[] | undefined = CLOUD_AGENT_PERMISSION_MODES[agentId as keyof typeof CLOUD_AGENT_PERMISSION_MODES];
  const posture = agentId === "codex" ? {auto:"auto-edit",danger:"full-access",plan:"read-only","tool-approval":"ask"}
    : agentId === "claude" ? {danger:"bypass","tool-approval":"default"}
    : {danger:"agent","tool-approval":"plan"};
  const mode = typeof value === "string" ? (posture as Record<string,string>)[value] ?? value : "";
  if (!modes?.includes(mode)) throw new Error("Unsupported agent permission mode");
  return mode;
}

// Portable workspace bridge contract; no Electron, provider or host paths.
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().safe().nonnegative();
export const CloudGoalUpdateSchema = z.object({
  objective: z.string().trim().min(1).max(32_768).optional(),
  status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).optional(),
  tokenBudget: z.number().int().safe().positive().nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export const CloudNativeOperationSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("fork"), sourceConversationId: identity,
    strategy: z.enum(["native", "transcript"]) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("goal"), action: z.enum(["get", "set", "clear"]), update: CloudGoalUpdateSchema.optional() }).strict(),
]).refine(value => value.kind !== "goal" || (value.action === "set") === (value.update !== undefined));
export const CloudNativeResultSchema = z.object({ version: z.literal(1),
  capabilities: CloudNativeCapabilitiesSchema.optional(), model: z.string().min(1).max(256).optional(),
  goal: z.object({ objective: z.string().max(32_768),
    status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
    tokenBudget: z.number().int().safe().nonnegative().nullable(), tokensUsed: revision,
    timeUsedSeconds: z.number().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
  }).strict().nullable().optional(),
}).strict();
export const CloudConversationCreateSchema = z.object({ conversationId: identity, workspaceId: identity,
  sourceConversationId: identity.optional(),
  agentId: identity, model: z.string().max(256).optional(), effort: z.string().max(64).optional(), title: z.string().max(1024).optional() }).strict();
export const CloudConversationReadSchema = z.object({ conversationId: identity }).strict();
export const CloudConversationModeSchema = z.object({ conversationId: identity, mode: z.enum(["code", "design"]), expectedRevision: revision }).strict();
const annotations = z.object({ audience: z.array(z.enum(["user", "assistant"])).max(2).optional(),
  lastModified: z.string().max(128).optional(), priority: z.number().min(0).max(1).optional() }).strict().optional();
const text = z.string().max(192 * 1024);
const uri = z.string().min(1).max(8192);
const mimeType = z.string().min(1).max(256);
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text, annotations }).strict(),
  z.object({ type: z.literal("image"), data: text, mimeType, uri: uri.optional(), annotations }).strict(),
  z.object({ type: z.literal("audio"), data: text, mimeType, annotations }).strict(),
  z.object({ type: z.literal("resource_link"), uri, name: z.string().max(1024),
    description: text.optional(), mimeType: mimeType.optional(), size: revision.optional(), title: z.string().max(1024).optional(), annotations }).strict(),
  z.object({ type: z.literal("resource"), annotations, resource: z.union([
    z.object({ uri, text, mimeType: mimeType.optional() }).strict(),
    z.object({ uri, blob: text, mimeType: mimeType.optional() }).strict(),
  ]) }).strict(),
]);
export const CloudQueuedPromptSchema = z.object({
  agentId: identity, userMessageId: identity, prompt: z.array(content).min(1).max(128),
  bubble: z.record(z.string(), z.unknown()).optional(), modeRevision: revision,
  permissionMode:z.string().min(1).max(32).optional(),
  agentCredentialGrantId:z.uuid().optional(),
  model:z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/).optional(),
  effort:z.enum(["low","medium","high","xhigh","max","ultracode"]).optional(),fast:z.boolean().optional(),
  operation: CloudNativeOperationSchema.optional(),
}).strict().superRefine((value,context)=>{
  if (value.operation && (!value.agentCredentialGrantId || !value.model ||
    (value.operation.kind !== "fork" && value.agentId !== "codex") ||
    (value.operation.kind === "fork" && value.operation.strategy === "native" && value.agentId !== "codex")))
    context.addIssue({code:"custom",message:"Native operations require explicit provider credential admission"});
  if(value.permissionMode !== undefined) {
    const modes: readonly string[] | undefined = CLOUD_AGENT_PERMISSION_MODES[value.agentId as keyof typeof CLOUD_AGENT_PERMISSION_MODES];
    if (!modes?.includes(value.permissionMode)) context.addIssue({code:"custom",message:"Invalid provider permission mode"});
  }
  if(value.agentCredentialGrantId&&(!value.model||!["claude","cursor","codex"].includes(value.agentId)))
    context.addIssue({code:"custom",message:"Personal credential execution requires an explicit provider and model"});
});
export const CloudCommandMutationSchema = z.object({
  conversationId: identity, operationId: z.uuid(), expectedRevision: revision,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enqueue"), commandId: z.uuid(), payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("fork"), commandId: z.uuid(), payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("edit"), commandId: z.uuid(), payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("remove"), commandId: z.uuid() }).strict(),
    z.object({ kind: z.literal("pause") }).strict(), z.object({ kind: z.literal("resume") }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const action = value.action;
  if (action.kind === "fork" && (action.payload.operation?.kind !== "fork" ||
      action.payload.operation.sourceConversationId === value.conversationId))
    context.addIssue({code:"custom",message:"Fork requires distinct source and destination conversations"});
  if ((action.kind === "enqueue" || action.kind === "edit") && action.payload.operation?.kind === "fork")
    context.addIssue({code:"custom",message:"Forks require the fork action"});
});
export const CloudCommandClientRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), conversationId: identity }).strict(),
  z.object({ kind: z.literal("read"), commandId: z.uuid() }).strict(),
  z.object({ kind: z.literal("mutate"), mutation: CloudCommandMutationSchema }).strict(),
  z.object({ kind: z.literal("stop"), conversationId: identity, operationId: z.uuid() }).strict(),
]);
export const CloudCommandEntrySchema = z.object({
  commandId: z.uuid(), position: revision, state: z.enum(["queued", "dispatching", "succeeded", "failed", "cancelled", "uncertain"]),
  payload: CloudQueuedPromptSchema.nullable(), executionId: identity.nullable(), generation: revision,
  resultCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  result: CloudNativeResultSchema.nullable().optional(),
}).strict();
export const CloudGoalSnapshotSchema = z.object({version:z.literal(1),conversationId:identity,revision,
  goal:CloudNativeResultSchema.shape.goal.unwrap()}).strict();
export type CloudGoalSnapshot=z.infer<typeof CloudGoalSnapshotSchema>;
export const CloudCommandSnapshotSchema = z.object({
  version: z.literal(1), conversationId: identity, revision, paused: z.boolean(),
  pending: z.array(CloudCommandEntrySchema).max(32), receipts: z.array(CloudCommandEntrySchema).max(50),
  replayed: z.boolean().optional(),
  nativeGoal: CloudGoalSnapshotSchema.optional(),
}).strict();
export const CloudCommandClaimSchema = z.object({
  commandId: z.uuid(), claimId: z.uuid(), conversationId: identity, executionId: identity, payload: CloudQueuedPromptSchema,
  dispatchAllowed:z.boolean().optional(),actor:CloudCommandActorSchema.optional(),
}).strict().superRefine((claim,context)=>{
  if ((claim.dispatchAllowed===true)!==(claim.actor!==undefined))
    context.addIssue({code:"custom",message:"Actor dispatch authority is incomplete"});
});
export type CloudQueuedPrompt = z.infer<typeof CloudQueuedPromptSchema>;
export type CloudCommandMutation = z.infer<typeof CloudCommandMutationSchema>;
export type CloudCommandClientRequest = z.infer<typeof CloudCommandClientRequestSchema>;
export type CloudCommandSnapshot = z.infer<typeof CloudCommandSnapshotSchema>;
export type CloudCommandClaim = z.infer<typeof CloudCommandClaimSchema>;
export type CloudNativeOperation = z.infer<typeof CloudNativeOperationSchema>;

/** Older attachments can still observe/cancel their prompt queue. Native
 * utility payloads and receipts are opaque until the client opts into v1. */
export function legacyCloudCommandResponse(value:unknown):unknown {
  if(!value||typeof value!=="object"||Array.isArray(value))return value;
  const {nativeGoal:_goal,...row}=value as Record<string,unknown>;
  const entry=(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))return value;
    const {result:_result,...rest}=value as Record<string,unknown>;
    return rest.payload&&typeof rest.payload==="object"&&"operation" in rest.payload?{...rest,payload:null}:rest;
  };
  return Array.isArray(row.pending)&&Array.isArray(row.receipts)
    ?{...row,pending:row.pending.map(entry),receipts:row.receipts.map(entry)}:entry(row);
}
export type CloudCommandResult = { commandId: string; claimId: string; state: "succeeded" | "failed" | "cancelled"; resultCode: string | null; result?: z.infer<typeof CloudNativeResultSchema> };
export type CloudCommandEngineRequest = Exclude<CloudCommandClientRequest, { kind: "mutate" }> |
  { kind: "mutate"; mutation: CloudCommandMutation; admissionError: "command_context_changed" | "command_not_found" | null } |
  { kind: "claim"; conversationId: string; executionId: string; claimId?: string } |
  { kind: "confirm-goal"; commandId:string; claimId:string; sequence:number; goal:CloudGoalSnapshot["goal"] } |
  { kind: "settle"; result: CloudCommandResult };
