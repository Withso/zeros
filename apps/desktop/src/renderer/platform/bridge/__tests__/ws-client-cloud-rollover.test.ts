import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLIENT_TOKEN_ROLLOVER_PROTOCOL } from "@zeros/protocol/cloud-v2-relay";
import { RuntimeClient, type RuntimeClientEnvironment, type RuntimeTransportSocket } from "../runtime-client";
import { resetCloudConnectBackoffForTests } from "../cloud-connect-backoff";

// §14.7: the desktop rolls its client token over on the SAME socket before the relay's deadline.
class Socket implements RuntimeTransportSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: RuntimeTransportSocket["onopen"] = null;
  onclose: RuntimeTransportSocket["onclose"] = null;
  onmessage: RuntimeTransportSocket["onmessage"] = null;
  onerror: RuntimeTransportSocket["onerror"] = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen?.({} as Event); }
  close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason } as CloseEvent); }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  answer(request: Record<string, any>) {
    this.frame({ id: `reply-${request.id}`, timestamp: Date.now(), source: "engine",
      type: "WORKSPACE_RESPONSE", requestId: request.id, op: request.op, result: { workspaces: [] } });
  }
  renewals() { return this.sent.filter(message => message.type === "CLOUD_CONNECTION_RENEW"); }
}

const clients: RuntimeClient[] = [];
const ticket = (n: number) => `zw2c_${String(n).padStart(43, "t")}`;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetCloudConnectBackoffForTests(); vi.spyOn(Math, "random").mockReturnValue(1); });
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(options: { renew?: boolean } = {}) {
  const sockets: Socket[] = [], offers: Array<string[] | undefined> = [];
  const target = {
    kind: "cloud" as const, channel: "v2-websocket" as const,
    runtimeId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333", engineInstanceId: "44444444-4444-4444-8444-444444444444",
    generation: 1, authorityEpoch: 1, connectionSequence: 1, expiresAt: Date.now() + 60_000,
    url: "wss://api.example.test/v2/cloud/workspaces/33333333-3333-4333-8333-333333333333/bridge",
    protocols: ["zeros.cloud.v2", `ticket.${ticket(0)}`] as ["zeros.cloud.v2", string],
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const environment: RuntimeClientEnvironment = {
    controlPlaneOrigin: "https://api.example.test", allowHttpLoopback: false,
    createWebSocket: (_url, protocols) => { offers.push(protocols); const socket = new Socket(); sockets.push(socket); return socket as unknown as globalThis.WebSocket; },
    resolveEnginePort: async () => 29920, resolveEngineToken: async () => "synthetic",
    invalidateEnginePort() {}, invalidateEngineToken() {}, getAuthAccessToken: () => null, logger,
  };
  const refresh = vi.fn(async (current: any) => ({ ...current, connectionSequence: current.connectionSequence + 1, expiresAt: Date.now() + 60_000 }));
  let minted = 0;
  // Each mint presents a bearer that expires 5 min after it was minted.
  const renew = vi.fn(async (_notExpiringBefore: number) => ({ ticket: ticket(++minted), tokenExpiresAt: Date.now() + 300_000 }));
  const client = new RuntimeClient(target, { environment, refreshCloudConnectionTarget: refresh,
    ...(options.renew === false ? {} : { renewCloudConnectionTicket: renew }) });
  clients.push(client);
  const ready = async (socket: Socket) => {
    socket.open(); socket.answer(socket.sent.find(message => message.op === "workspace.list")!);
    await vi.advanceTimersByTimeAsync(0); expect(client.status).toBe("connected");
  };
  const auth = (socket: Socket, expiresIn = 300_000) => {
    const now = Date.now();
    socket.frame({ type: "CLOUD_CONNECTION_AUTH", expiresAt: now + expiresIn, refreshAt: now + 0.6 * expiresIn, retryUntil: now + 0.9 * expiresIn });
    return now + expiresIn;
  };
  return { client, sockets, offers, refresh, renew, ready, auth, logger };
}

it("offers the rollover subprotocol only when it can renew", async () => {
  const h = fixture(); await h.client.connect();
  expect(h.offers[0]).toContain(CLIENT_TOKEN_ROLLOVER_PROTOCOL);
  const old = fixture({ renew: false }); await old.client.connect();
  expect(old.offers[0]).not.toContain(CLIENT_TOKEN_ROLLOVER_PROTOCOL);
});

it("renews on the same socket at refreshAt with a bearer newer than the AUTH expiry, then re-arms from the reply", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  const expiresAt = h.auth(h.sockets[0]);
  await vi.advanceTimersByTimeAsync(179_999); expect(h.renew).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.renew).toHaveBeenCalledExactlyOnceWith(expiresAt + 1_000);
  const [renewal] = h.sockets[0].renewals();
  expect(renewal).toEqual({ type: "CLOUD_CONNECTION_RENEW", id: expect.stringMatching(/^[0-9a-f-]{36}$/), ticket: ticket(1) });
  const now = Date.now();
  h.sockets[0].frame({ type: "CLOUD_CONNECTION_RENEWED", requestId: renewal.id, expiresAt: now + 300_000, refreshAt: now + 180_000, retryUntil: now + 270_000 });
  await vi.advanceTimersByTimeAsync(179_999); expect(h.renew).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(h.renew).toHaveBeenCalledTimes(2);
  expect(h.sockets).toHaveLength(1); expect(h.refresh).not.toHaveBeenCalled(); expect(h.client.status).toBe("connected");
  for (const call of [...h.logger.warn.mock.calls, ...h.logger.error.mock.calls]) expect(JSON.stringify(call)).not.toContain("zw2c_");
});

it("retries a temporary refusal with backoff, single flight, and stops at retryUntil without closing", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  h.auth(h.sockets[0]);
  await vi.advanceTimersByTimeAsync(180_000);
  const refuse = () => { const last = h.sockets[0].renewals().at(-1)!; h.sockets[0].frame({ type: "CLOUD_CONNECTION_RENEWED", requestId: last.id, error: { code: "temporarily_unavailable" } }); };
  refuse(); await vi.advanceTimersByTimeAsync(1_999); expect(h.sockets[0].renewals()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(h.sockets[0].renewals()).toHaveLength(2);
  for (let index = 0; index < 20; index++) { refuse(); await vi.advanceTimersByTimeAsync(20_000); }
  const sent = h.sockets[0].renewals().length;
  expect(Date.now()).toBeGreaterThan(1_000_000 + 270_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sockets[0].renewals()).toHaveLength(sent);
  expect(h.sockets[0].readyState).toBe(1); expect(h.sockets).toHaveLength(1);
});

it("after a dropped ACK, the next attempt asks for a bearer newer than the one it already presented", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  const expiresAt = h.auth(h.sockets[0]);
  await vi.advanceTimersByTimeAsync(180_000);
  const presented = Date.now() + 300_000;
  expect(h.renew).toHaveBeenLastCalledWith(expiresAt + 1_000);
  // No reply: the ACK timeout retries, and the server may already hold the presented bearer.
  await vi.advanceTimersByTimeAsync(10_000 + 2_000);
  expect(h.renew).toHaveBeenCalledTimes(2);
  expect(h.renew).toHaveBeenLastCalledWith(Math.max(expiresAt, presented) + 1_000);
});

it("stops on binding_changed and mints a new ticket after invalid_ticket", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  h.auth(h.sockets[0]); await vi.advanceTimersByTimeAsync(180_000);
  let last = h.sockets[0].renewals().at(-1)!;
  h.sockets[0].frame({ type: "CLOUD_CONNECTION_RENEWED", requestId: last.id, error: { code: "invalid_ticket" } });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sockets[0].renewals().map(frame => frame.ticket)).toEqual([ticket(1), ticket(2)]);
  last = h.sockets[0].renewals().at(-1)!;
  h.sockets[0].frame({ type: "CLOUD_CONNECTION_RENEWED", requestId: last.id, error: { code: "binding_changed" } });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.sockets[0].renewals()).toHaveLength(2);
});

it("cancels on close and ignores a reply for another request or a replaced socket", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  h.auth(h.sockets[0]); await vi.advanceTimersByTimeAsync(180_000);
  const first = h.sockets[0].renewals()[0]!;
  h.sockets[0].frame({ type: "CLOUD_CONNECTION_RENEWED", requestId: "99999999-9999-4999-8999-999999999999", expiresAt: Date.now() + 1, refreshAt: Date.now() + 1, retryUntil: Date.now() + 1 });
  h.sockets[0].close(1006); await vi.advanceTimersByTimeAsync(0);
  h.sockets[0].frame({ type: "CLOUD_CONNECTION_RENEWED", requestId: first.id, expiresAt: Date.now() + 300_000, refreshAt: Date.now() + 1_000, retryUntil: Date.now() + 2_000 });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.renew).toHaveBeenCalledOnce();
  // A socket closed before refreshAt never renews.
  const g = fixture(); await g.client.connect(); await g.ready(g.sockets[0]);
  g.auth(g.sockets[0]); g.sockets[0].close(1006); await vi.advanceTimersByTimeAsync(300_000);
  expect(g.renew).not.toHaveBeenCalled();
  // Dispose (account switch retires the client) cancels a pending rollover too.
  const d = fixture(); await d.client.connect(); await d.ready(d.sockets[0]);
  d.auth(d.sockets[0]); d.client.dispose(); await vi.advanceTimersByTimeAsync(300_000);
  expect(d.renew).not.toHaveBeenCalled();
});

it("an old relay (no AUTH frame) schedules nothing, and rollover frames never reach bridge listeners", async () => {
  const h = fixture(); await h.client.connect(); await h.ready(h.sockets[0]);
  const seen = vi.fn(); h.client.on("CLOUD_CONNECTION_AUTH", seen); h.client.on("CLOUD_CONNECTION_RENEWED", seen);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(h.renew).not.toHaveBeenCalled();
  h.auth(h.sockets[0]);
  expect(seen).not.toHaveBeenCalled();
});

it("labels an ENGINE_READY re-sent on an already ready socket as a repeat in diagnostics", async () => {
  const h = fixture(); void h.client.connect(); await vi.advanceTimersByTimeAsync(0);
  const socket = h.sockets[0]!; await h.ready(socket);
  const readies = () => h.logger.warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes("\"event\":\"ready\""));
  expect(readies()).toHaveLength(1);
  expect(readies()[0]).not.toContain("repeat");
  socket.frame({ id: "r2", timestamp: Date.now(), source: "engine", type: "ENGINE_READY", capabilities: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(readies()).toHaveLength(2);
  expect(readies()[1]).toContain("\"repeat\":1");
  expect(h.client.status).toBe("connected");
  // A new socket's first ready is not a repeat.
  socket.close(1013); await vi.advanceTimersByTimeAsync(60_000);
  const next = h.sockets.at(-1)!; if (next !== socket) { await h.ready(next); expect(readies().at(-1)).not.toContain("repeat"); }
});
