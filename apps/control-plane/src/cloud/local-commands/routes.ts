import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { isDatabaseUnavailable } from "../../db.js";
import { rateLimit } from "../../ratelimit.js";
import { DEVICE_LIVENESS_FEATURE, LOCAL_DEVICE_HEADERS, LocalDeviceBindingSchema, LocalDeviceRegistrationSchema, type LocalDeviceBinding } from "./contract.js";
import { LocalMacResultSchema } from "./contract.js";
import { localUnavailable, type CloudLocalCommands } from "./requests.js";
import { CloudLocalDevices, DEVICE_HEARTBEAT_MS, DEVICE_LIVENESS_HEARTBEAT_MS } from "./devices.js";
import { CloudLocalCommandSignals, deviceSignal } from "./signals.js";
import type { CloudNotifyUser, NotificationHint } from "../notify-user/store.js";
import { localCommandDiagnostic, type LocalChannelCloseReason } from "./diagnostics.js";
import { SYNC_HEADER, SYNC_WANTED_HEADER, SyncFlagSchema, SyncWantedFlagSchema } from "../workspace-sync/contract.js";

export type CloudLocalDeviceRoutes = { devices: CloudLocalDevices; signals: CloudLocalCommandSignals; requests?: CloudLocalCommands; notifications?: CloudNotifyUser };
export const isLocalCommandResultPath = (path: string) => /^\/v1\/cloud-v2\/devices\/[0-9a-f-]{36}\/requests\/[0-9a-f-]{36}\/result$/i.test(path);
export function localRouteError(error: Error, c: Context): Response {
  // PostgreSQL errors may include a failing row, including encrypted material
  // or a device name. Keep unexpected failures inside this closed boundary.
  if (!(error instanceof HttpError) && !isDatabaseUnavailable(error)) console.error("[local-commands] request_failed");
  const failure = error instanceof HttpError ? error : localUnavailable();
  c.header("Cache-Control","no-store");
  if (failure.status === 429) c.header("Retry-After","60");
  return c.json({ error: { code: failure.code, message: failure.message } },failure.status);
}
const TOKEN_END_MARGIN_MS = 2_000, TOKEN_END_SKEW_MS = 10_000;
const STREAM_FALLBACK_MS = 60_000;
const empty = z.object({}).strict();
export const localUuid = (value: string) => {
  if (!z.string().uuid().safeParse(value).success) throw new HttpError(404, "not_found", "Local command resource not found");
  return value;
};
export function localDeviceHeaders(c: Context, optional = false): LocalDeviceBinding | undefined {
  const [deviceId, registrationId, instanceId] = LOCAL_DEVICE_HEADERS.map(name => c.req.header(name));
  if (optional && [deviceId, registrationId, instanceId].every(value => value === undefined)) return undefined;
  const parsed = LocalDeviceBindingSchema.safeParse({ deviceId, registrationId, instanceId });
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid desktop registration headers");
  return parsed.data;
}
export async function localBody<T>(c: Context, schema: z.ZodType<T>, allowEmpty = false): Promise<T> {
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0 && allowEmpty) return schema.parse({});
  if ((c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new HttpError(400, "invalid_request", "A JSON request body is required");
  let input: unknown;
  try { input = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { input = null; }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid local command request");
  return parsed.data;
}

export function createCloudLocalDeviceRoutes(deps: CloudLocalDeviceRoutes): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/devices/:deviceId", macPath = "/v1/cloud-v2/workspaces/:id/macs";
  app.onError(localRouteError);
  const binding = (c: Context) => {
    const value = localDeviceHeaders(c)!;
    if (value.deviceId !== localUuid(c.req.param("deviceId")!)) throw new HttpError(404, "not_found", "Local command resource not found");
    return value;
  };
  for (const prefix of ["/v1/cloud-v2/devices/*", `${macPath}*`]) app.use(prefix, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    if (c.res.status === 429 && !c.res.headers.has("Retry-After")) c.header("Retry-After", "60");
  });
  const ordinaryLimit = bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) });
  const resultLimit = bodyLimit({ maxSize: 16 * 1024 * 1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) });
  app.use("/v1/cloud-v2/devices/*", async (c,next) => {
    if (c.req.method === "POST" && isLocalCommandResultPath(c.req.path)) return next();
    return ordinaryLimit(c,next);
  });
  app.use(`${path}/requests/:requestId/result`, async (c,next) => {
    await deps.devices.snapshot(c.get("user"),binding(c));
    return resultLimit(c,next);
  });
  app.put(path, rateLimit("local-device-registration", 30, 60_000), async c =>
    c.json(await deps.devices.register(c.get("user"), localUuid(c.req.param("deviceId")), await localBody(c, LocalDeviceRegistrationSchema))));
  app.delete(path, async c => {
    await localBody(c, empty, true); await deps.devices.unregister(c.get("user"), binding(c)); return c.body(null, 204);
  });
  app.post(`${path}/heartbeat`, async c => {
    await localBody(c, empty, true); return c.json(await deps.devices.heartbeat(c.get("user"), binding(c)));
  });
  app.get(`${path}/connections`, rateLimit("cloud-sync-connections", 60, 60_000, c => `${c.get("user").id}:${binding(c).deviceId.toLowerCase()}`), async c => {
    if (c.req.header(SYNC_WANTED_HEADER) !== "1") throw new HttpError(400, "invalid_request", "Sync wanted opt-in is required");
    const cursors = c.req.queries("cursor");
    if (cursors && (cursors.length !== 1 || !z.string().uuid().safeParse(cursors[0]).success))
      throw new HttpError(400, "invalid_request", "Invalid connection cursor");
    return c.json(await deps.devices.connections(c.get("user"), binding(c), cursors?.[0] ?? null, c.req.header(SYNC_HEADER) === "1"));
  });
  app.get(macPath, async c => c.json(await deps.devices.list(c.get("user"), localUuid(c.req.param("id")), c.req.header(SYNC_HEADER) === "1", c.req.header(SYNC_WANTED_HEADER) === "1")));
  app.post(`${macPath}/:deviceId/connect`, async c => {
    await localBody(c, empty, true);
    return c.json(await deps.devices.connect(c.get("user"), localUuid(c.req.param("id")), localUuid(c.req.param("deviceId")), localDeviceHeaders(c)!, c.req.header(SYNC_HEADER) === "1", c.req.header(SYNC_WANTED_HEADER) === "1"));
  });
  app.post(`${macPath}/:deviceId/disconnect`, async c => {
    await localBody(c, empty, true);
    return c.json(await deps.devices.disconnect(c.get("user"), localUuid(c.req.param("id")), localUuid(c.req.param("deviceId")), localDeviceHeaders(c)!, c.req.header(SYNC_HEADER) === "1", c.req.header(SYNC_WANTED_HEADER) === "1"));
  });
  app.put(`${macPath}/:deviceId/sync`, ordinaryLimit, rateLimit("cloud-sync-flag", 60, 60_000), async c => {
    const includeWanted = c.req.header(SYNC_WANTED_HEADER) === "1";
    const input = includeWanted ? await localBody(c, SyncWantedFlagSchema) : await localBody(c, SyncFlagSchema);
    return c.json(await deps.devices.setSync(c.get("user"), localUuid(c.req.param("id")), localUuid(c.req.param("deviceId")), localDeviceHeaders(c)!, input, includeWanted));
  });
  if (deps.requests) {
    const requests = deps.requests, requestPath = `${path}/requests/:requestId`;
    const settingPath = "/v1/cloud-v2/organizations/:org/local-commands";
    app.use(settingPath,async (c,next) => { c.header("Cache-Control","no-store"); await next(); });
    app.use(settingPath,ordinaryLimit,rateLimit("local-command-setting",90,60_000));
    app.get(settingPath,async c => c.json(await requests.setting(c.get("user"),localUuid(c.req.param("org")))));
    app.put(settingPath,async c => {
      const input = await localBody(c,z.object({ localCommandsEnabled: z.boolean() }).strict());
      return c.json(await requests.setting(c.get("user"),localUuid(c.req.param("org")),input.localCommandsEnabled));
    });
    app.get(requestPath, async c => c.json(await requests.deviceRead(c.get("user"),binding(c),localUuid(c.req.param("requestId")))));
    app.post(`${requestPath}/received`, async c => {
      await localBody(c,empty,true); return c.json(await requests.received(c.get("user"),binding(c),localUuid(c.req.param("requestId"))));
    });
    app.post(`${requestPath}/claim`, async c => {
      const input = await localBody(c,z.object({ decision: z.enum(["approve","deny"]) }).strict());
      return c.json(await requests.claim(c.get("user"),binding(c),localUuid(c.req.param("requestId")),input.decision));
    });
    app.post(`${requestPath}/result`, async c => {
      const input = await localBody(c,z.object({ result: LocalMacResultSchema }).strict());
      return c.json(await requests.result(c.get("user"),binding(c),localUuid(c.req.param("requestId")),input.result));
    });
    app.post(`${requestPath}/ack`, async c => {
      await localBody(c,empty,true); await requests.deviceAck(c.get("user"),binding(c),localUuid(c.req.param("requestId"))); return c.body(null,204);
    });
  }
  app.get(`${path}/events`, async c => {
    const user = c.get("user"), identity = binding(c);
    const initial = await deps.devices.openStream(user, identity);
    try { await deps.signals.start(); }
    catch (error) {
      if (initial.streamId) await deps.devices.closeStream(user, identity, initial.streamId);
      throw error;
    }
    return streamSSE(c, async stream => {
      const openedAt = performance.now();
      let closeReason: LocalChannelCloseReason = "client_closed";
      localCommandDiagnostic({ event: "channel_opened", userId: user.id, ...identity });
      const controller = new AbortController(); stream.onAbort(() => controller.abort());
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
      let first = true, previousPresence = "", lastHeartbeat = Date.now(), deviceChanged = false;
      const unsubscribeDevice = c.req.header(SYNC_WANTED_HEADER) === "1"
        ? deps.signals.deviceChanges(user.id, identity.deviceId, () => { deviceChanged = true; }) : undefined;
      // An access token lives minutes and the session outlives it. The channel
      // ends cleanly just before its token does, so the Mac reconnects with a
      // fresh one; "revoked" is kept for a session that is really gone.
      const expiresAt = user.authentication.tokenExpiresAt, tokenEnd = expiresAt ? expiresAt*1000 : Number.POSITIVE_INFINITY;
      const sent = new Map<string,string>();
      // Only hints observed by this open stream are queued. The database clock
      // also excludes an older hint delayed across a listener/channel reconnect.
      const pendingNotifications = new Map<string,NotificationHint>();
      const unsubscribe = deps.notifications ? deps.signals.notifications(user.id,identity,hint => {
        if (pendingNotifications.size >= 128) pendingNotifications.delete(pendingNotifications.keys().next().value!);
        pendingNotifications.set(`${hint.workspaceId}:${hint.notificationId}`,hint);
      }) : undefined;
      try {
        while (!stream.aborted && !signal.aborted && Date.now() < tokenEnd-TOKEN_END_MARGIN_MS) {
          const heartbeat = Date.now()-lastHeartbeat >= STREAM_FALLBACK_MS;
          if (heartbeat) lastHeartbeat = Date.now();
          const waiter = deps.signals.wait(deviceSignal(user.id, identity.deviceId),
            Math.max(0, Math.min(STREAM_FALLBACK_MS-(Date.now()-lastHeartbeat), tokenEnd-TOKEN_END_MARGIN_MS-Date.now())), signal);
          try {
            const observedChange = deviceChanged; deviceChanged = false;
            const snapshot = await deps.devices.snapshot(user, identity, initial.streamId ?? undefined);
            const encodedPresence = JSON.stringify(snapshot.presence);
            if (first) {
              await stream.writeSSE({ event: "ready", data: JSON.stringify({ ...identity, presence: snapshot.presence,
                heartbeatIntervalMs: initial.streamId ? DEVICE_LIVENESS_HEARTBEAT_MS : DEVICE_HEARTBEAT_MS,
                ...(initial.streamId ? { features: [DEVICE_LIVENESS_FEATURE] } : {}) }) });
              first = false;
            } else if (observedChange || encodedPresence !== previousPresence) await stream.writeSSE({ event: "presence", data: encodedPresence });
            previousPresence = encodedPresence;
            if (deps.requests) {
              const notices = snapshot.hasRequests ? await deps.requests.notices(user,identity) : [], retained = new Set(notices.map(value => value.requestId));
              for (const [key,prior] of sent) if (!retained.has(key)) {
                if (JSON.parse(prior).state !== "terminal") {
                  let terminal;
                  try { terminal = await deps.requests.deviceRead(user,identity,key); }
                  catch (error) {
                    if (!(error instanceof HttpError) || error.status !== 404) throw error;
                    terminal = { requestId: key, state: "terminal", outcome: "cancelled" };
                  }
                  await stream.writeSSE({ event: "request", data: JSON.stringify(terminal) });
                }
                sent.delete(key);
              }
              for (const notice of notices) {
                const data = JSON.stringify(notice);
                if (sent.get(notice.requestId) === data) continue;
                await stream.writeSSE({ event: "request", data }); sent.set(notice.requestId,data);
              }
            } else sent.clear();
            if (deps.notifications && pendingNotifications.size) {
              const hints = [...pendingNotifications.values()]; pendingNotifications.clear();
              const notifications = await deps.notifications.read(user,identity,hints,initial.checkedAt);
              for (const notification of notifications) await stream.writeSSE({ event: "notify",data: JSON.stringify(notification) });
            }
            if (heartbeat) {
              await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ at: new Date().toISOString(), presence: snapshot.presence }) });
            }
            if (!deps.signals.healthy()) { closeReason = "signals_unhealthy"; break; }
            await waiter.wait;
          } finally { waiter.dispose(); }
        }
        if (stream.aborted || signal.aborted) closeReason = "client_closed";
        else if (Date.now() >= tokenEnd-TOKEN_END_MARGIN_MS) closeReason = "token_end";
      } catch (error) {
        // The database clock may pass the token's end before this one does.
        const tokenEnded = error instanceof HttpError && error.status === 401 && Date.now() >= tokenEnd-TOKEN_END_SKEW_MS;
        closeReason = stream.aborted || signal.aborted ? "client_closed" : tokenEnded ? "token_end" : "error";
        if (!tokenEnded && !stream.aborted && !signal.aborted && error instanceof HttpError && [401,404,409].includes(error.status)) {
          const code = error.status === 401 ? "session_revoked" : "device_registration_changed";
          closeReason = `revoked:${code}`;
          try { await stream.writeSSE({ event: "revoked", data: JSON.stringify({ code }) }); }
          catch { closeReason = stream.aborted || signal.aborted ? "client_closed" : "error"; }
        }
      } finally {
        unsubscribe?.(); unsubscribeDevice?.(); controller.abort();
        if (initial.streamId) {
          try { await deps.devices.closeStream(user, identity, initial.streamId); }
          catch { closeReason = "error"; }
        }
        localCommandDiagnostic({ event: "channel_closed", userId: user.id, ...identity, reason: closeReason, secondsOpen: (performance.now()-openedAt)/1000 });
      }
    });
  });
  return app;
}
