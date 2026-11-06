import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeClientEnvironment, type RuntimeTransportSocket } from "../runtime-client";
import { classifyRpcError } from "../failure";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

class Socket implements RuntimeTransportSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: RuntimeTransportSocket["onopen"] = null;
  onclose: RuntimeTransportSocket["onclose"] = null;
  onmessage: RuntimeTransportSocket["onmessage"] = null;
  onerror: RuntimeTransportSocket["onerror"] = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen?.({} as Event); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  answer(request: Record<string, any>) {
    this.onmessage?.({ data: JSON.stringify({ id: `reply-${request.id}`, timestamp: Date.now(), source: "engine",
      type: "WORKSPACE_RESPONSE", requestId: request.id, op: request.op, result: { workspaces: [] } }) } as MessageEvent);
  }
}
const clients: RuntimeClient[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });
function fixture(local = false) {
  const sockets: Socket[] = [];
  const offers: Array<string[] | undefined> = [];
  const target = {
    kind: "cloud" as const, channel: "v2-websocket" as const,
    runtimeId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333", engineInstanceId: "44444444-4444-4444-8444-444444444444",
    generation: 1, authorityEpoch: 1, connectionSequence: 1, expiresAt: Date.now() + 60_000,
    url: "wss://api.example.test/v2/cloud/workspaces/33333333-3333-4333-8333-333333333333/bridge",
    protocols: ["zeros.cloud.v2", `ticket.zw2c_${"a".repeat(43)}`] as ["zeros.cloud.v2", string],
  };
  const environment: RuntimeClientEnvironment = {
    controlPlaneOrigin: "https://api.example.test", allowHttpLoopback: false,
    createWebSocket: (_url, protocols) => { offers.push(protocols); const socket = new Socket(); sockets.push(socket); return socket as unknown as globalThis.WebSocket; },
    resolveEnginePort: async () => 29920, resolveEngineToken: async () => "synthetic",
    invalidateEnginePort() {}, invalidateEngineToken() {}, getAuthAccessToken: () => null,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  const refresh = vi.fn(async current => ({ ...current, connectionSequence: current.connectionSequence + 1, expiresAt: Date.now() + 60_000 }));
  const client = new RuntimeClient(local ? { kind: "local" } : target, { environment, refreshCloudConnectionTarget: refresh });
  clients.push(client);
  const ready = async (socket: Socket) => {
    socket.open();
    if (!local) socket.answer(socket.sent.find(message => message.op === "workspace.list")!);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.status).toBe("connected");
  };
  return { client, sockets, refresh, ready, offers, target, environment };
}

it("retains connecting when an unopened cloud ticket expires during the same bounded wait", async () => {
  const h = fixture(), states: string[] = [];
  h.client.onStatusChange(status => states.push(status));
  await h.client.connect();
  const failed = vi.fn(), waiting = h.client.waitUntilReady().catch(failed);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.client.status).toBe("connecting");
  expect(states).not.toContain("disconnected");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.refresh).toHaveBeenCalledOnce();
  await h.ready(h.sockets[1]); await waiting;
  expect(failed).not.toHaveBeenCalled();
});

it("retains connecting through a transient cloud socket construction failure", async () => {
  const h = fixture(), states: string[] = [];
  h.client.onStatusChange(status => states.push(status));
  vi.spyOn(h.environment, "createWebSocket").mockImplementationOnce(() => { throw new Error("Transport unavailable"); });
  await h.client.connect();
  expect(h.client.status).toBe("connecting");
  expect(states).not.toContain("disconnected");
  const failed = vi.fn(), waiting = h.client.waitUntilReady().catch(failed);
  await vi.advanceTimersByTimeAsync(1_000);
  await h.ready(h.sockets[0]); await waiting;
  expect(failed).not.toHaveBeenCalled();
});

it("keeps a foreground read queued through the committed handoff window and completes it after the same handshake", async () => {
  const h = fixture(); await h.client.connect(); h.sockets[0].open();
  let failed: unknown;
  const connected = h.client.waitUntilReady().catch(error => { failed = error; });
  const reading = h.client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: { path: "retained.txt" } }, 1000)
    .catch(error => { failed = error; });
  await vi.advanceTimersByTimeAsync(11_000);
  expect(h.sockets).toHaveLength(1); expect(h.sockets[0].readyState).toBe(1); expect(failed).toBeUndefined();
  await vi.advanceTimersByTimeAsync(108_000);
  expect(h.client.status).toBe("connecting"); expect(failed).toBeUndefined();
  h.sockets[0].answer(h.sockets[0].sent.find(frame => frame.op === "workspace.list")!);
  await vi.advanceTimersByTimeAsync(0); await connected;
  expect(h.client.status).toBe("connected");
  const request = h.sockets[0].sent.find(frame => frame.op === "file.read"); expect(request).toBeDefined();
  h.sockets[0].answer(request!);
  expect(await reading).toMatchObject({ type: "WORKSPACE_RESPONSE", op: "file.read" });
  expect(failed).toBeUndefined(); expect(h.refresh).not.toHaveBeenCalled();
});

it("bounds a handoff handshake that never becomes ready", async () => {
  const h = fixture(); await h.client.connect(); h.sockets[0].open();
  let failed: unknown;
  const connected = h.client.waitUntilReady().catch(error => { failed = error; });
  await vi.advanceTimersByTimeAsync(119_999);
  expect(failed).toBeUndefined(); expect(h.sockets[0].readyState).toBe(1);
  await vi.advanceTimersByTimeAsync(1); await connected;
  expect(failed).toBeInstanceOf(Error); expect(h.sockets[0].readyState).toBe(3);
});

it("does not renew the cloud connection deadline after a transient reconnect", async () => {
  const h = fixture(); await h.client.connect(); h.sockets[0].open();
  const failure = vi.fn();
  const waiting = h.client.waitUntilReady().catch(failure);
  await vi.advanceTimersByTimeAsync(90_000);
  h.sockets[0].close(1013);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.sockets).toHaveLength(2); h.sockets[1].open();
  await vi.advanceTimersByTimeAsync(28_999);
  expect(failure).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await waiting;
  expect(failure).toHaveBeenCalledOnce();
  expect(h.client.lastRejection?.code).toBe("cloud_actor_runtime_unavailable");
  expect(h.sockets[1].readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.sockets).toHaveLength(2);
});

it.each([4001, 4003])("ends a definitive cloud refusal immediately (close %s)", async code => {
  const h = fixture(); await h.client.connect(); h.sockets[0].open();
  const connectFailure = vi.fn(), readFailure = vi.fn();
  const waiting = h.client.waitUntilReady().catch(connectFailure);
  const reading = h.client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: { path: "retained.txt" } }).catch(readFailure);
  h.sockets[0].close(code); await vi.advanceTimersByTimeAsync(0);
  expect(connectFailure).toHaveBeenCalledOnce(); expect(readFailure).toHaveBeenCalledOnce();
  await waiting; await reading;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.sockets).toHaveLength(1); expect(h.refresh).not.toHaveBeenCalled();
  await expect(h.client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list" })).rejects.toThrow();
});

it.each([400, 401, 403, 404, 408, 409, 429])("does not retry a definitive ticket HTTP %s refusal", async status => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  h.refresh.mockRejectedValue({ status, code: status === 409 ? "cloud_workspace_not_running" : "request_failed" });
  h.sockets[0].close(1006);
  const failure = vi.fn(); const waiting = h.client.waitUntilReady().catch(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toHaveBeenCalledOnce(); await waiting;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.refresh).toHaveBeenCalledOnce(); expect(h.sockets).toHaveLength(1);
});

it.each(["Personal", "organization-local"])("retains the 30 second Local readiness bound for %s", async () => {
  const h = fixture(true), failure = vi.fn();
  const waiting = h.client.waitUntilReady().catch(failure);
  await vi.advanceTimersByTimeAsync(29_999); expect(failure).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await waiting; expect(failure).toHaveBeenCalledOnce();
});

it.each([true, false])("rejects stopped-worker admission and queued writes promptly (handshake completed: %s)", async ready => {
  const h = fixture(); await h.client.connect();
  if (ready) await h.ready(h.sockets[0]);
  else h.sockets[0].open();
  let readyFailure: unknown, writeFailure: unknown;
  const waiting = h.client.waitUntilReady().catch(error => { readyFailure = error; });
  const writing = h.client.request({ type: "WORKSPACE_REQUEST", op: "file.write", params: { path: "draft.txt", content: "draft" } })
    .catch(error => { writeFailure = error; });
  h.sockets[0].close(4009);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.lastRejection).toMatchObject({ reason: "cloud-transient", code: "cloud_workspace_not_running" });
  if (!ready) expect(readyFailure).toBeInstanceOf(Error);
  expect(writeFailure).toBeInstanceOf(Error);
  expect(h.refresh).not.toHaveBeenCalled();
  await waiting; await writing;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sockets).toHaveLength(1);
});

it.each([true, false])("offers explicit-wake negotiation only for cloud (local: %s)", async local => {
  const h = fixture(local); await h.client.connect();
  expect(h.offers[0]).toEqual(local ? undefined : [...h.target.protocols, "zeros.cloud.v2.explicit-wake"]);
});

it("connects a new client to an N-1 server that selects the original bridge protocol", async () => {
  vi.useRealTimers();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = fixture();
  let offered = "", selected = "";
  server.on("connection", (ws, request) => {
    offered = String(request.headers["sec-websocket-protocol"]); selected = ws.protocol;
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "WORKSPACE_REQUEST") ws.send(JSON.stringify({ type: "WORKSPACE_RESPONSE", id: "reply", timestamp: Date.now(),
        source: "engine", requestId: frame.id, op: frame.op, result: frame.op === "workspace.list" ? { workspaces: [] } : { kind: "success" } }));
    });
  });
  const client = new RuntimeClient({ ...h.target, url: `${origin.replace("http:", "ws:")}/v2/cloud/workspaces/${h.target.workspaceId}/bridge` }, {
    environment: { ...h.environment, allowHttpLoopback: true, controlPlaneOrigin: origin,
      createWebSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as globalThis.WebSocket },
  });
  clients.push(client);
  try {
    await client.connect(); await client.waitUntilReady();
    expect(offered.split(/, */)).toContain("zeros.cloud.v2.explicit-wake");
    expect(selected).toBe("zeros.cloud.v2");
    await expect(client.request({ type: "WORKSPACE_REQUEST", op: "file.write", params: { path: "draft.txt", content: "draft" } }))
      .resolves.toMatchObject({ result: { kind: "success" } });
  } finally {
    client.dispose(); for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("refreshes a dropped cloud bridge immediately and flushes only unsent work after the handshake", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  const sent = h.client.request({ type: "AGENT_PROMPT", agentId: "codex", sessionId: "route",
    userMessageId: "already-sent", prompt: [{ type: "text", text: "synthetic prompt" }] }, { timeoutMs: 0 });
  const rejected = expect(sent).rejects.toThrow(/disconnected/);
  h.sockets[0].close(1006); await rejected;
  const queued = h.client.request({ type: "WORKSPACE_REQUEST", op: "chats.list" });
  void queued.catch(() => {}); // Cleanup also runs when the regression assertion is red.
  await vi.advanceTimersByTimeAsync(0);
  expect(h.refresh).toHaveBeenCalledOnce(); expect(h.sockets).toHaveLength(2);
  const next = h.sockets[1]; next.open();
  expect(next.sent.map(message => message.type)).toEqual(["CONNECTED", "WORKSPACE_REQUEST"]);
  next.answer(next.sent[1]); await vi.advanceTimersByTimeAsync(0);
  expect(next.sent.filter(message => message.op === "chats.list")).toHaveLength(1);
  expect(next.sent.some(message => message.type === "AGENT_PROMPT")).toBe(false);
  next.answer(next.sent.find(message => message.op === "chats.list")!); await queued;
});

it("backs off a failed cloud reconnect instead of spinning after the first immediate attempt", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  h.sockets[0].close(1006); await vi.advanceTimersByTimeAsync(0);
  expect(h.sockets).toHaveLength(2);
  h.sockets[1].close(1006); await vi.advanceTimersByTimeAsync(999);
  expect(h.sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(h.sockets).toHaveLength(3);
});

it.each(["Personal", "organization-local"])("keeps the existing Local reconnect ladder for %s", async () => {
  const h = fixture(true); await h.client.connect(); await h.ready(h.sockets[0]);
  h.sockets[0].close(1006); await vi.advanceTimersByTimeAsync(999);
  expect(h.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(h.sockets).toHaveLength(2);
  expect(h.refresh).not.toHaveBeenCalled();
});

it.each([true, false])("waits for the owning runtime handshake (local: %s)", async local => {
  const h = fixture(local);
  const settled = vi.fn();
  const waiting = h.client.waitUntilReady().then(settled);
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).not.toHaveBeenCalled();
  expect(h.sockets).toHaveLength(0);
  await h.client.connect();
  await h.ready(h.sockets[0]);
  await waiting;
  expect(settled).toHaveBeenCalledOnce();
});

it.each([true, false])("keeps readiness failures scoped to the runtime (local: %s)", async local => {
  const h = fixture(local);
  let failure: unknown;
  const waiting = h.client.waitUntilReady({ timeoutMs: 1000 }).catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(1000);
  await waiting;
  if (local) {
    expect(classifyRpcError(failure)).toMatchObject({
      kind: "transport-closed",
      message: expect.stringMatching(/local engine.*reconnecting/i),
    });
  } else {
    expect(failure).toMatchObject({ code: "cloud_actor_runtime_unavailable", status: 503 });
  }
});
