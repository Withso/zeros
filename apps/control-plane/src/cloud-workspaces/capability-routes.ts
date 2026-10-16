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
 * `realtime` outage. Behind the `capabilities` rollout flag; unknown
 * organizations get a 404. */
export function createCloudCapabilityEngineRoutes(service: CloudCapabilityService): Hono {
  const app = new Hono();
  const issuedAt = new Map<string, number>();
  const now = service.now ?? Date.now;
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
    if (!service.flags.enabled(request.organizationId, "capabilities")) return c.json({ error: { code: "not_found" } }, 404);
    const last = issuedAt.get(request.engineInstanceId);
    if (last !== undefined && now() - last < 60_000) {
      c.header("Retry-After", String(Math.ceil((60_000 - (now() - last)) / 1000)));
      return c.json({ error: { code: "capability_issuer_unavailable" } }, 429);
    }
    if (issuedAt.size > 10_000) {
      const cutoff = now() - 120_000;
      for (const [id, at] of issuedAt) if (at < cutoff) issuedAt.delete(id);
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
      return c.json({ capability: { token: issued.token, expiresAt: issued.expiresAt.toISOString() } }, 201);
    } catch (error) {
      return capabilityError(c, error);
    }
  });
  return app;
}
