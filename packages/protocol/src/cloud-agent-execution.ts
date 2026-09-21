import {z} from "zod";

/** Private control-plane ↔ trusted engine protocol. Material never belongs in
 * a workspace RPC, event, durable record, tool request, or diagnostic object. */
const uuid=z.uuid(),identity=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const token=z.string().min(16).max(16_384).regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/);
export const CloudAgentProviderSchema=z.enum(["claude","cursor","codex"]);
export const CloudAgentExecutionAdmissionSchema=z.object({executionId:identity,delegationId:uuid,provider:CloudAgentProviderSchema,
  model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),source:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("session"),actorSessionId:uuid}).strict(),
    z.object({kind:z.literal("command"),commandId:uuid,claimId:uuid}).strict(),
  ])}).strict();
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
  rotation:z.object({authorityId:z.string().regex(/^[a-f0-9]{64}$/),material:codexAccess}).strict().optional()}).strict();
export const CloudAgentExecutionAuthoritySchema=CloudAgentExecutionLeaseSchema.extend({authorityId:z.string().regex(/^[a-f0-9]{64}$/),
  credentialKind:z.enum(["claude-api-key","claude-setup-token","cursor-api-key","codex-api-key","codex-chatgpt"]),
  provider:CloudAgentProviderSchema,model:z.string().min(1).max(256),material:CloudAgentAccessMaterialSchema}).strict().superRefine((value,context)=>{
    if(value.material.kind!==value.credentialKind||!value.credentialKind.startsWith(`${value.provider}-`))
      context.addIssue({code:"custom",message:"Provider authority is inconsistent"});
  });
export type CloudAgentExecutionAdmission=z.infer<typeof CloudAgentExecutionAdmissionSchema>;
export type CloudAgentAccessMaterial=z.infer<typeof CloudAgentAccessMaterialSchema>;
export type CloudAgentExecutionAuthority=z.infer<typeof CloudAgentExecutionAuthoritySchema>;
export type CloudAgentExecutionLease=z.infer<typeof CloudAgentExecutionLeaseSchema>;
export const CloudAgentActionAuthoritySchema=z.object({authorized:z.literal(true),executionId:identity,actorSessionId:uuid}).strict();
export type CloudAgentExecutionRequest={kind:"admit";admission:CloudAgentExecutionAdmission}|{kind:"validate";leaseId:string;renew?:boolean;credentialVersion?:number}|
  {kind:"refresh-codex";leaseId:string;credentialVersion:number}|{kind:"release";leaseId:string}|
  {kind:"authorize-action";executionId:string;actorSessionId:string};
