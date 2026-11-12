import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2WorkerSigner } from "../worker-auth.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// The signed carrier must participate: its local routing ids differ from the
// control-plane ids that authorize the durable operation receipts.
const root = new URL(process.env.CLOUD_EXECUTION_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("client lease authority through the signed worker carrier", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  let clients: { InboundBridge: any; CloudWorker: any; FakeRelay: any; FakeDriver: any; browserFrame: any };
  const cleanups: Array<() => void | Promise<void>> = [];
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 });
    clients = {
      ...await import(new URL("apps/cloud-worker/src/inbound-bridge.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/worker.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/__tests__/worker-fixtures.ts", root).href),
    };
  });
  beforeEach(async () => {
    f = await executionFixture(pool);
    await f.cp.loginChanges.start();
    await f.activate();
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());

  const setup = async (turns = false) => {
    const hello = await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) });
    expect(hello.status).toBe(200);
    const config = (await hello.json()).config;
    const directory = await mkdtemp(join(tmpdir(), "relay-authority-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const checkout = join(directory, "checkout"), home = join(directory, "home"), state = join(directory, "state");
    await mkdir(checkout); await mkdir(home); await mkdir(state);
    execFileSync("git", ["init", "-q", "-b", "main", checkout]);
    const key = generateKeyPairSync("ed25519");
    const signer = new CloudV2WorkerSigner(key.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    const relay = new clients.FakeRelay();
    const calls: Array<{ path: string; body: any; status: number; code?: string }> = [];
    relay.contextRequest = async (path: string, body: unknown) => {
      const response = await f.worker(path, body), reply = await response.json();
      calls.push({ path, body, status: response.status, ...(reply.error ? { code: reply.error.code } : {}) });
      if (!response.ok) throw Object.assign(new Error("Context refused"), { status: response.status, contextCode: reply.error?.code });
      return reply;
    };
    if (turns) relay.promptRequest = async (operation: string, body: unknown, signal?: AbortSignal) => {
      const response = await f.app.request(`/v2/cloud/worker/prompts/${operation}`, { method: "POST", signal,
        headers: { authorization: `Bearer ${f.token}`, "x-zeros-worker-boot": f.boot,
          "x-zeros-worker-features": f.features, "content-type": "application/json" }, body: JSON.stringify(body) });
      const reply = await response.json();
      if (!response.ok) throw Object.assign(new Error("Prompt refused"), { status: response.status, contextCode: reply.error?.code });
      return reply;
    };
    const incoming: any[] = [];
    const bridge = new clients.InboundBridge({ workspaceId: f.workspace.id, bootId: f.boot, port: 0, publicKeys: signer.publicKeys });
    const address = await bridge.start(async (frame: unknown) => { incoming.push(frame); await relay.receive(frame); });
    cleanups.push(() => bridge.dispose());
    relay.send = async (frame: any) => {
      relay.frames.push(structuredClone(frame));
      return frame.t === "frame" || frame.t === "stop-ack" ? bridge.send(frame) : true;
    };
    const drivers: any[] = [];
    const worker = new clients.CloudWorker({ directory: state, homeDirectory: home, sharedMemory: join(directory, "shm"),
      workspaceId: f.workspace.id, transport: relay, bootClean: async () => 0, prepareCheckout: async () => {},
      drivers: { claude: () => { const driver = new clients.FakeDriver(); drivers.push(driver); return driver; } },
      workspaceServices: { watch: false } });
    cleanups.push(() => worker.dispose());
    worker.start();
    await relay.receive({ ...config, workspace: { ...config.workspace, checkoutPath: checkout } });
    const open = async (user = f.creator, clientId = randomUUID()) => {
      const ticket = await f.cp.execution.clients.ticket(f.workspace.id, user, false);
      const grant = await f.cp.store.consumeConnectTicket(ticket.token, f.workspace.id);
      expect(grant).not.toBeNull();
      const handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v2/worker/bridge`, "zeros.cloud.v2.worker", {
        headers: { "X-Zeros-Worker-Auth": signer.mint(f.workspace.id, f.boot) },
      });
      socket.on("error", () => {});
      const frames: any[] = [];
      socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
      await once(socket, "open");
      cleanups.push(() => socket.terminate());
      socket.send(JSON.stringify({ t: "open", clientId, userId: user.id, contextId: handle.contextId }));
      await expect.poll(() => frames.some(frame => frame.t === "frame" && frame.frame.type === "ENGINE_READY")).toBe(true);
      const send = async (frame: unknown) => {
        await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, frame);
        socket.send(JSON.stringify({ t: "frame", clientId, frame }));
      };
      return { clientId, handle, socket, frames, send };
    };
    return { calls, incoming, checkout, open, drivers };
  };

  it("leases a terminal using the opener id recorded before the carrier remaps it", async () => {
    const worker = await setup(), client = await worker.open();
    const frame = clients.browserFrame("PTY_CREATE", { workspaceId: f.workspace.id, cwd: worker.checkout,
      sessionId: randomUUID(), cols: 80, rows: 24 });
    await client.send(frame);
    await expect.poll(() => worker.calls.find(call => call.path === "terminal-lease")).toBeDefined();
    const lease = worker.calls.find(call => call.path === "terminal-lease")!;
    expect(lease, lease.code).toMatchObject({ status: 200, body: { clientId: client.clientId, requestId: frame.id, terminalId: frame.sessionId } });
    const local = worker.incoming.find(value => value.t === "open");
    expect(local.clientId).not.toBe(client.clientId);
    const row = (await pool.query("SELECT user_id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='terminal'", [f.workspace.id])).rows;
    expect(row).toEqual([{ user_id: f.creator.id }]);
  });

  it("leases file mutations by authority id while equal carrier ids keep their replies separate", async () => {
    const worker = await setup(), clientId = randomUUID();
    const first = await worker.open(f.creator, clientId), second = await worker.open(f.viewer, clientId);
    const requests = [clients.browserFrame("WORKSPACE_REQUEST", { op: "file.write", params: { path: "first.txt", content: "first" } }),
      clients.browserFrame("WORKSPACE_REQUEST", { op: "file.write", params: { path: "second.txt", content: "second" } })];
    await first.send(requests[0]); await second.send(requests[1]);
    await expect.poll(() => worker.calls.filter(call => call.path === "client-lease")).toHaveLength(2);
    const leases = worker.calls.filter(call => call.path === "client-lease");
    expect(leases, leases.map(call => call.code).join(",")).toEqual(expect.arrayContaining(requests.map(frame => expect.objectContaining({
      status: 200, body: { clientId, requestId: frame.id, operation: "file.write" },
    }))));
    for (const [client, request] of [[first, requests[0]], [second, requests[1]]] as const) {
      await expect.poll(() => client.frames.find(value => value.frame?.requestId === request.id)?.frame.type).toBe("WORKSPACE_RESPONSE");
    }
    expect(first.frames.some(value => value.frame?.requestId === requests[1].id)).toBe(false);
    expect(second.frames.some(value => value.frame?.requestId === requests[0].id)).toBe(false);
    expect(new Set(worker.incoming.filter(value => value.t === "open").map(value => value.clientId)).size).toBe(2);
    expect(await readFile(join(worker.checkout, "first.txt"), "utf8")).toBe("first");
    expect(await readFile(join(worker.checkout, "second.txt"), "utf8")).toBe("second");
  });

  it("delivers a durable turn hint and its named actor through the signed carrier", async () => {
    const login = await f.login();
    const worker = await setup(true), client = await worker.open();
    const prompt = f.prompt();
    expect((await f.send(prompt)).status).toBe(201);
    client.socket.send(JSON.stringify({ t: "prompts" }));
    await expect.poll(() => worker.drivers[0]?.prompts.length).toBe(1);
    await expect.poll(() => client.frames.some(value => value.frame?.type === "AGENT_SESSION_UPDATE" &&
      value.frame.notification.update.sessionUpdate === "turn_state" && value.frame.notification.update.state === "running" &&
      value.frame.notification.update.actingUserId === f.creator.id)).toBe(true);
    const contexts = (await pool.query("SELECT user_id,credential_id,state FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rows;
    expect(contexts).toEqual([{ user_id: f.creator.id, credential_id: login.id, state: "active" }]);
    expect(worker.calls.find(call => call.path === "turn-lease")?.status).toBe(200);
    worker.drivers[0].complete();
    await expect.poll(async () => (await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
      [f.workspace.id, prompt.userMessageId])).rows[0]?.state).toBe("completed");
  });
});
