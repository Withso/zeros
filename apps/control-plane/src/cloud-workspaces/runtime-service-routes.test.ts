import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudRuntimeServiceRoutes } from "./runtime-service-routes.js";
import { runtimeServiceToken } from "./runtime-services.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const path = "/v1/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cloud-workspaces/cccccccc-cccc-4ccc-8ccc-cccccccccccc/runtime/services";
const token = `zsh_${"a".repeat(43)}`;
describe("native runtime service HTTP and credential contracts", () => {
  const fixture = () => {
    const service = { issue: vi.fn(async () => ({ transport: { capability: token } })), revoke: vi.fn(async () => {}) };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    app.route("/", createCloudRuntimeServiceRoutes(service as never));
    app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({ code: "unknown" }, 500));
    return { app, service };
  };
  const headers = () => ({ "content-type": "application/json", "idempotency-key": "runtime-test-key",
    "x-zeros-device-id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "x-zeros-device-key-version": "1",
    "x-zeros-device-timestamp": String(Date.now()), "x-zeros-device-nonce": "n".repeat(32), "x-zeros-device-signature": "s".repeat(86) });
  it("requires a device proof and marks the one-time bearer response noncacheable", async () => {
    const f = fixture();
    const missing = await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: '{"kind":"ssh"}' });
    expect(missing.status).toBe(403); expect(f.service.issue).not.toHaveBeenCalled();
    const result = await f.app.request(path, { method: "POST", headers: headers(), body: '{"kind":"tunnel","remotePort":3000}' });
    expect(result.status).toBe(201); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(f.service.issue).toHaveBeenCalledWith(expect.objectContaining({ accountUserId: userId, remotePort: 3000, expiresInMinutes: 15,
      proof: expect.objectContaining({ keyVersion: 1 }) }));
  });
  it("rejects unknown body fields and bounded body overflow", async () => {
    const f = fixture();
    const unknown = await f.app.request(path, { method: "POST", headers: headers(), body: '{"kind":"ssh","username":"root"}' });
    expect(unknown.status).toBe(422);
    const oversized = await f.app.request(path, { method: "POST", headers: headers(), body: JSON.stringify({ kind: "ssh", padding: "x".repeat(5000) }) });
    expect(oversized.status).toBe(413); expect(f.service.issue).not.toHaveBeenCalled();
  });
  it("revokes with the authenticated account rather than a user-selected actor", async () => {
    const f = fixture(), grantId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const result = await f.app.request(`${path}/${grantId}`, { method: "DELETE" });
    expect(result.status).toBe(204); expect(f.service.revoke).toHaveBeenCalledWith(expect.objectContaining({ accountUserId: userId, grantId }));
  });
  it("accepts the header or browser credential carrier and rejects ambiguous credentials", () => {
    expect(runtimeServiceToken(new Headers({ "x-zeros-runtime-service": token }))).toBe(token);
    expect(runtimeServiceToken(new Headers({ "x-zeros-runtime-service": token, "sec-websocket-protocol": "zeros.service.v1" }))).toBe(token);
    expect(runtimeServiceToken(new Headers({ "sec-websocket-protocol": `zeros.service.v1, zeros.authorization.${token}` }))).toBe(token);
    for (const headers of [
      { "x-zeros-runtime-service": `zwp_${"a".repeat(43)}` },
      { "sec-websocket-protocol": `zeros.authorization.${token}` },
      { "sec-websocket-protocol": "zeros.service.v1, zeros.service.v1" },
      { "sec-websocket-protocol": `zeros.service.v1, zeros.authorization.${token}`, "x-zeros-runtime-service": `zsh_${"b".repeat(43)}` },
    ]) expect(runtimeServiceToken(new Headers(headers))).toBeNull();
  });
});
