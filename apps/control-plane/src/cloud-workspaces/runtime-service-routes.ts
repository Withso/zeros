import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { isIP } from "node:net";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import { CloudWorkspaceAuthorizationError } from "./authorization.js";
import { previewRequestFromEdge } from "./access.js";
import { WorkspaceReplicaError } from "./replicas.js";
import { CLOUD_RUNTIME_SERVICE_PATH, runtimeServiceToken, type DatabaseCloudRuntimeServiceAccess } from "./runtime-services.js";

/** Same capability/path as the WSS relay, without consuming an application stream. */
export function createCloudRuntimeServiceAuthorityRoutes(service: Pick<DatabaseCloudRuntimeServiceAccess, "check">): Hono {
  const routes = new Hono();
  routes.use(`${CLOUD_RUNTIME_SERVICE_PATH}/*`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  routes.use(`${CLOUD_RUNTIME_SERVICE_PATH}/*`, rateLimit("cloud-service-authority", 600, 60_000, c => {
    const ip = c.req.header("X-Real-IP")?.trim() ?? c.req.header("CF-Connecting-IP")?.trim() ?? "";
    return isIP(ip) ? ip : "unknown";
  }));
  routes.get(`${CLOUD_RUNTIME_SERVICE_PATH}/:kind/:grant`, async c => {
    if (!runtimeServiceToken(c.req.raw.headers)) return c.body(null, 401);
    const expiresAtMs = await service.check(previewRequestFromEdge(c.req.raw));
    return expiresAtMs === null ? c.body(null, 401) : c.json({ expiresAtMs });
  });
  return routes;
}

const proof = z.object({ deviceId: z.string().uuid(), keyVersion: z.number().int().safe().positive(),
  timestampMs: z.number().int().safe().nonnegative(), nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const requestSchema = z.object({ kind: z.enum(["ssh", "tunnel"]), remotePort: z.number().int().min(1024).max(65535).optional(),
  expiresInMinutes: z.number().int().min(1).max(30).default(15) }).strict();

/** Mounted only behind the account bearer and global per-account rate limit.
 * Grant issue also needs the device's signed, nonce-bound proof. */
export function createCloudRuntimeServiceRoutes(service: Pick<DatabaseCloudRuntimeServiceAccess, "issue" | "revoke">): Hono {
  const routes = new Hono();
  const path = "/v1/organizations/:organization/cloud-workspaces/:workspace/runtime/services";
  routes.use(`${path}/*`, bodyLimit({ maxSize: 4096 }));
  routes.use(path, bodyLimit({ maxSize: 4096 }));
  routes.use(`${path}*`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  routes.post(path, async c => {
    c.header("Cache-Control", "no-store");
    const body = requestSchema.safeParse(await c.req.json().catch(() => null));
    const device = proof.safeParse({ deviceId: c.req.header("x-zeros-device-id"), keyVersion: Number(c.req.header("x-zeros-device-key-version")),
      timestampMs: Number(c.req.header("x-zeros-device-timestamp")), nonce: c.req.header("x-zeros-device-nonce"), signature: c.req.header("x-zeros-device-signature") });
    if (!body.success) throw new HttpError(422, "invalid_runtime_service", "Cloud service request is invalid");
    if (!device.success) throw new HttpError(403, "device_proof_rejected", "A current device proof is required");
    try {
      return c.json(await service.issue({ kind: body.data.kind, expiresInMinutes: body.data.expiresInMinutes,
        ...(body.data.remotePort === undefined ? {} : { remotePort: body.data.remotePort }), proof: device.data,
        organizationId: c.req.param("organization"), workspaceId: c.req.param("workspace"), accountUserId: c.get("user").id,
        idempotencyKey: c.req.header("idempotency-key") ?? "" }), 201);
    } catch (error) {
      if (error instanceof WorkspaceReplicaError) throw new HttpError(403, "device_proof_rejected", "A current device proof is required");
      if (error instanceof CloudWorkspaceAuthorizationError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });
  routes.delete(`${path}/:grant`, async c => {
    c.header("Cache-Control", "no-store");
    await service.revoke({ organizationId: c.req.param("organization"), workspaceId: c.req.param("workspace"), accountUserId: c.get("user").id,
      grantId: c.req.param("grant") });
    return c.body(null, 204);
  });
  return routes;
}
