import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { CloudRuntimeBridgeRelay } from "./runtime-bridge.js";
import { CloudPreviewWebSocketRelay } from "./preview-websocket-relay.js";
import { CLOUD_RUNTIME_BRIDGE_PATH } from "./engine-client-admission.js";

const token = `zws_${"D".repeat(43)}`;
const protocols = ["zeros-v1", `zeros-cloud-token.${Buffer.from(token).toString("base64url")}`];
const grant = { workspaceId: "workspace", organizationId: "org", generation: 1, authorityEpoch: 1,
  engineInstanceId: "engine", resourceId: "resource", readOnly: false };
const endpoint = { url: "https://approved-provider.example/", headerName: "x-provider-preview" as const, headerValue: "secret" };
const servers: Server[] = [];
const sockets = new Set<WebSocket>();
const cleanups: (() => void)[] = [];

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return address.port;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections?.(); server.close(resolve);
  })));
});

async function bridgeFixture() {
  const upstreamServer = createServer(), upstream = new WebSocketServer({ noServer: true });
  upstreamServer.on("upgrade", (request, socket, head) => upstream.handleUpgrade(request, socket, head, ws => {
    sockets.add(ws); ws.on("message", (message, binary) => ws.send(message, { binary }));
  }));
  const upstreamPort = await listen(upstreamServer);
  const relay = new CloudRuntimeBridgeRelay({
    resolve: async () => ({ ...grant, endpoint }), revalidate: async () => true, log: () => {},
    maxConnections: 64, maxConnectionsPerWorkspace: 64,
    openUpstream: (_url, options) => new WebSocket(`ws://127.0.0.1:${upstreamPort}/ws`, options),
  });
  cleanups.push(() => { relay.close(); upstream.close(); });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  const port = await listen(server);
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${CLOUD_RUNTIME_BRIDGE_PATH}`, protocols);
    ws.on("error", () => {});
    sockets.add(ws);
    return ws;
  };
  return { relay, connect };
}

type Peer = { ws: WebSocket; sent: number; echoed: number; closedAt: number | null; code: number | null; sentAtClose: number };

/** A client that keeps one request in flight and counts its echoes. */
function loadPeer(ws: WebSocket): Peer {
  const peer: Peer = { ws, sent: 0, echoed: 0, closedAt: null, code: null, sentAtClose: 0 };
  const send = () => { if (ws.readyState === WebSocket.OPEN) { peer.sent += 1; ws.send(`m${peer.sent}`); } };
  ws.on("message", () => { peer.echoed += 1; setTimeout(send, 5); });
  ws.once("close", code => { peer.closedAt = performance.now(); peer.code = code; peer.sentAtClose = peer.sent; });
  ws.once("open", send);
  return peer;
}

describe("runtime relay drain", () => {
  it("keeps every relay forwarding until its own staggered close and refuses new ones at once", async () => {
    const { relay, connect } = await bridgeFixture();
    const peers = Array.from({ length: 40 }, () => loadPeer(connect()));
    await Promise.all(peers.map(peer => peer.ws.readyState === WebSocket.OPEN ? undefined : once(peer.ws, "open")));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(peers.every(peer => peer.echoed > 0)).toBe(true);
    expect(relay.stats().active).toBe(40);

    let step = 0;
    const startedAt = performance.now();
    const drained = relay.drain(1_200, () => (step++ % 40) / 40);
    const late = connect();
    const refused = await new Promise<number>(resolve => late.once("unexpected-response", (_req, response) => resolve(response.statusCode ?? 0)));
    expect(refused).toBe(503);

    await new Promise(resolve => setTimeout(resolve, 600));
    const midway = peers.filter(peer => peer.closedAt === null);
    expect(midway.length).toBeGreaterThan(5);
    expect(midway.length).toBeLessThan(35);
    const progress = midway.map(peer => peer.echoed);
    await new Promise(resolve => setTimeout(resolve, 100));
    // Relays not yet at their moment still carry traffic during the drain.
    expect(midway.filter((peer, index) => peer.closedAt === null && peer.echoed > progress[index]!).length)
      .toBeGreaterThan(0);

    await drained;
    expect(performance.now() - startedAt).toBeLessThan(1_200 + 1_500 + 250);
    expect(peers.every(peer => peer.closedAt !== null)).toBe(true);
    expect(new Set(peers.map(peer => peer.code))).toEqual(new Set([1012]));
    const spread = peers.map(peer => peer.closedAt! - startedAt);
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(800);
    expect(relay.stats()).toMatchObject({ active: 0, retired: expect.objectContaining({ shutdown: 40 }) });
  });

  it("closes everything at once with a zero window, matching the previous shutdown", async () => {
    const { relay, connect } = await bridgeFixture();
    const peers = Array.from({ length: 5 }, () => loadPeer(connect()));
    await Promise.all(peers.map(peer => once(peer.ws, "open")));
    await relay.drain(0);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(peers.map(peer => peer.code)).toEqual([1012, 1012, 1012, 1012, 1012]);
  });

  it("staggers preview sockets the same way", async () => {
    const upstreamServer = createServer(), upstream = new WebSocketServer({ noServer: true });
    upstreamServer.on("upgrade", (request, socket, head) => upstream.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws); ws.on("message", message => ws.send(message));
    }));
    const upstreamPort = await listen(upstreamServer);
    const relay = new CloudPreviewWebSocketRelay({
      recognizes: () => true,
      resolve: async () => ({ grantId: "grant", workspaceId: "w", organizationId: "o", generation: 1, resourceId: "r", remotePort: 3000,
        expiresAtMs: Date.now() + 9_000, endpoint: { url: "https://preview.example/" }, headers: {}, release: () => {} }),
      revalidate: async () => Date.now() + 9_000,
      openUpstream: (_url, offered, options) => new WebSocket(`ws://127.0.0.1:${upstreamPort}/`, offered, options),
    });
    cleanups.push(() => { relay.close(); upstream.close(); });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
    const port = await listen(server);
    const peers = Array.from({ length: 4 }, () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { "x-zeros-preview-capability": `zwp_${"P".repeat(43)}` } });
      ws.on("error", () => {});
      sockets.add(ws);
      return loadPeer(ws);
    });
    await Promise.all(peers.map(peer => once(peer.ws, "open")));
    let step = 0;
    const startedAt = performance.now();
    await relay.drain(600, () => [0, 0.3, 0.6, 0.9][step++]!);
    await new Promise(resolve => setTimeout(resolve, 50));
    const closed = peers.map(peer => peer.closedAt! - startedAt).sort((a, b) => a - b);
    expect(closed[3]! - closed[0]!).toBeGreaterThan(400);
  });
});
