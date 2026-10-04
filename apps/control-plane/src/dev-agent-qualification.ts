import { devConnectionRuntime } from "./dev-connections/runtime.js";
import { devConnectionsEnabled } from "./dev-connections/config.js";
import { prepareDevReferenceCanaryAccess } from "./dev-connections/qualification.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { createPool, withSystemTx, type Tx } from "./db.js";
import { DatabaseCloudAgentCredentialService, CloudAgentModelSchema } from "./cloud-workspaces/agent-credentials.js";
import { openCloudAgentCredential, type CloudAgentCredentialKeys, type CloudAgentCredentialKind, type CloudAgentCredentialMaterial } from "./cloud-workspaces/agent-credential-envelope.js";
import { DatabaseCodexAuthRenewal } from "./cloud-workspaces/codex-auth-renewal.js";
import { DevCanaryTargetSchema, startNativeDevCanary, type DevRenewalProof } from "./cloud-workspaces/dev-native-canary.js";
import { prepareNativeCanaryAccess as prepareDevCanaryAccess } from "./cloud-workspaces/native-canary-access.js";

const imageSchema = DevCanaryTargetSchema.omit({ id: true, attempt: true });
export const DevAgentRequestSchema = z.object({
  owner: z.string().regex(/^[a-f0-9]{24}$/), generation: z.string().uuid(),
  fixture: z.object({ workosUserId: z.string().regex(/^user_[A-Za-z0-9]+$/), workosOrganizationId: z.string().regex(/^org_[A-Za-z0-9]+$/),
    expectedEmail: z.string().email(), expectedOrganizationSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }).strict(),
  image: imageSchema,
  accountScope: z.string().min(1).max(200).optional(),
  referenceMode: z.literal(true).optional(),
  organizationImage: imageSchema.extend({ id: z.string().uuid() }).strict().optional(),
}).strict();
type Request = z.infer<typeof DevAgentRequestSchema>;
const startSchema = DevAgentRequestSchema.extend({ target: DevCanaryTargetSchema, credentialId: z.string().uuid(),
  credentialRevision: z.number().int().positive(), connectionRevision: z.number().int().positive(),
  model: CloudAgentModelSchema, startedAt: z.number().int().positive() }).strict();

export function assertDevAgentEnvironment(request: Request, env: NodeJS.ProcessEnv) {
  DevAgentRequestSchema.parse(request);
  if (env.ZEROS_DEV_ENVIRONMENT !== "hosted" || env.ZEROS_DEV_OWNER !== request.owner || env.ZEROS_DEV_GENERATION !== request.generation ||
      env.BOAT_SNAPSHOT_ID !== request.image.snapshotId || env.BOAT_IMAGE_BUILD_SHA256 !== request.image.buildSha256 ||
      env.ZEROS_CLOUD_SOURCE_COMMIT !== request.image.sourceCommit ||
      request.accountScope !== undefined && request.accountScope !== env.BOAT_ACCOUNT_SCOPE ||
      request.referenceMode && !devConnectionsEnabled(env)) throw new Error("Dev qualification backend identity mismatch");
}

export function devAgentModel(provider: string, models: string[]) {
  const preferred = provider === "claude" ? "claude-haiku-4-5" : provider === "codex" ? "gpt-5.6-luna" : "grok-4.6";
  return CloudAgentModelSchema.parse(models.includes(preferred) ? preferred : models[0]);
}

export type DevAgentConnection = { provider: string; kind: CloudAgentCredentialKind; credentialId: string; credentialRevision: number;
  connectionRevision: number; model: string; enabled: boolean; mode?: "dev-reference" };
type OrganizationImage = NonNullable<Request["organizationImage"]> & { contractSha256: string; connections: DevAgentConnection[] };
type Status = { needsSignIn: true } | { needsSeed: true } | { actorUserId: string; organizationId: string;
  connections: DevAgentConnection[]; organizationImages?: OrganizationImage[] };

/** Read-only discovery uses the product's account consent implementation. It
 * cannot borrow another member's token or enable an unselected connection. */
export async function inspectDevAgents(pool: pg.Pool, input: Request): Promise<Status> {
  const request = DevAgentRequestSchema.parse(input);
  const identities = (await pool.query("SELECT owner,generation FROM zeros_development_identity")).rows;
  if (identities.length !== 1 || identities[0].owner !== request.owner || identities[0].generation !== request.generation) {
    throw new Error("Dev qualification database identity mismatch");
  }
  const selected = await withSystemTx(pool, async tx => {
    const users = (await tx.query<{ id: string; email: string; staff_role: string }>(`SELECT u.id,u.email::text,u.staff_role FROM user_identities i
      JOIN users u ON u.id=i.user_id WHERE i.provider='workos' AND i.provider_sub=$1 AND i.status='active'
        AND i.email_verified_at IS NOT NULL AND u.auth_status='active' AND u.deleted_at IS NULL`, [request.fixture.workosUserId])).rows;
    if (!users.length) return null;
    if (users.length !== 1 || users[0]!.email.toLowerCase() !== request.fixture.expectedEmail.toLowerCase()) throw new Error("Dev qualification fixture identity mismatch");
    const user = users[0]!;
    const organizations = (await tx.query<{ id: string; slug: string }>(`SELECT o.id,o.slug::text FROM organizations o
      JOIN workos_organization_links l ON l.organization_id=o.id JOIN organization_members m ON m.org_id=o.id
      WHERE l.workos_organization_id=$1 AND l.state='active' AND m.user_id=$2 AND m.role='owner'
        AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND NOT o.is_personal AND o.cloud_workspaces_allowed`,
    [request.fixture.workosOrganizationId, user.id])).rows;
    if (!organizations.length || user.staff_role !== "platform_owner") return { needsSeed: true as const };
    if (organizations.length !== 1 || organizations[0]!.slug !== request.fixture.expectedOrganizationSlug) throw new Error("Dev qualification organization mismatch");
    return { user, organization: organizations[0]! };
  });
  if (!selected) return { needsSignIn: true };
  if (selected.needsSeed) return { needsSeed: true };
  // Metadata reads do not decrypt credential material.
  const service = new DatabaseCloudAgentCredentialService(pool, { keys: {}, currentKeyVersion: 1 });
  const accounts = await service.organizationConnections(selected.user.id, selected.organization.id);
  const enabled = await withSystemTx(pool, async tx => (await tx.query<{ credential_kind: string }>(`SELECT credential_kind
    FROM cloud_agent_runtime_qualifications WHERE provider='boat' AND image_ref=$1 AND enabled AND profile='zeros-cloud-worker-v3'`,
  [`boat:${request.image.snapshotId}@sha256:${request.image.buildSha256}`])).rows);
  const referenceMode=request.referenceMode === true || devConnectionsEnabled(process.env);
  const references=referenceMode?await withSystemTx(pool,async tx=>(await tx.query<{binding_id:string}>("SELECT binding_id FROM dev_connection_references WHERE owner_user_id=$1 AND org_id=$2 AND generation_id=$3 AND invalidated_at IS NULL AND removed_at IS NULL",[selected.user.id,selected.organization.id,request.generation])).rows):[];
  const connections: DevAgentConnection[] = [];
  for (const connection of accounts.connections.filter(row => row.connected)) {
    const credential = accounts.credentials.find(row => row.id === connection.credentialId)!;
    if(referenceMode&&!references.some(row=>row.binding_id===credential.id))continue;
    connections.push({ provider: connection.provider, kind: credential.kind, credentialId: credential.id, credentialRevision: credential.revision,
      connectionRevision: connection.revision, ...(references.some(row=>row.binding_id===credential.id)?{mode:"dev-reference" as const}:{}), model: devAgentModel(connection.provider, connection.models), enabled: enabled.some(row => row.credential_kind === credential.kind) });
  }
  const organizationImages: OrganizationImage[] | undefined = request.accountScope === undefined ? undefined : await withSystemTx(pool, async tx => {
    const images = await tx.query<{ id: string; snapshot_name: string; build_sha256: string; base_source_commit: string;
      image_contract: string; enabled_kinds: string[] }>(`SELECT image.id,image.snapshot_name,image.build_sha256,image.base_source_commit,image.image_contract,
        ARRAY(SELECT q.credential_kind FROM cloud_agent_runtime_qualifications q WHERE q.provider='boat'
          AND q.image_ref=image.image_ref AND q.enabled AND q.profile='zeros-cloud-worker-v3'
          AND q.runtime_contract_sha256=image.image_contract AND q.qualified_at>=image.attested_at) AS enabled_kinds
      FROM cloud_computer_images image JOIN cloud_computer_builds build ON build.id=image.id AND build.org_id=image.org_id
      JOIN cloud_computers computer ON computer.org_id=image.org_id
      WHERE image.org_id=$1 AND image.account_scope=$2 AND image.state='attested' AND build.state='succeeded'
        AND image.base_image_ref=$3 AND image.base_source_commit=$4 AND image.snapshot_id IS NOT NULL
        AND image.image_ref='boat:'||image.snapshot_name||'@sha256:'||image.build_sha256
      ORDER BY (image.id=computer.active_image_id) DESC NULLS LAST,image.created_at DESC LIMIT 10`,
    [selected.organization.id, request.accountScope, `boat:${request.image.snapshotId}@sha256:${request.image.buildSha256}`, request.image.sourceCommit]);
    return images.rows.map(image => ({ id: image.id, snapshotId: image.snapshot_name, buildSha256: image.build_sha256,
      sourceCommit: image.base_source_commit, contractSha256: image.image_contract,
      connections: connections.map(connection => ({ ...connection, enabled: image.enabled_kinds.includes(connection.kind) })) }));
  });
  const chosen = request.organizationImage && organizationImages?.find(image => image.id === request.organizationImage!.id &&
    image.snapshotId === request.organizationImage!.snapshotId && image.buildSha256 === request.organizationImage!.buildSha256 &&
    image.sourceCommit === request.organizationImage!.sourceCommit);
  if (request.organizationImage && !chosen) throw new Error("Dev organization image changed or is unavailable");
  return { actorUserId: selected.user.id, organizationId: selected.organization.id, connections: chosen ? chosen.connections : connections,
    ...(organizationImages === undefined ? {} : { organizationImages }) };
}

export { prepareNativeCanaryAccess as prepareDevCanaryAccess } from "./cloud-workspaces/native-canary-access.js";

/** SSH-only operator entrypoint, never registered as a public API. The login
 * role is the ordinary runtime role: approval writes remain migration-owned. */
async function start(input: unknown, env: NodeJS.ProcessEnv) {
  const request = startSchema.parse(input), base = DevAgentRequestSchema.parse({ owner: request.owner, generation: request.generation,
    fixture: request.fixture, image: request.image, accountScope: request.accountScope, referenceMode: request.referenceMode,
    organizationImage: request.organizationImage });
  assertDevAgentEnvironment(base, env);
  const image = request.organizationImage ?? request.image;
  if (process.platform !== "linux" || Date.now() - request.startedAt > 12 * 60_000 || request.startedAt > Date.now() + 5000 ||
      request.target.snapshotId !== image.snapshotId || request.target.sourceCommit !== image.sourceCommit ||
      request.target.buildSha256 !== image.buildSha256) throw new Error("Invalid Dev canary dispatch");
  const pool = createPool(env.DATABASE_URL!, { maxConnections: 2, applicationName: "zeros-dev-agent-canary" });
  try {
    const status = await inspectDevAgents(pool, base);
    if (!("connections" in status)) throw new Error("Dev member is not ready");
    const connection = status.connections.find(row => row.credentialId === request.credentialId && row.credentialRevision === request.credentialRevision &&
      row.connectionRevision === request.connectionRevision && row.model === request.model);
    if (!connection) throw new Error("Dev connection changed before qualification");
    const occupied = await withSystemTx(pool, tx => tx.query("SELECT 1 FROM cloud_workspace_provider_operations WHERE resource_id=$1", [request.target.id]));
    if (occupied.rowCount) throw new Error("Dev qualification requires a separate disposable worker");
    if (request.organizationImage && (await withSystemTx(pool, tx => tx.query(
      "SELECT 1 FROM cloud_computer_images WHERE builder_id=$1 OR verifier_id=$1", [request.target.id]))).rowCount)
      throw new Error("An image builder or verifier cannot qualify its own output");
    const keys: CloudAgentCredentialKeys = { keys: { 1: env.CLOUD_WORKSPACE_SECRET_KEY_V1! }, currentKeyVersion: 1,
      refreshFingerprints: { keys: JSON.parse(env.CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON!), currentKeyVersion: Number(env.CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION) } };
    const read = async (tx: Tx) => {
      const row = (await tx.query<{ id: string; owner_user_id: string; revision: string; current_version: number }>(`SELECT id,owner_user_id,revision::text,current_version
        FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 AND revision=$3 AND kind=$4 AND revoked_at IS NULL FOR UPDATE`,
      [connection.credentialId, status.actorUserId, connection.credentialRevision, connection.kind])).rows[0];
      if (!row) throw new Error("Dev credential changed");
      const version = (await tx.query("SELECT * FROM cloud_agent_credential_versions WHERE credential_id=$1 AND version=$2", [row.id, row.current_version])).rows[0];
      const material = openCloudAgentCredential({ nonce: version.nonce, ciphertext: version.ciphertext, authTag: version.auth_tag },
        { credentialId: row.id, ownerUserId: row.owner_user_id, kind: connection.kind, version: row.current_version, keyVersion: version.key_version }, keys.keys);
      if (material.kind === "codex-chatgpt" && material.refreshToken) throw new Error("Only access material may reach the canary");
      return { credential: row, material };
    };
    const renew = new DatabaseCodexAuthRenewal(pool, keys);
    const runtime=connection.mode==='dev-reference'?devConnectionRuntime(pool,keys,env):null;
    if(connection.mode==='dev-reference'&&!runtime)throw new Error('Dev reference qualification is disabled');
    if(runtime)await runtime.consumeInvalidations();
    const referenceAccess=(expectedVersion?:number)=>withSystemTx(pool,async tx=>{
      const selected=await tx.query(`SELECT 1 FROM cloud_agent_organization_connections c JOIN cloud_agent_credentials a ON a.id=c.credential_id
        WHERE c.org_id=$1 AND c.owner_user_id=$2 AND c.credential_id=$3 AND c.revision=$4 AND a.revision=$5 AND a.revoked_at IS NULL AND $6=ANY(c.models)`,
      [status.organizationId,status.actorUserId,connection.credentialId,connection.connectionRevision,connection.credentialRevision,connection.model]);
      if(!selected.rowCount)throw new Error('Dev qualification consent changed');
      return runtime!.issue(tx,connection.credentialId,status.actorUserId,status.organizationId,{action:'agent',workspaceId:request.target.attempt,model:connection.model},
        expectedVersion===undefined?undefined:{expectedVersion});
    });
    const access=runtime?await prepareDevReferenceCanaryAccess(()=>referenceAccess(),version=>referenceAccess(version)):await prepareDevCanaryAccess(() => withSystemTx(pool, read), async () => {
      const reservation = await withSystemTx(pool, async tx => { const current = await read(tx); return renew.reserve(tx, current.credential, true); });
      if (!reservation) throw new Error("Dev native renewal unavailable");
      await renew.complete(reservation);
    });
    const {before,renewedCodex,renewal}=access;
    const accessDeadline='expiresAt' in access?access.expiresAt as number:Date.now()+14*60_000;
    const boat = async (method: string, route: string, body?: unknown): Promise<any> => {
      const response = await fetch(`https://boat.dev/api/v1${route}`, { method, redirect: "error", signal: AbortSignal.timeout(55_000),
        headers: { authorization: `Bearer ${env.BOAT_API_KEY}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error("Dev canary provider request failed");
      const bytes = await response.text(); if (bytes.length > 1024 * 1024) throw new Error("Dev canary response exceeded its bound");
      return JSON.parse(bytes);
    };
    const sandbox = await boat("GET", `/sandboxes/${request.target.id}`);
    if (sandbox.sandbox?.team?.id !== env.BOAT_BILLING_ORG) throw new Error("Dev canary account mismatch");
    await startNativeDevCanary({
      command: async command => { const result = await boat("POST", `/sandboxes/${request.target.id}/commands`, { command, timeoutSeconds: 25 });
        if (result.exitCode !== 0 || result.timedOut) throw new Error("Dev canary command failed"); return String(result.stdout); },
      upload: async (file, contents) => { const result = await boat("PUT", `/sandboxes/${request.target.id}/files`, { path: file, encoding: "base64", content: contents.toString("base64") });
        if (result.size !== contents.length) throw new Error("Dev canary private input upload was not confirmed"); },
    }, request.target, { version: 1, expiresAtMs: accessDeadline, sourceCommit: image.sourceCommit,
      buildSha256: image.buildSha256, model: connection.model, material: before.material, ...(renewedCodex ? { renewedCodex } : {}) }, renewal);
    return { started: true };
  } finally { await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error(); }
    const result = await start(JSON.parse(input), process.env);
    console.log(JSON.stringify(result));
  } catch { console.error("Dev agent qualification could not start; credentials and provider output were withheld"); process.exitCode = 1; }
}
