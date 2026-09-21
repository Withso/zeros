import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import {
  CloudRuntimeBridgeRelay,
  runtimeBridgeToken,
} from "./runtime-bridge.js";
import { CLOUD_RUNTIME_BRIDGE_PATH } from "./engine-client-admission.js";

const token = `zws_${"A".repeat(43)}`;
const protocols = [
  "zeros-v1",
  `zeros-cloud-token.${Buffer.from(token).toString("base64url")}`,
];
const grant = {
  workspaceId: "workspace",
  organizationId: "org",
  generation: 1,
  authorityEpoch: 1,
  engineInstanceId: "engine",
  resourceId: "resource",
};
const servers: Server[] = [];
const sockets = new Set<WebSocket>();
const upstreams: WebSocketServer[] = [];
const relays: CloudRuntimeBridgeRelay[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return address.port;
}
async function fixture(
  overrides: Partial<
    ConstructorParameters<typeof CloudRuntimeBridgeRelay>[0]
  > = {},
) {
  const upstreamServer = createServer();
  const upstreamPort = await listen(upstreamServer);
  const upstream = new WebSocketServer({ server: upstreamServer });
  upstreams.push(upstream);
  upstream.on("connection", (ws, request) => {
    sockets.add(ws);
    expect(request.headers["x-zeros-cloud-token"]).toBe(token);
    expect(request.headers["x-daytona-preview-token"]).toBe(
      "outer-provider-secret",
    );
    ws.on("message", (message, binary) => ws.send(message, { binary }));
  });
  const resolve = vi.fn(async () => ({
    ...grant,
    endpoint: {
      url: "https://approved-provider.example/",
      headerName: "x-daytona-preview-token" as const,
      headerValue: "outer-provider-secret",
    },
  }));
  const revalidate = vi.fn(async () => true);
  const relay = new CloudRuntimeBridgeRelay({
    resolve,
    revalidate,
    openUpstream: (_url, options) =>
      new WebSocket(`ws://127.0.0.1:${upstreamPort}/ws`, options),
    ...overrides,
  });
  relays.push(relay);
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await listen(server);
  const connect = () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${CLOUD_RUNTIME_BRIDGE_PATH}`,
      protocols,
    );
    sockets.add(ws);
    return ws;
  };
  return { relay, port, connect, resolve, revalidate, upstream };
}
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const ws of sockets) {
    ws.on("error", () => {});
    ws.terminate();
  }
  sockets.clear();
  for (const ws of upstreams.splice(0)) ws.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("portable cloud runtime relay", () => {
  it("accepts one canonical header or browser subprotocol token, never credentials in a URL", () => {
    expect(runtimeBridgeToken({ "x-zeros-cloud-token": token })).toBe(token);
    expect(
      runtimeBridgeToken({ "sec-websocket-protocol": protocols.join(", ") }),
    ).toBe(token);
    for (const headers of [
      {},
      {
        "x-zeros-cloud-token": token,
        "sec-websocket-protocol": protocols.join(", "),
      },
      { "sec-websocket-protocol": `${protocols.join(", ")},zeros-v1` },
      { "x-zeros-cloud-token": `${token},${token}` },
      {
        "sec-websocket-protocol": `zeros-v1,zeros-cloud-token.${Buffer.from(token).toString("base64url")}=`,
      },
    ]) {
      expect(runtimeBridgeToken(headers)).toBeNull();
    }
  });
  it("relays incrementally after engine admission and keeps provider secrets server-side", async () => {
    const f = await fixture();
    const ws = f.connect();
    await once(ws, "open");
    expect(ws.protocol).toBe("zeros-v1");
    const response = once(ws, "message");
    ws.send(JSON.stringify({ type: "HELLO" }));
    const [data, binary] = await response;
    expect(data.toString()).toBe('{"type":"HELLO"}');
    expect(binary).toBe(false);
    expect(f.resolve).toHaveBeenCalledWith(token);
    expect(JSON.stringify([...ws.protocol])).not.toContain("secret");
  });
  it("denies before upstream I/O and bounds pending lookup work after client disconnect", async () => {
    let finish!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      finish = resolve;
    });
    const resolve = vi.fn(() => pending);
    const f = await fixture({ resolve, maxPending: 1 });
    const first = f.connect();
    first.on("error", () => {});
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    first.terminate();
    const second = f.connect();
    const error = await once(second, "error");
    expect(String(error[0])).toContain("429");
    expect(resolve).toHaveBeenCalledTimes(1);
    finish(null);
    await vi.waitFor(() => expect(f.relay.pendingCount).toBe(0));
  });
  it("closes both sides on authority loss", async () => {
    const revalidate = vi.fn(async () => false);
    const f = await fixture({ revalidate, authorityCheckMs: 30 });
    const ws = f.connect();
    await once(ws, "open");
    await once(ws, "close");
    expect(revalidate).toHaveBeenCalled();
    await vi.waitFor(() => expect([...f.upstream.clients]).toHaveLength(0));
  });
  it("retires a stream when authority revalidation never returns", async () => {
    const revalidate = vi.fn(() => new Promise<boolean>(() => {}));
    const f = await fixture({ revalidate, authorityCheckMs: 30 });
    const ws = f.connect();
    await once(ws, "open");
    await once(ws, "close");
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
  it("isolates a workspace's connection ceiling from another workspace", async () => {
    const resolve = vi.fn(async () => ({
      ...grant,
      endpoint: {
        url: "https://approved-provider.example/",
        headerName: "x-daytona-preview-token" as const,
        headerValue: "outer-provider-secret",
      },
    }));
    const f = await fixture({ resolve });
    for (let count = 0; count < 4; count++) await once(f.connect(), "open");
    const denied = f.connect();
    expect(String((await once(denied, "error"))[0])).toContain("429");
    resolve.mockResolvedValueOnce({
      ...grant,
      workspaceId: "other-workspace",
      endpoint: {
        url: "https://approved-provider.example/",
        headerName: "x-daytona-preview-token",
        headerValue: "outer-provider-secret",
      },
    });
    await once(f.connect(), "open");
  });
  it("does not put malformed destinations or headers on the network", async () => {
    for (const endpoint of [
      { url: "http://127.0.0.1/" },
      { url: "https://approved-provider.example/?token=secret" },
      {
        url: "https://approved-provider.example/",
        headerName: "authorization",
        headerValue: "secret",
      },
    ]) {
      const openUpstream = vi.fn();
      const f = await fixture({
        resolve: async () => ({ ...grant, endpoint: endpoint as never }),
        openUpstream,
      });
      const ws = f.connect();
      await once(ws, "error");
      expect(openUpstream).not.toHaveBeenCalled();
    }
  });
});
