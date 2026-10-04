import {z} from "zod";
import { CloudRepositoryMcpSchema, CloudCustomizationSnapshotSchema } from "./cloud-customization";
import type { CloudCustomizationOperation } from "./cloud-customization";

export const CloudGitAuthorSchema=z.object({
  name:z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f<>]+$/),
  email:z.string().regex(/^[1-9][0-9]{0,15}\+[A-Za-z0-9_-]{1,100}@users\.noreply\.github\.com$/),
}).strict();
export type CloudGitAuthor=z.infer<typeof CloudGitAuthorSchema>;

/** Private control-plane ↔ trusted engine protocol. Material never belongs in
 * a workspace RPC, event, durable record, tool request, or diagnostic object. */
const uuid=z.uuid(),identity=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const CloudNativeCapabilitiesSchema=z.object({version:z.literal(1),
  goals:z.boolean(),nativeFork:z.boolean(),transcriptFork:z.boolean(),nativeReview:z.boolean(),connectedApps:z.boolean(),multiAgent:z.boolean(),
}).strict();
export type CloudNativeCapabilities=z.infer<typeof CloudNativeCapabilitiesSchema>;
/** Bounded live snapshot, read only while the exact execution lease is valid.
 * Transcript events own completed output; these records never restart work. */
export const CloudBackgroundSnapshotSchema=z.object({
  tasks:z.array(z.object({taskId:z.string().min(1).max(256),name:z.string().min(1).max(512),
    startedAt:z.number().nonnegative().finite(),updatedAt:z.number().nonnegative().finite(),
    taskType:z.string().max(128).optional(),command:z.string().max(2048).optional(),summary:z.string().max(2048).optional(),
    lastToolName:z.string().max(128).optional(),scheduledFor:z.number().nonnegative().finite().optional()}).strict()).max(64),
  waiting:z.boolean(),processWork:z.boolean(),
  activity:z.object({state:z.enum(["running","idle","requires_action"]),startedAt:z.number().nonnegative().finite()}).strict().nullable().optional(),
}).strict();
export type CloudBackgroundSnapshot=z.infer<typeof CloudBackgroundSnapshotSchema>;
export const CloudBackgroundStateSchema=z.object({version:z.literal(1),leaseId:uuid,conversationId:identity,
  phase:z.enum(["foreground","background"]),deadline:z.iso.datetime(),revision:z.number().int().nonnegative().safe(),snapshot:CloudBackgroundSnapshotSchema}).strict();
export type CloudBackgroundOperation={kind:"retain"|"sync";conversationId:string;revision:number;snapshot:CloudBackgroundSnapshot}|
  {kind:"resume";conversationId:string;admission:CloudAgentExecutionAdmission}|{kind:"read";conversationId:string};
const token=z.string().min(16).max(16_384).regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/);
export const CloudAgentProviderSchema=z.enum(["claude","cursor","codex"]);
export const CloudWorkerRuntimeProfileSchema=z.enum(["zeros-cloud-worker-v3","zeros-cloud-worker-v4"]);
export type CloudWorkerRuntimeProfile=z.infer<typeof CloudWorkerRuntimeProfileSchema>;
/** Public diagnostic only: independent of the strict v1 native qualification
 * and private authority responses, so older workers/control planes remain
 * compatible. Absence or an unknown version never implies Browser readiness. */
const cloudBrowserScope = {
  version: z.literal(1),
  provider: CloudAgentProviderSchema,
  runtimeProfile: CloudWorkerRuntimeProfileSchema,
  credentialKind: z.enum(["claude-api-key", "claude-setup-token", "cursor-api-key", "codex-api-key", "codex-chatgpt", "unknown"]),
};
export const CloudBrowserCapabilitySchema = z.discriminatedUnion("state", [
  z.object({ ...cloudBrowserScope, state: z.literal("unavailable"), reason: z.enum([
    "codex-runtime-unavailable", "claude-direct-login-required", "provider-unsupported", "not-reported", "scope-mismatch",
  ]) }).strict(),
  z.object({ ...cloudBrowserScope, state: z.literal("disabled") }).strict(),
  z.object({ ...cloudBrowserScope, state: z.literal("ready"), qualifiedVersion: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict(),
]).superRefine((value, context) => {
  if (value.credentialKind === "unknown" ? value.state === "ready" : !value.credentialKind.startsWith(`${value.provider}-`))
    context.addIssue({ code: "custom", message: "Browser capability scope is inconsistent" });
});
export type CloudBrowserCapability = z.infer<typeof CloudBrowserCapabilitySchema>;
export const CloudAgentExecutionAdmissionSchema=z.object({executionId:identity,delegationId:uuid,provider:CloudAgentProviderSchema,
  model:z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/),source:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("session"),actorSessionId:uuid}).strict(),
    z.object({kind:z.literal("command"),commandId:uuid,claimId:uuid}).strict(),
  ]),customization:z.object({version:z.union([z.literal(1),z.literal(2)]),repositoryServers:CloudRepositoryMcpSchema}).strict().optional()}).strict();
export const CloudAgentAccessMaterialSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("claude-api-key"),apiKey:token}).strict(),
  z.object({kind:z.literal("claude-setup-token"),accessToken:token}).strict(),
  z.object({kind:z.literal("cursor-api-key"),apiKey:token}).strict(),
  z.object({kind:z.literal("codex-api-key"),apiKey:token}).strict(),
  z.object({kind:z.literal("codex-chatgpt"),accessToken:token,accountId:z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
    expiresAt:z.number().int().positive().max(4_102_444_800)}).strict(),
]);
const codexAccess=z.object({kind:z.literal("codex-chatgpt"),accessToken:token,accountId:z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  expiresAt:z.number().int().positive().max(4_102_444_800)}).strict();
export const CloudAgentExecutionLeaseSchema=z.object({leaseId:uuid,expiresAt:z.iso.datetime(),credentialVersion:z.number().int().positive().safe(),
  nativeCapabilities:CloudNativeCapabilitiesSchema.optional(),
  rotation:z.object({authorityId:z.string().regex(/^[a-f0-9]{64}$/),material:codexAccess}).strict().optional()}).strict();
export const CloudAgentExecutionAuthoritySchema=CloudAgentExecutionLeaseSchema.extend({authorityId:z.string().regex(/^[a-f0-9]{64}$/),
  backgroundTasksVersion:z.literal(1).optional(),
  credentialKind:z.enum(["claude-api-key","claude-setup-token","cursor-api-key","codex-api-key","codex-chatgpt"]),
  provider:CloudAgentProviderSchema,model:z.string().min(1).max(256),material:CloudAgentAccessMaterialSchema,
  gitAuthor:CloudGitAuthorSchema.nullable().optional(),customization:CloudCustomizationSnapshotSchema.optional()}).strict().superRefine((value,context)=>{
    if(value.material.kind!==value.credentialKind||!value.credentialKind.startsWith(`${value.provider}-`))
      context.addIssue({code:"custom",message:"Provider authority is inconsistent"});
  });
export type CloudAgentExecutionAdmission=z.infer<typeof CloudAgentExecutionAdmissionSchema>;
export type CloudAgentAccessMaterial=z.infer<typeof CloudAgentAccessMaterialSchema>;
export type CloudAgentExecutionAuthority=z.infer<typeof CloudAgentExecutionAuthoritySchema>;
export type CloudAgentExecutionLease=z.infer<typeof CloudAgentExecutionLeaseSchema>;
export const CloudAgentActionAuthoritySchema=z.object({authorized:z.literal(true),executionId:identity,actorSessionId:uuid}).strict();
export type CloudAgentExecutionRequest={kind:"admit";admission:CloudAgentExecutionAdmission;includeGitAuthor?:boolean;nativeCapabilitiesVersion?:1;backgroundTasksVersion?:1}|{kind:"validate";leaseId:string;renew?:boolean;credentialVersion?:number;nativeCapabilitiesVersion?:1}|
  {kind:"refresh-codex";leaseId:string;credentialVersion:number;nativeCapabilitiesVersion?:1}|{kind:"release";leaseId:string}|
  {kind:"background";leaseId:string;operation:CloudBackgroundOperation}|
  {kind:"authorize-action";executionId:string;actorSessionId:string}|
  {kind:"customization";actorSessionId:string;operation:CloudCustomizationOperation;params:Record<string,unknown>};
