import { z } from "zod";
import { createHash } from "node:crypto";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";

const CloudAgentProviderSchema = z.enum(["codex", "claude", "cursor"]);
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

const sourceSchema = z.object({
  organizations: z.array(uuid).min(1).max(32).nullable(),
  selectors: z.array(z.object({provider:CloudAgentProviderSchema,credentialId:uuid}).strict()).min(1).max(32),
  devReference: z.object({ referenceId: uuid, organizationId: uuid, scope: z.enum(["local", "organization", "global"]),
    connectionId: uuid, generationId: uuid, referenceRevision: revision, consentRevision: revision,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict();
type RemovalSource = z.infer<typeof sourceSchema>;
type Mutation = {
  id: string; owner_user_id: string; target: unknown; source_snapshot: unknown; request_sha256: Buffer;
  fence_epoch: string; revision: string; state: "preparing" | "awaiting-confirmation" | "removing" | "cancelling" | "removed" | "cancelled" | "expired";
  decision: "remove" | "cancel" | "expire" | null; decision_revision: string | null; expires_at: Date;
};
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
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412)) /*lock_purpose='agent-credential-owner'*/", [userId]);
}
/** Vault and Dev-reference writers share the same owner transaction lock. */
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
  checked(CloudAgentCredentialRemovalTargetSchema, row.target); checked(sourceSchema, row.source_snapshot);
  if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1 || !Number.isSafeInteger(Number(row.fence_epoch)) || Number(row.fence_epoch) < 1) denied();
  return row;
}
function outcome(row: Mutation): CloudAgentCredentialRemovalOutcome {
  const base = { version: 1, operationId: row.id, revision: Number(row.revision) };
  if (row.state === "awaiting-confirmation") return checked(CloudAgentCredentialRemovalOutcomeSchema,
    { ...base, state: row.state, expiresAt: row.expires_at.toISOString(), confirmedRunning: true });
  if (row.state === "preparing" || row.state === "removing" || row.state === "cancelling") return checked(CloudAgentCredentialRemovalOutcomeSchema,
    { ...base, state: "pending", phase: row.state, retryAfterMs: 1000 });
  return checked(CloudAgentCredentialRemovalOutcomeSchema, { ...base, state: row.state });
}
/** A pending remote Dev removal owns its captured source until its broker receipt arrives. */
export async function assertCloudAgentCredentialMutationAllowed(tx: Tx, ownerUserId: string,
  scope: { credentialId: string; organizationId?: string }): Promise<void> {
  await lockOwner(tx, ownerUserId);
  const pending = await tx.query(`SELECT 1 FROM cloud_agent_credential_mutations
    WHERE owner_user_id=$1 AND state IN ('preparing','awaiting-confirmation','removing','cancelling')
      AND source_snapshot->'selectors' @> jsonb_build_array(jsonb_build_object('credentialId',$2::text))
      AND ($3::uuid IS NULL OR source_snapshot->'organizations'='null'::jsonb OR source_snapshot->'organizations' @> to_jsonb($3::text)) LIMIT 1`,
    [ownerUserId, scope.credentialId, scope.organizationId ?? null]);
  if (pending.rowCount) busy();
}

async function setState(tx: Tx, row: Mutation, state: Mutation["state"], decision = row.decision) {
  await tx.query(`UPDATE cloud_agent_credential_mutations SET state=$2,decision=$3,
    decision_revision=CASE WHEN decision IS NULL AND $3::text IS NOT NULL THEN revision ELSE decision_revision END,revision=revision+1 WHERE id=$1`,
  [row.id, state, decision]);
}

export async function prepareCloudAgentCredentialRemoval(tx: Tx, userId: string, value: unknown): Promise<CloudAgentCredentialRemovalOutcome> {
  const request = checked(CloudAgentCredentialRemovalPrepareSchema, value);
  await lockOwner(tx, userId);
  const previous = (await tx.query<Mutation>("SELECT * FROM cloud_agent_credential_mutations WHERE id=$1 FOR UPDATE", [request.operationId])).rows[0];
  if (previous) { if (previous.owner_user_id !== userId) denied(); if (!previous.request_sha256.equals(hash(request))) conflict(); return outcome(previous); }
  const count = Number((await tx.query<{ count: string }>("SELECT count(*) FROM cloud_agent_credential_mutations WHERE owner_user_id=$1", [userId])).rows[0]!.count);
  if (!Number.isSafeInteger(count) || count >= 128) busy();
  const source = await removalSource(tx, userId, request.target);
  await tx.query("INSERT INTO cloud_agent_credential_mutations(id,owner_user_id,target,source_snapshot,request_sha256) VALUES($1,$2,$3,$4,$5)",
    [request.operationId, userId, request.target, source, hash(request)]);
  const row = await mutation(tx, userId, request.operationId);
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
    if (row.expires_at.getTime() <= Date.now()) { await setState(tx, row, "cancelling", "expire"); }
    else {
      if (action === "confirm" && row.state !== "awaiting-confirmation") conflict();
      // Revalidate the exact frozen source before accepting irreversible Yes.
      if (action === "confirm" && !hash(await removalSource(tx, userId, checked(CloudAgentCredentialRemovalTargetSchema, row.target))).equals(hash(row.source_snapshot))) conflict();
      await setState(tx, row, action === "confirm" ? "removing" : "cancelling", action === "confirm" ? "remove" : "cancel");
    }
  }
  await tx.query("INSERT INTO cloud_agent_credential_mutation_decisions(mutation_id,request_id,action,request_sha256) VALUES($1,$2,$3,$4)",
    [row.id, request.requestId, action, digest]);
  await progressRemoval(tx, await mutation(tx, userId, row.id));
  return outcome(await mutation(tx, userId, row.id));
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

    return true;
  }
  if (!hash(await removalSource(tx, row.owner_user_id, target)).equals(hash(source))) conflict();
  if (target.kind === "revoke-credential") {
    await tx.query("UPDATE cloud_agent_credentials SET revoked_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND revision=$3",
      [target.credentialId, row.owner_user_id, target.expectedCredentialRevision]);
    await tx.query("DELETE FROM cloud_agent_credential_versions WHERE credential_id=$1", [target.credentialId]);
    await tx.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=$1", [target.credentialId]);

  } else {
    const credentialId = source.selectors[0]!.credentialId;
    await tx.query(`UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',all_models=false,
      revision=revision+1,request_sha256=digest(request_sha256,'sha256'),updated_at=now()
      WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3 AND ($4::text IS NULL OR provider=$4)`,
    [target.organizationId, row.owner_user_id, credentialId, target.kind === "disconnect-provider" ? target.provider : null]);
    if (target.kind === "remove-organization-credential") await tx.query("DELETE FROM cloud_agent_credential_organizations WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3",
      [target.organizationId, row.owner_user_id, credentialId]);
  }
  if(source.devReference?.scope==="local") {
    await tx.query("UPDATE dev_connection_references SET removed_at=now(),invalidated_at=now() WHERE binding_id=$1 AND owner_user_id=$2",[source.devReference.referenceId,row.owner_user_id]);
    await tx.query("UPDATE cloud_agent_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_user_id=$2",[source.devReference.referenceId,row.owner_user_id]);
  }
  return true;
}
/** V2 pushes complete login config to connected workers. The vault no longer
 * waits for a retired engine's boot/control acknowledgement. Remote Dev
 * revocation still waits for the broker's exact, durable receipt. */
async function progressRemoval(tx: Tx, row: Mutation): Promise<void> {
  if (["removed", "cancelled", "expired"].includes(row.state)) return;
  if (row.decision === null && row.expires_at.getTime() <= Date.now()) {
    await setState(tx, row, "expired", "expire");
    return;
  }
  if (row.state === "preparing") {
    if (row.expires_at.getTime() <= Date.now()) { await setState(tx,row,"expired","expire"); return; }
    await setState(tx,row,"removing","remove");
    row = await mutation(tx,row.owner_user_id,row.id);
  }
  if (row.state === "cancelling") {
    await setState(tx,row,row.decision === "expire" ? "expired" : "cancelled");
  } else if (row.state === "removing" && await commitSourceRemoval(tx,row)) {
    await setState(tx,row,"removed");
  }
}

/** Private Dev broker handoff for the frozen source.
 * The public client never supplies broker/source identity or a stop receipt. */
export async function pendingCloudAgentCredentialRemoteRemoval(tx:Tx,userId:string,operationId:string) {
  await lockOwner(tx,userId);const row=await mutation(tx,userId,operationId),source=checked(sourceSchema,row.source_snapshot);
  if(row.state!=="removing"||row.decision!=="remove"||!source.devReference||source.devReference.scope==="local")return null;
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

