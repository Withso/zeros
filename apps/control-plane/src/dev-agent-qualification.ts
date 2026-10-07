import { devConnectionsEnabled } from "./dev-connections/config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "./db.js";
import { DatabaseCloudAgentCredentialService, CloudAgentModelSchema } from "./cloud-workspaces/agent-credentials.js";
import { type CloudAgentCredentialKind } from "./cloud-workspaces/agent-credential-envelope.js";
import { DevCanaryTargetSchema } from "./cloud-workspaces/dev-native-canary.js";
import { refuseRetiredReleaseWorker } from "./cloud-workspaces/release-worker-retirement.js";
import { HttpError } from "./authz.js";

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

/** SSH-only historical entrypoint: refuse before DB, credential or provider access. */
export async function start(_input: unknown, _env: NodeJS.ProcessEnv): Promise<never> {
  refuseRetiredReleaseWorker();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error(); }
    const result = await start(JSON.parse(input), process.env);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof HttpError && error.code === "release_worker_images_retired"
      ? JSON.stringify({ code: error.code, message: error.message })
      : "Dev agent qualification could not start; credentials and provider output were withheld");
    process.exitCode = 1;
  }
}
