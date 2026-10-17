import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";

import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { rateLimit } from "../ratelimit.js";
import type { RolloutFlagReader } from "../rollout-flags.js";
import { deviceProof } from "../cloud-workspaces/routes.js";
import { consumeCloudWorkspaceDeviceProof, replicaErrorToHttp, WorkspaceReplicaError } from "../cloud-workspaces/replicas.js";
import { issueDeviceSession } from "./device-sessions.js";
import { DEVICE_STREAM_CONTRACT, DEVICE_STREAM_HEARTBEAT_INTERVAL_MS } from "./device-stream-protocol.js";

export const DEVICE_SESSIONS_PATH = "/v1/device-sessions";
/** The device proof's action; its payload is `{ deviceSessionId }` (null for
 * a new device session), so a proof cannot be replayed to claim another. */
export const DEVICE_SESSION_PROOF_ACTION = "device-session.create";

const BodySchema = z.object({
  deviceId: z.string().uuid(),
  deviceSessionId: z.string().uuid().optional(),
  client: z.object({
    platform: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/),
    appVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9._+-]+$/),
    contract: z.object({ min: z.number().int().min(1).max(1_000), max: z.number().int().min(1).max(1_000) }).strict(),
  }).strict(),
}).strict();

export type DeviceSessionRouteOptions = {
  flags: RolloutFlagReader;
  /** `wss://…/v1/device-stream` on the realtime origin. */
  streamUrl: string;
  /** Bind the device session to the WorkOS session, re-read at every
   * consume; other providers keep no revocable session row. */
  workosEnabled: boolean;
};

/** S3 `POST /v1/device-sessions`: a device-proved, single-use 60 s ticket for
 * the device stream. Mounted behind the `/v1` bearer authentication. */
export function createDeviceSessionRoutes(pool: pg.Pool, options: DeviceSessionRouteOptions): Hono {
  const app = new Hono();
  app.use(DEVICE_SESSIONS_PATH, rateLimit("device-sessions", 30, 60_000));
  app.post(DEVICE_SESSIONS_PATH, async c => {
    c.header("Cache-Control", "no-store");
    if (!options.flags.anyEnabled("device_stream")) throw new HttpError(404, "not_found", "Not found");
    const user = c.get("user");
    const proof = deviceProof(c);
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(422, "invalid_input", "Invalid device session request");
    const body = parsed.data;
    if (body.deviceId !== proof.deviceId) throw new HttpError(422, "invalid_input", "Invalid device session request");
    if (body.client.contract.min > DEVICE_STREAM_CONTRACT || body.client.contract.max < DEVICE_STREAM_CONTRACT)
      throw new HttpError(409, "contract_unsupported", "No common device stream contract");
    try {
      const issued = await withSystemTx(pool, async tx => {
        await consumeCloudWorkspaceDeviceProof(tx, { accountUserId: user.id, action: DEVICE_SESSION_PROOF_ACTION,
          payload: { deviceSessionId: body.deviceSessionId ?? null }, proof });
        return issueDeviceSession(tx, { accountUserId: user.id, deviceId: proof.deviceId,
          providerSessionId: options.workosEnabled ? user.authentication.sessionId : null, reuseId: body.deviceSessionId ?? null });
      });
      return c.json({
        deviceSessionId: issued.deviceSessionId,
        stream: { url: options.streamUrl, ticket: issued.ticket, ticketExpiresAt: issued.ticketExpiresAt.toISOString() },
        contract: DEVICE_STREAM_CONTRACT,
        heartbeatIntervalMs: DEVICE_STREAM_HEARTBEAT_INTERVAL_MS,
      }, 201);
    } catch (error) {
      if (error instanceof WorkspaceReplicaError) throw replicaErrorToHttp(error);
      throw error;
    }
  });
  return app;
}
