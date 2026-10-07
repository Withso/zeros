import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import {
  CloudRuntimeBridgeRelay,
  runtimeBridgeToken,
} from "./runtime-bridge.js";
import { CLOUD_RUNTIME_BRIDGE_PATH } from "./engine-client-admission.js";

const MiB = 1024 * 1024;
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
  readOnly: false,
};
const endpoint = {
  url: "https://approved-provider.example/",
  headerName: "x-provider-preview" as const,
  headerValue: "outer-provider-secret",
};
const servers: Server[] = [];
const sockets = new Set<WebSocket>();
const rawSockets = new Set<Duplex>();
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
/** `echo` answers every client message; `record` only keeps the engine end
 * so a test can drive it; `raw` completes the handshake by hand so a test can
 * write partial frames from the engine side. */
async function fixture(
  overrides: Partial<
    ConstructorParameters<typeof CloudRuntimeBridgeRelay>[0]
  > = {},
  options: { upstream?: "echo" | "record" | "raw"; upstreamHead?: Buffer } = {},
) {
  const mode = options.upstream ?? "echo";
  const upstreamServer = createServer();
  const upstreamPort = await listen(upstreamServer);
  const engines: WebSocket[] = [];
  const rawEngines: Duplex[] = [];
  const relayClientSockets: Duplex[] = [];
  const relayEngineSockets: Duplex[] = [];
  const relayRemotes: WebSocket[] = [];
  const upstream = new WebSocketServer({ noServer: true });
  upstreams.push(upstream);
  upstreamServer.on("upgrade", (request, socket, head) => {
    if (mode !== "raw") {
      upstream.handleUpgrade(request, socket, head, (ws) =>
        upstream.emit("connection", ws, request),
      );
      return;
    }
    rawSockets.add(socket);
    const response =
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${createHash("sha1")
        .update(
          `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest("base64")}\r\n\r\n`;
    socket.write(
      Buffer.concat([
        Buffer.from(response),
        options.upstreamHead ?? Buffer.alloc(0),
      ]),
    );
    rawEngines.push(socket);
  });
  upstream.on("connection", (ws, request) => {
    sockets.add(ws);
    engines.push(ws);
    expect(request.headers["x-zeros-cloud-token"]).toBe(token);
    expect(request.headers["x-provider-preview"]).toBe(
      "outer-provider-secret",
    );
    if (mode === "echo")
      ws.on("message", (message, binary) => ws.send(message, { binary }));
  });
  const resolve = vi.fn(async () => ({ ...grant, endpoint }));
  const revalidate = vi.fn(async () => true);
  const logs: string[] = [];
  const relay = new CloudRuntimeBridgeRelay({
    resolve,
    revalidate,
    openUpstream: (_url, options) => {
      const remote = new WebSocket(
        `ws://127.0.0.1:${upstreamPort}/ws`,
        options,
      );
      relayRemotes.push(remote);
      remote.once("upgrade", (response) =>
        relayEngineSockets.push(response.socket),
      );
      return remote;
    },
    log: (line) => logs.push(line),
    ...overrides,
  });
  relays.push(relay);
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    relayClientSockets.push(socket);
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
  return {
    relay,
    port,
    connect,
    resolve,
    revalidate,
    upstream,
    engines,
    rawEngines,
    relayClientSockets,
    relayEngineSockets,
    relayRemotes,
    logs,
  };
}
/** Spread each new connection onto its own workspace. */
function distinctWorkspaces(resolve: ReturnType<typeof vi.fn>) {
  let next = 0;
  resolve.mockImplementation(async () => ({
    ...grant,
    workspaceId: `workspace-${next++}`,
    endpoint,
  }));
}
/** A client that writes frames by hand, so a test can leave a message
 * partially sent the way a slow or hostile peer would. */
async function rawClient(
  port: number,
  head = Buffer.alloc(0),
): Promise<Socket> {
  const socket = connectTcp(port, "127.0.0.1");
  rawSockets.add(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  const request =
    `GET ${CLOUD_RUNTIME_BRIDGE_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
    `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n\r\n`;
  socket.write(Buffer.concat([Buffer.from(request), head]));
  const response = await new Promise<string>((resolve) => {
    let text = "";
    const read = (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (!text.includes("\r\n\r\n")) return;
      socket.off("data", read);
      resolve(text);
    };
    socket.on("data", read);
  });
  expect(response.startsWith("HTTP/1.1 101")).toBe(true);
  return socket;
}
/** Header of a final binary frame; clients mask with a zero key. */
function binaryHeader(length: number, masked: boolean): Buffer {
  const header = Buffer.alloc(10 + (masked ? 4 : 0));
  header[0] = 0x82;
  header[1] = (masked ? 0x80 : 0) | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const socket of rawSockets) socket.destroy();
  rawSockets.clear();
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
  it("reports bounded upstream close codes and classes without arbitrary reasons or credentials", async () => {
    const f = await fixture({}, { upstream: "record" });
    for (const reason of ["CONNECTED required", ...Array.from({ length: 10 }, () => "private-upstream-text")]) {
      const socket = f.connect(); await once(socket, "open");
      const closed = once(socket, "close");
      f.engines.at(-1)!.close(1008, reason); await closed;
    }
    const logs = f.logs.filter(line => line.includes("upstream close"));
    expect(logs[0]).toContain("code=1008");
    expect(logs[0]).toContain("class=handshake_required");
    expect(logs[0]).toContain("stage=relay");
    expect(logs.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(f.logs)).not.toMatch(/private-upstream-text|outer-provider-secret/);
    expect(JSON.stringify(f.logs)).not.toContain(token);
  });
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
        headerName: "x-provider-preview" as const,
        headerValue: "outer-provider-secret",
      },
    }));
    const f = await fixture({ resolve, maxConnectionsPerWorkspace: 4 });
    for (let count = 0; count < 4; count++) await once(f.connect(), "open");
    const denied = f.connect();
    expect(String((await once(denied, "error"))[0])).toContain("429");
    resolve.mockResolvedValueOnce({
      ...grant,
      workspaceId: "other-workspace",
      endpoint: {
        url: "https://approved-provider.example/",
        headerName: "x-provider-preview",
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

describe("cloud runtime relay capacity", () => {
  it("retains an engine message coalesced with the upstream upgrade", async () => {
    const payload = Buffer.from("ready-at-upgrade");
    const upstreamHead = Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload,
    ]);
    const f = await fixture({}, { upstream: "raw", upstreamHead });
    const client = f.connect();
    const message = once(client, "message");
    await once(client, "open");
    expect((await message)[0]).toEqual(payload);
  });

  it("charges a client frame header coalesced with the upgrade", async () => {
    const f = await fixture();
    await rawClient(f.port, binaryHeader(64 * MiB, true));
    await vi.waitFor(() =>
      expect(f.relay.stats().inboundReservedBytes).toBe(64 * MiB),
    );
  });

  it.each(["client", "engine"] as const)(
    "charges automatic %s ping replies to the outbound budget",
    async (direction) => {
      const f = await fixture({}, { upstream: "record" });
      const client = f.connect();
      await once(client, "open");
      const source = direction === "client" ? client : f.engines[0]!;
      const payload = Buffer.from("budgeted-pong");
      const replied = once(source, "pong");
      source.ping(payload);
      expect((await replied)[0]).toEqual(payload);
      expect(f.relay.stats().peakOutboundQueuedBytes).toBeGreaterThanOrEqual(
        512,
      );
      await vi.waitFor(() =>
        expect(f.relay.stats().outboundQueuedBytes).toBe(0),
      );
    },
  );

  it("charges empty outbound frames while send callbacks are stalled", async () => {
    const f = await fixture();
    const client = f.connect();
    await once(client, "open");
    const callbacks: (() => void)[] = [];
    vi.spyOn(f.relayRemotes[0]!, "send").mockImplementation(
      (_data, _options, callback) => {
        callbacks.push(callback as () => void);
      },
    );
    client.send(Buffer.alloc(0));
    client.send(Buffer.alloc(0));
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    expect(f.relay.stats().outboundQueuedBytes).toBe(1024);
    for (const callback of callbacks) callback();
    expect(f.relay.stats().outboundQueuedBytes).toBe(0);
  });

  it("admits all ten writers without charging Read-only guests to writer slots", async () => {
    const f = await fixture({
      maxConnections: 20,
      maxConnectionsPerWorkspace: 10,
    });
    f.resolve.mockResolvedValueOnce({ ...grant, endpoint, readOnly: true });
    await once(f.connect(), "open");
    for (let count = 0; count < 10; count++) await once(f.connect(), "open");
    expect(f.relay.stats().active).toBe(11);
    expect(String((await once(f.connect(), "error"))[0])).toContain("429");
    expect(f.relay.stats().rejected.workspace_limit).toBe(1);
  });

  it("bounds Read-only connections separately and frees their slots on close", async () => {
    const f = await fixture({ maxReadOnlyConnectionsPerWorkspace: 2 });
    f.resolve.mockResolvedValue({ ...grant, endpoint, readOnly: true });
    const first = f.connect();
    await once(first, "open");
    await once(f.connect(), "open");
    expect(String((await once(f.connect(), "error"))[0])).toContain("429");
    expect(f.relay.stats().rejected.read_only_workspace_limit).toBe(1);
    first.close();
    await vi.waitFor(() => expect(f.relay.stats().active).toBe(1));
    await once(f.connect(), "open");
    f.resolve.mockResolvedValueOnce({ ...grant, endpoint });
    await once(f.connect(), "open");
    expect(f.relay.stats().active).toBe(3);
  });

  it.each(["client", "engine"] as const)(
    "meters a coalesced %s frame before ws can forward it over the shared budget",
    async (direction) => {
      const f = await fixture(
        { inboundBudgetBytes: 64 * MiB },
        { upstream: "record" },
      );
      const holder = await rawClient(f.port);
      holder.write(binaryHeader(64 * MiB, true));
      await vi.waitFor(() =>
        expect(f.relay.stats().inboundReservedBytes).toBe(64 * MiB),
      );
      const client = f.connect();
      await once(client, "open");
      const source =
        direction === "client"
          ? f.relayClientSockets[1]!
          : f.relayEngineSockets[1]!;
      const target =
        direction === "client"
          ? f.relayEngineSockets[1]!
          : f.relayClientSockets[1]!;
      const writes = vi.spyOn(target, "write");
      source.emit(
        "data",
        Buffer.concat([
          binaryHeader(128 * 1024, direction === "client"),
          Buffer.alloc(128 * 1024, 1),
        ]),
      );
      expect(writes).not.toHaveBeenCalled();
      expect(f.relay.stats()).toMatchObject({
        active: 1,
        inboundReservedBytes: 64 * MiB,
        retired: { inbound_budget: 1 },
      });
    },
  );

  it("admits the measured default ceiling and refuses the next connection", async () => {
    const f = await fixture();
    distinctWorkspaces(f.resolve);
    for (let count = 0; count < 64; count++) await once(f.connect(), "open");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const denied = f.connect();
    expect(String((await once(denied, "error"))[0])).toContain("429");
    expect(f.relay.stats()).toMatchObject({
      active: 64,
      admitted: 64,
      limits: {
        maxConnections: 64,
        maxConnectionsPerWorkspace: 10,
        maxReadOnlyConnectionsPerWorkspace: 10,
        outboundBudgetBytes: 128 * MiB,
        inboundBudgetBytes: 256 * MiB,
      },
      rejected: { instance_limit: 1 },
    });
  });

  it("admits up to a configured instance ceiling above eight, then refuses", async () => {
    const f = await fixture({ maxConnections: 12 });
    distinctWorkspaces(f.resolve);
    for (let count = 0; count < 12; count++) await once(f.connect(), "open");
    const denied = f.connect();
    expect(String((await once(denied, "error"))[0])).toContain("429");
    expect(f.relay.stats()).toMatchObject({
      active: 12,
      admitted: 12,
      rejected: { instance_limit: 1 },
    });
  });

  it("applies a configured per-workspace ceiling without affecting other workspaces", async () => {
    const f = await fixture({ maxConnectionsPerWorkspace: 2 });
    for (let count = 0; count < 2; count++) await once(f.connect(), "open");
    const denied = f.connect();
    expect(String((await once(denied, "error"))[0])).toContain("429");
    expect(f.relay.stats().rejected.workspace_limit).toBe(1);
    f.resolve.mockResolvedValueOnce({
      ...grant,
      workspaceId: "other",
      endpoint,
    });
    await once(f.connect(), "open");
    expect(f.relay.stats().active).toBe(3);
  });

  it("frees a slot when a connection closes", async () => {
    const f = await fixture({ maxConnections: 2 });
    distinctWorkspaces(f.resolve);
    const first = f.connect();
    await once(first, "open");
    await once(f.connect(), "open");
    first.close();
    await vi.waitFor(() => expect(f.relay.stats().active).toBe(1));
    await once(f.connect(), "open");
  });

  it("admits a reconnect wave as large as the configured ceiling at once", async () => {
    const f = await fixture({ maxConnections: 40 });
    distinctWorkspaces(f.resolve);
    // Twenty at a time stays within the pending-admission bound; the
    // admission bucket itself must not refuse any of the forty.
    for (let batch = 0; batch < 2; batch++)
      await Promise.all(
        Array.from({ length: 20 }, () => once(f.connect(), "open")),
      );
    expect(f.relay.stats()).toMatchObject({
      active: 40,
      rejected: { rate_limited: 0 },
    });
  });

  it("rejects relay bounds outside the validated envelope", () => {
    const base = { resolve: async () => null, revalidate: async () => true };
    for (const bound of [
      { maxConnections: 0 },
      { maxConnections: 1025 },
      { maxConnections: 2, maxConnectionsPerWorkspace: 3 },
      { outboundBudgetBytes: 32 * MiB },
      { inboundBudgetBytes: 1.5 },
    ])
      expect(() => new CloudRuntimeBridgeRelay({ ...base, ...bound })).toThrow(
        "invalid relay bound",
      );
  });

  it("charges partially received client messages to the shared inbound budget", async () => {
    const f = await fixture({ inboundBudgetBytes: 64 * MiB });
    const first = await rawClient(f.port);
    first.write(
      Buffer.concat([binaryHeader(40 * MiB, true), Buffer.alloc(4096)]),
    );
    await vi.waitFor(() =>
      expect(f.relay.stats().inboundReservedBytes).toBe(40 * MiB),
    );
    const second = await rawClient(f.port);
    const refused = once(second, "close");
    second.write(binaryHeader(40 * MiB, true));
    await refused;
    expect(f.relay.stats()).toMatchObject({
      active: 1,
      inboundReservedBytes: 40 * MiB,
      retired: { inbound_budget: 1 },
    });
    expect(first.destroyed).toBe(false);
    first.destroy();
    await vi.waitFor(() =>
      expect(f.relay.stats()).toMatchObject({
        active: 0,
        inboundReservedBytes: 0,
      }),
    );
    const third = await rawClient(f.port);
    third.write(binaryHeader(40 * MiB, true));
    await vi.waitFor(() =>
      expect(f.relay.stats().inboundReservedBytes).toBe(40 * MiB),
    );
  });

  it("charges partially received engine messages to the same budget", async () => {
    const f = await fixture(
      { inboundBudgetBytes: 64 * MiB },
      { upstream: "raw" },
    );
    const client = f.connect();
    await once(client, "open");
    f.rawEngines[0]!.write(binaryHeader(48 * MiB, false));
    await vi.waitFor(() =>
      expect(f.relay.stats().inboundReservedBytes).toBe(48 * MiB),
    );
    const other = await rawClient(f.port);
    const refused = once(other, "close");
    other.write(binaryHeader(20 * MiB, true));
    await refused;
    expect(f.relay.stats().retired.inbound_budget).toBe(1);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("releases a message's charge once it is delivered and never charges small ones", async () => {
    const f = await fixture({ inboundBudgetBytes: 64 * MiB });
    const client = f.connect();
    await once(client, "open");
    for (const size of [10, 64 * 1024, 3 * MiB]) {
      const echoed = once(client, "message");
      client.send(Buffer.alloc(size, 1));
      const [data] = await echoed;
      expect((data as Buffer).length).toBe(size);
    }
    expect(f.relay.stats()).toMatchObject({
      inboundReservedBytes: 0,
      outboundQueuedBytes: 0,
    });
    expect(f.relay.stats().peakInboundReservedBytes).toBe(3 * MiB);
  });

  it("retires the connection holding the most queued output instead of a healthy sender", async () => {
    // Today's defaults: 64 MiB per direction and 128 MiB across the relay.
    const f = await fixture({}, { upstream: "record" });
    distinctWorkspaces(f.resolve);
    const slow = [f.connect(), f.connect()];
    for (const ws of slow) {
      await once(ws, "open");
      ws.pause();
    }
    const healthy = f.connect();
    await once(healthy, "open");
    await vi.waitFor(() => expect(f.engines).toHaveLength(3));
    const block = Buffer.alloc(MiB);
    for (let count = 0; count < 60; count++)
      for (const engine of f.engines.slice(0, 2)) engine.send(block);
    // Both slow readers now pin most of the shared outbound budget; the rest
    // of the 120 MiB sits in kernel socket buffers.
    await vi.waitFor(
      () =>
        expect(f.relay.stats().outboundQueuedBytes).toBeGreaterThan(100 * MiB),
      { timeout: 10_000 },
    );
    const delivered = once(healthy, "message");
    f.engines[2]!.send(Buffer.alloc(30 * MiB));
    const [data] = await Promise.race([
      delivered,
      once(healthy, "close").then(() => {
        throw new Error("the healthy connection was retired");
      }),
    ]);
    expect((data as Buffer).length).toBe(30 * MiB);
    expect(healthy.readyState).toBe(WebSocket.OPEN);
    expect(f.relay.stats()).toMatchObject({
      active: 2,
      retired: { outbound_budget: 1 },
    });
    expect(f.logs.some((line) => line.includes("outbound_budget"))).toBe(true);
  });

  it("logs refusals and pressure by reason without identifiers or credentials", async () => {
    const identity = {
      workspaceId: "ws-7f3a9c1d",
      organizationId: "org-55e1b2aa",
      generation: 1,
      authorityEpoch: 1,
      engineInstanceId: "engine-c0ffee12",
      resourceId: "resource-9d8e7f6a",
      readOnly: false,
    };
    const f = await fixture({ maxConnections: 1 });
    f.resolve.mockImplementation(async () => ({ ...identity, endpoint }));
    await once(f.connect(), "open");
    for (let count = 0; count < 3; count++) await once(f.connect(), "error");
    f.resolve.mockResolvedValueOnce(null as never);
    await once(f.connect(), "error");
    expect(f.relay.stats()).toMatchObject({
      admitted: 1,
      rejected: { instance_limit: 3, unauthorized: 1 },
    });
    const refusals = f.logs.filter((line) => line.includes("instance_limit"));
    // One line per reason per interval; repeats are counted, not printed.
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(
      /^\[cloud-bridge\] refused connection: instance_limit /,
    );
    f.relay.close();
    const summary = f.logs.at(-1) ?? "";
    expect(summary).toMatch(/^\[cloud-bridge\] summary /);
    expect(summary).toContain("instance_limit=3");
    for (const line of f.logs)
      for (const secret of [
        token,
        token.slice(4),
        protocols[1]!,
        ...Object.values(identity).filter(
          (value): value is string => typeof value === "string",
        ),
        "approved-provider",
        "outer-provider-secret",
        "127.0.0.1",
      ])
        expect(line).not.toContain(secret);
  });
});
