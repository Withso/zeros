import type pg from "pg";

import { withSystemStatement } from "../db.js";
import type { RolloutFlagReader } from "../rollout-flags.js";
import { sql, SqlFragment } from "../sql-fragment.js";
import type { CapabilityErrorCode } from "./capability-contract.js";
import type { CloudCapabilityService } from "./capability-routes.js";
import {
  CapabilityVerifier,
  type CapabilityPin,
  type CapabilityProof,
  type CapabilityRoute,
  type CapabilityVerifyResult,
} from "./capability-verifier.js";
import { installedEngineAuthorityCache, type EngineAuthorityCache } from "./engine-authority-cache.js";

/**
 * The control-plane verifiers of S1 (`api` for engine tokens, `realtime` for
 * client tokens on relay admission). Both wrap the shared CapabilityVerifier
 * with a fixed pin and take the current generation and engine instance for
 * step 8 from the authority cache, falling back to a committed read, never
 * from the request.
 */

export const API_ENGINE_CAPABILITY_PIN: CapabilityPin = Object.freeze({ aud: "zeros:api", knd: "engine" });
export const REALTIME_CLIENT_CAPABILITY_PIN: CapabilityPin = Object.freeze({ aud: "zeros:realtime", knd: "client" });

/** The header an engine sends its `zeros:api` token in, beside the heartbeat
 * bearer that remains the request's mutation fence in v1. */
export const ENGINE_CAPABILITY_HEADER = "x-zeros-capability";

export type CapabilityPlacement = Readonly<{ generation: number; engineInstanceId: string | null }>;
export type CapabilityWorkspaceScope = Readonly<{ workspaceId: string; organizationId: string }>;
/** The current placement of a running workspace, or null when it has none. */
export type CapabilityPlacementResolver = (scope: CapabilityWorkspaceScope) => Promise<CapabilityPlacement | null>;

export type ServiceCapabilityRequest = CapabilityWorkspaceScope & Readonly<{
  route?: CapabilityRoute;
  proof?: CapabilityProof;
  scope?: string;
}>;

export type ServiceCapabilityVerifierOptions = {
  pin: CapabilityPin;
  issuer: string;
  /** The in-process published key set (S1 "Keys and rotation"). */
  keys: () => readonly unknown[];
  placement: CapabilityPlacementResolver;
  now?: () => number;
};

// No workspace has an empty id, so step 8 fails with
// capability_workspace_mismatch, after steps 1-7 have run in order.
const NO_PLACEMENT = { workspaceId: "", organizationId: "", generation: 0, engineInstanceId: null } as const;

export class ServiceCapabilityVerifier {
  readonly verifier: CapabilityVerifier;
  private appliedKeys: readonly unknown[] | null = null;

  constructor(private readonly options: ServiceCapabilityVerifierOptions) {
    this.verifier = new CapabilityVerifier({
      issuer: options.issuer,
      ...(options.now ? { now: options.now } : {}),
      fetchKeys: async () => options.keys(),
    });
  }

  get pin(): CapabilityPin { return this.options.pin; }

  async verify(token: unknown, request: ServiceCapabilityRequest): Promise<CapabilityVerifyResult> {
    this.syncKeys();
    const placement = await this.options.placement({ workspaceId: request.workspaceId, organizationId: request.organizationId });
    const context = placement
      ? { workspaceId: request.workspaceId, organizationId: request.organizationId, ...placement }
      : NO_PLACEMENT;
    return this.verifier.verify(token, this.options.pin, {
      ...context,
      ...(request.route ? { route: request.route } : {}),
      ...(request.proof ? { proof: request.proof } : {}),
      ...(request.scope !== undefined ? { scope: request.scope } : {}),
    });
  }

  /** The key store replaces its published array on every change, so a new
   * reference is the only signal needed. */
  private syncKeys(): void {
    const keys = this.options.keys();
    if (keys === this.appliedKeys) return;
    try { this.verifier.applyKeys(keys); this.appliedKeys = keys; } catch { /* keep the last valid set */ }
  }
}

/** Cache first (only while the cache is enforcing for the organization, the
 * same gate as fence-free authority reads), then one committed read. */
export function capabilityPlacementResolver(pool: pg.Pool,
  cache: () => EngineAuthorityCache | undefined = installedEngineAuthorityCache): CapabilityPlacementResolver {
  return async scope => {
    const installed = cache();
    if (installed?.enforcing(scope.organizationId)) {
      const cached = installed.placement(scope.workspaceId, scope.organizationId);
      if (cached) return cached;
    }
    return readCapabilityPlacement(pool, scope);
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function readCapabilityPlacement(pool: pg.Pool, scope: CapabilityWorkspaceScope): Promise<CapabilityPlacement | null> {
  const workspaceId = scope.workspaceId.toLowerCase(), organizationId = scope.organizationId.toLowerCase();
  if (!UUID.test(workspaceId) || !UUID.test(organizationId)) return null;
  const rows = (await withSystemStatement<{ generation: number; engine_instance_id: string | null; engines: number }>(pool,
    sql`SELECT workspace.current_generation AS generation, live.engine_instance_id, live.engines::int AS engines
      FROM cloud_workspaces workspace
      LEFT JOIN LATERAL (SELECT min(engine.id::text) AS engine_instance_id, count(*) AS engines
        FROM cloud_workspace_engine_instances engine
        WHERE engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
          AND engine.generation=workspace.current_generation AND engine.state='ready'
          AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
          AND engine.lease_expires_at>clock_timestamp()) live ON true
      WHERE workspace.id=${SqlFragment.uuid(workspaceId)} AND workspace.org_id=${SqlFragment.uuid(organizationId)}
        AND workspace.deleted_at IS NULL AND workspace.desired_state='running'`)).rows;
  const row = rows[0];
  if (!row || !Number.isSafeInteger(Number(row.generation))) return null;
  // Two live engines in one generation is a handover in progress; neither is
  // "the" current instance, so an engine-bound token fails closed.
  return { generation: Number(row.generation), engineInstanceId: row.engines === 1 ? row.engine_instance_id : null };
}

export function createApiEngineCapabilityVerifier(options: Omit<ServiceCapabilityVerifierOptions, "pin">): ServiceCapabilityVerifier {
  return new ServiceCapabilityVerifier({ ...options, pin: API_ENGINE_CAPABILITY_PIN });
}

export function createRealtimeClientCapabilityVerifier(options: Omit<ServiceCapabilityVerifierOptions, "pin">): ServiceCapabilityVerifier {
  return new ServiceCapabilityVerifier({ ...options, pin: REALTIME_CLIENT_CAPABILITY_PIN });
}

/** Engine route families on `api`, behind the `capabilities` flag. */
export type EngineCapabilityGate = Readonly<{ flags: RolloutFlagReader; verifier: ServiceCapabilityVerifier }>;

export function createEngineCapabilityGate(service: CloudCapabilityService): EngineCapabilityGate {
  return {
    flags: service.flags,
    verifier: createApiEngineCapabilityVerifier({ issuer: service.issuer, keys: () => service.keyStore.publicKeySet(),
      placement: capabilityPlacementResolver(service.pool), ...(service.now ? { now: service.now } : {}) }),
  };
}

export type EngineCapabilityRejection = Readonly<{ status: 401 | 403; code: CapabilityErrorCode }>;

/**
 * Checks the engine token a request carries. With the flag off, or no gate,
 * nothing changes. With the flag on, a request that carries a token must
 * pass steps 1-13 for the route family's scope and name the same placement
 * as the token; a request without one keeps the heartbeat path, so an engine
 * that predates engine tokens keeps working during the rollout.
 */
export async function checkEngineCapability(gate: EngineCapabilityGate | undefined, token: string | undefined,
  request: CapabilityWorkspaceScope & Readonly<{ generation: number; engineInstanceId: string }>, scope: string): Promise<EngineCapabilityRejection | null> {
  if (!gate || token === undefined || !gate.flags.enabled(request.organizationId, "capabilities")) return null;
  const result = await gate.verifier.verify(token, { workspaceId: request.workspaceId, organizationId: request.organizationId, scope });
  if (!result.ok) return { status: result.code === "capability_scope_denied" ? 403 : 401, code: result.code };
  if (result.claims.gen !== request.generation || result.claims.ein?.toLowerCase() !== request.engineInstanceId.toLowerCase())
    return { status: 401, code: "capability_generation_mismatch" };
  return null;
}
