import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2ControlFrameSchema } from "../contract.js";
import { CLOUD_V2_BRIDGE_PROTOCOL } from "../relay.js";
import { sealPortToken } from "../worker-port-token.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("activated relay authority through real sockets, routes and PostgreSQL", () => {
  let pool: pg.Pool, f: ExecutionFixture, server: Server, worker: WebSocketServer, url: string;
  let frames: any[], apps: WebSocket[];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 4000 }); });
  beforeEach(async () => {
    frames = []; apps = [];
    f = await executionFixture(pool, { relay: true });
    await f.login(); await f.login(f.viewer); await f.activate(); expect((await f.hello()).status).toBe(200);
    worker = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
    worker.on("headers", headers => headers.push(`X-Zeros-Worker-Features: ${f.features}`));
    worker.on("connection", (ws, request) => {
      expect(request.url).toBe("/v2/worker/bridge");
      expect(request.headers.cookie).toBe("_port_auth=synthetic-port-token");
      expect(request.headers["x-zeros-worker-auth"]).toBeTypeOf("string");
      ws.on("message", raw => frames.push(CloudV2ControlFrameSchema.parse(JSON.parse(String(raw)))));
    });
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
  const connect = async (user = f.viewer) => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, user, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const { protocols } = await response.json();
    expect(protocols[0]).toBe(CLOUD_V2_BRIDGE_PROTOCOL);
    const count = frames.filter(value => value.t === "open").length;
    const ws = new WebSocket(url, protocols); apps.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("unexpected-response", (_request, reply) => reject(new Error(`Bridge refused ${reply.statusCode}`))); });
    await expect.poll(() => frames.filter(value => value.t === "open").length).toBe(count + 1);
    return { ws, open: frames.filter(value => value.t === "open").at(-1) };
  };
  const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>(resolve => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));

  it("authors member identity, fences forwarded mutations and refuses legacy sends", async () => {
    const { ws, open } = await connect();
    expect(open).toMatchObject({ userId: f.viewer.id, contextId: expect.any(String) });
    expect(frames.find(value => value.t === "config")).toMatchObject({ actingUser: 1, notifyUser: 1, agents: {} });
    const request = { type: "WORKSPACE_REQUEST", id: "change", op: "file.write", params: { path: "fixture", content: "fixture" }, userId: f.creator.id };
    ws.send(JSON.stringify(request));
    await expect.poll(() => frames.some(value => value.t === "frame" && value.frame.id === request.id)).toBe(true);
    const lease = await f.worker("client-lease", { clientId: open.clientId, requestId: request.id, operation: request.op });
    expect(lease.status).toBe(200); expect(await lease.json()).toMatchObject({ userId: f.viewer.id });
    const reply = new Promise<any>(resolve => ws.once("message", raw => resolve(JSON.parse(String(raw)))));
    ws.send(JSON.stringify({ type: "AGENT_PROMPT", id: "legacy", sessionId: "native" }));
    expect(await reply).toMatchObject({ type: "AGENT_ERROR", requestId: "legacy", code: "client_update_required" });
    expect(frames.some(value => value.t === "frame" && value.frame.id === "legacy")).toBe(false);
  });

  it("uses a retryable close for unknown repository authority, never revocation", async () => {
    const { ws } = await connect(), ending = closed(ws);
    f.unavailable.add(f.viewer.id);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '1 hour' WHERE owner_user_id=$1", [f.viewer.id]);
    f.cp.execution.deps.authority.source.invalidate();
    f.cp.relay!.revalidateSources({ ownerUserId: f.viewer.id });
    expect(await ending).toEqual({ code: 1013, reason: "workspace_verification_unavailable" });
  });

  it("ends a desktop connection cleanly at token end and keeps its terminal for the same person", async () => {
    f.viewer.authentication.tokenExpiresAt = Math.floor(Date.now() / 1000) + 29;
    let tokenDeadline: { end: () => void; at: number } | undefined;
    const timeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
      if (ms >= 25_000 && ms <= 28_000) tokenDeadline = { end: callback, at: Date.now() + ms };
      return timeout(callback, ms, ...args);
    }) as typeof setTimeout);
    const { ws, open } = await connect(), ending = closed(ws);
    ws.send(JSON.stringify({ type: "PTY_CREATE", id: "terminal-open", sessionId: "terminal" }));
    await expect.poll(() => frames.some(value => value.t === "frame" && value.frame.id === "terminal-open")).toBe(true);
    const result = await f.worker("terminal-lease", { clientId: open.clientId, requestId: "terminal-open", terminalId: "terminal" });
    expect(result.status).toBe(200); const terminal = await result.json();
    expect(tokenDeadline).toBeDefined();
    vi.spyOn(Date, "now").mockReturnValue(tokenDeadline!.at);
    tokenDeadline!.end();
    expect(await ending).toEqual({ code: 1000, reason: "token_end" });
    f.viewer.authentication.tokenExpiresAt += 300;
    const next = await connect();
    next.ws.send(JSON.stringify({ type: "PTY_CREATE", id: "terminal-reattach", sessionId: "terminal" }));
    await expect.poll(() => frames.some(value => value.t === "frame" && value.frame.id === "terminal-reattach")).toBe(true);
    const reattached = await f.worker("terminal-lease", { clientId: next.open.clientId, requestId: "terminal-reattach", terminalId: "terminal" });
    expect(reattached.status).toBe(200); expect((await reattached.json()).contextId).toBe(terminal.contextId);
  });

  it("pushes person revocation without a desktop room, credentials or a wake", async () => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    const before = (await pool.query("SELECT active_at,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await expect.poll(() => frames.some(value => value.t === "revoke-context" && value.contextId === turn.begun.contextId), { timeout: 5000 }).toBe(true);
    expect(frames).toContainEqual({ t: "revoke-context", contextId: turn.begun.contextId, reason: "access_revoked" });
    expect(frames.some(value => value.t === "config" || value.t === "open")).toBe(false);
    expect((await pool.query("SELECT active_at,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
  });

  it("pushes revocation past a full page of older cleanup barriers", async () => {
    await pool.query(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,client_id,
      access_epoch,stop_generation,worker_boot_id,worker_token_hash,authority,source_fingerprint,expires_at,state,reason)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,w.id,w.org_id,$2,'client',gen_random_uuid(),
        w.access_epoch,w.stop_generation,w.worker_boot_id,w.worker_token_hash,'{}',repeat('a',64),now(),'revoked','client_closed'
      FROM cloud_v2_workspaces w CROSS JOIN generate_series(1,129) n WHERE w.id=$1`, [f.workspace.id, f.viewer.id]);
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='revoked' AND id<$2",
      [f.workspace.id, turn.begun.contextId])).rows[0].n).toBe(129);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await expect.poll(() => frames.some(value => value.t === "revoke-context" && value.contextId === turn.begun.contextId), { timeout: 2000 }).toBe(true);
  });

  it("revokes only the signed-out person's live client and terminal", async () => {
    const member = await connect(), owner = await connect(f.creator), ending = closed(member.ws);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    f.cp.relay!.revalidateSources({ ownerUserId: f.viewer.id });
    expect(await ending).toEqual({ code: 4001, reason: "access_revoked" });
    owner.ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "owner-read", op: "chats.list" }));
    await expect.poll(() => frames.some(value => value.t === "frame" && value.frame.id === "owner-read")).toBe(true);
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  });
});
