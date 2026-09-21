import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeReadyCloudWorkspaceAccess } from "./access.js";
import { consumeCloudWorkspaceDeviceProof, type CloudWorkspaceDeviceProof } from "./replicas.js";
import { assertProviderPreviewEndpoint } from "./provider.js";
import type { CloudWorkspaceProviderResolver } from "./provider-resolver.js";
import type { CloudPreviewSocketGrant } from "./preview-websocket-relay.js";

export const CLOUD_RUNTIME_SERVICE_PATH = "/v1/cloud-workspaces/services";
export const CLOUD_RUNTIME_SERVICE_PROTOCOL = "zeros.service.v1";
export const CLOUD_RUNTIME_SERVICE_HEADER = "x-zeros-runtime-service";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^zsh_[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value).digest();
const rejected = () => new HttpError(404, "runtime_service_unavailable", "Cloud service is unavailable or expired");

/** Browser WebSockets cannot set an HTTP authorization header. The offered
 * credential protocol is consumed here, never selected or forwarded upstream.
 * A header and a protocol may coexist only when they contain the same token. */
export function runtimeServiceToken(headers: Headers): string | null {
  const header = headers.get(CLOUD_RUNTIME_SERVICE_HEADER);
  const raw = headers.get("sec-websocket-protocol");
  let protocolToken: string | null = null;
  if (raw !== null) {
    const protocols = raw.split(",").map(value => value.trim());
    if (protocols.length < 1 || protocols.length > 2 || new Set(protocols).size !== protocols.length || !protocols.includes(CLOUD_RUNTIME_SERVICE_PROTOCOL)) return null;
    const credential = protocols.find(value => value.startsWith("zeros.authorization."));
    protocolToken = credential?.slice("zeros.authorization.".length) ?? null;
    if (protocols.length === 2 && (!protocolToken || !TOKEN.test(protocolToken))) return null;
  }
  if (header !== null && !TOKEN.test(header)) return null;
  if (header && protocolToken && header !== protocolToken) return null;
  return header ?? protocolToken;
}

export type CloudRuntimeServiceIssue = {
  organizationId: string;
  workspaceId: string;
  accountUserId: string;
  kind: "ssh" | "tunnel";
  remotePort?: number;
  expiresInMinutes: number;
  idempotencyKey: string;
  proof: CloudWorkspaceDeviceProof;
};
export function runtimeServiceProofPayload(input: CloudRuntimeServiceIssue) {
  return { organizationId: input.organizationId, workspaceId: input.workspaceId,
    kind: input.kind, remotePort: input.remotePort ?? null,
    expiresInMinutes: input.expiresInMinutes, idempotencyKey: input.idempotencyKey };
}
type GrantRow = {
  id: string; workspace_id: string; org_id: string; generation: number;
  account_user_id: string; authority_epoch: string | number; engine_instance_id: string;
  provider_resource_id: string; device_id: string; device_key_version: string | number;
  kind: "ssh" | "tunnel"; remote_port: number | null; expires_at: Date;
  request_sha256: Buffer;
  actor_fingerprint:string;
};
type ActiveGrant = GrantRow & { leaseExpiresAtMs: number };
export type CloudRuntimeServiceDocument = {
  grant: { id: string; workspaceId: string; generation: number; kind: "ssh" | "tunnel";
    deviceId: string; remotePort: number | null; expiresAt: string };
  transport: { version: 1; url: string; capability: string;
    headerName: typeof CLOUD_RUNTIME_SERVICE_HEADER; protocol: typeof CLOUD_RUNTIME_SERVICE_PROTOCOL };
  ssh?: { username: "zeros"; hostKey: "stream-introduction" };
};

/** Device-bound human access, independent of the compute provider's SSH API.
 * Bearers are returned once and only their hashes persist. A stream is bound
 * to one engine, generation, authority epoch and exact current device key. */
export class DatabaseCloudRuntimeServiceAccess {
  private readonly origin: string;
  private readonly forbiddenPorts: Set<number>;
  constructor(private readonly options: {
    pool: pg.Pool; providerResolver: CloudWorkspaceProviderResolver;
    publicOrigin: string; enginePort: number; workosEnabled: boolean;
    forbiddenPorts?: number[];
  }) {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
        !Number.isSafeInteger(options.enginePort) || options.enginePort < 1024 || options.enginePort > 65535)
      throw new Error("Invalid native cloud service configuration");
    this.origin = origin.origin;
    this.forbiddenPorts = new Set([22_222, options.enginePort, ...options.forbiddenPorts ?? []]);
  }

  async issue(input: CloudRuntimeServiceIssue): Promise<CloudRuntimeServiceDocument> {
    if (![input.organizationId, input.workspaceId, input.accountUserId].every(value => UUID.test(value)) ||
        !["ssh", "tunnel"].includes(input.kind) || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expiresInMinutes) || input.expiresInMinutes < 1 || input.expiresInMinutes > 30 || !input.proof ||
        (input.kind === "ssh" ? input.remotePort !== undefined :
          !Number.isSafeInteger(input.remotePort) || input.remotePort! < 1024 || input.remotePort! > 65535 || this.forbiddenPorts.has(input.remotePort!)))
      throw new HttpError(422, "invalid_runtime_service", "Cloud service request is invalid");
    const capability = `zsh_${randomBytes(32).toString("base64url")}`;
    const payload = runtimeServiceProofPayload(input);
    const requestHash = digest(JSON.stringify(payload));
    const grant = await withSystemTx(this.options.pool, async tx => {
      const workspace = await authorizeReadyCloudWorkspaceAccess(tx, { ...input, workosEnabled: this.options.workosEnabled });
      const device = await consumeCloudWorkspaceDeviceProof(tx, {
        accountUserId: input.accountUserId, action: "runtime-service.issue", payload, proof: input.proof,
      });
      const previous = (await tx.query<{ request_sha256: Buffer }>(
        `SELECT request_sha256 FROM cloud_workspace_runtime_service_grants
         WHERE workspace_id = $1 AND account_user_id = $2 AND idempotency_key = $3`,
        [input.workspaceId, input.accountUserId, input.idempotencyKey],
      )).rows[0];
      if (previous) throw new HttpError(409, previous.request_sha256.equals(requestHash)
        ? "runtime_service_response_not_replayable" : "idempotency_conflict", "Request a new service grant with a new idempotency key");
      const engines = (await tx.query<{ id: string }>(
        `SELECT id FROM cloud_workspace_engine_instances
         WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
           AND state = 'ready' AND revoked_at IS NULL AND lease_expires_at > now()
         LIMIT 2`, [input.workspaceId, input.organizationId, workspace.generation],
      )).rows;
      if (engines.length !== 1) throw rejected();
      const active = await tx.query<{ count: string }>(
        `SELECT count(*) FROM cloud_workspace_runtime_service_grants access
         JOIN devices device ON device.id = access.device_id AND device.user_id = access.account_user_id
           AND device.key_version = access.device_key_version AND device.trust_state = 'trusted' AND device.revoked_at IS NULL
         WHERE access.workspace_id = $1 AND access.engine_instance_id = $2 AND access.authority_epoch = $3
           AND access.actor_fingerprint=cloud_workspace_actor_fingerprint(access.workspace_id,access.account_user_id)
           AND cloud_workspace_actor_role(access.workspace_id,access.account_user_id) IN ('developer','manager','owner')
           AND access.revoked_at IS NULL AND access.expires_at > now()`,
        [input.workspaceId, engines[0]!.id, workspace.authority_epoch],
      );
      if (Number(active.rows[0]!.count) >= 16) throw new HttpError(429, "runtime_service_limit", "Close an existing cloud service grant first");
      const result = await tx.query<GrantRow>(
        `INSERT INTO cloud_workspace_runtime_service_grants (
          id, workspace_id, generation, org_id, account_user_id, authority_epoch,
          engine_instance_id, provider_resource_id, device_id, device_key_version,
          kind, remote_port, token_hash, idempotency_key, request_sha256, expires_at,actor_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           now() + $16 * interval '1 minute',$17) RETURNING *`,
        [randomUUID(), input.workspaceId, workspace.generation, input.organizationId, input.accountUserId,
          workspace.authority_epoch, engines[0]!.id, workspace.provider_resource_id, device.id, device.key_version,
          input.kind, input.remotePort ?? null, digest(capability), input.idempotencyKey, requestHash, input.expiresInMinutes,workspace.actorFingerprint],
      );
      await audit(tx, input.organizationId, input.accountUserId, "cloud_workspace.runtime_service_issued", {
        workspaceId: input.workspaceId, grantId: result.rows[0]!.id, kind: input.kind, generation: workspace.generation,
      });
      return result.rows[0]!;
    });
    const url = new URL(`${CLOUD_RUNTIME_SERVICE_PATH}/${grant.kind}/${grant.id}`, this.origin);
    url.protocol = "wss:";
    return { grant: { id: grant.id, workspaceId: grant.workspace_id, generation: grant.generation,
      kind: grant.kind, deviceId: grant.device_id, remotePort: grant.remote_port, expiresAt: grant.expires_at.toISOString() },
      transport: { version: 1, url: url.toString(), capability, headerName: CLOUD_RUNTIME_SERVICE_HEADER, protocol: CLOUD_RUNTIME_SERVICE_PROTOCOL },
      ...(grant.kind === "ssh" ? { ssh: { username: "zeros" as const, hostKey: "stream-introduction" as const } } : {}),
    };
  }

  private scope(request: Request): { id: string; kind: "ssh" | "tunnel" } | null {
    const url = new URL(request.url);
    if (url.origin !== this.origin || url.search || url.hash) return null;
    const match = /^\/v1\/cloud-workspaces\/services\/(ssh|tunnel)\/([^/]+)$/.exec(url.pathname);
    return match && UUID.test(match[2]!) ? { id: match[2]!, kind: match[1] as "ssh" | "tunnel" } : null;
  }
  recognizes(request: Request): boolean { return this.scope(request) !== null; }

  private async authorize(tx: Tx, request: Request): Promise<ActiveGrant | null> {
    const scope = this.scope(request), token = runtimeServiceToken(request.headers);
    if (!scope || !token) return null;
    const grant = (await tx.query<GrantRow>(
      `SELECT access.* FROM cloud_workspace_runtime_service_grants access
       JOIN devices device ON device.id = access.device_id AND device.user_id = access.account_user_id
         AND device.key_version = access.device_key_version AND device.trust_state = 'trusted' AND device.revoked_at IS NULL
       WHERE access.id = $1 AND access.kind = $2 AND access.token_hash = $3
         AND access.revoked_at IS NULL AND access.expires_at > now()`,
      [scope.id, scope.kind, digest(token)],
    )).rows[0];
    if (!grant || (grant.remote_port !== null && this.forbiddenPorts.has(grant.remote_port))) return null;
    const workspace = await authorizeReadyCloudWorkspaceAccess(tx, {
      organizationId: grant.org_id, workspaceId: grant.workspace_id, accountUserId: grant.account_user_id,
      workosEnabled: this.options.workosEnabled,workspaceLock:"share",
    });
    if (workspace.actorFingerprint!==grant.actor_fingerprint || workspace.generation !== grant.generation || String(workspace.authority_epoch) !== String(grant.authority_epoch) ||
        workspace.provider_resource_id !== grant.provider_resource_id) return null;
    const engine = (await tx.query<{ lease_expires_at: Date }>(
      `SELECT lease_expires_at FROM cloud_workspace_engine_instances
       WHERE id = $1 AND workspace_id = $2 AND org_id = $3 AND generation = $4
         AND state = 'ready' AND revoked_at IS NULL AND lease_expires_at > now()`,
      [grant.engine_instance_id, grant.workspace_id, grant.org_id, grant.generation],
    )).rows[0];
    if (!engine) return null;
    return { ...grant, leaseExpiresAtMs: Math.min(Date.now() + 10_000, grant.expires_at.getTime(), engine.lease_expires_at.getTime()) };
  }

  async resolve(request: Request): Promise<CloudPreviewSocketGrant | null> {
    const grant = await withSystemTx(this.options.pool, tx => this.authorize(tx, request)).catch(() => null);
    if (!grant) return null;
    const resolved = await this.options.providerResolver.resolve({ workspaceId: grant.workspace_id,
      organizationId: grant.org_id, generation: grant.generation, purpose: "preview" });
    if (!resolved.provider.getEngineEndpoint) return null;
    const endpoint = await resolved.provider.getEngineEndpoint(grant.provider_resource_id, this.options.enginePort);
    assertProviderPreviewEndpoint({ url: endpoint.url, headerName: endpoint.headerName ?? "x-zeros-endpoint-validation", headerValue: endpoint.headerValue ?? "none" });
    if ((endpoint.headerName === undefined) !== (endpoint.headerValue === undefined) || endpoint.headerName?.startsWith("x-zeros-")) return null;
    const current = await withSystemTx(this.options.pool, tx => this.authorize(tx, request)).catch(() => null);
    if (!current || current.id !== grant.id) return null;
    return { grantId: grant.id, workspaceId: grant.workspace_id, organizationId: grant.org_id, generation: grant.generation,
      resourceId: grant.provider_resource_id, remotePort: grant.remote_port, expiresAtMs: current.leaseExpiresAtMs,
      endpoint, headers: { [CLOUD_RUNTIME_SERVICE_HEADER]: runtimeServiceToken(request.headers)! },
      upstreamPath: `/services/v1/${grant.kind}`, release() {} };
  }

  async revalidate(request: Request, expected: CloudPreviewSocketGrant): Promise<number | null> {
    const grant = await withSystemTx(this.options.pool, tx => this.authorize(tx, request)).catch(() => null);
    return grant && grant.id === expected.grantId && grant.workspace_id === expected.workspaceId &&
      grant.org_id === expected.organizationId && grant.generation === expected.generation &&
      grant.provider_resource_id === expected.resourceId && grant.remote_port === expected.remotePort ? grant.leaseExpiresAtMs : null;
  }

  async revoke(input: { organizationId: string; workspaceId: string; accountUserId: string; grantId: string }): Promise<void> {
    if (![input.organizationId, input.workspaceId, input.accountUserId, input.grantId].every(value => UUID.test(value))) throw rejected();
    // Only the authenticated owning account can revoke its grant. Revocation
    // remains available after stop, loss of a paid seat, or device retirement.
    await withSystemTx(this.options.pool, async tx => {
      const result = await tx.query(
        `UPDATE cloud_workspace_runtime_service_grants SET revoked_at = coalesce(revoked_at, now())
         WHERE id = $1 AND workspace_id = $2 AND org_id = $3 AND account_user_id = $4 RETURNING id`,
        [input.grantId, input.workspaceId, input.organizationId, input.accountUserId],
      );
      if (result.rowCount !== 1) throw rejected();
      await audit(tx, input.organizationId, input.accountUserId, "cloud_workspace.runtime_service_revoked", {
        workspaceId: input.workspaceId, grantId: input.grantId,
      });
    });
  }
}
