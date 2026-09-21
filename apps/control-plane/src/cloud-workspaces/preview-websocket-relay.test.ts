import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { CloudPreviewWebSocketRelay } from "./preview-websocket-relay.js";

const token = `zwp_${"a".repeat(43)}`;
const servers: Server[] = [], upstreams: WebSocketServer[] = [], relays: CloudPreviewWebSocketRelay[] = [];
const clients = new Set<WebSocket>();
async function listen(server: Server) {
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function fixture(options: Partial<ConstructorParameters<typeof CloudPreviewWebSocketRelay>[0]> = {}) {
  const app = createServer(); const appPort = await listen(app); const upstream = new WebSocketServer({ server: app }); upstreams.push(upstream);
  const received = vi.fn(); upstream.on("connection", (client, req) => {
    clients.add(client); received(req.headers); client.on("message", (data, binary) => client.send(data, { binary }));
  });
  const release = vi.fn();
  const grant = { grantId: "grant", workspaceId: "workspace", organizationId: "org", generation: 1, resourceId: "resource", remotePort: 3000,
    expiresAtMs: Date.now() + 10_000, endpoint: { url: "https://approved.example.test/", headerName: "x-zeros-runtime-access" as const, headerValue: token },
    headers: { authorization: "Bearer application-login" }, release };
  const resolve = vi.fn(async () => grant), revalidate = vi.fn(async () => Date.now() + 10_000);
  const relay = new CloudPreviewWebSocketRelay({ recognizes: () => true, resolve, revalidate,
    openUpstream: (_url, protocols, clientOptions) => new WebSocket(`ws://127.0.0.1:${appPort}/hmr`, protocols, clientOptions), ...options });
  relays.push(relay); const server = createServer();
  server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  const port = await listen(server);
  const connect = (authorized = true) => { const client = new WebSocket(`ws://127.0.0.1:${port}/hmr?value=1`, ["vite-hmr"],
    { headers: authorized ? { "x-zeros-preview-capability": token } : {} }); clients.add(client); return client; };
  return { grant, release, received, relay, resolve, revalidate, connect, port, appPort };
}
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const client of clients) client.terminate(); clients.clear();
  for (const server of upstreams.splice(0)) server.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
describe("public authenticated preview WebSocket relay", () => {
  it("consumes browser service credentials without selecting or forwarding them", async () => {
    const { runtimeServiceToken } = await import("./runtime-services.js");
    const serviceToken = `zsh_${"s".repeat(43)}`;
    const openUpstream = vi.fn((url, protocols, options) => new WebSocket(`ws://127.0.0.1:${f.appPort}/services/v1/ssh`, protocols, options));
    const f = await fixture({ authorizeUpgrade: request => runtimeServiceToken(request.headers) ? { protocols: ["zeros.service.v1"] } : null, openUpstream });
    Object.assign(f.grant, { upstreamPath: "/services/v1/ssh", headers: { "x-zeros-runtime-service": serviceToken } });
    const client = new WebSocket(`ws://127.0.0.1:${f.port}/v1/cloud-workspaces/services/ssh/grant`, ["zeros.service.v1", `zeros.authorization.${serviceToken}`]);
    clients.add(client); await once(client, "open");
    expect(client.protocol).toBe("zeros.service.v1");
    expect(openUpstream.mock.calls[0]![0]).toBe("wss://approved.example.test/services/v1/ssh");
    expect(f.received.mock.calls[0]![0]["sec-websocket-protocol"]).toBe("zeros.service.v1");
    expect(f.received.mock.calls[0]![0]["x-zeros-runtime-service"]).toBe(serviceToken);
    const response = once(client, "message"); client.send(Buffer.from([0, 1, 2, 255]));
    expect(Buffer.from((await response)[0])).toEqual(Buffer.from([0, 1, 2, 255]));
  });
  it("relays application protocols and frames with an upstream-only service credential", async () => {
    const f = await fixture(); const client = f.connect(); await once(client, "open");
    expect(client.protocol).toBe("vite-hmr");
    const message = once(client, "message"); client.send("hot-update"); expect((await message)[0].toString()).toBe("hot-update");
    expect(f.received.mock.calls[0]![0]).toMatchObject({ "x-zeros-runtime-access": token, authorization: "Bearer application-login" });
    expect(f.received.mock.calls[0]![0]["x-zeros-preview-capability"]).toBeUndefined();
    f.relay.close(); await once(client, "close"); expect(f.release).toHaveBeenCalledOnce();
  });
  it("rejects missing capabilities without touching the control plane or application", async () => {
    const f = await fixture(); const client = f.connect(false); await once(client, "error");
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.received).not.toHaveBeenCalled();
  });
  it("closes when revalidation hangs beyond the existing lease", async () => {
    const f = await fixture({ revalidate: () => new Promise(() => {}), authorityCheckMs: 25 });
    f.grant.expiresAtMs = Date.now() + 120;
    const client = f.connect(); await once(client, "open"); await once(client, "close");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("releases a grant that arrives after shutdown without opening an upstream", async () => {
    let ready!: (value: Awaited<ReturnType<ConstructorParameters<typeof CloudPreviewWebSocketRelay>[0]["resolve"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<ConstructorParameters<typeof CloudPreviewWebSocketRelay>[0]["resolve"]>>>(resolve => { ready = resolve; });
    const resolve = vi.fn(() => pending); const f = await fixture({ resolve }); const client = f.connect();
    const failed = once(client, "error"); await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    f.relay.close(); ready(f.grant); await failed;
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce()); expect(f.received).not.toHaveBeenCalled();
  });
});
