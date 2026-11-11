import { describe, expect, it, vi } from "vitest";
import { DeviceControl, DeviceControlError, parseEventStream } from "../local-commands/control";
import type { LocalCommandDevice } from "@zeros/protocol/local-commands";

const deviceId = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", registrationId = "8f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d12", instanceId = "9f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d13";
const requestId = "af1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d14";
const iso = "2026-11-10T12:00:00.000Z";
const presence = { presenceRequired: false, reachableUntil: null };
const device: LocalCommandDevice = { deviceId, registrationId, instanceId, name: "Studio", capabilities: ["local-commands-v1"] };

function fake(handler: (method: string, path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ method: string; path: string; headers: Headers; body?: unknown }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(String(url)), method = init.method ?? "GET";
    calls.push({ method, path: target.pathname + target.search, headers: new Headers(init.headers), ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return handler(method, target.pathname, init);
  }) as unknown as typeof globalThis.fetch;
  const control = new DeviceControl({ fetch, baseUrl: () => "https://api.example.test", token: async () => "synthetic-desktop-bearer" });
  return { control, calls };
}

describe("device control client", () => {
  it("sends exactly the capabilities it is given: no fallback hides a second body under the same request id", async () => {
    const deviceId = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", requestId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const f = fake(() => Response.json({ error: { code: "invalid_request" } }, { status: 400 }));
    await expect(f.control.register(deviceId, { requestId, name: "Studio", capabilities: ["local-commands-v1", "local-commands-reason-v1"] })).rejects.toMatchObject({ status: 400 });
    expect(f.calls.map(call => (call.body as { capabilities: string[] }).capabilities)).toEqual([["local-commands-v1", "local-commands-reason-v1"]]);
  });

  it("registers without H, then sends exactly the three H headers and the bearer on device routes", async () => {
    const f = fake((method, path) => {
      if (method === "PUT") return Response.json({ device, presence, heartbeatIntervalMs: 25000 });
      if (path.endsWith("/heartbeat")) return Response.json(presence);
      if (path.endsWith("/claim")) return Response.json({ requestId, state: "terminal", outcome: "denied" });
      if (path.endsWith("/ack")) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    const registered = await f.control.register(deviceId, { requestId, name: "Studio", capabilities: ["local-commands-v1", "local-commands-reason-v1"] });
    expect(registered.device).toEqual(device);
    expect(f.calls[0]).toMatchObject({ method: "PUT", path: `/v1/cloud-v2/devices/${deviceId}`, body: { requestId, name: "Studio", capabilities: ["local-commands-v1", "local-commands-reason-v1"] } });
    expect(f.calls[0]!.headers.get("x-zeros-device-id")).toBeNull();
    expect(await f.control.heartbeat(device)).toEqual(presence);
    expect(await f.control.claim(device, requestId, "deny")).toEqual({ requestId, state: "terminal", outcome: "denied" });
    await f.control.ack(device, requestId);
    for (const call of f.calls.slice(1)) {
      expect(call.headers.get("authorization")).toBe("Bearer synthetic-desktop-bearer");
      expect([call.headers.get("x-zeros-device-id"), call.headers.get("x-zeros-device-registration"), call.headers.get("x-zeros-device-instance")]).toEqual([deviceId, registrationId, instanceId]);
    }
    expect(f.calls.map(call => `${call.method} ${call.path}`)).toEqual([`PUT /v1/cloud-v2/devices/${deviceId}`, `POST /v1/cloud-v2/devices/${deviceId}/heartbeat`,
      `POST /v1/cloud-v2/devices/${deviceId}/requests/${requestId}/claim`, `POST /v1/cloud-v2/devices/${deviceId}/requests/${requestId}/ack`]);
    expect(f.calls[2]!.body).toEqual({ decision: "deny" });
  });

  it("names the server's error code, keeps status, and refuses a reply in the wrong shape", async () => {
    const f = fake(() => Response.json({ error: { code: "device_registration_changed", message: "Register again." } }, { status: 409 }));
    await expect(f.control.heartbeat(device)).rejects.toMatchObject({ status: 409, code: "device_registration_changed" });
    const bad = fake(() => Response.json({ presenceRequired: "yes" }));
    await expect(bad.control.heartbeat(device)).rejects.toBeInstanceOf(DeviceControlError);
  });

  it("posts a result and connects and disconnects a workspace Mac", async () => {
    const mac = { deviceId, name: "Studio", connected: true, active: false, reachable: true, expiresAt: iso };
    const f = fake((_method, path) => path.endsWith("/result") ? Response.json({ outcome: "completed" })
      : path.endsWith("/connect") ? Response.json({ mac, presence }) : Response.json({ mac: { ...mac, connected: false, expiresAt: null } }));
    expect(await f.control.result(device, requestId, { outcome: "completed", code: 0, stdout: "ok" })).toEqual({ outcome: "completed" });
    expect(f.calls[0]!.body).toEqual({ result: { outcome: "completed", code: 0, stdout: "ok" } });
    expect((await f.control.connect(device, "11111111-1111-4111-8111-111111111111")).mac.connected).toBe(true);
    expect((await f.control.disconnect(device, "11111111-1111-4111-8111-111111111111", deviceId)).mac.connected).toBe(false);
    expect(await f.control.setSyncing(device, "11111111-1111-4111-8111-111111111111", true)).toMatchObject({ mac: { deviceId } });
    expect(f.calls.slice(1).map(call => call.path)).toEqual([`/v1/cloud-v2/workspaces/11111111-1111-4111-8111-111111111111/macs/${deviceId}/connect`,
      `/v1/cloud-v2/workspaces/11111111-1111-4111-8111-111111111111/macs/${deviceId}/disconnect`, `/v1/cloud-v2/workspaces/11111111-1111-4111-8111-111111111111/macs/${deviceId}/sync`]);
    // Rows include `syncing` only when asked; the result route never asks.
    expect(f.calls.map(call => call.headers.get("x-zeros-sync"))).toEqual([null, "1", "1", "1"]);
    expect(f.calls.at(-1)).toMatchObject({ method: "PUT", body: { syncing: true } });
  });

  it("parses named SSE events across chunk boundaries and skips comments and unknown names", async () => {
    const text = `: hi\n\nevent: ready\ndata: {"deviceId":"${deviceId}",\ndata: "registrationId":"${registrationId}","instanceId":"${instanceId}","presence":{"presenceRequired":false,"reachableUntil":null},"heartbeatIntervalMs":25000}\n\nevent: other\ndata: {}\n\nevent: revoked\ndata: {"code":"session_revoked"}\n\n`;
    const chunks = [text.slice(0, 7), text.slice(7, 90), text.slice(90)].map(part => new TextEncoder().encode(part));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const events = [];
    for await (const event of parseEventStream(stream)) events.push(event);
    expect(events.map(event => event.event)).toEqual(["ready", "revoked"]);
    expect(events[1]!.data).toEqual({ code: "session_revoked" });
  });
});
