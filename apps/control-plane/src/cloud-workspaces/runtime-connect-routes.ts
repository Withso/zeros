import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { rateLimit } from "../ratelimit.js";
import { deviceSessionLive } from "../realtime/device-sessions.js";
import {
  cloudDirectProviderWebSocketUrl,
  type CloudDirectProviderEndpointLookup,
  type CloudDirectProviderLookupScope,
} from "./actor-sessions.js";
import {
  CapabilityIssuanceError,
  CapabilityIssuerUnavailableError,
  issueClientCapabilities,
  type IssuedCapability,
} from "./capability-issuer.js";
import type { CloudCapabilityService } from "./capability-routes.js";
import { publicCloudError } from "./public-contract.js";
import {
  consumeCloudWorkspaceDeviceProof,
  WorkspaceReplicaError,
  type CloudWorkspaceDeviceProof,
} from "./replicas.js";
import { deviceProof, readCloudWorkspaceDocument } from "./routes.js";
import { CLOUD_WORKSPACE_V2_REQUIRED, requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";

export const CLOUD_RUNTIME_CONNECT_PATH = "/v1/organizations/:organization/cloud-workspaces/:workspace/runtime/connect";
export const CLOUD_RUNTIME_CAPABILITIES_PATH = "/v1/organizations/:organization/cloud-workspaces/:workspace/runtime/capabilities";
/** Device proof actions (S3 "Runtime connect"). Each payload is the request
 * body plus the path's lowercase `organizationId` and `workspaceId`, so a
 * proof cannot be replayed for another workspace, device session or route set. */
export const RUNTIME_CONNECT_PROOF_ACTION = "runtime.connect";
export const RUNTIME_CAPABILITIES_PROOF_ACTION = "runtime.capabilities";
export const DEFAULT_RELAY_HEDGE_MS = 400;
/** The direct route's provider lookup runs after the transaction; a slower
 * lookup leaves the response with the other routes. */
const DIRECT_ENDPOINT_TIMEOUT_MS = 5_000;

const PATH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const CapabilitiesBodySchema = z.object({ deviceSessionId: Uuid, clientSessionId: Uuid }).strict();
const ConnectBodySchema = z.object({
  deviceSessionId: Uuid,
  clientSessionId: Uuid,
  routes: z.array(z.enum(["direct", "relay"])).min(1).max(2).refine(routes => new Set(routes).size === routes.length),
}).strict();

type FailureStatus = 401 | 403 | 404 | 409 | 422 | 503;
type FailureDetail = { retryable?: boolean; wakeable?: boolean };

/** A refusal with its public status and code. */
export class CloudRuntimeConnectError extends Error {
  constructor(readonly status: FailureStatus, readonly code: string, readonly detail: FailureDetail = {}) {
    super(`Runtime connect refused: ${code}`);
    this.name = "CloudRuntimeConnectError";
  }
}

export type CloudRuntimeTarget = {
  generation: number;
  engineInstanceId: string;
  /** The provider resource observed running, for the direct route. */
  providerResourceId: string | null;
};

export type CloudRuntimeCapabilities = CloudRuntimeTarget & {
  engine: IssuedCapability;
  realtime: IssuedCapability;
  renewAt: Date;
};

/** Authorizes the caller for the workspace and finds the one engine running
 * its current generation, with the predicate runtime admission uses. Null
 * when none is running it: connect never wakes a workspace. */
export async function readCloudRuntimeTarget(
  tx: Tx,
  scope: { organizationId: string; workspaceId: string; actorUserId: string },
  workosEnabled: boolean,
): Promise<CloudRuntimeTarget | null> {
  const workspace = (await tx.query<{ generation: number; role: string | null }>(
    `SELECT current_generation AS generation, cloud_workspace_actor_role(id, $3) AS role
     FROM cloud_workspaces WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [scope.workspaceId, scope.organizationId, scope.actorUserId])).rows[0];
  if (!workspace) throw new CloudRuntimeConnectError(404, "cloud_workspace_not_found");
  if (!workspace.role) throw new CloudRuntimeConnectError(403, "workspace_role_required");
  try {
    await requireSupportedCloudWorkspaceGeneration(tx, { ...scope, generation: workspace.generation });
  } catch (error) {
    if (error instanceof HttpError && error.code === CLOUD_WORKSPACE_V2_REQUIRED) throw new CloudRuntimeConnectError(409, error.code);
    throw error;
  }
  const engines = (await tx.query<{ id: string; provider_resource_id: string | null }>(
    `SELECT engine.id, binding.provider_resource_id
     FROM cloud_workspace_engine_instances engine
     JOIN cloud_workspaces workspace ON workspace.id = engine.workspace_id AND workspace.org_id = engine.org_id
       AND workspace.current_generation = engine.generation AND workspace.owner_user_id = engine.account_user_id
     LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id = workspace.id
       AND binding.org_id = workspace.org_id AND binding.generation = engine.generation AND binding.observed_state = 'running'
     WHERE workspace.id = $1 AND workspace.org_id = $2 AND workspace.current_generation = $4 AND workspace.deleted_at IS NULL
       AND workspace.desired_state = 'running' AND workspace.status IN ('ready', 'busy')
       AND engine.state = 'ready' AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
       AND engine.lease_expires_at > clock_timestamp()
       AND cloud_workspace_generation_policy_current(workspace.id, engine.generation, workspace.org_id)
       AND cloud_workspace_runtime_authority_live(workspace.id, engine.generation, workspace.owner_user_id, $3)
     LIMIT 2`,
    [scope.workspaceId, scope.organizationId, workosEnabled, workspace.generation])).rows;
  if (engines.length === 0) return null;
  // Two ready engines for one generation is a fence the reconciler settles;
  // a retry after that finds one.
  if (engines.length > 1) throw new CloudRuntimeConnectError(503, "cloud_workspace_unavailable", { retryable: true });
  return { generation: workspace.generation, engineInstanceId: engines[0]!.id, providerResourceId: engines[0]!.provider_resource_id };
}

/** The runtime connection's `zeros:engine` and `zeros:realtime` tokens for
 * the target engine, from one issuance read. The caller has verified the
 * bearer, the device and the device session; pushed renewals reuse this with
 * the same checks minus a fresh device proof (S1 "Issuance"). */
export async function issueCloudRuntimeCapabilities(
  tx: Tx,
  service: Pick<CloudCapabilityService, "keyStore" | "issuer">,
  scope: { organizationId: string; workspaceId: string; actorUserId: string; deviceId: string; sessionId: string },
  target: CloudRuntimeTarget,
): Promise<CloudRuntimeCapabilities> {
  const issued = await issueClientCapabilities(tx, service.keyStore, service.issuer,
    { ...scope, engineInstanceId: target.engineInstanceId }, ["zeros:engine", "zeros:realtime"] as const);
  // The engine stopped or the generation moved between the two reads.
  if (issued.generation !== target.generation || issued.engineInstanceId !== target.engineInstanceId)
    throw new CloudRuntimeConnectError(503, "cloud_workspace_unavailable", { retryable: true });
  const engine = issued.capabilities["zeros:engine"], realtime = issued.capabilities["zeros:realtime"];
  return { ...target, engine, realtime, renewAt: new Date(Math.min(engine.renewAt.getTime(), realtime.renewAt.getTime())) };
}

export type CloudRuntimeConnectOptions = {
  capabilities: CloudCapabilityService;
  /** For `wakeable`, the workspace document's `canStart`. */
  cloudWorkspaces: CloudWorkspaceBackendConfig | null;
  /** The direct route: the engine port and the provider lookup of its endpoint. */
  direct?: { enginePort: number; endpoint: CloudDirectProviderEndpointLookup };
  /** `wss://…/v1/relay` on the realtime origin, offered while `relay_over_uplink` is on. */
  relayUrl?: string;
  /** Clamped to 300–500 ms. */
  relayHedgeMs?: number;
};

type RuntimeRoute = { kind: "direct" | "relay"; url: string; priority: number };

function notFound(c: Context) {
  return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
}

function failure(c: Context, status: FailureStatus, code: string, detail: FailureDetail = {}) {
  if (status === 503) console.warn("[cloud-runtime] connect unavailable", { code });
  return c.json({ error: { ...publicCloudError(code), ...detail } }, status);
}

function refusal(c: Context, error: unknown) {
  if (error instanceof CloudRuntimeConnectError) return failure(c, error.status, error.code, error.detail);
  if (error instanceof CapabilityIssuerUnavailableError) return failure(c, 503, error.code, { retryable: true });
  if (error instanceof CapabilityIssuanceError) {
    return failure(c, error.code === "cloud_workspace_not_found" ? 404 : error.code === "capability_expired" ? 401 : 403, error.code);
  }
  // Only the device proof raises these here: a replay is 409, anything else
  // about the proof or its device is a rejected proof.
  if (error instanceof WorkspaceReplicaError) {
    return error.code === "device_proof_replayed"
      ? failure(c, 409, "workspace_replica_device_proof_replayed")
      : failure(c, 403, "workspace_replica_device_proof_rejected");
  }
  throw error;
}

function grants(issued: CloudRuntimeCapabilities) {
  return {
    engine: { token: issued.engine.token, expiresAt: issued.engine.expiresAt.toISOString() },
    realtime: { token: issued.realtime.token, expiresAt: issued.realtime.expiresAt.toISOString() },
  };
}

async function authSessionId(tx: Tx, user: AuthedUser): Promise<string | null> {
  if (user.identity.provider !== "workos" || !user.authentication.sessionId) return null;
  return (await tx.query<{ id: string }>(
    "SELECT id FROM auth_sessions WHERE provider = 'workos' AND provider_session_id = $1 AND user_id = $2",
    [user.authentication.sessionId, user.id])).rows[0]?.id ?? null;
}

async function wakeable(tx: Tx, scope: { organizationId: string; workspaceId: string; actorUserId: string },
  config: CloudWorkspaceBackendConfig | null): Promise<boolean> {
  try {
    return (await readCloudWorkspaceDocument(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
      userId: scope.actorUserId }, config)).capabilities.canStart;
  } catch (error) {
    // A role holder whose document read refuses has nothing to wake.
    if (error instanceof HttpError) return false;
    throw error;
  }
}

async function directRoute(direct: NonNullable<CloudRuntimeConnectOptions["direct"]>,
  scope: Omit<CloudDirectProviderLookupScope, "remotePort">): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lookup = direct.endpoint({ ...scope, remotePort: direct.enginePort });
  // The race may settle first; a later rejection must not go unhandled.
  lookup.catch(() => {});
  try {
    const endpoint = await Promise.race([lookup, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("direct_endpoint_timeout")), DIRECT_ENDPOINT_TIMEOUT_MS);
    })]);
    const url = cloudDirectProviderWebSocketUrl(endpoint, direct.enginePort);
    if (!url) console.warn("[cloud-runtime] direct route endpoint rejected");
    return url;
  } catch {
    // Provider errors may carry provider detail; only the outcome is logged.
    console.warn("[cloud-runtime] direct route unavailable");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** S3 `runtime/connect` and `runtime/capabilities`, behind the `/v1` bearer
 * authentication and the `runtime_connect` rollout flag. */
export function createCloudRuntimeConnectRoutes(options: CloudRuntimeConnectOptions): Hono {
  const app = new Hono();
  const { pool, flags, workosEnabled } = options.capabilities;
  const hedge = options.relayHedgeMs ?? DEFAULT_RELAY_HEDGE_MS;
  const relayHedgeMs = Number.isFinite(hedge) ? Math.min(500, Math.max(300, Math.round(hedge))) : DEFAULT_RELAY_HEDGE_MS;

  // Memory only and before any lookup or limit: an organization without the
  // flag gets the router's own 404, headers included.
  const pathIds = (c: Context) => {
    const organizationId = c.req.param("organization")?.toLowerCase(), workspaceId = c.req.param("workspace")?.toLowerCase();
    if (!organizationId || !workspaceId || !PATH_UUID.test(organizationId) || !PATH_UUID.test(workspaceId)) return null;
    return flags.enabled(organizationId, "runtime_connect") ? { organizationId, workspaceId } : null;
  };
  const gated = (middleware: MiddlewareHandler): MiddlewareHandler => (c, next) => pathIds(c) ? middleware(c, next) : next();
  app.use(CLOUD_RUNTIME_CONNECT_PATH, gated(rateLimit("cloud-runtime-connect", 60, 60_000)));
  app.use(CLOUD_RUNTIME_CAPABILITIES_PATH, gated(rateLimit("cloud-runtime-capabilities", 120, 60_000)));
  for (const path of [CLOUD_RUNTIME_CONNECT_PATH, CLOUD_RUNTIME_CAPABILITIES_PATH]) app.use(path, gated(bodyLimit({ maxSize: 4 * 1024 })));

  const admitted = (c: Context) => {
    const ids = pathIds(c);
    if (!ids) return null;
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return ids;
  };

  const read = async <T extends z.ZodTypeAny>(c: Context, schema: T) => {
    let proof: CloudWorkspaceDeviceProof;
    try { proof = deviceProof(c); }
    catch (error) { if (error instanceof HttpError) return failure(c, 403, error.code); throw error; }
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return failure(c, 422, "invalid_input");
    return { proof, body: parsed.data as z.infer<T> };
  };

  const issue = async (c: Context, input: {
    organizationId: string; workspaceId: string; user: AuthedUser; proof: CloudWorkspaceDeviceProof;
    deviceSessionId: string; action: string; payload: Record<string, unknown>;
  }) => {
    const scope = { organizationId: input.organizationId, workspaceId: input.workspaceId, actorUserId: input.user.id };
    const deviceId = input.proof.deviceId.toLowerCase();
    try {
      const outcome = await withSystemTx(pool, async (tx): Promise<CloudRuntimeCapabilities | { wakeable: boolean }> => {
        const target = await readCloudRuntimeTarget(tx, scope, workosEnabled);
        if (!target) return { wakeable: await wakeable(tx, scope, options.cloudWorkspaces) };
        const sessionId = await authSessionId(tx, input.user);
        if (!sessionId) throw new CloudRuntimeConnectError(403, "capability_revoked");
        if (!await deviceSessionLive(tx, { deviceSessionId: input.deviceSessionId, accountUserId: input.user.id, deviceId,
          providerSessionId: workosEnabled ? input.user.authentication.sessionId : null }))
          throw new CloudRuntimeConnectError(409, "device_session_expired");
        await consumeCloudWorkspaceDeviceProof(tx, { accountUserId: input.user.id, action: input.action,
          payload: input.payload, proof: input.proof });
        return issueCloudRuntimeCapabilities(tx, options.capabilities, { ...scope, deviceId, sessionId }, target);
      });
      if ("wakeable" in outcome) return failure(c, 409, "cloud_workspace_not_running", { wakeable: outcome.wakeable });
      return outcome;
    } catch (error) {
      return refusal(c, error);
    }
  };

  app.post(CLOUD_RUNTIME_CONNECT_PATH, async c => {
    const ids = admitted(c);
    if (!ids) return notFound(c);
    const request = await read(c, ConnectBodySchema);
    if (request instanceof Response) return request;
    const { proof, body } = request;
    const relayUrl = body.routes.includes("relay") && options.relayUrl && flags.enabled(ids.organizationId, "relay_over_uplink")
      ? options.relayUrl : null;
    const direct = body.routes.includes("direct") ? options.direct ?? null : null;
    if (!relayUrl && !direct) return failure(c, 503, "cloud_workspace_runtime_not_configured", { retryable: false });
    const issued = await issue(c, { ...ids, user: c.get("user"), proof, deviceSessionId: body.deviceSessionId,
      action: RUNTIME_CONNECT_PROOF_ACTION, payload: { ...ids, ...body } });
    if (issued instanceof Response) return issued;
    const routes: RuntimeRoute[] = [];
    if (direct && issued.providerResourceId) {
      const url = await directRoute(direct, { organizationId: ids.organizationId, workspaceId: ids.workspaceId,
        generation: issued.generation, engineInstanceId: issued.engineInstanceId, resourceId: issued.providerResourceId });
      if (url) routes.push({ kind: "direct", url, priority: 0 });
    }
    if (relayUrl) routes.push({ kind: "relay", url: relayUrl, priority: 1 });
    // Only a requested direct route can be missing here, while its provider
    // resource or endpoint settles.
    if (routes.length === 0) return failure(c, 503, "cloud_workspace_unavailable", { retryable: true });
    return c.json({
      workspaceId: ids.workspaceId, generation: issued.generation, engineInstanceId: issued.engineInstanceId,
      capabilities: grants(issued), routes, renewAt: issued.renewAt.toISOString(), relayHedgeMs,
    }, 201);
  });

  app.post(CLOUD_RUNTIME_CAPABILITIES_PATH, async c => {
    const ids = admitted(c);
    if (!ids) return notFound(c);
    const request = await read(c, CapabilitiesBodySchema);
    if (request instanceof Response) return request;
    const issued = await issue(c, { ...ids, user: c.get("user"), proof: request.proof, deviceSessionId: request.body.deviceSessionId,
      action: RUNTIME_CAPABILITIES_PROOF_ACTION, payload: { ...ids, ...request.body } });
    if (issued instanceof Response) return issued;
    return c.json({ capabilities: grants(issued), renewAt: issued.renewAt.toISOString() }, 201);
  });
  return app;
}
