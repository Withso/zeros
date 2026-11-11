import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Only tests cross the deployment boundary; integration resolves the same
// relative sources, while a separate worktree can pin the worker revision.
const root = new URL(process.env.CLOUD_EXECUTION_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("real acting-user worker clients against HTTP routes and PostgreSQL", () => {
  let pool: pg.Pool, f: ExecutionFixture, directory: string;
  let clients: { HybridTransport: any; ExecutionContexts: any; CloudWorker: any; protocol: any };
  let worker: any, contexts: any, config: any;
  let loseCleanReply: boolean;
  type Call = { path: string; body: any; headers: Headers; status?: number; reply?: any };
  let calls: Call[];
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 });
    clients = {
      ...await import(new URL("apps/cloud-worker/src/hybrid-transport.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/sharing/execution-contexts.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/worker.ts", root).href),
      protocol: await import(new URL("packages/protocol/src/cloud-v2-relay.ts", root).href),
    };
  });
  beforeEach(async () => {
    calls = []; config = undefined; loseCleanReply = false;
    directory = await mkdtemp(join(tmpdir(), "execution-clients-"));
    const tokenFile = join(directory, "token");
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (!path.startsWith("/v2/cloud/worker/")) return f.fetcher(input, init);
      const call: Call = { path, headers: request.headers, body: request.body ? await request.clone().json() : undefined };
      calls.push(call);
      const response = await f.app.fetch(request);
      call.status = response.status;
      if (response.headers.get("content-type")?.includes("application/json")) call.reply = await response.clone().json();
      if (loseCleanReply && path.endsWith("/boot-clean") && response.ok) {
        loseCleanReply = false;
        throw new TypeError("Fixture lost the committed boot-clean reply");
      }
      return response;
    };
    f = await executionFixture(pool);
    await f.login(); await f.login(f.viewer); await f.activate();
    worker = new clients.HybridTransport({ apiUrl: "https://api.example.test", workspaceId: f.workspace.id, tokenFile, port: 0,
      runtimeSha256: "b".repeat(64), fetch: fetcher,
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()] });
    await writeFile(tokenFile, f.token, { mode: 0o600 });
    contexts = new clients.ExecutionContexts({ post: (path: string, body: unknown) => worker.contextRequest(path, body) });
    worker.start({ open: async () => {}, close: () => {}, frame: async (frame: any) => { if (frame.t === "config") config = frame; } });
    await expect.poll(() => config).toBeDefined();
  });
  afterEach(async () => {
    contexts?.dispose(); await worker?.dispose(); await f?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());
  const clean = () => contexts.clean(async () => 0);
  const offer = async (input = f.prompt(), user = f.creator) => {
    expect((await f.send(input, user)).status).toBe(201);
    const delivery = (await worker.promptRequest("pull", { waitMs: 0, held: [] })).prompts.find((value: any) => value.payload.userMessageId === input.userMessageId);
    expect(delivery.senderUserId).toBe(user.id);
    await worker.promptRequest("ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId });
    return { input, begin: { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() } };
  };
  const begin = async (offered: Awaited<ReturnType<typeof offer>>) => {
    const result = clients.protocol.CloudV2BeginActiveReplySchema.parse(await worker.promptRequest("begin", offered.begin));
    const request = { chatId: offered.input.chatId, userMessageId: offered.input.userMessageId, dispatchId: offered.begin.dispatchId,
      generation: result.actingUser.generation, contextId: result.contextId };
    return { ...offered, result, request, lease: await contexts.turnLease(request) };
  };
  const finish = (turn: Awaited<ReturnType<typeof begin>>) => worker.promptRequest("outcome", {
    userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed",
  });

  it("gates every personal lease behind boot-clean and replays a lost successful reply", async () => {
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null, promptOutbox: 1, notifyUser: 1 });
    for (const key of ["api", "environment", "mcpServers", "codeReview"]) expect(config).not.toHaveProperty(key);
    await expect(worker.contextRequest("bootstrap-lease", { contextId: config.bootstrapContextId })).rejects.toMatchObject({ status: 409, contextCode: "actor_busy" });
    loseCleanReply = true; await clean();
    const receipts = calls.filter(value => value.path.endsWith("/boot-clean"));
    expect(receipts).toHaveLength(2); expect(receipts[0]!.body).toEqual(receipts[1]!.body);
    expect(receipts[1]!.reply).toEqual({ retired: 0 });
    const lease = await contexts.bootstrapLease(config.bootstrapContextId);
    expect(lease.userId).toBe(f.creator.id);
    await contexts.retire(lease.contextId, "setup_done", 0);
    await contexts.retire(lease.contextId, "setup_done", 0);
    const ended = calls.filter(value => value.path.endsWith(`/${lease.contextId}/retired`));
    expect(ended[0]!.body).toEqual(ended[1]!.body);
    for (const call of calls) {
      expect(call.headers.get("x-zeros-worker-boot")).toBe(worker.bootId);
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("x-zeros-worker-features")?.split(",")).toContain("acting-user-v1");
    }
  });

  it("keeps existing feature flags on the WebSocket configuration path too", async () => {
    const current = await f.cp.store.workerSession(f.token, worker.bootId);
    const frame = await f.cp.workers.config(current!);
    expect(clients.protocol.CloudV2ControlFrameSchema.parse(frame)).toMatchObject({ actingUser: 1, notifyUser: 1, promptOutbox: 1 });
  });

  it("passes begin, steer, handover and stable leases through the real strict decoders", async () => {
    await clean();
    const a = await begin(await offer());
    expect(a.lease.userId).toBe(f.creator.id);
    expect(Object.keys(a.lease.agents)).toEqual(["claude"]);
    expect(await contexts.turnLease(a.request)).toEqual(a.lease);
    const steer = await begin(await offer(f.prompt(randomUUID(), { mode: "steer" })));
    expect(steer.result).toMatchObject({ mode: "steer", contextId: a.result.contextId, parentContextId: a.result.contextId, actingUser: a.result.actingUser });
    expect(steer.lease).toEqual(a.lease); await finish(steer); await finish(a);
    const b = await offer(f.prompt(), f.viewer);
    await expect(worker.promptRequest("begin", b.begin)).rejects.toMatchObject({ status: 409, contextCode: "actor_busy" });
    await expect(contexts.retire(a.result.contextId, "outcome", 1)).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    await contexts.retire(a.result.contextId, "outcome", 0);
    const next = await begin(b);
    expect(next.result.actingUser).toMatchObject({ userId: f.viewer.id, generation: "2" });
    expect(next.lease.agents.claude.apiKey).not.toBe(a.lease.agents.claude.apiKey);
    expect(next.lease.api.token).not.toBe(a.lease.api.token);
  });

  it("never leases after an unproven boot cleanup and preserves the closed error", async () => {
    await expect(contexts.clean(async () => 1)).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    const before = calls.length;
    await expect(contexts.bootstrapLease(config.bootstrapContextId)).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    expect(calls).toHaveLength(before);
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE workspace_id=$1", [f.workspace.id])).rows)
      .toEqual([{ state: "active" }]);
  });

  it("renews a batch without extending authority on a temporary failure, then retires on Stop", async () => {
    await clean(); const turn = await begin(await offer(f.prompt(), f.viewer));
    const deadline = contexts.expiresAt(turn.result.contextId);
    vi.spyOn(f.cp.execution.deps.logins, "select").mockRejectedValueOnce(new (await import("../../authz.js")).HttpError(503, "agent_credentials_unavailable", "Fixture vault unavailable"));
    await contexts.renew(); expect(contexts.expiresAt(turn.result.contextId)).toBe(deadline);
    expect(calls.at(-1)!.status).toBe(503); expect(contexts.live(turn.result.contextId)).toBe(true);
    const stopped = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", { chatId: "chat", throughEpoch: "0" }, f.admin, { "X-Zeros-Team-Sharing": "1" });
    expect(stopped.status).toBe(200);
    await contexts.renew(); expect(contexts.live(turn.result.contextId)).toBe(false);
    expect(calls.at(-1)!.reply.leases).toEqual([{ contextId: turn.result.contextId, refused: "cancelled" }]);
    await contexts.retire(turn.result.contextId, "stop", 0);
  });

  it("keeps the worker's context API bearer tied to its sender when writing another person's chat", async () => {
    await clean(); const turn = await begin(await offer(f.prompt(), f.viewer));
    const me = await f.app.request("/api/v0/me", { headers: { authorization: `Bearer ${turn.lease.api.token}` } });
    expect(await me.json()).toMatchObject({ userId: f.viewer.id, credential: "workspace_token" });
    const absent = await f.send(f.prompt(), f.admin);
    expect(absent.status).toBe(409); expect(await absent.json()).toMatchObject({ error: { code: "agent_login_required", agent: "claude" } });
    const sentId = randomUUID();
    const sent = await f.app.request("/api/v0/sessions/chat/messages", { method: "POST",
      headers: { authorization: `Bearer ${turn.lease.api.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "A follow-up", messageId: sentId }) });
    expect(sent.status).toBe(201);
    expect((await pool.query("SELECT creator_user_id,sender_context_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, sentId])).rows[0])
      .toEqual({ creator_user_id: f.viewer.id, sender_context_id: turn.result.contextId });
  });

  it("uses real terminal and client lease serializers with CP-authored identities", async () => {
    await clean();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "PTY_CREATE", id: "terminal-create", sessionId: "terminal" });
    const terminal = await contexts.terminalLease({ clientId, requestId: "terminal-create", terminalId: "terminal" });
    expect(terminal.userId).toBe(f.viewer.id); expect(terminal).not.toHaveProperty("agents");
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "WORKSPACE_REQUEST", id: "write-file", op: "file.write" });
    const operation = await contexts.clientLease({ clientId, requestId: "write-file", operation: "file.write" });
    expect(operation.userId).toBe(f.viewer.id); expect(operation).not.toHaveProperty("environment");
    await contexts.retire(operation.contextId, "operation_done", 0);
    await f.cp.execution.clients.close(f.workspace.id, clientId);
    await contexts.renew(); expect(contexts.live(terminal.contextId)).toBe(true);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    await contexts.renew(); expect(contexts.live(terminal.contextId)).toBe(false);
  });

  it("keeps a real worker's open client alive through twelve renewal cycles and releases it on close", async () => {
    await clean();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    let handlers: any, tick: (() => void) | undefined;
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
      if (ms === 10_000) tick = callback;
      return interval(callback, ms, ...args);
    }) as typeof setInterval);
    const ingress = new clients.CloudWorker({ directory, homeDirectory: directory, transport: {
      start: (value: unknown) => { handlers = value; }, send: async () => true, dispose: async () => {},
      contextRequest: (path: string, body: unknown) => worker.contextRequest(path, body),
    } });
    try {
      ingress.start();
      await handlers.frame({ t: "open", clientId, userId: handle.userId, contextId: handle.contextId });
      expect(tick).toBeTypeOf("function");
      const started = Date.now(), clock = vi.spyOn(Date, "now");
      for (let cycle = 1; cycle <= 12; cycle++) {
        clock.mockReturnValue(started + cycle * 10_000);
        const count = calls.filter(call => call.path.endsWith("/renew")).length;
        tick!();
        await expect.poll(() => calls.filter(call => call.path.endsWith("/renew") && call.status !== undefined).length).toBe(count + 1);
        expect(calls.at(-1)!.reply.leases).toEqual([{ contextId: handle.contextId, expiresAt: started + cycle * 10_000 + 30_000 }]);
      }
      await expect(f.cp.execution.clients.current(f.workspace.id, handle.contextId)).resolves.toMatchObject({ context: { user_id: f.viewer.id } });
      await f.cp.execution.clients.close(f.workspace.id, clientId);
      await handlers.frame({ t: "close", clientId });
      const count = calls.length;
      tick!(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(calls).toHaveLength(count);
      expect(calls.some(call => call.path.endsWith(`/${handle.contextId}/retired`))).toBe(false);
    } finally { await ingress.dispose(); }
  });
});
