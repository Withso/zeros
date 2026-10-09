import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { assertCurrentCloudEngineAuthority, assertCloudEngineAuthorityDeadline } from "./engine-authority.js";
import { CloudAgentBootScopeSchema, CloudAgentCredentialRunInfoSchema, CloudAgentProviderSchema } from "./agent-boot-contract.js";
import type { CloudAgentBootScope } from "./agent-boot-contract.js";

const revision = z.number().int().positive().safe();
const uuid = z.string().uuid();
// Keep the credential service independent of Dev's schema/authority graph.
const ConditionalRemovalResponseSchema=z.object({version:z.literal(1),operationId:uuid,connectionId:uuid,
  scope:z.enum(["organization","global"]),removed:z.literal(true)}).strict();

/** The account comes from authentication. These targets preserve the distinct
 * organization association, global key and upstream Dev-reference scopes. */
export const CloudAgentCredentialRemovalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove-organization-credential"), organizationId: uuid,
    credentialId: uuid, expectedCredentialRevision: revision }).strict(),
  z.object({ kind: z.literal("revoke-credential"), credentialId: uuid,
    expectedCredentialRevision: revision }).strict(),
  z.object({ kind: z.literal("disconnect-provider"), organizationId: uuid,
    provider: CloudAgentProviderSchema, expectedConnectionRevision: revision }).strict(),
  z.object({ kind: z.literal("remove-dev-reference"), organizationId: uuid,
    referenceId: uuid, scope: z.enum(["local", "organization", "global"]), expectedCredentialRevision: revision }).strict(),
]);
export type CloudAgentCredentialRemovalTarget = z.infer<typeof CloudAgentCredentialRemovalTargetSchema>;
export const CloudAgentCredentialRemovalPrepareSchema = z.object({
  version: z.literal(1), operationId: uuid, target: CloudAgentCredentialRemovalTargetSchema,
}).strict();
export type CloudAgentCredentialRemovalPrepare = z.infer<typeof CloudAgentCredentialRemovalPrepareSchema>;
export const CloudAgentCredentialRemovalDecisionSchema = z.object({
  version: z.literal(1), requestId: uuid, expectedRevision: revision,
}).strict();
export type CloudAgentCredentialRemovalDecision = z.infer<typeof CloudAgentCredentialRemovalDecisionSchema>;

const outcomeBase = { version: z.literal(1), operationId: uuid, revision };
/** No counts, credential material, actor fields or opaque retirement proof
 * are public. Pending is neither confirmation of running nor removal success. */
export const CloudAgentCredentialRemovalOutcomeSchema = z.discriminatedUnion("state", [
  z.object({ ...outcomeBase, state: z.literal("removed") }).strict(),
  z.object({ ...outcomeBase, state: z.literal("cancelled") }).strict(),
  z.object({ ...outcomeBase, state: z.literal("expired") }).strict(),
  z.object({ ...outcomeBase, state: z.literal("awaiting-confirmation"),
    expiresAt: z.string().datetime(), confirmedRunning: z.literal(true) }).strict(),
  z.object({ ...outcomeBase, state: z.literal("pending"), phase: z.enum(["preparing", "removing", "cancelling"]),
    retryAfterMs: z.number().int().min(100).max(30_000) }).strict(),
]);
export type CloudAgentCredentialRemovalOutcome = z.infer<typeof CloudAgentCredentialRemovalOutcomeSchema>;

/** Private, CP-authored background controls. Selectors intentionally cover all
 * revisions of a source, including old active captures and idle native hosts. */
export const CloudAgentCredentialControlSelectorSchema = z.object({
  provider: CloudAgentProviderSchema, credentialId: uuid,
}).strict();
const controlIdentity = {
  ...CloudAgentBootScopeSchema.shape, version: z.literal(1), mutationId: uuid,
  controlRequestId: uuid, fenceEpoch: revision,
};
export const CloudAgentCredentialControlRequestSchema = z.object({
  ...controlIdentity,
  selectors: z.array(CloudAgentCredentialControlSelectorSchema).min(1).max(32)
    .refine(values => new Set(values.map(value => `${value.provider}:${value.credentialId}`)).size === values.length),
  operation: z.enum(["pause-starts", "publish-desired", "retire", "release"]),
  desiredCacheRevision: revision.nullable(),
}).strict().refine(value => (value.operation === "publish-desired") === (value.desiredCacheRevision !== null));
export type CloudAgentCredentialControlRequest = z.infer<typeof CloudAgentCredentialControlRequestSchema>;

const activityScope = z.object({
  executionId: uuid, conversationId: uuid, commandId: uuid.nullable(),
  phase: z.enum(["launch-reserved", "foreground", "background", "idle"]),
  credentialRun: CloudAgentCredentialRunInfoSchema,
}).strict();
const activityCount = z.number().int().min(0).max(1_000_000);
export const CloudAgentCredentialControlActivitySchema = z.object({
  complete: z.boolean(), foreground: activityCount, reservedLaunches: activityCount,
  background: activityCount, idleHosts: activityCount, scopes: z.array(activityScope).max(256),
}).strict().superRefine((value, context) => {
  if (!value.complete) return;
  const counts = { foreground: 0, "launch-reserved": 0, background: 0, idle: 0 };
  for (const scope of value.scopes) counts[scope.phase]++;
  if (counts.foreground !== value.foreground || counts["launch-reserved"] !== value.reservedLaunches ||
      counts.background !== value.background || counts.idle !== value.idleHosts)
    context.addIssue({ code: "custom", message: "Incomplete activity binding" });
});
export const CloudAgentCredentialControlAcknowledgementSchema = z.object({
  ...controlIdentity, controlRevision: revision,
  phase: z.enum(["fenced", "waiting-ready", "ready", "retiring", "retired", "released", "failed"]),
  mutationFenced: z.boolean(), startsFenced: z.boolean(),
  desiredCacheRevision: revision.nullable(), readyCacheRevision: revision.nullable(),
  activity: CloudAgentCredentialControlActivitySchema, proofId: uuid.nullable(),
}).strict().superRefine((value, context) => {
  const issue = () => context.addIssue({ code: "custom", message: "Invalid credential control binding" });
  const terminalUnfenced = value.phase === "ready" || value.phase === "released";
  if (value.mutationFenced === terminalUnfenced || (!terminalUnfenced && !value.startsFenced)) issue();
  if (value.phase === "ready" && (value.desiredCacheRevision === null || value.readyCacheRevision === null ||
      value.desiredCacheRevision > value.readyCacheRevision)) issue();
  if (value.phase === "waiting-ready" && value.desiredCacheRevision === null) issue();
  if (value.phase === "retired") {
    const activity = value.activity;
    if (value.proofId === null || !activity.complete || activity.foreground || activity.reservedLaunches ||
        activity.background || activity.idleHosts || activity.scopes.length) issue();
  } else if (value.proofId !== null) issue();
  for (const item of value.activity.scopes) {
    const run = item.credentialRun;
    if (run.bootId !== value.bootId || run.writerEpoch !== value.writerEpoch ||
        run.fundingOwnerUserId !== value.fundingOwnerUserId || run.fundingOwnerEpoch !== value.fundingOwnerEpoch) issue();
  }
});
export type CloudAgentCredentialControlAcknowledgement = z.infer<typeof CloudAgentCredentialControlAcknowledgementSchema>;

const exchangeIdentity = {
  version: z.literal(1), mode: z.literal("boot-owner-v1"),
  organizationId: uuid, workspaceId: uuid, generation: revision, engineInstanceId: uuid,
  bootId: uuid, writerEpoch: uuid,
};
/** One bounded inventory ACK per exchange; authentication resolves the funder,
 * the mutation and the selectors from CP rows rather than caller fields. */
export const CloudAgentCredentialControlExchangeRequestSchema = z.object({
  ...exchangeIdentity, acknowledgements: z.array(CloudAgentCredentialControlAcknowledgementSchema).max(1),
}).strict().superRefine((value, context) => {
  for (const ack of value.acknowledgements)
    if (ack.organizationId !== value.organizationId || ack.workspaceId !== value.workspaceId ||
        ack.generation !== value.generation || ack.engineInstanceId !== value.engineInstanceId ||
        ack.bootId !== value.bootId || ack.writerEpoch !== value.writerEpoch)
      context.addIssue({ code: "custom", message: "Invalid credential control scope" });
});
export type CloudAgentCredentialControlExchangeRequest = z.infer<typeof CloudAgentCredentialControlExchangeRequestSchema>;
export const CloudAgentCredentialControlExchangeResponseSchema = z.object({
  version: z.literal(1), mode: z.literal("boot-owner-v1"),
  controls: z.array(CloudAgentCredentialControlRequestSchema).max(16),
}).strict();
export type CloudAgentCredentialControlExchangeResponse = z.infer<typeof CloudAgentCredentialControlExchangeResponseSchema>;

/** Non-negotiated destructive writers cannot bypass positive retirement.
 * Ordinary legacy workspaces have no delivery rows and keep their old path. */
export async function assertLegacyCloudAgentCredentialMutationAllowed(tx: Tx, ownerUserId: string,
  scope: { credentialId: string; organizationId?: string }): Promise<void> {
  await lockOwner(tx,ownerUserId);
  const held = await tx.query(`SELECT 1 FROM cloud_agent_boot_source_deliveries delivery
    JOIN cloud_agent_boot_bindings binding ON binding.id=delivery.binding_id
    WHERE binding.funding_owner_user_id=$1 AND delivery.credential_id=$2 AND delivery.retired_proof_id IS NULL
      AND ($3::uuid IS NULL OR binding.org_id=$3) LIMIT 1`, [ownerUserId, scope.credentialId, scope.organizationId ?? null]);
  if (held.rowCount) throw new HttpError(409,"cloud_runtime_upgrade_required","cloud_runtime_upgrade_required");
}

const sourceSchema = z.object({
  organizations: z.array(uuid).min(1).max(32).nullable(),
  selectors: z.array(CloudAgentCredentialControlSelectorSchema).min(1).max(32),
  devReference: z.object({ referenceId: uuid, organizationId: uuid, scope: z.enum(["local", "organization", "global"]),
    connectionId: uuid, generationId: uuid, referenceRevision: revision, consentRevision: revision,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict();
type RemovalSource = z.infer<typeof sourceSchema>;
const publicationTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publish-credential"), credentialId: uuid, expectedRevision: z.number().int().min(0).safe(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("publish-connection"), organizationId: uuid, provider: CloudAgentProviderSchema,
    expectedRevision: z.number().int().min(0).safe(), credentialId: uuid.nullable(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type CloudAgentCredentialPublicationTarget = z.infer<typeof publicationTarget>;
const mutationTarget = z.union([CloudAgentCredentialRemovalTargetSchema, publicationTarget]);
const isPublication = (row: Mutation) => publicationTarget.safeParse(row.target).success;
type Mutation = {
  id: string; owner_user_id: string; target: unknown; source_snapshot: unknown; request_sha256: Buffer;
  fence_epoch: string; revision: string; state: "preparing" | "awaiting-confirmation" | "removing" | "cancelling" | "removed" | "cancelled" | "expired" | "publishing" | "published";
  decision: "remove" | "cancel" | "expire" | "publish" | null; decision_revision: string | null; expires_at: Date;
};
type Control = { id: string; binding_id: string; operation: CloudAgentCredentialControlRequest["operation"];
  request: unknown; acknowledgement: unknown; control_revision: string; attempt: number; source_retirement?: unknown };
const sourceRetirementSchema=z.object({kind:z.enum(["provider-lifecycle","resident-consumed"]),proofId:uuid,
  retiredAt:z.string().datetime({offset:true})}).strict();
function sourceRetired(control:Control):boolean {
  if(control.source_retirement===null || control.source_retirement===undefined)return false;
  checked(sourceRetirementSchema,control.source_retirement);return true;
}
function completedControl(control:Control,phase:CloudAgentCredentialControlAcknowledgement["phase"]):boolean {
  return sourceRetired(control) || control.acknowledgement!==null &&
    checked(CloudAgentCredentialControlAcknowledgementSchema,control.acknowledgement).phase===phase;
}
function fencedControl(control:Control):boolean {
  if(sourceRetired(control))return true;
  if(control.acknowledgement===null)return false;
  const ack=checked(CloudAgentCredentialControlAcknowledgementSchema,control.acknowledgement);
  return ack.phase==="fenced" && ack.activity.complete;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest();
function denied(): never { throw new HttpError(403, "cloud_validation_access_denied", "cloud_validation_access_denied"); }
function conflict(): never { throw new HttpError(409, "agent_credential_conflict", "agent_credential_conflict"); }
function busy(): never { throw new HttpError(503, "cloud_agent_credential_busy", "cloud_agent_credential_busy"); }
function checked<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) denied(); return result.data; }

async function lockOwner(tx: Tx, userId: string) {
  if (!uuid.safeParse(userId).success) denied();
  const account = await tx.query(`SELECT account.id FROM users account WHERE account.id=$1 AND account.auth_status='active'
    AND account.deleted_at IS NULL AND EXISTS(SELECT 1 FROM user_identities identity WHERE identity.user_id=account.id
      AND identity.provider='workos' AND identity.status='active' AND identity.email_verified_at IS NOT NULL) FOR SHARE OF account`, [userId]);
  if (account.rowCount !== 1) denied();
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412))", [userId]);
}
/** First delivery and every destructive source writer use the same ordering. */
export const serializeCloudAgentCredentialSourceMutation = lockOwner;
async function organization(tx: Tx, userId: string, organizationId: string) {
  if ((await tx.query(`SELECT 1 FROM organization_members member JOIN organizations organization ON organization.id=member.org_id
    WHERE member.org_id=$1 AND member.user_id=$2 AND NOT organization.is_personal AND organization.deleted_at IS NULL
    FOR SHARE OF member,organization`, [organizationId, userId])).rowCount !== 1) denied();
}
/** Freeze only verified nonsecret source identities. The public request never
 * selects an engine/funder, and org Remove never expands to global revoke. */
async function removalSource(tx: Tx, userId: string, target: CloudAgentCredentialRemovalTarget): Promise<RemovalSource> {
  if ("organizationId" in target) await organization(tx, userId, target.organizationId);
  let credentialId: string;
  if (target.kind === "disconnect-provider") {
    const connection = (await tx.query<{ credential_id: string | null; revision: string }>(`SELECT credential_id,revision
      FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3 FOR UPDATE`,
    [target.organizationId, userId, target.provider])).rows[0];
    if (!connection || !connection.credential_id || Number(connection.revision) !== target.expectedConnectionRevision) conflict();
    credentialId = connection.credential_id;
  } else credentialId = target.kind === "remove-dev-reference" ? target.referenceId : target.credentialId;
  const credential = (await tx.query<{ kind: string; revision: string }>(`SELECT kind,revision FROM cloud_agent_credentials
    WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL FOR UPDATE`, [credentialId, userId])).rows[0];
  if (!credential) denied();
  if (target.kind !== "disconnect-provider" && Number(credential.revision) !== target.expectedCredentialRevision) conflict();
  const provider = checked(CloudAgentProviderSchema, credential.kind.split("-", 1)[0]);
  if (target.kind === "remove-organization-credential" && (await tx.query(`SELECT 1 FROM cloud_agent_credential_organizations
    WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3`, [target.organizationId, userId, credentialId])).rowCount !== 1) denied();
  if (target.kind === "disconnect-provider" && target.provider !== provider) denied();
  const reference = (await tx.query<{ reference: { connectionId: string; revision: number; consentRevision: number }; org_id:string;generation_id: string; fingerprint: string }>(
    `SELECT reference,org_id,generation_id,fingerprint FROM dev_connection_references WHERE binding_id=$1 AND ($2::uuid IS NULL OR org_id=$2) AND owner_user_id=$3
      AND removed_at IS NULL AND invalidated_at IS NULL FOR UPDATE`, [credentialId, "organizationId" in target?target.organizationId:null, userId])).rows[0];
  if (!reference) {
    if(target.kind==="remove-dev-reference")denied();
    return { organizations: "organizationId" in target ? [target.organizationId] : null,
      selectors: [{ provider, credentialId }], devReference: null };
  }
  // Released generic Remove/revoke are local reference removal. Disconnect
  // withdraws the actual organization broker consent instead.
  const scope=target.kind==="remove-dev-reference"?target.scope:target.kind==="disconnect-provider"?"organization":"local";
  const ids = scope === "local" ? [{ id: credentialId, provider }] : (await tx.query<{ id: string; provider: string }>(
    `SELECT reference.binding_id AS id,split_part(credential.kind,'-',1) AS provider FROM dev_connection_references reference
      JOIN cloud_agent_credentials credential ON credential.id=reference.binding_id AND credential.owner_user_id=reference.owner_user_id
      WHERE reference.owner_user_id=$1 AND reference.reference->>'connectionId'=$2 AND reference.generation_id=$3
        AND ($4::uuid IS NULL OR reference.org_id=$4) AND reference.removed_at IS NULL AND reference.invalidated_at IS NULL
      ORDER BY reference.binding_id LIMIT 33`, [userId, reference.reference.connectionId, reference.generation_id,
      scope === "organization" ? reference.org_id : null])).rows;
  return checked(sourceSchema, { organizations: scope === "global" || target.kind==="revoke-credential" ? null : [reference.org_id],
    selectors: ids.map(value => ({ provider: value.provider, credentialId: value.id })),
    devReference: { referenceId: credentialId, organizationId: reference.org_id, scope,
      connectionId: reference.reference.connectionId, generationId: reference.generation_id,
      referenceRevision: reference.reference.revision, consentRevision: reference.reference.consentRevision, fingerprint: reference.fingerprint } });
}
async function mutation(tx: Tx, userId: string, operationId: string): Promise<Mutation> {
  if (!uuid.safeParse(operationId).success) denied();
  const row = (await tx.query<Mutation>("SELECT * FROM cloud_agent_credential_mutations WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [operationId, userId])).rows[0];
  if (!row) denied();
  checked(mutationTarget, row.target); checked(sourceSchema, row.source_snapshot);
  if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1 || !Number.isSafeInteger(Number(row.fence_epoch)) || Number(row.fence_epoch) < 1) denied();
  return row;
}
function outcome(row: Mutation): CloudAgentCredentialRemovalOutcome {
  if (isPublication(row)) denied();
  const base = { version: 1, operationId: row.id, revision: Number(row.revision) };
  if (row.state === "awaiting-confirmation") return checked(CloudAgentCredentialRemovalOutcomeSchema,
    { ...base, state: row.state, expiresAt: row.expires_at.toISOString(), confirmedRunning: true });
  if (row.state === "preparing" || row.state === "removing" || row.state === "cancelling") return checked(CloudAgentCredentialRemovalOutcomeSchema,
    { ...base, state: "pending", phase: row.state, retryAfterMs: 1000 });
  return checked(CloudAgentCredentialRemovalOutcomeSchema, { ...base, state: row.state });
}
async function controlsFor(tx: Tx, operationId: string): Promise<Control[]> {
  const rows = (await tx.query<Control>(`SELECT DISTINCT ON(control.binding_id,control.operation) control.*,
    CASE WHEN proof.control_id IS NOT NULL THEN jsonb_build_object('kind',proof.proof_kind,'proofId',proof.proof_id,
      'retiredAt',proof.retired_at) ELSE NULL END AS source_retirement
    FROM cloud_agent_credential_controls control LEFT JOIN cloud_agent_credential_source_retirements proof ON proof.control_id=control.id
    WHERE control.mutation_id=$1 ORDER BY control.binding_id,control.operation,control.attempt DESC`, [operationId])).rows;
  if (rows.length > 1024) busy();
  for (const row of rows) { checked(CloudAgentCredentialControlRequestSchema, row.request);
    if (row.acknowledgement !== null) checked(CloudAgentCredentialControlAcknowledgementSchema, row.acknowledgement);
    sourceRetired(row); }
  return rows;
}
async function nextControls(tx: Tx, row: Mutation, operation: "retire" | "release") {
  const previous = (await controlsFor(tx, row.id)).filter(value => value.operation === "pause-starts");
  for (const control of previous) {
    const request = checked(CloudAgentCredentialControlRequestSchema, { ...checked(CloudAgentCredentialControlRequestSchema, control.request),
      controlRequestId: randomUUID(), operation });
    await tx.query(`INSERT INTO cloud_agent_credential_controls(id,mutation_id,binding_id,operation,request,request_sha256)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(mutation_id,binding_id,operation,attempt) DO NOTHING`,
    [request.controlRequestId, row.id, control.binding_id, operation, request, hash(request)]);
    await tx.query(`INSERT INTO cloud_agent_credential_source_retirements(control_id,proof_kind,proof_id,retired_at)
      SELECT next.id,proof.proof_kind,proof.proof_id,proof.retired_at FROM cloud_agent_credential_controls next
        JOIN cloud_agent_credential_source_retirements proof ON proof.control_id=$4
      WHERE next.mutation_id=$1 AND next.binding_id=$2 AND next.operation=$3 AND next.attempt=1
      ON CONFLICT(control_id) DO NOTHING`,[row.id,control.binding_id,operation,control.id]);
  }
}
async function setState(tx: Tx, row: Mutation, state: Mutation["state"], decision = row.decision) {
  await tx.query(`UPDATE cloud_agent_credential_mutations SET state=$2,decision=$3,
    decision_revision=CASE WHEN decision IS NULL AND $3::text IS NOT NULL THEN revision ELSE decision_revision END,revision=revision+1 WHERE id=$1`,
  [row.id, state, decision]);
}

/** Retain a potential-holder record before returning access. Pending/removal
 * fences apply to late boots as well as the frozen original engine set. */
export async function recordCloudAgentBootCredentialDelivery(tx: Tx, admitted: CloudAgentBootScope,
  selected: z.infer<typeof CloudAgentCredentialControlSelectorSchema>, publication?:{cacheRevision:number;connectionRevision:number}): Promise<void> {
  const scope=checked(CloudAgentBootScopeSchema,admitted),source=checked(CloudAgentCredentialControlSelectorSchema,selected);
  const capture=publication?checked(z.object({cacheRevision:revision,connectionRevision:revision}).strict(),publication):{cacheRevision:1,connectionRevision:1};
  await lockOwner(tx,scope.fundingOwnerUserId);
  const recorded=(await tx.query<{id:string;cache_revision:string;desired_cache_revision:string}>(`SELECT binding.id,binding.cache_revision,binding.desired_cache_revision FROM cloud_agent_boot_bindings binding
    JOIN cloud_workspace_engine_instances engine ON engine.id=binding.engine_instance_id
    JOIN cloud_workspaces workspace ON workspace.id=binding.workspace_id
    JOIN cloud_agent_credentials credential ON credential.id=$9 AND credential.owner_user_id=binding.funding_owner_user_id
    WHERE binding.org_id=$1 AND binding.workspace_id=$2 AND binding.generation=$3 AND binding.engine_instance_id=$4
      AND binding.boot_id=$5 AND binding.writer_epoch=$6 AND binding.funding_owner_user_id=$7 AND binding.funding_owner_epoch=$8
      AND binding.retired_at IS NULL AND workspace.current_generation=binding.generation AND workspace.deleted_at IS NULL
      AND engine.revoked_at IS NULL AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
      AND credential.revoked_at IS NULL AND split_part(credential.kind,'-',1)=$10 FOR UPDATE OF binding`,
    [scope.organizationId,scope.workspaceId,scope.generation,scope.engineInstanceId,scope.bootId,scope.writerEpoch,scope.fundingOwnerUserId,scope.fundingOwnerEpoch,source.credentialId,source.provider])).rows[0];
  if(!recorded)denied();
  if(publication) {
    if(capture.cacheRevision!==Number(recorded.desired_cache_revision))conflict();
    if((await tx.query(`SELECT 1 FROM cloud_agent_organization_connections connection JOIN cloud_agent_credentials credential ON credential.id=connection.credential_id
      JOIN cloud_agent_credential_organizations association ON association.credential_id=credential.id AND association.owner_user_id=credential.owner_user_id AND association.org_id=connection.org_id
      WHERE connection.org_id=$1 AND connection.owner_user_id=$2 AND connection.provider=$3 AND connection.credential_id=$4 AND connection.revision=$5
        AND connection.credential_revision=credential.revision AND credential.revoked_at IS NULL`,[scope.organizationId,scope.fundingOwnerUserId,source.provider,source.credentialId,capture.connectionRevision])).rowCount!==1)denied();
  }
  const retired=(await tx.query<{connection_revision:string;cache_revision:string}>("SELECT connection_revision,cache_revision FROM cloud_agent_boot_source_deliveries WHERE binding_id=$1 AND provider=$2 AND credential_id=$3 AND retired_proof_id IS NOT NULL",[recorded.id,source.provider,source.credentialId])).rows;
  const newAssociation=Boolean(publication && retired.length && retired.every(previous=>capture.connectionRevision>Number(previous.connection_revision)&&capture.cacheRevision>Number(previous.cache_revision)));
  if(retired.length&&!newAssociation)conflict();
  const pending=(await tx.query<{id:string;state:string}>(`SELECT id,state FROM cloud_agent_credential_mutations WHERE owner_user_id=$1
    AND state NOT IN ('cancelled','expired','published') AND (source_snapshot->'organizations'='null'::jsonb OR source_snapshot->'organizations' @> $2::jsonb)
    AND source_snapshot->'selectors' @> $3::jsonb`,[scope.fundingOwnerUserId,JSON.stringify([scope.organizationId]),JSON.stringify([source])])).rows;
  for(const mutation of pending) {
    if(mutation.state==="removed"&&newAssociation)continue;
    if(mutation.state==="publishing"&&publication && (await tx.query(`SELECT 1 FROM cloud_agent_credential_controls WHERE mutation_id=$1 AND binding_id=$2 AND operation='publish-desired'
      AND (request->>'desiredCacheRevision')::bigint=$3`,[mutation.id,recorded.id,capture.cacheRevision])).rowCount)continue;
    conflict();
  }
  await tx.query(`INSERT INTO cloud_agent_boot_source_deliveries(binding_id,provider,credential_id,connection_revision,cache_revision)
    SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM cloud_agent_boot_source_deliveries WHERE binding_id=$1 AND provider=$2 AND credential_id=$3 AND connection_revision=$4)
    ON CONFLICT DO NOTHING`,[recorded.id,source.provider,source.credentialId,capture.connectionRevision,capture.cacheRevision]);
}

export async function prepareCloudAgentCredentialRemoval(tx: Tx, userId: string, value: unknown): Promise<CloudAgentCredentialRemovalOutcome> {
  const request = checked(CloudAgentCredentialRemovalPrepareSchema, value);
  await lockOwner(tx, userId);
  const previous = (await tx.query<Mutation>("SELECT * FROM cloud_agent_credential_mutations WHERE id=$1 FOR UPDATE", [request.operationId])).rows[0];
  if (previous) { if (previous.owner_user_id !== userId) denied(); if (!previous.request_sha256.equals(hash(request))) conflict(); return outcome(previous); }
  const count = Number((await tx.query<{ count: string }>("SELECT count(*) FROM cloud_agent_credential_mutations WHERE owner_user_id=$1", [userId])).rows[0]!.count);
  if (!Number.isSafeInteger(count) || count >= 128) busy();
  const source = await removalSource(tx, userId, request.target);
  const bindings = (await tx.query<{ id: string; scope: unknown; selectors: unknown }>(`SELECT binding.id,
    jsonb_build_object('organizationId',binding.org_id,'workspaceId',binding.workspace_id,'generation',binding.generation,
      'engineInstanceId',binding.engine_instance_id,'bootId',binding.boot_id,'writerEpoch',binding.writer_epoch,
      'fundingOwnerUserId',binding.funding_owner_user_id,'fundingOwnerEpoch',binding.funding_owner_epoch) AS scope,
    jsonb_agg(DISTINCT jsonb_build_object('provider',delivery.provider,'credentialId',delivery.credential_id)) AS selectors
    FROM cloud_agent_boot_bindings binding JOIN cloud_agent_boot_source_deliveries delivery ON delivery.binding_id=binding.id
    WHERE binding.funding_owner_user_id=$1 AND ($2::uuid[] IS NULL OR binding.org_id=ANY($2)) AND delivery.retired_proof_id IS NULL
      AND $3::jsonb @> jsonb_build_array(jsonb_build_object('provider',delivery.provider,'credentialId',delivery.credential_id))
    GROUP BY binding.id ORDER BY binding.id LIMIT 257`, [userId, source.organizations, JSON.stringify(source.selectors)])).rows;
  if (bindings.length > 256) busy();
  await tx.query("INSERT INTO cloud_agent_credential_mutations(id,owner_user_id,target,source_snapshot,request_sha256) VALUES($1,$2,$3,$4,$5)",
    [request.operationId, userId, request.target, source, hash(request)]);
  const row = await mutation(tx, userId, request.operationId);
  for (const binding of bindings) {
    if((await tx.query("SELECT id FROM cloud_agent_boot_bindings WHERE id=$1 FOR UPDATE",[binding.id])).rowCount!==1)busy();
    // A physical retirement can commit between candidate capture and outbox
    // creation. Serialize on its exact binding and reread positive deliveries.
    if(!(await tx.query(`SELECT 1 FROM cloud_agent_boot_source_deliveries WHERE binding_id=$1 AND retired_proof_id IS NULL
      AND $2::jsonb @> jsonb_build_array(jsonb_build_object('provider',provider,'credentialId',credential_id)) LIMIT 1`,
      [binding.id,JSON.stringify(source.selectors)])).rowCount)continue;
    const control = checked(CloudAgentCredentialControlRequestSchema, { ...checked(CloudAgentBootScopeSchema, binding.scope),
      version: 1, mutationId: row.id, controlRequestId: randomUUID(), fenceEpoch: Number(row.fence_epoch), selectors: binding.selectors,
      operation: "pause-starts", desiredCacheRevision: null });
    await tx.query("INSERT INTO cloud_agent_credential_controls(id,mutation_id,binding_id,operation,request,request_sha256) VALUES($1,$2,$3,$4,$5,$6)",
      [control.controlRequestId, row.id, binding.id, control.operation, control, hash(control)]);
  }
  await progressRemoval(tx, row);
  return outcome(await mutation(tx, userId, row.id));
}
export async function readCloudAgentCredentialRemoval(tx: Tx, userId: string, operationId: string): Promise<CloudAgentCredentialRemovalOutcome> {
  await lockOwner(tx, userId); const row = await mutation(tx, userId, operationId);
  await progressRemoval(tx, row); return outcome(await mutation(tx, userId, operationId));
}
export async function decideCloudAgentCredentialRemoval(tx: Tx, userId: string, operationId: string,
  action: "confirm" | "cancel", value: unknown): Promise<CloudAgentCredentialRemovalOutcome> {
  const request = checked(CloudAgentCredentialRemovalDecisionSchema, value);
  await lockOwner(tx, userId); const row = await mutation(tx, userId, operationId);
  const digest = hash({ action, ...request });
  const previous = (await tx.query<{ request_sha256: Buffer }>("SELECT request_sha256 FROM cloud_agent_credential_mutation_decisions WHERE mutation_id=$1 AND request_id=$2",
    [row.id, request.requestId])).rows[0];
  if (previous) { if (!previous.request_sha256.equals(digest)) conflict(); return outcome(row); }
  if (row.decision !== null) {
    if (Number(row.decision_revision) !== request.expectedRevision) conflict();
  } else {
    if (Number(row.revision) !== request.expectedRevision) conflict();
    if (row.expires_at.getTime() <= Date.now()) { await setState(tx, row, "cancelling", "expire"); await nextControls(tx, row, "release"); }
    else {
      if (action === "confirm" && row.state !== "awaiting-confirmation") conflict();
      // Revalidate the exact frozen source before accepting irreversible Yes.
      if (action === "confirm" && !hash(await removalSource(tx, userId, checked(CloudAgentCredentialRemovalTargetSchema, row.target))).equals(hash(row.source_snapshot))) conflict();
      await setState(tx, row, action === "confirm" ? "removing" : "cancelling", action === "confirm" ? "remove" : "cancel");
      await nextControls(tx, row, action === "confirm" ? "retire" : "release");
    }
  }
  await tx.query("INSERT INTO cloud_agent_credential_mutation_decisions(mutation_id,request_id,action,request_sha256) VALUES($1,$2,$3,$4)",
    [row.id, request.requestId, action, digest]);
  await progressRemoval(tx, await mutation(tx, userId, row.id));
  return outcome(await mutation(tx, userId, row.id));
}

async function clearRemovedBootMaterial(tx:Tx,row:Mutation) {
  const bindings=(await tx.query<{binding_id:string}>("SELECT DISTINCT binding_id FROM cloud_agent_credential_controls WHERE mutation_id=$1 AND operation='pause-starts'",[row.id])).rows;
  for(const {binding_id:id} of bindings) {
    if((await tx.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=desired_cache_revision+1 WHERE id=$1 AND desired_cache_revision<9007199254740991",[id])).rowCount!==1)conflict();
    await tx.query("DELETE FROM cloud_agent_boot_credentials WHERE binding_id=$1",[id]);
  }
}
async function commitSourceRemoval(tx: Tx, row: Mutation): Promise<boolean> {
  const target = checked(CloudAgentCredentialRemovalTargetSchema, row.target), source = checked(sourceSchema, row.source_snapshot);
  // Remote Dev revocation requires its existing broker's positive ACK. Never
  // claim that deleting a CP reference completed an organization/global revoke.
  if (source.devReference && source.devReference.scope !== "local") {
    const saved=(await tx.query<{response:unknown}>("SELECT response FROM cloud_agent_credential_remote_removals WHERE mutation_id=$1",[row.id])).rows[0];
    if(!saved)return false;
    const receipt=checked(ConditionalRemovalResponseSchema,saved.response);
    if(receipt.operationId!==row.id||receipt.connectionId!==source.devReference.connectionId||receipt.scope!==source.devReference.scope)denied();
    await organization(tx,row.owner_user_id,source.devReference.organizationId);
    // The operation's own broker outbox/empty restore may already invalidate
    // this source. Its frozen receipt may finish only those exact old records;
    // newer connection/consent records are never tombstoned by an old ACK.
    const ids=(await tx.query<{binding_id:string}>(`SELECT binding_id FROM dev_connection_references WHERE binding_id=ANY($1::uuid[])
      AND owner_user_id=$2 AND generation_id=$3 AND reference->>'connectionId'=$4
      AND (reference->>'revision')::bigint=$5 AND ($6::boolean OR (reference->>'consentRevision')::bigint=$7) FOR UPDATE`,
      [source.selectors.map(value=>value.credentialId),row.owner_user_id,source.devReference.generationId,source.devReference.connectionId,
        source.devReference.referenceRevision,source.devReference.scope==="global",source.devReference.consentRevision])).rows.map(value=>value.binding_id);
    await tx.query("UPDATE dev_connection_references SET removed_at=now(),invalidated_at=now() WHERE binding_id=ANY($1::uuid[]) AND owner_user_id=$2",[ids,row.owner_user_id]);
    await tx.query("UPDATE cloud_agent_credentials SET revoked_at=coalesce(revoked_at,now()),revision=revision+CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END WHERE id=ANY($1::uuid[]) AND owner_user_id=$2",[ids,row.owner_user_id]);
    await tx.query("DELETE FROM cloud_agent_credential_versions WHERE credential_id=ANY($1::uuid[])",[ids]);
    await tx.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=ANY($1::uuid[])",[ids]);
    await tx.query(`UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',all_models=false,
      revision=revision+1,request_sha256=digest(request_sha256,'sha256'),updated_at=now()
      WHERE owner_user_id=$1 AND credential_id=ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR org_id=ANY($3))`,[row.owner_user_id,ids,source.organizations]);
    await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR org_id=ANY($2))",[ids,source.organizations]);
    await clearRemovedBootMaterial(tx,row);
    return true;
  }
  if (!hash(await removalSource(tx, row.owner_user_id, target)).equals(hash(source))) conflict();
  if (target.kind === "revoke-credential") {
    await tx.query("UPDATE cloud_agent_credentials SET revoked_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND revision=$3",
      [target.credentialId, row.owner_user_id, target.expectedCredentialRevision]);
    await tx.query("DELETE FROM cloud_agent_credential_versions WHERE credential_id=$1", [target.credentialId]);
    await tx.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=$1", [target.credentialId]);
    await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=$1", [target.credentialId]);
  } else {
    const credentialId = source.selectors[0]!.credentialId;
    await tx.query(`UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',all_models=false,
      revision=revision+1,request_sha256=digest(request_sha256,'sha256'),updated_at=now()
      WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3 AND ($4::text IS NULL OR provider=$4)`,
    [target.organizationId, row.owner_user_id, credentialId, target.kind === "disconnect-provider" ? target.provider : null]);
    await tx.query(`UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now())
      WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3 AND ($4::text IS NULL OR organization_provider=$4)`,
    [target.organizationId, row.owner_user_id, credentialId, target.kind === "disconnect-provider" ? target.provider : null]);
    if (target.kind === "remove-organization-credential") await tx.query("DELETE FROM cloud_agent_credential_organizations WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3",
      [target.organizationId, row.owner_user_id, credentialId]);
  }
  if(source.devReference?.scope==="local") {
    await tx.query("UPDATE dev_connection_references SET removed_at=now(),invalidated_at=now() WHERE binding_id=$1 AND owner_user_id=$2",[source.devReference.referenceId,row.owner_user_id]);
    await tx.query("UPDATE cloud_agent_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_user_id=$2",[source.devReference.referenceId,row.owner_user_id]);
  }
  await clearRemovedBootMaterial(tx,row);
  return true;
}
async function progressRemoval(tx: Tx, row: Mutation): Promise<void> {
  if (isPublication(row)) {
    if (row.state === "preparing" && row.expires_at.getTime() <= Date.now()) {
      await setState(tx,row,"cancelling","expire"); await nextControls(tx,row,"release");
    } else if (row.state === "publishing") {
      const publications = (await controlsFor(tx,row.id)).filter(control=>control.operation==="publish-desired");
      if (publications.length && publications.every(control=>completedControl(control,"ready"))) await setState(tx,row,"published");
    }
    if (row.state!=="cancelling") return;
  }
  if (["removed", "cancelled", "expired"].includes(row.state)) return;
  const controls = await controlsFor(tx, row.id);
  if (row.decision === null) {
    if (row.expires_at.getTime() <= Date.now()) { await setState(tx, row, "cancelling", "expire"); await nextControls(tx, row, "release"); return; }
    const pauses = controls.filter(control => control.operation === "pause-starts");
    if (pauses.some(control=>!fencedControl(control))) return;
    const acks = pauses.map(control => sourceRetired(control) || control.acknowledgement === null ? null : checked(CloudAgentCredentialControlAcknowledgementSchema, control.acknowledgement));
    if (acks.some(value => value && (value.activity.foreground || value.activity.reservedLaunches || value.activity.background))) {
      if (row.state !== "awaiting-confirmation") await setState(tx, row, "awaiting-confirmation");
    } else { await setState(tx, row, "removing", "remove"); await nextControls(tx, row, "retire");
      if (pauses.length === 0 && await commitSourceRemoval(tx, row)) await setState(tx, await mutation(tx, row.owner_user_id, row.id), "removed", "remove"); }
    return;
  }
  const operation = row.decision === "remove" ? "retire" : "release";
  const expected = controls.filter(control => control.operation === "pause-starts").length;
  const completions = controls.filter(control => control.operation === operation);
  if (completions.length !== expected || completions.some(control=>!completedControl(control,operation==="retire"?"retired":"released"))) return;
  if (operation === "retire") {
    if (!await commitSourceRemoval(tx, row)) return;
    for (const control of completions) {
      if(sourceRetired(control))continue;
      const request = checked(CloudAgentCredentialControlRequestSchema, control.request), ack = checked(CloudAgentCredentialControlAcknowledgementSchema, control.acknowledgement);
      for (const selector of request.selectors) await tx.query("UPDATE cloud_agent_boot_source_deliveries SET retired_proof_id=$4 WHERE binding_id=$1 AND provider=$2 AND credential_id=$3 AND retired_proof_id IS NULL",
        [control.binding_id, selector.provider, selector.credentialId, ack.proofId]);
    }
  }
  await setState(tx, row, row.decision === "remove" ? "removed" : row.decision === "cancel" ? "cancelled" : "expired");
}

/** Private network handoff, only after complete positive whole-scope Stop.
 * The public client never supplies broker/source identity or a stop receipt. */
export async function pendingCloudAgentCredentialRemoteRemoval(tx:Tx,userId:string,operationId:string) {
  await lockOwner(tx,userId);const row=await mutation(tx,userId,operationId),source=checked(sourceSchema,row.source_snapshot);
  if(row.state!=="removing"||row.decision!=="remove"||!source.devReference||source.devReference.scope==="local")return null;
  const controls=await controlsFor(tx,row.id),pauses=controls.filter(value=>value.operation==="pause-starts"),retires=controls.filter(value=>value.operation==="retire");
  if(retires.length!==pauses.length||retires.some(value=>!completedControl(value,"retired")))return null;
  // Authorization is current; source intent is the irreversible CP-owned
  // snapshot. Requiring it to remain live would make its own revocation
  // impossible to reconcile after a lost broker acknowledgement.
  await organization(tx,userId,source.devReference.organizationId);
  return {...source.devReference,scope:source.devReference.scope};
}
export async function acknowledgeCloudAgentCredentialRemoteRemoval(tx:Tx,userId:string,operationId:string,value:unknown) {
  await lockOwner(tx,userId);const row=await mutation(tx,userId,operationId),source=checked(sourceSchema,row.source_snapshot),receipt=checked(ConditionalRemovalResponseSchema,value);
  if(!source.devReference||source.devReference.scope==="local"||receipt.operationId!==row.id||receipt.connectionId!==source.devReference.connectionId||receipt.scope!==source.devReference.scope)denied();
  const previous=(await tx.query<{response:unknown}>("SELECT response FROM cloud_agent_credential_remote_removals WHERE mutation_id=$1",[row.id])).rows[0];
  if(previous){if(!hash(previous.response).equals(hash(receipt)))conflict();return outcome(row);}
  if(!await pendingCloudAgentCredentialRemoteRemoval(tx,userId,operationId))conflict();
  await tx.query("INSERT INTO cloud_agent_credential_remote_removals(mutation_id,response) VALUES($1,$2)",[operationId,receipt]);
  await progressRemoval(tx,row);return outcome(await mutation(tx,userId,operationId));
}

export async function exchangeCloudAgentCredentialControls(tx: Tx,
  engine: Omit<CloudAgentBootScope,"fundingOwnerUserId"|"fundingOwnerEpoch"> & { heartbeatToken: string; workosEnabled: boolean }, value: unknown): Promise<CloudAgentCredentialControlExchangeResponse> {
  const request = checked(CloudAgentCredentialControlExchangeRequestSchema, value);
  const recorded = (await tx.query<{ id: string; scope: unknown }>(`SELECT binding.id,jsonb_build_object('organizationId',binding.org_id,
    'workspaceId',binding.workspace_id,'generation',binding.generation,'engineInstanceId',binding.engine_instance_id,'bootId',binding.boot_id,
    'writerEpoch',binding.writer_epoch,'fundingOwnerUserId',binding.funding_owner_user_id,'fundingOwnerEpoch',binding.funding_owner_epoch) AS scope
    FROM cloud_agent_boot_bindings binding WHERE org_id=$1 AND workspace_id=$2 AND generation=$3 AND engine_instance_id=$4 AND boot_id=$5 AND writer_epoch=$6`,
  [request.organizationId, request.workspaceId, request.generation, request.engineInstanceId, request.bootId, request.writerEpoch])).rows[0];
  if (!recorded) denied();
  const scope = checked(CloudAgentBootScopeSchema, recorded.scope);
  for (const key of ["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch"] as const)
    if (engine[key] !== scope[key]) denied();
  await lockOwner(tx, scope.fundingOwnerUserId);
  await assertCurrentCloudEngineAuthority(tx, engine);
  for (const acknowledgement of request.acknowledgements) {
    const row = await mutation(tx, scope.fundingOwnerUserId, acknowledgement.mutationId);
    const control = (await tx.query<Control>("SELECT * FROM cloud_agent_credential_controls WHERE id=$1 AND mutation_id=$2 AND binding_id=$3",
      [acknowledgement.controlRequestId, row.id, recorded.id])).rows[0];
    if (!control) denied();
    const command = checked(CloudAgentCredentialControlRequestSchema, control.request);
    for (const key of ["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch", "mutationId", "controlRequestId", "fenceEpoch"] as const)
      if (command[key] !== acknowledgement[key]) denied();
    if (acknowledgement.activity.scopes.some(item => !command.selectors.some(selector => selector.provider === item.credentialRun.provider && selector.credentialId === item.credentialRun.credentialId))) denied();
    const allowed = command.operation === "pause-starts" ? ["fenced", "failed"] : command.operation === "retire" ? ["retiring", "retired", "failed"] :
      command.operation === "release" ? ["released", "failed"] : ["waiting-ready", "ready", "failed"];
    if (!allowed.includes(acknowledgement.phase) || command.operation === "retire" && row.decision !== "remove" ||
        command.operation === "release" && row.decision !== "cancel" && row.decision !== "expire" ||
        command.operation === "publish-desired" && row.decision !== "publish") denied();
    if (command.operation === "publish-desired") {
      if (acknowledgement.desiredCacheRevision !== command.desiredCacheRevision) denied();
      const ready = (await tx.query<{cache_revision:string}>("SELECT cache_revision FROM cloud_agent_boot_bindings WHERE id=$1",[recorded.id])).rows[0];
      if (acknowledgement.phase === "ready" && (!ready || Number(ready.cache_revision)<command.desiredCacheRevision! ||
          acknowledgement.readyCacheRevision===null || acknowledgement.readyCacheRevision>Number(ready.cache_revision))) denied();
    }
    if (control.acknowledgement !== null) {
      if (acknowledgement.controlRevision !== Number(control.control_revision) || !hash(control.acknowledgement).equals(hash(acknowledgement))) conflict();
    } else {
      await tx.query("UPDATE cloud_agent_credential_controls SET acknowledgement=$2,control_revision=$3 WHERE id=$1", [control.id, acknowledgement, acknowledgement.controlRevision]);
      if (acknowledgement.phase === "failed" || acknowledgement.phase === "waiting-ready" || acknowledgement.phase === "retiring" ||
          acknowledgement.phase === "fenced" && !acknowledgement.activity.complete) {
        if (control.attempt >= 256) busy();
        const retry = checked(CloudAgentCredentialControlRequestSchema, { ...command, controlRequestId: randomUUID() });
        await tx.query(`INSERT INTO cloud_agent_credential_controls(id,mutation_id,binding_id,operation,attempt,request,request_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [retry.controlRequestId, row.id, control.binding_id, control.operation, control.attempt + 1, retry, hash(retry)]);
      }
    }
    await progressRemoval(tx, row);
  }
  await assertCloudEngineAuthorityDeadline(tx, scope.engineInstanceId, engine.workosEnabled);
  const pending = (await tx.query<{ request: unknown }>(`SELECT request FROM
    (SELECT DISTINCT ON(mutation_id,operation) * FROM cloud_agent_credential_controls WHERE binding_id=$1
      ORDER BY mutation_id,operation,attempt DESC) current_control
    WHERE acknowledgement IS NULL
      AND operation=CASE (SELECT decision FROM cloud_agent_credential_mutations WHERE id=mutation_id)
        WHEN 'remove' THEN 'retire' WHEN 'cancel' THEN 'release' WHEN 'expire' THEN 'release' WHEN 'publish' THEN 'publish-desired' ELSE 'pause-starts' END
    ORDER BY id LIMIT 16`, [recorded.id])).rows;
  return checked(CloudAgentCredentialControlExchangeResponseSchema, { version: 1, mode: "boot-owner-v1", controls: pending.map(value => value.request) });
}

/** Settings preflight is a separate committed transaction: a pending refusal
 * must not roll back the outbox/start fence. It never stores provider bytes. */
export async function prepareCloudAgentCredentialPublication(tx:Tx,userId:string,operationId:string,
  value:CloudAgentCredentialPublicationTarget):Promise<"legacy"|"pending"|"fenced"|"committed"> {
  const target=checked(publicationTarget,value); if(!uuid.safeParse(operationId).success) denied();
  await lockOwner(tx,userId);
  const previous=(await tx.query<Mutation>("SELECT * FROM cloud_agent_credential_mutations WHERE id=$1 FOR UPDATE",[operationId])).rows[0];
  if(previous) {
    if(previous.owner_user_id!==userId) denied();
    if(!hash(previous.target).equals(hash(target))) conflict();
    if(previous.state==="publishing"||previous.state==="published") return "committed";
    if(previous.decision!==null) conflict();
    const pauses=(await controlsFor(tx,operationId)).filter(control=>control.operation==="pause-starts");
    return pauses.every(fencedControl) ? "fenced" : "pending";
  }
  if(target.kind==="publish-connection") await organization(tx,userId,target.organizationId);
  const credentialId=target.kind==="publish-credential"?target.credentialId:target.credentialId;
  let provider: z.infer<typeof CloudAgentProviderSchema>;
  if(target.kind==="publish-credential") {
    const credential=(await tx.query<{kind:string;revision:string;last_operation_id:string;last_request_sha256:Buffer}>("SELECT kind,revision,last_operation_id,last_request_sha256 FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL FOR UPDATE",[credentialId,userId])).rows[0];
    if(!credential) { if(target.expectedRevision===0)return "legacy"; denied(); }
    if(Number(credential.revision)===target.expectedRevision+1 && credential.last_operation_id===operationId && credential.last_request_sha256.toString("hex")===target.requestDigest)return "legacy";
    if(Number(credential.revision)!==target.expectedRevision)conflict();
    provider=checked(CloudAgentProviderSchema,credential.kind.split("-",1)[0]);
  } else {
    provider=target.provider;
    const connection=(await tx.query<{revision:string;request_sha256:Buffer}>("SELECT revision,request_sha256 FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3 FOR UPDATE",[target.organizationId,userId,provider])).rows[0];
    if(Number(connection?.revision)===target.expectedRevision+1 && connection?.request_sha256.toString("hex")===target.requestDigest)return "legacy";
    if(Number(connection?.revision??0)!==target.expectedRevision)conflict();
  }
  const candidates=(await tx.query<{id:string;scope:unknown;selectors:unknown}>(`SELECT binding.id,jsonb_build_object('organizationId',binding.org_id,
      'workspaceId',binding.workspace_id,'generation',binding.generation,'engineInstanceId',binding.engine_instance_id,'bootId',binding.boot_id,
      'writerEpoch',binding.writer_epoch,'fundingOwnerUserId',binding.funding_owner_user_id,'fundingOwnerEpoch',binding.funding_owner_epoch) AS scope,
      coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('provider',delivery.provider,'credentialId',delivery.credential_id))
        FROM cloud_agent_boot_source_deliveries delivery WHERE delivery.binding_id=binding.id AND delivery.provider=$2
          AND delivery.retired_proof_id IS NULL AND ($3::uuid IS NULL OR delivery.credential_id=$3)),'[]'::jsonb) AS selectors
    FROM cloud_agent_boot_bindings binding WHERE binding.funding_owner_user_id=$1 AND ($4::uuid IS NULL OR binding.org_id=$4)
      AND (EXISTS(SELECT 1 FROM cloud_agent_boot_source_deliveries delivery WHERE delivery.binding_id=binding.id AND delivery.provider=$2
        AND delivery.retired_proof_id IS NULL AND ($3::uuid IS NULL OR delivery.credential_id=$3))
        OR (binding.retired_at IS NULL AND binding.credentials_initialized AND ($3::uuid IS NULL OR EXISTS(
          SELECT 1 FROM cloud_agent_organization_connections connection WHERE connection.org_id=binding.org_id AND connection.owner_user_id=$1 AND connection.credential_id=$3))))
    ORDER BY binding.id LIMIT 257`,[userId,provider,target.kind==="publish-credential"?credentialId:null,target.kind==="publish-connection"?target.organizationId:null])).rows;
  if(!candidates.length)return "legacy"; if(candidates.length>256)busy();
  const selectors=new Map<string,z.infer<typeof CloudAgentCredentialControlSelectorSchema>>();
  for(const candidate of candidates) for(const selector of checked(z.array(CloudAgentCredentialControlSelectorSchema).max(32),candidate.selectors)) selectors.set(selector.credentialId,selector);
  if(credentialId)selectors.set(credentialId,{provider,credentialId});
  if(!selectors.size)conflict(); if(selectors.size>32)busy();
  const source:RemovalSource={organizations:target.kind==="publish-connection"?[target.organizationId]:null,selectors:[...selectors.values()],devReference:null};
  await tx.query("INSERT INTO cloud_agent_credential_mutations(id,owner_user_id,target,source_snapshot,request_sha256) VALUES($1,$2,$3,$4,$5)",[operationId,userId,target,source,hash(target)]);
  const row=await mutation(tx,userId,operationId);
  let controlsCreated=0;
  for(const candidate of candidates) {
    const live=(await tx.query<{retired_at:Date|null}>("SELECT retired_at FROM cloud_agent_boot_bindings WHERE id=$1 FOR UPDATE",[candidate.id])).rows[0];
    if(!live)busy();
    if(live.retired_at!==null)continue;
    const request=checked(CloudAgentCredentialControlRequestSchema,{...checked(CloudAgentBootScopeSchema,candidate.scope),version:1,mutationId:operationId,
      controlRequestId:randomUUID(),fenceEpoch:Number(row.fence_epoch),selectors:source.selectors,operation:"pause-starts",desiredCacheRevision:null});
    await tx.query("INSERT INTO cloud_agent_credential_controls(id,mutation_id,binding_id,operation,request,request_sha256) VALUES($1,$2,$3,$4,$5,$6)",[request.controlRequestId,operationId,candidate.id,request.operation,request,hash(request)]);
    controlsCreated++;
  }
  return controlsCreated?"pending":"fenced";
}

/** Called in the SAME source-write transaction. All old bytes disappear before
 * commit; acknowledged durable fences already prohibit old future starts. */
export async function commitCloudAgentCredentialPublication(tx:Tx,userId:string,operationId:string,
  value:CloudAgentCredentialPublicationTarget):Promise<void> {
  await lockOwner(tx,userId); const row=await mutation(tx,userId,operationId),target=checked(publicationTarget,value);
  if(!hash(row.target).equals(hash(target)))conflict();
  if(row.state==="publishing"||row.state==="published")return;
  if(row.decision!==null||row.expires_at.getTime()<=Date.now())conflict();
  const pauses=(await controlsFor(tx,operationId)).filter(control=>control.operation==="pause-starts");
  if(pauses.some(control=>!fencedControl(control)))busy();
  const effective=target.kind==="publish-credential"?await tx.query(`SELECT 1 FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2
    AND revision=$3 AND last_operation_id=$4 AND encode(last_request_sha256,'hex')=$5`,[target.credentialId,userId,target.expectedRevision+1,operationId,target.requestDigest]):
    await tx.query(`SELECT 1 FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3
      AND revision=$4 AND encode(request_sha256,'hex')=$5 AND credential_id IS NOT DISTINCT FROM $6::uuid`,[target.organizationId,userId,target.provider,target.expectedRevision+1,target.requestDigest,target.credentialId]);
  if(effective.rowCount!==1)conflict();
  if(target.kind==="publish-credential") {
    // Key replacement is a new selected source. Only the acknowledged path
    // advances existing organization selections; legacy PUT stays unchanged.
    await tx.query(`UPDATE cloud_agent_organization_connections SET credential_revision=$3,revision=revision+1,
      request_sha256=digest(request_sha256||convert_to(($3::bigint)::text,'UTF8'),'sha256'),updated_at=now()
      WHERE owner_user_id=$1 AND credential_id=$2 AND credential_revision=$4`,
      [userId,target.credentialId,target.expectedRevision+1,target.expectedRevision]);
  }
  await setState(tx,row,"publishing","publish");
  for(const control of pauses) {
    const changed=(await tx.query<{desired_cache_revision:string}>(`UPDATE cloud_agent_boot_bindings SET desired_cache_revision=desired_cache_revision+1
      WHERE id=$1 AND desired_cache_revision<9007199254740991 RETURNING desired_cache_revision`,[control.binding_id])).rows[0];
    if(!changed)conflict();
    await tx.query("DELETE FROM cloud_agent_boot_credentials WHERE binding_id=$1",[control.binding_id]);
    const request=checked(CloudAgentCredentialControlRequestSchema,{...checked(CloudAgentCredentialControlRequestSchema,control.request),
      controlRequestId:randomUUID(),operation:"publish-desired",desiredCacheRevision:Number(changed.desired_cache_revision)});
    await tx.query("INSERT INTO cloud_agent_credential_controls(id,mutation_id,binding_id,operation,request,request_sha256) VALUES($1,$2,$3,$4,$5,$6)",
      [request.controlRequestId,operationId,control.binding_id,request.operation,request,hash(request)]);
    await tx.query(`INSERT INTO cloud_agent_credential_source_retirements(control_id,proof_kind,proof_id,retired_at)
      SELECT $1,proof_kind,proof_id,retired_at FROM cloud_agent_credential_source_retirements WHERE control_id=$2
      ON CONFLICT(control_id) DO NOTHING`,[request.controlRequestId,control.id]);
  }
  // Every old host is independently proven dead; no native cache can adopt
  // old bytes. A successor will bootstrap the new source normally.
  if(pauses.every(sourceRetired))await setState(tx,await mutation(tx,userId,operationId),"published");
}
