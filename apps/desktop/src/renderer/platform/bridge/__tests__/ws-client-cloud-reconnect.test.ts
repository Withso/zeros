import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeClientEnvironment, type RuntimeTransportSocket } from "../runtime-client";

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
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
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
  return { client, sockets, refresh, ready };
}

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
