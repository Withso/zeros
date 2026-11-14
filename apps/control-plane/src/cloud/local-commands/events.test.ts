import { Hono } from "hono";
import type pg from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { CloudV2PromptSignals } from "../prompt-signals.js";
import { CloudLocalDevices } from "./devices.js";
import { createCloudLocalDeviceRoutes } from "./routes.js";
import type { CloudLocalCommandSignals } from "./signals.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers(); vi.restoreAllMocks();
});

async function open() {
  const identity = { deviceId: "11111111-1111-4111-8111-111111111111", registrationId: "22222222-2222-4222-8222-222222222222",
    instanceId: "33333333-3333-4333-8333-333333333333" };
  const user = { id: "44444444-4444-4444-8444-444444444444", authentication: { sessionId: "session", tokenExpiresAt: Date.now()/1000+3600 } } as AuthedUser;
  const devices = new CloudLocalDevices({} as pg.Pool), waits = new CloudV2PromptSignals();
  const value = { device: { ...identity, name: "Fixture", capabilities: ["local-commands-v1" as const] },
    presence: { presenceRequired: true, reachableUntil: new Date(Date.now()+65_000).toISOString() }, hasRequests: false, checkedAt: new Date().toISOString() };
  vi.spyOn(devices, "openStream").mockResolvedValue({ ...value, streamId: "stream" });
  vi.spyOn(devices, "closeStream").mockResolvedValue();
  const snapshot = vi.spyOn(devices, "snapshot").mockResolvedValue(value);
  const signals = { start: async () => {}, healthy: () => true, wait: waits.wait.bind(waits) };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  app.route("/", createCloudLocalDeviceRoutes({ devices, signals: signals as CloudLocalCommandSignals }));
  const controller = new AbortController();
  const response = await app.request(`/v1/cloud-v2/devices/${identity.deviceId}/events`, { signal: controller.signal,
    headers: { "x-zeros-device-id": identity.deviceId, "x-zeros-device-registration": identity.registrationId, "x-zeros-device-instance": identity.instanceId } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let output = "";
  const pump = (async () => { for (;;) { const next = await reader.read(); if (next.done) return; output += decoder.decode(next.value); } })();
  cleanups.push(async () => { controller.abort(); await reader.cancel(); await pump; });
  await vi.advanceTimersByTimeAsync(0);
  expect(output).toContain("event: ready");
  return { snapshot, wake: () => waits.wakeAll(), output: () => output };
}

it("keeps device snapshot and reachability SQL idle until the sixty-second fallback", async () => {
  const f = await open(); f.snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(f.snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(f.output()).toContain("event: heartbeat");
});

it("rechecks a changed device immediately and refuses delivery after revocation", async () => {
  const f = await open();
  f.snapshot.mockRejectedValue(new HttpError(401, "session_revoked", "Unavailable"));
  f.wake(); await vi.advanceTimersByTimeAsync(0);
  expect(f.output()).toContain('"code":"session_revoked"');
});
