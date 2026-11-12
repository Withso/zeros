import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { brokerRequest } from "../credentials/client";
import { operationEnvironment } from "../sharing/operation-environment";
import { CloudWorker } from "../worker";
import { CLIENT_A, CLIENT_B, FakeDriver, FakeRelay, WORKSPACE_ID, browserFrame, config } from "./worker-fixtures";

/** Team sharing slice B: an activated workspace runs each turn as its CP-chosen person, from a lease. */
const ALEX = "44444444-4444-4444-8444-444444444444", SAM = "55555555-5555-4555-8555-555555555555";
const directories: string[] = [], workers: CloudWorker[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workers.splice(0).map(worker => worker.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const until = (read: () => unknown) => expect.poll(read, { timeout: 2000, interval: 5 });
const delivery = (sender: string, chatId = "chat", sequence = "1") => {
  const id = randomUUID();
  return { receipt: { workspaceId: WORKSPACE_ID, chatId, userMessageId: id, epoch: "0", sequence, acceptedAt: new Date(0).toISOString(), workspaceState: "running" as const },
    deliveryId: randomUUID(), senderUserId: sender,
    payload: { chatId, userMessageId: id, agentId: "claude" as const, model: "claude-opus-4-8", effort: "low", prompt: [{ type: "text" as const, text: "ok" }], startedAt: 1,
      mode: undefined as "steer" | undefined } };
};
type Delivery = ReturnType<typeof delivery>;

class ActingRelay extends FakeRelay {
  queued: Array<{ prompts: Delivery[]; stops: [] }> = [];
  calls: Array<{ op: string; body: any }> = [];
  senders = new Map<string, string>();   // userMessageId -> sender
  generation = 0; lastUser?: string;
  beginReply?: (body: any) => unknown;
  leaseReply?: (body: any) => unknown;
  waiting?: (batch: { prompts: Delivery[]; stops: [] }) => void;
  authorizations: unknown[][] = [];
  clientUsers = new Map<string, string>();
  mcpAuthorization = async (...args: unknown[]) => {
    this.authorizations.push(args.filter(arg => !(arg instanceof AbortSignal)));
    throw Object.assign(new Error("sign in"), { code: "mcp_auth_required" });
  };
  async promptRequest(op: string, body: any, signal?: AbortSignal): Promise<any> {
    this.calls.push({ op, body });
    if (op === "pull") {
      if (this.queued.length) return this.queued.shift();
      if (body.waitMs === 0) return { prompts: [], stops: [] };
      return new Promise((resolve, reject) => {
        const abort = () => { this.waiting = undefined; reject(new DOMException("Aborted", "AbortError")); };
        this.waiting = batch => { signal?.removeEventListener("abort", abort); resolve(batch); };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (op === "ack") return { state: "inboxed" };
    if (op === "begin") {
      const custom = this.beginReply?.(body);
      if (custom !== undefined) return custom;
      const userId = this.senders.get(body.userMessageId)!;
      if (userId !== this.lastUser) { this.generation++; this.lastUser = userId; }
      return { dispatch: true, state: "dispatching", actingUser: { userId, generation: String(this.generation), userMessageId: body.userMessageId },
        contextId: randomUUID(), mode: "prompt" };
    }
    if (op === "outcome") return { state: body.state };
    return { ok: true };
  }
  async contextRequest(path: string, body: any): Promise<unknown> {
    this.calls.push({ op: path, body });
    if (path === "turn-lease") {
      if (this.leaseReply) return this.leaseReply(body);
      const userId = this.senders.get(body.userMessageId)!;
      return { contextId: body.contextId, userId, generation: body.generation, expiresAt: Date.now() + 30_000,
        agents: { claude: { apiKey: `${userId === ALEX ? "alex" : "sam"}-personal-key-0000` } },
        gitIdentity: { name: userId === ALEX ? "Alex" : "Sam", email: `${userId === ALEX ? "1" : "2"}+person@users.noreply.github.com` },
        api: { url: "https://api.example.test", token: `zw2x_${(userId === ALEX ? "a" : "s").repeat(43)}` } };
    }
    if (path === "terminal-lease") {
      const userId = this.clientUsers.get(body.clientId)!;
      return { contextId: randomUUID(), userId, expiresAt: Date.now() + 30_000, gitIdentity: { name: userId === ALEX ? "Alex" : "Sam", email: "1+person@users.noreply.github.com" } };
    }
    if (path === "client-lease") {
      const userId = this.clientUsers.get(body.clientId)!;
      return { contextId: randomUUID(), userId, expiresAt: Date.now() + 30_000, gitIdentity: { name: "Alex", email: "1+person@users.noreply.github.com" } };
    }
    if (path === "bootstrap-lease") return { contextId: body.contextId, userId: SAM, expiresAt: Date.now() + 30_000,
      gitIdentity: { name: "Sam", email: "2+person@users.noreply.github.com" } };
    if (path === "execution-leases/boot-clean") {
      if (body.processes > 0) throw Object.assign(new Error("not retired"), { status: 409, contextCode: "execution_not_retired" });
      return { retired: 0 };
    }
    if (path === "execution-leases/renew") return { leases: body.contextIds.map((contextId: string) => ({ contextId, expiresAt: Date.now() + 30_000 })) };
    if (/^execution-leases\/.+\/retired$/.test(path)) return { retired: true };
    throw new Error(`unexpected ${path}`);
  }
  deliver(item: Delivery): void {
    this.senders.set(item.receipt.userMessageId, item.senderUserId);
    const batch = { prompts: [item], stops: [] as [] };
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(batch); } else this.queued.push(batch);
  }
}

async function setup(options: { activated?: boolean; bootstrap?: string; survivors?: number; beforeStart?: (home: string) => Promise<void>; environment?: unknown; setupRunner?: (...args: any[]) => Promise<number>; checkout?: () => void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-acting-")); directories.push(directory);
  const root = join(directory, "checkout"); await mkdir(root);
  const relay = new ActingRelay(), drivers: FakeDriver[] = [];
  let socketPath = "";
  const home = join(directory, "home"); await mkdir(home);
  await options.beforeStart?.(home);
  const worker = new CloudWorker({ directory, homeDirectory: home, transport: relay, workspaceId: WORKSPACE_ID, githubFetch: async () => new Response(null, { status: 200 }),
    prepareCheckout: async (_workspace, environment) => { socketPath = environment.GH_ZEROS_BROKER_SOCKET!; options.checkout?.(); return { createdBranch: true }; },
    ...(options.setupRunner ? { setupRunner: options.setupRunner } : {}),
    bootClean: async () => options.survivors ?? 0,
    contextRenewMs: 20, sharedMemory: join(directory, "shm"),
    drivers: { claude: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } } });
  workers.push(worker); worker.start();
  await relay.receive({ ...config, workspace: { ...config.workspace, checkoutPath: root, ...(options.setupRunner ? { setup: "make bootstrap" } : {}) }, promptOutbox: 1,
    ...(options.bootstrap ? { bootstrapContextId: options.bootstrap } : {}),
    ...(options.environment ? { environment: options.environment } : {}), agents: options.activated === false ? { claude: { apiKey: "creator-claude-key-000" } } : {},
    ...(options.activated === false ? {} : { actingUser: 1, gitIdentity: null }) });
  return { relay, drivers, home, root, socketPath: () => socketPath };
}

it("attests a clean boot before its first begin, and starts no one's turn when cleanup is unproven", async () => {
  const f = await setup();
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const ops = f.relay.calls.map(call => call.op);
  expect(ops.filter(op => op === "execution-leases/boot-clean")).toHaveLength(1);
  expect(ops.indexOf("execution-leases/boot-clean")).toBeLessThan(ops.indexOf("begin"));
  f.drivers[0]!.complete();
  const dirty = await setup({ survivors: 1 });
  dirty.relay.deliver(delivery(ALEX));
  await until(() => dirty.relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(true);
  expect(dirty.relay.calls.some(call => call.op === "begin" || call.op.endsWith("-lease"))).toBe(false);
  expect(dirty.drivers.every(driver => !driver.opened)).toBe(true);
});

it("runs an activated turn as its person: begin first, then the exact lease, then the driver with that person's login and identity; retired after", async () => {
  const f = await setup();
  const item = delivery(ALEX); f.relay.deliver(item);
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const ops = f.relay.calls.map(call => call.op);
  expect(ops.indexOf("begin")).toBeLessThan(ops.indexOf("turn-lease"));
  const begin = f.relay.calls.find(call => call.op === "begin")!.body, lease = f.relay.calls.find(call => call.op === "turn-lease")!.body;
  expect(lease).toEqual({ chatId: "chat", userMessageId: item.receipt.userMessageId, dispatchId: begin.dispatchId, generation: "1", contextId: lease.contextId });
  const opened = f.drivers[0]!.opened!;
  expect(opened).toMatchObject({ apiKey: "alex-personal-key-0000" });
  expect(opened.gitEnvironment).toEqual({ GIT_AUTHOR_NAME: "Alex", GIT_COMMITTER_NAME: "Alex", GIT_AUTHOR_EMAIL: "1+person@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "1+person@users.noreply.github.com" });
  expect(opened.zerosEnvironment).toMatchObject({ ZEROS_API_URL: "https://api.example.test", ZEROS_API_TOKEN: `zw2x_${"a".repeat(43)}`,
    ZEROS_EXECUTION_CONTEXT: lease.contextId });
  f.drivers[0]!.complete();
  await until(() => f.relay.calls.some(call => call.op === `execution-leases/${lease.contextId}/retired`)).toBe(true);
  const retired = f.relay.calls.find(call => call.op === `execution-leases/${lease.contextId}/retired`)!.body;
  expect(retired).toMatchObject({ reason: "outcome", processes: 0 });
  await until(() => f.relay.calls.some(call => call.op === "outcome" && call.body.state === "completed")).toBe(true);
});

it("restarts the chat's driver for the next person's turn, with that person's login (never the previous one's)", async () => {
  const f = await setup();
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  f.drivers[0]!.complete();
  f.relay.deliver(delivery(SAM));
  await until(() => f.drivers[1]?.prompts.length ?? 0).toBe(1);
  expect(f.drivers[0]!.disposed).toBe(true);
  expect(f.drivers[1]!.opened).toMatchObject({ apiKey: "sam-personal-key-0000" });
  expect(f.drivers[1]!.opened!.gitEnvironment).toMatchObject({ GIT_AUTHOR_NAME: "Sam" });
  f.drivers[1]!.complete();
});

it("fails an activated dispatch closed when begin names no actor, or the lease is refused; never falls back to the config's login", async () => {
  const f = await setup();
  f.relay.beginReply = () => ({ dispatch: true, state: "dispatching" });
  f.relay.deliver(delivery(ALEX));
  await until(() => f.relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(true);
  expect(f.drivers.every(driver => !driver.opened)).toBe(true);
  f.relay.beginReply = undefined;
  f.relay.leaseReply = () => { throw Object.assign(new Error("refused"), { status: 409, contextCode: "agent_login_required", agent: "claude" }); };
  f.relay.deliver(delivery(SAM, "chat-2"));
  await until(() => f.relay.calls.filter(call => call.op === "outcome" && call.body.state === "failed").length).toBe(2);
  expect(f.drivers.every(driver => !driver.opened)).toBe(true);
});

it("keeps today's path without actingUser: the config's login, no lease, no begin actor", async () => {
  const f = await setup({ activated: false });
  f.relay.beginReply = () => ({ dispatch: true, state: "dispatching" });
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  expect(f.drivers[0]!.opened).toMatchObject({ apiKey: "creator-claude-key-000" });
  expect(f.drivers[0]!.opened!.gitEnvironment).toBeUndefined();
  expect(f.relay.calls.some(call => call.op.includes("lease"))).toBe(false);
  f.drivers[0]!.complete();
});

const steer = (sender: string) => { const item = delivery(sender, "chat", "2"); item.payload.mode = "steer"; return item; };

it("joins a same-person steer to the running turn's context: its own receipt is leased, the driver keeps running", async () => {
  const f = await setup();
  const first = delivery(ALEX); f.relay.deliver(first);
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const parent = f.relay.calls.find(call => call.op === "turn-lease")!.body;
  const second = steer(ALEX);
  f.relay.beginReply = body => body.userMessageId === second.receipt.userMessageId ? { dispatch: true, state: "dispatching",
    actingUser: { userId: ALEX, generation: parent.generation, userMessageId: first.receipt.userMessageId },
    contextId: parent.contextId, mode: "steer", parentContextId: parent.contextId } : undefined;
  f.relay.deliver(second);
  await until(() => f.drivers[0]!.steers.length).toBe(1);
  const leases = f.relay.calls.filter(call => call.op === "turn-lease").map(call => call.body);
  expect(leases[1]).toEqual({ chatId: "chat", userMessageId: second.receipt.userMessageId, dispatchId: expect.any(String), generation: parent.generation, contextId: parent.contextId });
  expect(f.drivers).toHaveLength(1);
  expect(f.relay.calls.some(call => call.op.endsWith("/retired"))).toBe(false);
  f.drivers[0]!.complete();
  await until(() => f.relay.calls.filter(call => call.op.endsWith("/retired")).length).toBe(1);
});

it("lets another person's steer wait as their own turn while the first person's turn holds the chat", async () => {
  const f = await setup();
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const second = steer(SAM);
  let busy = true;
  f.relay.beginReply = body => {
    if (body.userMessageId !== second.receipt.userMessageId || !busy) return undefined;
    busy = false;
    throw Object.assign(new Error("busy"), { status: 409, contextCode: "actor_busy" });
  };
  f.relay.deliver(second);
  await until(() => f.relay.calls.filter(call => call.op === "begin").length).toBe(2);
  expect(f.drivers[0]!.steers).toHaveLength(0);
  f.drivers[0]!.complete();
  await until(() => f.drivers[1]?.prompts.length ?? 0).toBe(1);
  expect(f.drivers[1]!.opened).toMatchObject({ apiKey: "sam-personal-key-0000" });
  const retiredFirst = f.relay.calls.findIndex(call => call.op.endsWith("/retired"));
  const samLease = f.relay.calls.findIndex(call => call.op === "turn-lease" && call.body.userMessageId === second.receipt.userMessageId);
  expect(retiredFirst).toBeGreaterThan(-1);
  expect(retiredFirst).toBeLessThan(samLease);
  f.drivers[1]!.complete();
});

it("serves GitHub only to a live context's own helpers, asking for that context's person; never a contextless or ended one", async () => {
  const f = await setup();
  const requests = () => f.relay.frames.filter((frame): frame is Extract<CloudV2WorkerFrame, { t: "request" }> => frame.t === "request");
  await expect(brokerRequest(f.socketPath(), "token")).rejects.toThrow();
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const contextId = f.relay.calls.find(call => call.op === "turn-lease")!.body.contextId;
  vi.stubEnv("ZEROS_EXECUTION_CONTEXT", contextId);
  const pending = brokerRequest(f.socketPath(), "token");
  await until(() => requests().length).toBe(1);
  expect(requests()[0]).toMatchObject({ kind: "github-token", contextId });
  await f.relay.receive({ t: "reply", id: requests()[0]!.id, token: "fixture-alex-token", expiresAt: Date.now() + 120_000 });
  await expect(pending).resolves.toMatchObject({ token: "fixture-alex-token" });
  f.drivers[0]!.complete();
  await until(() => f.relay.calls.some(call => call.op === `execution-leases/${contextId}/retired`)).toBe(true);
  await expect(brokerRequest(f.socketPath(), "token")).rejects.toThrow();
  vi.stubEnv("ZEROS_EXECUTION_CONTEXT", "77777777-7777-4777-8777-777777777777");
  await expect(brokerRequest(f.socketPath(), "token")).rejects.toThrow();
  expect(requests()).toHaveLength(1);
});

it("gives an activated turn its person's own MCP servers through a gateway that asks for that context and closes with it", async () => {
  const f = await setup();
  const serverId = "88888888-8888-4888-8888-888888888888";
  f.relay.leaseReply = body => ({ contextId: body.contextId, userId: ALEX, generation: body.generation, expiresAt: Date.now() + 30_000,
    agents: { claude: { apiKey: "alex-personal-key-0000" } }, gitIdentity: null,
    mcpServers: [{ id: serverId, name: "alex-tools", transport: "http", url: "https://mcp.example.test", auth: "oauth" }] });
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const contextId = f.relay.calls.find(call => call.op === "turn-lease")!.body.contextId;
  const servers = Object.entries(f.drivers[0]!.opened!.mcpServers ?? {}).filter(([name]) => name.endsWith(serverId.replaceAll("-", ""))).map(([, server]) => server);
  expect(servers).toHaveLength(1);
  const initialize = () => fetch(servers[0]!.url, { method: "POST", headers: { ...servers[0]!.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) })
    .then(async response => { await response.arrayBuffer(); return response.status; });
  await initialize();
  await until(() => f.relay.authorizations.length).toBeGreaterThan(0);
  expect(f.relay.authorizations[0]).toEqual([serverId, false, contextId]);
  f.drivers[0]!.complete();
  await until(() => f.relay.calls.some(call => call.op === `execution-leases/${contextId}/retired`)).toBe(true);
  // The context's gateway is gone: its port refuses, or answers without serving.
  await expect(initialize().then(status => status === 200, () => false)).resolves.toBe(false);
});

it("gives an activated turn its person's own environment variables, with their values and file contents redacted from what the chat mirrors", async () => {
  const f = await setup();
  f.relay.leaseReply = body => ({ contextId: body.contextId, userId: ALEX, generation: body.generation, expiresAt: Date.now() + 30_000,
    agents: { claude: { apiKey: "alex-personal-key-0000" } }, gitIdentity: null,
    environment: { versionId: "99999999-9999-4999-8999-999999999999", repositoryId: "123", variables: { ALEX_SECRET: "synthetic-alex-value" },
      files: [{ path: ".env.local", content: "FILE_SECRET=synthetic-alex-file\n" }] } });
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  expect(f.drivers[0]!.opened!.application?.variables).toMatchObject({ ALEX_SECRET: "synthetic-alex-value", FILE_SECRET: "synthetic-alex-file" });
  const contextId = f.relay.calls.find(call => call.op === "turn-lease")!.body.contextId;
  const envDirectory = join(f.home, ".zeros", "contexts", contextId, "env");
  expect(f.drivers[0]!.opened!.zerosEnvironment).toMatchObject({ ZEROS_PERSONAL_ENV_DIR: envDirectory });
  expect(await readFile(join(envDirectory, ".env.local"), "utf8")).toBe("FILE_SECRET=synthetic-alex-file\n");
  await expect(stat(join(f.root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  // One line tells the agent where the repository's expected env files are; the person's recorded message stays theirs.
  expect(f.drivers[0]!.prompts[0]![0]).toEqual({ type: "text", text: "Personal env files for this turn (.env.local) are in $ZEROS_PERSONAL_ENV_DIR, not in the checkout." });
  expect(JSON.stringify(f.relay.frames)).not.toContain("ZEROS_PERSONAL_ENV_DIR, not in");
  f.drivers[0]!.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "saw synthetic-alex-value and synthetic-alex-file" } });
  await until(() => JSON.stringify(f.relay.frames).includes("saw [redacted]")).toBe(true);
  expect(JSON.stringify(f.relay.frames)).not.toContain("synthetic-alex");
  f.drivers[0]!.complete();
  await until(() => f.relay.calls.some(call => call.op === `execution-leases/${contextId}/retired`)).toBe(true);
  await expect(stat(join(f.home, ".zeros", "contexts", contextId))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform !== "linux")("runs a terminal as the person who opened it, and keeps another person's client out of it", async () => {
  const f = await setup();
  f.relay.clientUsers.set(CLIENT_A, ALEX).set(CLIENT_B, SAM);
  await f.relay.receive({ t: "open", clientId: CLIENT_A, userId: ALEX, contextId: randomUUID() });
  await f.relay.receive({ t: "open", clientId: CLIENT_B, userId: SAM, contextId: randomUUID() });
  await f.relay.request(CLIENT_A, browserFrame("PTY_CREATE", { sessionId: "alex-shell", cols: 120, rows: 10 }));
  await until(() => f.relay.bridge("PTY_CREATED").length).toBe(1);
  const lease = f.relay.calls.find(call => call.op === "terminal-lease")!.body;
  expect(lease).toMatchObject({ clientId: CLIENT_A, terminalId: "alex-shell" });
  await f.relay.request(CLIENT_A, browserFrame("PTY_WRITE", { sessionId: "alex-shell", data: "echo \"who=$GIT_AUTHOR_NAME ctx=${ZEROS_EXECUTION_CONTEXT:+set}\"\r" }));
  const output = () => f.relay.bridge("PTY_DATA").filter(entry => entry.clientId === CLIENT_A).map(({ frame }) => (frame as { data: string }).data).join("");
  await until(output).toContain("who=Alex ctx=set");
  await f.relay.request(CLIENT_B, browserFrame("PTY_CREATE", { sessionId: "alex-shell", cols: 120, rows: 10 }));
  await until(() => f.relay.bridge("PTY_EXIT").some(entry => entry.clientId === CLIENT_B)).toBe(true);
  expect(f.relay.bridge("PTY_CREATED").filter(entry => entry.clientId === CLIENT_B)).toHaveLength(0);
});

it("runs a client's mutation as that client's person from an operation lease retired when the request ends; reads need none", async () => {
  const f = await setup();
  f.relay.clientUsers.set(CLIENT_A, ALEX);
  await f.relay.receive({ t: "open", clientId: CLIENT_A, userId: ALEX, contextId: randomUUID() });
  await f.relay.receive({ t: "open", clientId: CLIENT_B });
  const write = browserFrame("WORKSPACE_REQUEST", { op: "file.write", params: { path: "notes.txt", content: "hello" } });
  await f.relay.request(CLIENT_A, write);
  await until(() => !!f.relay.response(write.id)).toBe(true);
  expect(f.relay.response(write.id)!.type).toBe("WORKSPACE_RESPONSE");
  const lease = f.relay.calls.find(call => call.op === "client-lease")!.body;
  expect(lease).toEqual({ clientId: CLIENT_A, requestId: write.id, operation: "file.write" });
  const leaseIndex = f.relay.calls.findIndex(call => call.op === "client-lease");
  await until(() => f.relay.calls.some(call => call.op.endsWith("/retired") && call.body.reason === "operation_done")).toBe(true);
  expect(f.relay.calls.findIndex(call => call.op.endsWith("/retired"))).toBeGreaterThan(leaseIndex);
  const read = browserFrame("WORKSPACE_REQUEST", { op: "file.read", params: { path: "notes.txt" } });
  await f.relay.request(CLIENT_A, read);
  await until(() => !!f.relay.response(read.id)).toBe(true);
  expect(f.relay.calls.filter(call => call.op === "client-lease")).toHaveLength(1);
  const anonymous = browserFrame("WORKSPACE_REQUEST", { op: "file.write", params: { path: "other.txt", content: "x" } });
  await f.relay.request(CLIENT_B, anonymous);
  await until(() => !!f.relay.response(anonymous.id)).toBe(true);
  expect(f.relay.response(anonymous.id)!.type).toBe("WORKSPACE_ERROR");
  expect(f.relay.calls.filter(call => call.op === "client-lease")).toHaveLength(1);
  await expect(stat(join(f.root, "other.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("checks out and runs setup as the workspace's starter from the bootstrap lease, retired when setup is done", async () => {
  const BOOT = "77777777-7777-4777-8777-777777777777";
  let checkoutAs: unknown, setupEnv: NodeJS.ProcessEnv | undefined;
  const f = await setup({ bootstrap: BOOT, checkout: () => { checkoutAs = operationEnvironment.getStore(); },
    setupRunner: async (_program: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { setupEnv = options.env; return 0; } });
  expect(f.relay.calls.find(call => call.op === "bootstrap-lease")?.body).toEqual({ contextId: BOOT });
  expect(checkoutAs).toMatchObject({ git: { GIT_AUTHOR_NAME: "Sam" }, zeros: { ZEROS_EXECUTION_CONTEXT: BOOT } });
  await until(() => setupEnv?.GIT_AUTHOR_NAME).toBe("Sam");
  expect(setupEnv!.ZEROS_EXECUTION_CONTEXT).toBe(BOOT);
  await until(() => f.relay.calls.find(call => call.op === `execution-leases/${BOOT}/retired`)?.body.reason).toBe("setup_done");
});

it("interrupts a running turn whose context is revoked, and retires it as revoked", async () => {
  const f = await setup();
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const contextId = f.relay.calls.find(call => call.op === "turn-lease")!.body.contextId;
  await f.relay.receive({ t: "revoke-context", contextId, reason: "access_revoked" });
  await until(() => f.drivers[0]!.interrupts).toBe(1);
  await until(() => f.relay.calls.find(call => call.op === `execution-leases/${contextId}/retired`)?.body.reason).toBe("revoked");
  expect(f.drivers[0]!.disposed).toBe(true);
});

it("waits for the previous person's cleanup when begin answers actor_busy, then runs the turn with the same dispatch", async () => {
  const f = await setup();
  let busy = 2;
  f.relay.beginReply = () => {
    if (busy-- > 0) throw Object.assign(new Error("busy"), { status: 409, contextCode: "actor_busy" });
    return undefined;
  };
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  const begins = f.relay.calls.filter(call => call.op === "begin").map(call => call.body);
  expect(begins).toHaveLength(3);
  expect(new Set(begins.map(body => body.dispatchId)).size).toBe(1);
  expect(f.relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(false);
  f.drivers[0]!.complete();
});

it("renews an open desktop connection's client context while it stays open, and releases it on close", async () => {
  const f = await setup();
  const handle = randomUUID();
  await f.relay.receive({ t: "open", clientId: CLIENT_A, userId: ALEX, contextId: handle });
  const renewed = () => f.relay.calls.filter(call => call.op === "execution-leases/renew").map(call => call.body.contextIds as string[]);
  await until(() => renewed().filter(ids => ids.includes(handle)).length).toBeGreaterThan(2);
  await f.relay.receive({ t: "close", clientId: CLIENT_A });
  const after = renewed().length;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(renewed().slice(after + 1).some(ids => ids.includes(handle))).toBe(false);
});

it("names the running turn's person on its turn_state, and nobody on a legacy turn", async () => {
  const states = (relay: ActingRelay) => relay.bridge("AGENT_SESSION_UPDATE").flatMap(({ frame }) => frame.type === "AGENT_SESSION_UPDATE" &&
    frame.notification.update.sessionUpdate === "turn_state" ? [frame.notification.update as { state: string; actingUserId?: string }] : []);
  const f = await setup();
  await f.relay.receive({ t: "open", clientId: CLIENT_A, userId: ALEX, contextId: randomUUID() });
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  await until(() => states(f.relay).find(update => update.state === "running")?.actingUserId).toBe(ALEX);
  f.drivers[0]!.complete();
  await until(() => states(f.relay).some(update => update.state === "completed")).toBe(true);
  expect(states(f.relay).find(update => update.state === "completed")).not.toHaveProperty("actingUserId");
  const legacy = await setup({ activated: false });
  await legacy.relay.receive({ t: "open", clientId: CLIENT_A });
  legacy.relay.deliver(delivery(ALEX));
  await until(() => legacy.drivers[0]?.prompts.length ?? 0).toBe(1);
  expect(states(legacy.relay).every(update => !("actingUserId" in update))).toBe(true);
  legacy.drivers[0]!.complete();
});

it("removes the Creator's legacy Git identity before attesting a clean boot, and says what it did", async () => {
  const cleanBodies = (relay: ActingRelay) => relay.calls.filter(call => call.op === "execution-leases/boot-clean").map(call => call.body);
  const fresh = await setup();
  await until(() => cleanBodies(fresh.relay).length).toBe(1);
  expect(cleanBodies(fresh.relay)[0]).toMatchObject({ processes: 0, legacyMaterial: "none" });
  const legacy = await setup({ beforeStart: async home => {
    await mkdir(join(home, ".config", "zeros"), { recursive: true });
    await writeFile(join(home, ".config", "zeros", "git-identity"), '[user]\n\tuseConfigOnly = true\n\tname = "Creator Person"\n\temail = "1+creator@users.noreply.github.com"\n');
  } });
  await until(() => cleanBodies(legacy.relay).length).toBe(1);
  // The activated config's empty identity may land first; either way the Creator's is gone and nothing is refused.
  expect(["none", "removed"]).toContain(cleanBodies(legacy.relay)[0]!.legacyMaterial);
  expect(cleanBodies(legacy.relay)[0]).toMatchObject({ processes: 0 });
  expect(await readFile(join(legacy.home, ".config", "zeros", "git-identity"), "utf8")).not.toContain("Creator");
});

it("never seeds a global environment into an activated workspace's shared checkout", async () => {
  const f = await setup({ environment: { versionId: randomUUID(), repositoryId: "42", variables: {}, files: [{ path: ".env.local", content: "VALUE=synthetic-creator\n" }] } });
  f.relay.deliver(delivery(ALEX));
  await until(() => f.drivers[0]?.prompts.length ?? 0).toBe(1);
  await expect(stat(join(f.root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  f.drivers[0]!.complete();
});
