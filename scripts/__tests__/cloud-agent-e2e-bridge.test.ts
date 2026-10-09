import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { BridgeClient } from "../cloud-workspace-validation/lib/bridge-client";

const servers: WebSocketServer[] = [];
const clients: BridgeClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function fixture(handler: (socket: WebSocket, request: Record<string, unknown>) => void) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  server.on("connection", socket => {
    socket.on("message", data => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.type === "WORKSPACE_REQUEST") handler(socket, request);
    });
    socket.send(JSON.stringify({ type: "ENGINE_READY", source: "engine", root: "/fixture", version: "fixture", capabilities: [] }));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  const client = new BridgeClient({ url: `ws://127.0.0.1:${address.port}/ws`, requestTimeoutMs: 200 });
  clients.push(client);
  await client.connect();
  return client;
}

describe("headless renderer bridge envelope", () => {
  it("refuses rejected trusted ENGINE_READY before sending CONNECTED", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    const inbound: string[] = [];
    server.on("connection", socket => {
      socket.on("message", data => inbound.push(JSON.parse(data.toString()).type));
      socket.send(JSON.stringify({ type: "ENGINE_READY", source: "engine", root: "/fixture", version: "fixture" }));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const client = new BridgeClient({ url: `ws://127.0.0.1:${address.port}/ws`, verifyEngineReady: () => false }); clients.push(client);
    await expect(client.connect()).rejects.toThrow("bridge ENGINE_READY rejected");
    expect(inbound).toEqual([]); expect(client.status).toBe("disconnected");
  });
  it("closes a throwing trusted handshake guard without copying its error text", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    server.on("connection", socket => socket.send(JSON.stringify({ type: "ENGINE_READY", source: "engine" })));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const client = new BridgeClient({ url: `ws://127.0.0.1:${address.port}/ws`, verifyEngineReady: () => { throw new Error("fixture-private-detail"); } });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/^bridge ENGINE_READY rejected$/);
    expect(client.status).toBe("disconnected");
  });
  it("uses only the explicit harness socket factory with the original browser protocols", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    server.on("connection", socket => socket.send(JSON.stringify({ type: "ENGINE_READY", source: "engine" })));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const factory = vi.fn((url: string, protocols?: string[]) => {
      expect(url).toBe("ws://127.0.0.1:1/ws");
      expect(protocols?.[0]).toBe("zeros-v1");
      return new WebSocket(`ws://127.0.0.1:${address.port}/ws`, protocols);
    });
    const client = new BridgeClient({ url: "ws://127.0.0.1:1/ws", cloudToken: "fixture-only-cloud-token", webSocketFactory: factory }); clients.push(client);
    await client.connect(); expect(factory).toHaveBeenCalledOnce(); client.close();
  });
  it("preserves the actual response envelope and keeps the legacy result API", async () => {
    const client = await fixture((socket, request) => socket.send(JSON.stringify({ type: "WORKSPACE_RESPONSE", source: "engine",
      requestId: request.id, op: request.op, result: { revision: 7 } })));
    expect(await client.requestEnvelope("cloudCommands.conversation", { conversationId: "fixture" }))
      .toMatchObject({ type: "WORKSPACE_RESPONSE", op: "cloudCommands.conversation", result: { revision: 7 } });
    expect(await client.request("cloudCommands.conversation", {})).toEqual({ revision: 7 });
  });
  it("preserves exact engine WORKSPACE_ERROR without reconstructing or accepting empty success", async () => {
    const client = await fixture((socket, request) => socket.send(JSON.stringify({ type: "WORKSPACE_ERROR", source: "engine",
      requestId: request.id, op: request.op, code: "command_context_changed", message: "command_context_changed" })));
    expect(await client.requestEnvelope("cloudCommands.request", {}))
      .toMatchObject({ type: "WORKSPACE_ERROR", code: "command_context_changed", message: "command_context_changed" });
    await expect(client.request("cloudCommands.request", {})).rejects.toThrow("command_context_changed");
  });
  it("continues real protocol dispatch when a message observer throws", async () => {
    const client = await fixture((socket, request) => socket.send(JSON.stringify({ type: "WORKSPACE_RESPONSE", source: "engine",
      requestId: request.id, op: request.op, result: { revision: 1 } })));
    client.onMessage(() => { throw new Error("fixture observer failure"); });
    expect(await client.requestEnvelope("cloudCommands.conversation", {})).toMatchObject({ result: { revision: 1 } });
  });
  it("bounds an unresponsive envelope request and never resolves an empty result", async () => {
    const client = await fixture(() => {});
    await expect(client.requestEnvelope("cloudCommands.request", {}, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });
  it("rejects an already aborted request without submitting it", async () => {
    const received = vi.fn();
    const client = await fixture(received);
    const controller = new AbortController(); controller.abort();
    await expect(client.requestEnvelope("cloudCommands.request", {}, { signal: controller.signal })).rejects.toThrow();
    expect(received).not.toHaveBeenCalled();
  });
  it("retires a pending envelope on cancellation and ignores its late acknowledgement", async () => {
    let reply: (() => void) | undefined;
    const client = await fixture((socket, request) => { reply = () => socket.send(JSON.stringify({ type: "WORKSPACE_RESPONSE",
      source: "engine", requestId: request.id, op: request.op, result: {} })); });
    const controller = new AbortController();
    const flight = client.requestEnvelope("cloudCommands.request", {}, { signal: controller.signal });
    const rejected = expect(flight).rejects.toThrow();
    await vi.waitFor(() => expect(reply).toBeTypeOf("function"));
    controller.abort(); await rejected; reply!();
    expect(client.status).toBe("connected");
  });
  it("publishes closed connection status and disposes only its own observer", async () => {
    const client = await fixture(() => {});
    expect(client.status).toBe("connected");
    const first = vi.fn(), second = vi.fn();
    const off = client.onStatusChange(first); client.onStatusChange(second);
    off(); off(); client.close();
    expect(client.status).toBe("disconnected");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("disconnected");
  });
  it("rejects pending requests on close even when a status observer throws", async () => {
    const client = await fixture(() => {});
    client.onStatusChange(() => { throw new Error("fixture observer failure"); });
    const flight = client.requestEnvelope("cloudCommands.request", {});
    const rejected = expect(flight).rejects.toThrow(/closed/);
    client.close(); await rejected;
  });
});
