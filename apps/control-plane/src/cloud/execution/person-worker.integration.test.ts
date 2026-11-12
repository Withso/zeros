import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { sealPortToken } from "../worker-port-token.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// This pin is separate from the phase-2/seed-proof clients: each feature is
// qualified against its own frozen worker before the combined PR is built.
const root = new URL(process.env.CLOUD_TEAM3A_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("per-person authority through the real worker and PostgreSQL", () => {
  let pool: pg.Pool, f: ExecutionFixture, config: any;
  let clients: { InboundBridge: any; ExecutionContexts: any; CloudWorker: any; FakeRelay: any; browserFrame: any };
  const cleanups: Array<() => void | Promise<void>> = [];
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 });
    clients = {
      ...await import(new URL("apps/cloud-worker/src/inbound-bridge.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/sharing/execution-contexts.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/worker.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/__tests__/worker-fixtures.ts", root).href),
    };
  });
  beforeEach(async () => {
    f = await executionFixture(pool); await f.activate();
    await f.cp.store.setWorkerRoute(f.workspace.id, "bx_fixture1234", "https://worker.example.test/",
      sealPortToken("synthetic-sync-port-token", f.workspace.id, f.keys));
    const response = await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) },
      { features: `${f.features},sync-v1,sync-context-v1` });
    expect(response.status).toBe(200); config = (await response.json()).config;
    await f.cp.loginChanges.stop();
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await f?.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());

  const post = async (path: string, body: unknown) => {
    const response = await f.worker(path, body), reply = await response.json();
    if (!response.ok) throw Object.assign(new Error("Worker route refused"), { status: response.status, contextCode: reply.error?.code });
    return reply;
  };
  const mac = async (user = f.viewer) => {
    const deviceId = randomUUID();
    const registered = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", {
      requestId: randomUUID(), name: "Fixture Mac", capabilities: ["local-commands-v1"],
    }, user);
    expect(registered.status).toBe(200);
    const { device } = await registered.json();
    const headers = { "x-zeros-device-id": deviceId, "x-zeros-device-registration": device.registrationId,
      "x-zeros-device-instance": device.instanceId };
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/macs/${deviceId}/connect`, "POST", {}, user, headers)).status).toBe(200);
    return { user, headers };
  };
  const grant = async (device: Awaited<ReturnType<typeof mac>>) => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/sync/grant`, "POST", {}, device.user, device.headers);
    expect(response.status).toBe(200);
    const reply = await response.json();
    return { ...reply, claims: JSON.parse(Buffer.from(reply.grant.split(".")[1], "base64url").toString()) };
  };
  const remove = async (oldWriter = false) => {
    if (!oldWriter) return withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    const old = await pool.connect();
    try {
      await old.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await old.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      expect((await old.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])).rowCount).toBe(1);
      await old.query("COMMIT");
    } finally { await old.query("ROLLBACK"); old.release(); }
  };
  const sockets = async () => {
    let clock: number | undefined, unavailable = false;
    const now = () => clock ?? Date.now();
    const requests: Array<{ path: string; body: any }> = [], frames: any[] = [];
    const contexts = new clients.ExecutionContexts({ now, post: async (path: string, body: unknown) => {
      requests.push({ path, body });
      if (unavailable) throw Object.assign(new Error("Fixture offline"), { status: 503 });
      return post(path, body);
    } });
    cleanups.push(() => contexts.dispose());
    await contexts.clean(async () => ({ processes: 0, legacyMaterial: "none" }));
    const bridge = new clients.InboundBridge({ workspaceId: f.workspace.id, bootId: f.boot, port: 0, publicKeys: f.workerPublicKeys,
      now, syncContexts: { required: () => true,
        admit: (id: string, user: string) => contexts.admitHandle(id, user),
        live: (id: string) => contexts.live(id),
        ended: (id: string, listener: () => void) => contexts.onEnd(id, listener), release: (id: string) => contexts.release(id) } });
    const address = await bridge.start(async (frame: unknown) => { frames.push(frame); });
    cleanups.push(() => bridge.dispose());
    const dial = (auth: string) => new Promise<{ ws: WebSocket; status: number; closed: Promise<number> }>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v2/worker/sync`, "zeros.worker.sync.v1", { headers: { "X-Zeros-Worker-Auth": auth } });
      const closed = new Promise<number>(done => ws.on("close", code => done(code)));
      ws.on("error", () => {});
      ws.on("unexpected-response", (_request, response) => { response.resume(); resolve({ ws, status: response.statusCode!, closed }); });
      ws.on("open", () => resolve({ ws, status: 101, closed }));
    });
    return { contexts, bridge, dial, frames, requests, now, clock: (value: number) => { clock = value; }, offline: () => { unavailable = true; } };
  };
  const read = (ws: WebSocket, id: string) => ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id, op: "sync.snapshot", params: {} }));

  it.each([false, true])("refuses a minted sync grant before any passive open/read after member loss (N-1 writer: %s)", async oldWriter => {
    const worker = await sockets(), lost = await grant(await mac()), peer = await grant(await mac(f.creator));
    expect(Object.keys(lost.claims).sort()).toEqual(["aud", "boot", "ctx", "dev", "exp", "iat", "iss", "jti", "scope", "sub"]);
    await remove(oldWriter);
    const refused = await worker.dial(lost.grant);
    expect(refused.status).toBe(101); read(refused.ws, "must-not-read");
    expect(await refused.closed).toBe(4001); expect(worker.frames).toEqual([]);
    const admitted = await worker.dial(peer.grant); expect(admitted.status).toBe(101); read(admitted.ws, "peer");
    await expect.poll(() => worker.frames.filter(frame => frame.t === "frame")).toHaveLength(1);
    expect(worker.frames.find(frame => frame.t === "frame").frame.id).toBe("peer");
    expect(worker.requests.filter(value => value.path.endsWith("/renew")).map(value => value.body.contextIds))
      .toEqual([[lost.claims.ctx], [peer.claims.ctx]]);
  });

  it("pushes only the departed person's handle and keeps the other socket reading", async () => {
    const worker = await sockets(), lost = await grant(await mac()), peer = await grant(await mac(f.creator));
    const first = await worker.dial(lost.grant), second = await worker.dial(peer.grant);
    await expect.poll(() => worker.frames.filter(frame => frame.t === "open")).toHaveLength(2);
    await remove();
    await f.cp.execution.maintenance.publish(f.workspace.id, async (_id, frames) => {
      for (const frame of frames) worker.contexts.revoke(frame.contextId, frame.reason);
    });
    expect(await first.closed).toBe(4001);
    expect(worker.contexts.live(peer.claims.ctx)).toBe(true);
    read(second.ws, "surviving-peer");
    await expect.poll(() => worker.frames.some(frame => frame.t === "frame" && frame.frame.id === "surviving-peer")).toBe(true);
  });

  it("ends an offline handle at its lease deadline, without forwarding a later read", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const worker = await sockets(), signed = await grant(await mac());
    const socket = await worker.dial(signed.grant);
    await expect.poll(() => worker.frames.filter(frame => frame.t === "open")).toHaveLength(1);
    const deadline = worker.contexts.expiresAt(signed.claims.ctx);
    const start = worker.now(); expect(deadline - start).toBeLessThanOrEqual(30_000);
    await remove(true); worker.offline();
    for (let time = start; time < deadline;) {
      const elapsed = Math.min(1000, deadline - time); time += elapsed;
      worker.clock(time); await vi.advanceTimersByTimeAsync(elapsed);
    }
    read(socket.ws, "expired-read");
    await expect.poll(() => socket.ws.readyState).toBe(WebSocket.CLOSED);
    expect(await socket.closed).toBe(4001);
    expect(worker.frames.filter(frame => frame.t === "frame")).toEqual([]);
  });

  it("honors a shortened lease deadline between renewal ticks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const worker = await sockets(), signed = await grant(await mac());
    await pool.query("UPDATE cloud_v2_execution_contexts SET client_token_expires_at=clock_timestamp()+interval '25 seconds' WHERE id=$1", [signed.claims.ctx]);
    const socket = await worker.dial(signed.grant);
    await expect.poll(() => worker.frames.filter(frame => frame.t === "open")).toHaveLength(1);
    const deadline = worker.contexts.expiresAt(signed.claims.ctx), start = worker.now();
    expect(deadline - start).toBeLessThanOrEqual(25_000);
    expect(deadline - start).toBeGreaterThan(20_000);
    await remove(true); worker.offline();
    for (let time = start; time < deadline;) {
      const elapsed = Math.min(1000, deadline - time); time += elapsed;
      worker.clock(time); await vi.advanceTimersByTimeAsync(elapsed);
    }
    read(socket.ws, "expired-read");
    await expect.poll(() => socket.ws.readyState).toBe(WebSocket.CLOSED);
    expect(await socket.closed).toBe(4001);
    expect(worker.frames.filter(frame => frame.t === "frame")).toEqual([]);
  });

  it("records code-review mutations with each requester's client lease after Creator departure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "person-review-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const checkout = join(directory, "checkout"), home = join(directory, "home"), state = join(directory, "state");
    await mkdir(checkout); await mkdir(home); await mkdir(state);
    execFileSync("git", ["init", "-q", "-b", "main", checkout]);
    await writeFile(join(checkout, "example.ts"), "original\n");
    const relay = new clients.FakeRelay(), refused: string[] = [];
    relay.contextRequest = async (path: string, body: unknown) => {
      try { return await post(path, body); }
      catch (error) { refused.push(`${path}:${(error as { contextCode?: string }).contextCode}`); throw error; }
    };
    const worker = new clients.CloudWorker({ directory: state, homeDirectory: home, sharedMemory: join(directory, "shm"),
      workspaceId: f.workspace.id, transport: relay, bootClean: async () => 0, prepareCheckout: async () => {},
      workspaceServices: { watch: false } });
    cleanups.push(() => worker.dispose());
    worker.start(); await relay.receive({ ...config, workspace: { ...config.workspace, checkoutPath: checkout } });
    const open = async (user = f.viewer) => {
      const ticket = await f.cp.execution.clients.ticket(f.workspace.id, user, false);
      const grant = await f.cp.store.consumeConnectTicket(ticket.token, f.workspace.id);
      expect(grant).not.toBeNull();
      const clientId = randomUUID(), context = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
      await relay.receive({ t: "open", clientId, userId: user.id, contextId: context.contextId });
      return { clientId, context };
    };
    const first = await open(), second = await open(f.admin);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const op = async (client: typeof first, op: string, params: unknown) => {
      const request = clients.browserFrame("WORKSPACE_REQUEST", { op, params });
      await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, request);
      await relay.request(client.clientId, request);
      const reply = relay.response(request.id);
      expect(reply, `${reply?.code ?? ""}: ${reply?.message ?? ""}; ${refused.join(",")}`).toMatchObject({ type: "WORKSPACE_RESPONSE" });
      return reply.result;
    };
    const thread = await op(first, "codeReview.create", { workspaceId: f.workspace.id, body: "First person",
      anchor: { path: "example.ts", side: "new", startLine: 1, endLine: 1, revision: "sha256:original" } });
    expect(thread.comments[0].author).toMatchObject({ id: `human:${f.viewer.id}`, kind: "human" });
    const replied = await op(second, "codeReview.reply", { workspaceId: f.workspace.id, threadId: thread.id, body: "Second person" });
    expect(replied.comments[1].author).toMatchObject({ id: `human:${f.admin.id}`, kind: "human" });
    const resolved = await op(first, "codeReview.setResolved", { workspaceId: f.workspace.id, threadId: thread.id, resolved: true, expectedVersion: replied.version });
    expect(resolved.resolved).toBe(true);
  });
});
