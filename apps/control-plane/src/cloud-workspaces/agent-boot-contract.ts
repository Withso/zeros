// Standalone mirror of protocol/cloud-agent-bootstrap; the control plane deploys independently.
import { z } from "zod";
import { CLOUD_AGENT_ADMISSION_CODES } from "./agent-admission-errors.js";
import { CloudMcpServerSchema, CloudSkillSchema } from "./mcp-contract.js";
import { CloudComputerV2EnvironmentOperationSchema } from "./computer-v2-contract.js";

const token = z.string().min(16).max(16_384).regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/);
export const CloudAgentProviderSchema = z.enum(["claude", "cursor", "codex"]);
export const CloudAgentAccessMaterialSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("claude-api-key"),apiKey:token}).strict(),
  z.object({kind:z.literal("claude-setup-token"),accessToken:token}).strict(),
  z.object({kind:z.literal("cursor-api-key"),apiKey:token}).strict(),
  z.object({kind:z.literal("codex-api-key"),apiKey:token}).strict(),
  z.object({kind:z.literal("codex-chatgpt"),accessToken:token,
    accountId:z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
    expiresAt:z.number().int().positive().max(4_102_444_800)}).strict(),
]);
export type CloudAgentAccessMaterial = z.infer<typeof CloudAgentAccessMaterialSchema>;
export const CloudNativeCapabilitiesSchema = z.object({version:z.literal(1),goals:z.boolean(),
  nativeFork:z.boolean(),transcriptFork:z.boolean(),nativeReview:z.boolean(),connectedApps:z.boolean(),multiAgent:z.boolean()}).strict();
const CloudCommandActorSchema = z.object({userId:z.string().uuid(),deviceId:z.string().uuid(),
  deviceKeyVersion:z.number().int().positive().safe(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  role:z.enum(["viewer","prompter","developer","manager","owner"])}).strict();
function cloudActorCan(role:z.infer<typeof CloudCommandActorSchema>["role"],capability:"run") {
  return capability === "run" && role !== "viewer";
}
const nativeServer = z.discriminatedUnion("transport", [
  CloudMcpServerSchema.options[0].omit({id:true}),
  CloudMcpServerSchema.options[1].omit({id:true}),
  CloudMcpServerSchema.options[2].omit({id:true}),
]);
const CloudRepositoryMcpSchema = z.array(nativeServer).max(32).refine(values=>new Set(values.map(value=>value.name)).size===values.length);
const history = z.object({owner:z.string().regex(/^[a-f0-9]{64}$/),currentKeyVersion:z.number().int().positive(),
  keys:z.record(z.string().regex(/^\d+$/),z.string().regex(/^[A-Za-z0-9_-]{43}$/))}).strict();
const CloudCustomizationSnapshotSchema = z.object({version:z.literal(1),digest:z.string().regex(/^[a-f0-9]{64}$/),
  repositoryDigest:z.string().regex(/^[a-f0-9]{64}$/),history:history.optional(),
  servers:z.array(z.object({server:nativeServer,scope:z.enum(["organization","member","repository"]),
    secretRef:z.string().uuid().nullable(),revision:z.number().int().nonnegative().safe()}).strict()).max(64),
  skills:z.array(CloudSkillSchema).max(64),cursorTeamSettings:z.literal("disabled")}).strict();
const CloudComputerExecutionEnvironmentSchema = z.object({version:z.literal(1),revision:z.string().regex(/^[a-f0-9]{64}$/),
  values:z.record(z.string().refine(name=>CloudComputerV2EnvironmentOperationSchema.safeParse({op:"preserve",name}).success),
    z.string().max(65_536).refine(value=>!value.includes("\0")&&Buffer.byteLength(value)<=65_536))
    .refine(values=>Object.keys(values).length<=128&&Object.values(values).reduce((sum,value)=>sum+Buffer.byteLength(value),0)<=512*1024&&Buffer.byteLength(JSON.stringify(values))<=768*1024),
  history}).strict();
const CloudGitAuthorSchema = z.object({name:z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f<>]+$/),
  email:z.string().regex(/^[1-9][0-9]{0,15}\+[A-Za-z0-9_-]{1,100}@users\.noreply\.github\.com$/)}).strict();

const revision = z.number().int().positive().safe();
const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const model = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/);
const timestamp = z.number().int().positive().safe().max(4_102_444_800_000);
const scope = {
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(), generation: revision, engineInstanceId: z.string().uuid(),
};
const bootReference = { ...scope, bootId: z.string().uuid(), writerEpoch: z.string().uuid() };

/** Trusted engine scope only. Neither sender identity nor funding identity is
 * accepted from a workspace RPC or native process. */
export const CloudAgentBootScopeSchema = z.object({
  ...bootReference, fundingOwnerUserId: z.string().uuid(), fundingOwnerEpoch: revision,
}).strict();
export type CloudAgentBootScope = z.infer<typeof CloudAgentBootScopeSchema>;

/** CP chooses the boot/writer and current owner binding. The engine's request
 * cannot substitute a creator, sending member, credential or shared consent. */
export const CloudAgentBootCredentialRequestSchema = z.object({
  ...scope, version: z.literal(1), mode: z.literal("boot-owner-v1"),
}).strict();
export type CloudAgentBootCredentialRequest = z.infer<typeof CloudAgentBootCredentialRequestSchema>;

export const CloudAgentBootIdentitySchema = CloudAgentBootScopeSchema.extend({
  version: z.literal(1), mode: z.literal("boot-owner-v1"), fundingScope: z.literal("workspace-roles-v1"),
  authorityEpoch: revision,
}).strict();
export type CloudAgentBootIdentity = z.infer<typeof CloudAgentBootIdentitySchema>;

const readyEntry = z.object({
  status: z.literal("ready"), provider: CloudAgentProviderSchema,
  credentialId: z.string().uuid(), credentialRevision: revision, connectionRevision: revision, adoptionId: z.string().uuid(),
  displayName: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  kind: z.enum(["claude-api-key", "claude-setup-token", "cursor-api-key", "codex-api-key", "codex-chatgpt"]),
  models: z.array(model).min(1).max(128).refine(values => new Set(values).size === values.length),
  nativeCapabilities: CloudNativeCapabilitiesSchema,
  materialVersion: revision,
  expiresAt: z.string().datetime().nullable(), refreshAfter: z.string().datetime().nullable(),
  /** Real upstream/broker source authorization deadline, independently of
   * native token expiry. Null uses the current engine/actor boot authority. */
  authorityExpiresAt: z.string().datetime().nullable(),
  material: CloudAgentAccessMaterialSchema,
}).strict();
function refineProviderReady(value: z.infer<typeof readyEntry>, context: z.RefinementCtx) {
  if (value.kind !== value.material.kind || !value.kind.startsWith(`${value.provider}-`))
    context.addIssue({ code: "custom", message: "Provider material binding is inconsistent" });
  if (value.material.kind === "codex-chatgpt") {
    if (!value.expiresAt || Date.parse(value.expiresAt) !== value.material.expiresAt * 1000 ||
        !value.refreshAfter || Date.parse(value.refreshAfter) > Date.parse(value.expiresAt))
      context.addIssue({ code: "custom", message: "Access expiry binding is inconsistent" });
  } else if (value.refreshAfter !== null) {
    context.addIssue({ code: "custom", message: "This provider has no boot refresh source" });
  }
}
export const CloudAgentBootProviderReadySchema = readyEntry.superRefine(refineProviderReady);
export type CloudAgentBootProviderReady = z.infer<typeof CloudAgentBootProviderReadySchema>;

export const CloudAgentBootProviderUnavailableSchema = z.object({
  status: z.literal("unavailable"), provider: CloudAgentProviderSchema,
  code: z.enum(CLOUD_AGENT_ADMISSION_CODES),
}).strict();
const provider = z.discriminatedUnion("status", [readyEntry, CloudAgentBootProviderUnavailableSchema]);

/** Nonsecret immutable boot baseline, never cached historical material.
 * Unknown is neither explicit absence nor evidence of an account change. */
export const CloudAgentInitialAdoptionSchema = z.discriminatedUnion("status", [
  z.object({ provider: CloudAgentProviderSchema, status: z.literal("known"), adoptionId: z.string().uuid() }).strict(),
  z.object({ provider: CloudAgentProviderSchema, status: z.literal("missing") }).strict(),
  z.object({ provider: CloudAgentProviderSchema, status: z.literal("unknown") }).strict(),
]);
export type CloudAgentInitialAdoption = z.infer<typeof CloudAgentInitialAdoptionSchema>;
export const CloudAgentInitialAdoptionsSchema = z.array(CloudAgentInitialAdoptionSchema).length(3)
  .refine(values => new Set(values.map(value => value.provider)).size === 3);

/** Exactly one closed slot for each provider. Missing material is never a
 * reason to select another person's account or run legacy admission on Send. */
export const CloudAgentBootCredentialResponseSchema = CloudAgentBootIdentitySchema.extend({
  cacheRevision: revision, desiredCacheRevision: revision,
  initialAdoptions: CloudAgentInitialAdoptionsSchema,
  providers: z.array(provider).length(3).refine(values => new Set(values.map(value => value.provider)).size === 3),
}).strict().superRefine((value, context) => {
  for (const entry of value.providers) if (entry.status === "ready") refineProviderReady(entry, context);
  if (value.desiredCacheRevision < value.cacheRevision ||
      (value.desiredCacheRevision > value.cacheRevision && value.providers.some(entry => entry.status === "ready")))
    context.addIssue({ code: "custom", message: "Credential readiness binding is inconsistent" });
});
export type CloudAgentBootCredentialResponse = z.infer<typeof CloudAgentBootCredentialResponseSchema>;

/** Bootstrap retries keep the binding and return current readiness only.
 * Superseded material is never replayed. A known dirty revision parks new
 * dispatch; only background sync publishes a ready next-run snapshot. Owner
 * transfer never changes the existing boot's funding owner. */
export const CloudAgentBootSyncRequestSchema = z.object({
  ...bootReference, version: z.literal(1), mode: z.literal("boot-owner-v1"), expectedCacheRevision: revision,
}).strict();
export type CloudAgentBootSyncRequest = z.infer<typeof CloudAgentBootSyncRequestSchema>;
export const CloudAgentBootSyncResponseSchema = CloudAgentBootCredentialResponseSchema;
export type CloudAgentBootSyncResponse = z.infer<typeof CloudAgentBootSyncResponseSchema>;
export const CloudAgentBootActivateRequestSchema=CloudAgentBootSyncRequestSchema;
export type CloudAgentBootActivateRequest=z.infer<typeof CloudAgentBootActivateRequestSchema>;
export const CloudAgentBootActivateResponseSchema=CloudAgentBootIdentitySchema.extend({cacheRevision:revision,activated:z.literal(true)}).strict();
export type CloudAgentBootActivateResponse=z.infer<typeof CloudAgentBootActivateResponseSchema>;

export const CloudAgentBootRefreshRequestSchema = z.object({
  ...bootReference, version: z.literal(1), mode: z.literal("boot-owner-v1"), provider: z.literal("codex"),
  credentialId: z.string().uuid(), credentialRevision: revision, expectedCacheRevision: revision, expectedMaterialVersion: revision,
}).strict();
export type CloudAgentBootRefreshRequest = z.infer<typeof CloudAgentBootRefreshRequestSchema>;
export const CloudAgentBootRefreshResponseSchema = CloudAgentBootIdentitySchema.extend({
  cacheRevision: revision, desiredCacheRevision: revision, provider: CloudAgentBootProviderReadySchema,
}).strict().superRefine((value, context) => {
  if (value.provider.provider !== "codex" || value.provider.material.kind !== "codex-chatgpt")
    context.addIssue({ code: "custom", message: "Boot refresh requires Codex subscription access" });
  if (value.desiredCacheRevision !== value.cacheRevision)
    context.addIssue({ code: "custom", message: "Boot refresh requires current ready selection" });
});
export type CloudAgentBootRefreshResponse = z.infer<typeof CloudAgentBootRefreshResponseSchema>;

/** Persistable actor provenance, never a credential or bearer. Reading this
 * schema does not mint authority: the engine registry rechecks its current
 * verified principal before accepting or dispatching work. */
export const CloudAgentFundingGrantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }).strict(),
  z.object({ kind: z.literal("share"), grantId: z.string().uuid(), grantRevision: revision }).strict(),
  z.object({ kind: z.literal("general-access"), grantId: z.string().uuid(), grantRevision: revision }).strict(),
]);
export const CloudActorProvenanceSchema = z.object({
  scope: CloudAgentBootScopeSchema, actor: CloudCommandActorSchema,
  actorSessionId: z.string().uuid(), authorityEpoch: revision, confirmedUntilMs: timestamp,
  fundingConsentVersion: z.literal(1).nullable(),
  fundingGrant: CloudAgentFundingGrantSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.fundingConsentVersion === null) !== (value.fundingGrant === null) ||
      (value.fundingGrant?.kind === "owner" && value.actor.userId !== value.scope.fundingOwnerUserId))
    context.addIssue({ code: "custom", message: "Funding consent provenance is inconsistent" });
});
export type CloudActorProvenance = z.infer<typeof CloudActorProvenanceSchema>;

/** Private engine-auth reauthorization of an already consumed recorded actor.
 * CP resolves all identity/role/grant fields; transport disconnect does not
 * itself revoke accepted intent. Actual revocation/expiry still refuses it. */
export const CloudAgentActorConfirmRequestSchema = z.object({
  ...bootReference, version: z.literal(1), mode: z.literal("boot-owner-v1"), actorSessionId: z.string().uuid(),
}).strict();
export type CloudAgentActorConfirmRequest = z.infer<typeof CloudAgentActorConfirmRequestSchema>;
export const CloudAgentActorConfirmResponseSchema = z.object({
  version: z.literal(1), mode: z.literal("boot-owner-v1"), provenance: CloudActorProvenanceSchema,
}).strict();
export type CloudAgentActorConfirmResponse = z.infer<typeof CloudAgentActorConfirmResponseSchema>;

const cwd = z.string().min(1).max(2048).refine(value => /^\/(?:[^/\0]+(?:\/[^/\0]+)*)?$/.test(value) &&
  !value.includes("\0") && !value.split("/").some(component => component === ".." || component === "."));
/** Only the trusted engine submits the verified checkout and tolerant MCP set;
 * the control plane still verifies workspace/boot/actor/context identity. */
export const CloudAgentWarmActorRequestSchema = z.object({
  ...bootReference, version: z.literal(1), mode: z.literal("boot-owner-v1"),
  actorSessionId: z.string().uuid(), provider: CloudAgentProviderSchema,
  conversationId: identity, model, cwd, repositoryServers: CloudRepositoryMcpSchema,
}).strict();
export type CloudAgentWarmActorRequest = z.infer<typeof CloudAgentWarmActorRequestSchema>;

export const CloudAgentWarmActorResponseSchema = CloudAgentBootIdentitySchema.extend({
  contextId: z.string().uuid(), contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  actor: CloudActorProvenanceSchema,
  conversationId: identity, provider: CloudAgentProviderSchema, model, cwd,
  gitAuthor: CloudGitAuthorSchema.nullable(),
  customization: CloudCustomizationSnapshotSchema.nullable(),
  environment: CloudComputerExecutionEnvironmentSchema,
  nativeCapabilities: CloudNativeCapabilitiesSchema,
  backgroundTasksVersion: z.literal(1).optional(), computerToolsVersion: z.literal(1).optional(),
}).strict().superRefine((value, context) => {
  const actor = value.actor;
  if (!cloudActorCan(actor.actor.role, "run") || actor.fundingConsentVersion !== 1 || !actor.fundingGrant ||
      actor.authorityEpoch !== value.authorityEpoch ||
      Object.entries(actor.scope).some(([key, item]) => value[key as keyof typeof value] !== item))
    context.addIssue({ code: "custom", message: "Actor context binding is inconsistent" });
  if (value.customization && !value.customization.history)
    context.addIssue({ code: "custom", message: "Actor customization requires private history authority" });
});
export type CloudAgentWarmActorResponse = z.infer<typeof CloudAgentWarmActorResponseSchema>;

/** Emitted only when a native run actually uses its captured snapshot. A
 * materialVersion-only rotation is not a changed-account information card. */
export const CloudAgentCredentialRunInfoSchema = z.object({
  version: z.literal(1), bootId: z.string().uuid(), writerEpoch: z.string().uuid(), cacheRevision: revision,
  provider: CloudAgentProviderSchema, fundingOwnerUserId: z.string().uuid(), fundingOwnerEpoch: revision,
  credentialId: z.string().uuid(), credentialRevision: revision, connectionRevision: revision, adoptionId: z.string().uuid(), materialVersion: revision,
  displayName: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
}).strict();
export type CloudAgentCredentialRunInfo = z.infer<typeof CloudAgentCredentialRunInfoSchema>;
