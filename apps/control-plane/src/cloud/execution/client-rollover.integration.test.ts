import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2ControlFrameSchema } from "../contract.js";
import { sealPortToken } from "../worker-port-token.js";
import { hashCloudV2Token } from "../tokens.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const feature = "client-token-rollover-v1";
database("in-place client authentication through the real router, PostgreSQL and socket", () => {
  let pool: pg.Pool, f: ExecutionFixture, server: Server, worker: WebSocketServer, url: string;
  let frames: any[], apps: WebSocket[];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 4000 }); });
  beforeEach(async () => {
    frames = []; apps = [];
    f = await executionFixture(pool, { relay: true });
    await f.activate(); expect((await f.hello()).status).toBe(200);
    f.viewer.authentication.tokenExpiresAt = Math.floor(Date.now() / 1000) + 300;
    worker = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
    worker.on("headers", headers => headers.push(`X-Zeros-Worker-Features: ${f.features}`));
    worker.on("connection", ws => ws.on("message", raw => frames.push(CloudV2ControlFrameSchema.parse(JSON.parse(String(raw))))));
    await new Promise<void>(resolve => worker.once("listening", resolve));
    await pool.query("UPDATE cloud_v2_workspaces SET worker_route_url=$2,worker_port_token=$3 WHERE id=$1", [f.workspace.id,
      `http://127.0.0.1:${(worker.address() as AddressInfo).port}`, sealPortToken("synthetic-port-token", f.workspace.id, f.keys)]);
    server = createServer();
    server.on("upgrade", (request, socket, head) => { if (!f.cp.relay!.handleUpgrade(request, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cloud/workspaces/${f.workspace.id}/bridge`;
  });
  afterEach(async () => {
    for (const ws of apps ?? []) ws.terminate();
    await f?.close();
    for (const ws of worker?.clients ?? []) ws.terminate();
    if (worker) await new Promise<void>(resolve => worker.close(() => resolve()));
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());
  const ticket = async (instance: string, user = f.viewer, negotiated = true) => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, user, {
      "X-Zeros-Team-Sharing": "1", ...(negotiated ? { "X-Zeros-Client-Features": feature, "X-Zeros-Client-Instance": instance } : {}),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const connect = async (negotiated = true, ticketNegotiated = negotiated) => {
    const instance = randomUUID(), grant = await ticket(instance, f.viewer, ticketNegotiated);
    const messages: any[] = [], closes: Array<{ code: number; reason: string }> = [];
    const count = frames.filter(value => value.t === "open").length;
    const ws = new WebSocket(url, [...grant.protocols, ...(negotiated ? [`zeros.cloud.v2.${feature}`] : [])]); apps.push(ws);
    ws.on("message", raw => messages.push(JSON.parse(String(raw))));
    ws.on("close", (code, reason) => closes.push({ code, reason: String(reason) }));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("unexpected-response", (_request, reply) => reject(new Error(`Bridge refused ${reply.statusCode}`))); });
    await expect.poll(() => frames.filter(value => value.t === "open").length).toBe(count + 1);
    return { ws, instance, messages, closes, open: frames.filter(value => value.t === "open").at(-1) };
  };
  const renewal = async (client: Awaited<ReturnType<typeof connect>>, instance = client.instance, user = f.viewer, rawTicket?: string) => {
    const id = randomUUID(), value = rawTicket ?? (await ticket(instance, user)).protocols[1].slice(7);
    client.ws.send(JSON.stringify({ type: "CLOUD_CONNECTION_RENEW", id, ticket: value }));
    await expect.poll(() => client.messages.find(message => message.requestId === id), { timeout: 3000 }).toBeDefined();
    return client.messages.find(message => message.requestId === id);
  };
  const context = async (id: string) => (await pool.query("SELECT * FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];

  it("renews the same socket and handle twice while a live child follows the parent token cap", async () => {
    const client = await connect();
    await expect.poll(() => client.messages.find(message => message.type === "CLOUD_CONNECTION_AUTH")).toBeDefined();
    const initial = client.messages.find(message => message.type === "CLOUD_CONNECTION_AUTH");
    expect(initial.expiresAt).toBe(f.viewer.authentication.tokenExpiresAt! * 1000);
    expect(initial.refreshAt).toBeLessThan(initial.retryUntil);
    expect(initial.retryUntil).toBeLessThan(initial.expiresAt);
    client.ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "write", op: "file.write" }));
    await expect.poll(() => frames.some(frame => frame.t === "frame" && frame.frame.id === "write")).toBe(true);
    const issued = await f.worker("client-lease", { clientId: client.open.clientId, requestId: "write", operation: "file.write" });
    expect(issued.status).toBe(200); const child = await issued.json();
    const before = await context(client.open.contextId);
    for (let index = 0; index < 2; index++) {
      f.viewer.authentication.tokenExpiresAt! += 300;
      const renewed = await renewal(client);
      expect(renewed).toMatchObject({ type: "CLOUD_CONNECTION_RENEWED", expiresAt: f.viewer.authentication.tokenExpiresAt! * 1000 });
      expect(renewed).not.toHaveProperty("error");
      const response = await f.worker("execution-leases/renew", { contextIds: [client.open.contextId, child.contextId] });
      expect(response.status).toBe(200);
      expect((await response.json()).leases.every((lease: any) => typeof lease.expiresAt === "number")).toBe(true);
      expect((await context(client.open.contextId)).client_token_expires_at.getTime()).toBe(renewed.expiresAt);
      expect((await context(child.contextId)).client_token_expires_at.getTime()).toBe(renewed.expiresAt);
    }
    const after = await context(client.open.contextId);
    expect(after.id).toBe(before.id); expect(after.client_id).toBe(before.client_id); expect(after.created_at).toEqual(before.created_at);
    expect(frames.filter(frame => frame.t === "open")).toHaveLength(1);
    expect(frames.some(frame => frame.t === "frame" && frame.frame.type === "CLOUD_CONNECTION_RENEW")).toBe(false);
    expect(client.ws.readyState).toBe(WebSocket.OPEN); expect(client.closes).toEqual([]);
  });

  it.each(["person", "session", "instance"])("refuses a rollover from another %s without changing the live handle", async mismatch => {
    const client = await connect(), before = await context(client.open.contextId);
    f.viewer.authentication.tokenExpiresAt! += 300;
    let session: string | null | undefined;
    if (mismatch === "session") {
      session = f.viewer.authentication.sessionId;
      const replacement = `session-${randomUUID()}`;
      await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status,provider_session_expires_at)
        SELECT provider,$2,provider_sub,user_id,client_kind,status,provider_session_expires_at FROM auth_sessions WHERE provider_session_id=$1`, [session, replacement]);
      f.viewer.authentication.sessionId = replacement;
    }
    try {
      const reply = await renewal(client, mismatch === "instance" ? randomUUID() : client.instance, mismatch === "person" ? f.creator : f.viewer);
      expect(reply).toMatchObject({ type: "CLOUD_CONNECTION_RENEWED", error: { code: "binding_changed" } });
    } finally { if (session !== undefined) f.viewer.authentication.sessionId = session; }
    expect((await context(client.open.contextId)).client_token_expires_at).toEqual(before.client_token_expires_at);
    expect(client.closes).toEqual([]);
  });

  it("requires a newer token and rejects replay or expiry of a single-use ticket", async () => {
    const client = await connect(), before = await context(client.open.contextId);
    expect(await renewal(client)).toMatchObject({ error: { code: "token_not_advanced" } });
    expect((await context(client.open.contextId)).client_token_expires_at).toEqual(before.client_token_expires_at);
    f.viewer.authentication.tokenExpiresAt! += 300;
    const raw = (await ticket(client.instance)).protocols[1].slice(7);
    expect(await renewal(client, client.instance, f.viewer, raw)).not.toHaveProperty("error");
    expect(await renewal(client, client.instance, f.viewer, raw)).toMatchObject({ error: { code: "invalid_ticket" } });
    const expired = (await ticket(client.instance)).protocols[1].slice(7);
    await pool.query("UPDATE cloud_v2_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hashCloudV2Token(expired)]);
    expect(await renewal(client, client.instance, f.viewer, expired)).toMatchObject({ error: { code: "invalid_ticket" } });
    expect(client.closes).toEqual([]);
  });

  it("never revives an expired child while advancing its still-live parent", async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "write", op: "file.write" }));
    await expect.poll(() => frames.some(frame => frame.t === "frame" && frame.frame.id === "write")).toBe(true);
    const child = await (await f.worker("client-lease", { clientId: client.open.clientId, requestId: "write", operation: "file.write" })).json();
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [child.contextId]);
    const before = await context(child.contextId);
    f.viewer.authentication.tokenExpiresAt! += 300;
    expect(await renewal(client)).not.toHaveProperty("error");
    expect((await context(child.contextId)).expires_at).toEqual(before.expires_at);
    expect((await context(child.contextId)).client_token_expires_at).toEqual(before.client_token_expires_at);
    const response = await f.worker("execution-leases/renew", { contextIds: [child.contextId, client.open.contextId] });
    expect(response.status).toBe(200);
    expect((await response.json()).leases).toEqual([{ contextId: child.contextId, refused: "expired" },
      { contextId: client.open.contextId, expiresAt: expect.any(Number) }]);
  });

  it("keeps the old deadline after a temporary rollover failure and retries with a new ticket", async () => {
    const client = await connect(), before = await context(client.open.contextId);
    f.viewer.authentication.tokenExpiresAt! += 300;
    vi.spyOn(f.cp.execution.clients, "rollover").mockRejectedValueOnce(new Error("synthetic temporary failure"));
    expect(await renewal(client)).toMatchObject({ error: { code: "temporarily_unavailable" } });
    expect((await context(client.open.contextId)).client_token_expires_at).toEqual(before.client_token_expires_at);
    expect(await renewal(client)).not.toHaveProperty("error");
    expect(client.closes).toEqual([]);
  });

  it("cuts a revoked session immediately even when it presents an unused renewal ticket", async () => {
    const client = await connect();
    f.viewer.authentication.tokenExpiresAt! += 300;
    const raw = (await ticket(client.instance)).protocols[1].slice(7);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    client.ws.send(JSON.stringify({ type: "CLOUD_CONNECTION_RENEW", id: randomUUID(), ticket: raw }));
    await expect.poll(() => client.closes).toEqual([{ code: 4001, reason: "access_revoked" }]);
    expect((await context(client.open.contextId)).state).not.toBe("active");
  });

  it("does not negotiate rollover with an old desktop", async () => {
    const client = await connect(false);
    expect(client.messages.some(message => message.type === "CLOUD_CONNECTION_AUTH")).toBe(false);
    expect((await context(client.open.contextId)).state).toBe("active");
  });

  it.each([[true, false], [false, true]])("requires both socket and ticket negotiation (%s/%s)", async (socketOptIn, ticketOptIn) => {
    const client = await connect(socketOptIn, ticketOptIn);
    expect(client.messages.some(message => message.type === "CLOUD_CONNECTION_AUTH")).toBe(false);
    expect((await context(client.open.contextId)).state).toBe("active");
  });

  it("binds only the exact feature to a valid per-open instance and a real session", async () => {
    const call = (features: string, instance?: string) => f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, {
      "X-Zeros-Team-Sharing": "1", "X-Zeros-Client-Features": features, ...(instance ? { "X-Zeros-Client-Instance": instance } : {}),
    });
    expect((await call(feature)).status).toBe(400);
    expect((await call(feature, "invalid")).status).toBe(400);
    const response = await call(`${feature}0`, randomUUID());
    expect(response.status).toBe(200);
    const value = await response.json(), raw = value.protocols[1].slice(7);
    const row = (await pool.query("SELECT execution_authority FROM cloud_v2_tokens WHERE token_hash=$1", [hashCloudV2Token(raw)])).rows[0];
    expect(row.execution_authority).not.toHaveProperty("clientInstanceId");
    f.viewer.authentication.sessionId = null;
    expect((await call(feature, randomUUID())).status).toBe(400);
  });

  it("does not acknowledge or revive a handle closed while rollover is waiting", async () => {
    const client = await connect();
    f.viewer.authentication.tokenExpiresAt! += 300;
    const raw = (await ticket(client.instance)).protocols[1].slice(7), id = randomUUID();
    const rollover = f.cp.execution.clients.rollover.bind(f.cp.execution.clients);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(f.cp.execution.clients, "rollover").mockImplementationOnce(async (...args) => {
      entered(); await held; return rollover(...args);
    });
    client.ws.send(JSON.stringify({ type: "CLOUD_CONNECTION_RENEW", id, ticket: raw }));
    await started;
    try {
      client.ws.close(1000);
      await expect.poll(async () => (await context(client.open.contextId)).state).toBe("retired");
    } finally { release(); }
    await expect(spy.mock.results[0]!.value).rejects.toMatchObject({ code: "actor_changed" });
    expect(client.messages.some(message => message.requestId === id)).toBe(false);
    expect((await context(client.open.contextId)).state).toBe("retired");
  });
});
