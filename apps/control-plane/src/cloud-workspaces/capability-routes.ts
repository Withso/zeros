import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { RolloutFlagReader } from "../rollout-flags.js";
import { assertCurrentCloudEngineAuthority, CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import {
  CapabilityIssuanceError,
  CapabilityIssuerUnavailableError,
  issueEngineCapability,
  type IssuedCapability,
} from "./capability-issuer.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { CAPABILITY_JWKS_PATH } from "./capability-contract.js";

export const CLOUD_CAPABILITY_ENGINE_PATH = "/internal/v2/cloud-workspaces/engine/capability";

/** Public S1 key-set publication (S1 "Keys and rotation"). Verifiers refetch
 * with Cache-Control: no-cache; the set replaces theirs. */
export function createCloudCapabilityKeyRoutes(keyStore: CapabilitySigningKeyStore): Hono {
  const app = new Hono();
  app.get(CAPABILITY_JWKS_PATH, c => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ keys: keyStore.publicKeySet() });
  });
  return app;
}

const EngineCapabilityRequestSchema = z.object({
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  engineInstanceId: z.string().uuid(),
  bootId: z.string().uuid(),
}).strict();

export type CloudCapabilityService = {
  pool: pg.Pool;
  keyStore: CapabilitySigningKeyStore;
  issuer: string;
  flags: RolloutFlagReader;
  workosEnabled: boolean;
  now?: () => number;
};

function capabilityError(c: Context, error: unknown) {
  if (error instanceof CloudWorkspaceEngineAuthorityError) return c.json({ error: { code: "engine_authority_rejected" } }, 401);
  if (error instanceof CapabilityIssuerUnavailableError) return c.json({ error: { code: "capability_issuer_unavailable" } }, 503);
  if (error instanceof CapabilityIssuanceError) {
    const status = error.code === "cloud_workspace_not_found" ? 404 : error.code === "capability_expired" ? 401 : 403;
    return c.json({ error: { code: error.code } }, status);
  }
  throw error;
}

/** The engine-token REST fallback (S1 "Issuance"): while its uplink has been
 * down for at least 30 s the engine may request a token directly with its
 * heartbeat credential and registered boot id, at most once a minute. The
 * budget is per api process: N replicas allow N requests per minute per
 * engine, which is accepted for a fallback that only fires during a
 * `realtime` outage. Behind the `capabilities` rollout flag.
 *
 * An organization with the flag off gets the same 401 as a bad credential,
 * without SQL, so an unauthenticated caller cannot use the endpoint as a
 * flag oracle. Failed attempts (flag off included, for the same reason) are
 * limited before any SQL runs, in two ways:
 * - FAILURE_LIMIT per (engine id, trusted client address) per minute, which
 *   bounds credential guessing against one engine without letting a caller
 *   elsewhere who knows the id hold the engine's own fallback at 429;
 * - CAPABILITY_FALLBACK_FAILURE_CEILING failed attempts per api process per
 *   minute across all keys, which bounds the authority SQL a caller rotating
 *   engine ids or addresses can drive. While the ceiling holds, every request
 *   (a legitimate engine's included) gets 429 until the window turns; that
 *   is accepted for a fallback that only fires during a `realtime` outage. */
const FAILURE_LIMIT = 5;
export const CAPABILITY_FALLBACK_FAILURE_CEILING = 120;
const WINDOW_MS = 60_000;

export type CloudCapabilityEngineRouteOptions = {
  /** The caller's address from the trusted proxy header; one shared bucket
   * when absent or invalid. */
  clientAddress?: (c: Context) => string;
};

export function createCloudCapabilityEngineRoutes(service: CloudCapabilityService, options: CloudCapabilityEngineRouteOptions = {}): Hono {
  const app = new Hono();
  const issuedAt = new Map<string, number>();
  const failures = new Map<string, { count: number; since: number }>();
  const ceiling = { count: 0, since: Number.NEGATIVE_INFINITY };
  const now = service.now ?? Date.now;
  const clientAddress = options.clientAddress ?? (() => "unknown");
  const prune = () => {
    const cutoff = now() - 2 * WINDOW_MS;
    if (issuedAt.size > 10_000) for (const [id, at] of issuedAt) if (at < cutoff) issuedAt.delete(id);
    if (failures.size > 10_000) for (const [id, entry] of failures) if (entry.since < cutoff) failures.delete(id);
  };
  const recordFailure = (key: string) => {
    const entry = failures.get(key);
    if (!entry || now() - entry.since >= WINDOW_MS) failures.set(key, { count: 1, since: now() });
    else entry.count += 1;
    if (now() - ceiling.since >= WINDOW_MS) { ceiling.count = 1; ceiling.since = now(); }
    else ceiling.count += 1;
  };
  const rejected = (c: Context, key: string) => {
    recordFailure(key);
    return c.json({ error: { code: "engine_authority_rejected" } }, 401);
  };
  const throttled = (c: Context, since: number) => {
    c.header("Retry-After", String(Math.max(1, Math.ceil((WINDOW_MS - (now() - since)) / 1000))));
    return c.json({ error: { code: "capability_issuer_unavailable" } }, 429);
  };
  app.use(CLOUD_CAPABILITY_ENGINE_PATH, bodyLimit({ maxSize: 4 * 1024 }));
  app.post(CLOUD_CAPABILITY_ENGINE_PATH, async c => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return c.json({ error: { code: "capability_malformed" } }, 415);
    }
    const heartbeatToken = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const parsed = EngineCapabilityRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!heartbeatToken || !parsed.success) return c.json({ error: { code: "capability_missing" } }, 401);
    const request = parsed.data;
    prune();
    const failureKey = `${request.engineInstanceId}\n${clientAddress(c)}`;
    if (now() - ceiling.since < WINDOW_MS && ceiling.count >= CAPABILITY_FALLBACK_FAILURE_CEILING) return throttled(c, ceiling.since);
    const failed = failures.get(failureKey);
    if (failed && now() - failed.since < WINDOW_MS && failed.count >= FAILURE_LIMIT) return throttled(c, failed.since);
    if (!service.flags.enabled(request.organizationId, "capabilities")) return rejected(c, failureKey);
    const last = issuedAt.get(request.engineInstanceId);
    if (last !== undefined && now() - last < WINDOW_MS) {
      c.header("Retry-After", String(Math.ceil((WINDOW_MS - (now() - last)) / 1000)));
      return c.json({ error: { code: "capability_issuer_unavailable" } }, 429);
    }
    try {
      const issued: IssuedCapability = await withSystemTx(service.pool, async tx => {
        await assertCurrentCloudEngineAuthority(tx, { ...request, heartbeatToken, workosEnabled: service.workosEnabled, lock: "share" });
        // Same binding as the uplink hello: the heartbeat credential must name
        // the boot this registration recorded.
        const boot = (await tx.query<{ runtime_boot_id: string | null }>(`SELECT runtime_boot_id
          FROM cloud_workspace_engine_instances WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4`,
          [request.engineInstanceId, request.workspaceId, request.organizationId, request.generation])).rows[0];
        if (!boot?.runtime_boot_id || boot.runtime_boot_id !== request.bootId) {
          throw new CloudWorkspaceEngineAuthorityError();
        }
        return issueEngineCapability(tx, service.keyStore, service.issuer, request);
      });
      // Only a granted token spends the once-a-minute budget; failures must
      // not lock out a retrying engine.
      issuedAt.set(request.engineInstanceId, now());
      failures.delete(failureKey);
      return c.json({ capability: { token: issued.token, expiresAt: issued.expiresAt.toISOString() } }, 201);
    } catch (error) {
      if (!(error instanceof CapabilityIssuerUnavailableError)) recordFailure(failureKey);
      return capabilityError(c, error);
    }
  });
  return app;
}
