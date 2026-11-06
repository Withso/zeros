import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { observeTransactionTiming, requestTiming, type RequestDatabaseCost } from "../request-timing.js";
import { CloudV2Store } from "./store.js";
import { createCloudGithubServices } from "./github-composition.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { createCloudV2WorkerRoutes, type CloudV2WorkerRouteDeps } from "./worker-routes.js";
import { CloudV2PromptSignals } from "./prompt-signals.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("durable prompt request cost", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  async function fixture() {
    const userId = randomUUID(), organizationId = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [userId, `${userId}@example.test`]);
    await grantTestPro(pool, userId);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [organizationId, `org-${organizationId}`, userId]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organizationId, userId]);
    const store = new CloudV2Store(pool), fetcher = vi.fn<typeof fetch>(async value => {
      const path = new URL(String(value)).pathname;
      if (path === "/user") return Response.json({ id: 12, login: "contributor" });
      if (path === "/repositories/42") return Response.json({ id: 42, name: "project", owner: { login: "example" },
        default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
      if (path === "/repositories/42/branches") return Response.json([]);
      throw new Error("Unexpected synthetic GitHub request");
    });
    const github = createCloudGithubServices(pool, null, { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } }, store, fetcher);
    const scope = { organizationId, userId };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope), { id: "12", login: "contributor" },
      { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId, creatorUserId: userId,
      repository: "example/project", sourceRepositoryId: "42", branch: "topic", baseBranch: "main", name: "Prompt cost", computerBuildId: null });
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.acceptWorkerHello(token, boot);
    const live = (await store.workerSession(token, boot))!;
    await github.authorizeSource(live);
    await github.continueSource(live, live);
    fetcher.mockClear();
    const costs: RequestDatabaseCost[] = [];
    const app = (signals?: CloudV2PromptSignals, continueSource = github.continueSource) => {
      const api = new Hono();
      api.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: cost => { costs.push(cost); } }));
      api.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
      api.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
      api.route("/", createCloudV2Routes({ store, promptOutbox: true, bridgeBaseUrl: "wss://example.test",
        authorizeSource: github.authorizeSource, continueSource } as CloudV2RouteDeps));
      api.route("/", createCloudV2WorkerRoutes({ store, promptOutbox: true, runtimeSha256: "a".repeat(64),
        authorizeSource: github.authorizeSource, continueSource: github.continueSource,
        ...(signals ? { waitForPrompts: (id: string, ms: number, signal: AbortSignal) => signals.wait(id, ms, signal) } : {}) } as CloudV2WorkerRouteDeps));
      return api;
    };
    const submit = (api = app()) => api.request(`/v1/cloud-v2/workspaces/${workspace.id}/prompts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: "native-chat", userMessageId: randomUUID(),
        agentId: "claude", model: "claude-haiku-5-5", effort: "low", prompt: [{ type: "text", text: "Reply with exactly: ok" }], startedAt: 1234 }),
    });
    return { store, workspace, live, scope, github, fetcher, token, boot, userId, organizationId, app, submit, costs };
  }

  it("wakes the durable pull at commit and bounds receipt, ACK and dispatch authority work", async () => {
    const { store, workspace, fetcher, token, boot, costs, app: createApp } = await fixture();
    const signals = new CloudV2PromptSignals(), listener = await pool.connect(), app = createApp(signals);
    listener.on("notification", notice => { if (notice.channel === "zeros_cloud_v2_prompts" && notice.payload) signals.wake(notice.payload); });
    await listener.query("LISTEN zeros_cloud_v2_prompts");
    const samples: Array<{ phase: string; transactions: number; queries: number; ms: number }> = [];
    const measure = (phase: string, run: () => Promise<Response>) => {
      const started = performance.now();
      return observeTransactionTiming(run, timing => samples.push({ phase, transactions: timing.transactions, queries: costs.findLast(cost => cost.route.endsWith(phase === "receipt" ? "/prompts" : `/${phase}`))!.queriesStarted, ms: Math.round(performance.now() - started) }));
    };
    const controller = new AbortController();
    const worker = (phase: string, body: object) => measure(phase, () => app.request(`/v2/cloud/worker/prompts/${phase}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot },
      body: JSON.stringify(body), signal: controller.signal,
    }));
    let empty!: () => void;
    const waiting = new Promise<void>(resolve => { empty = resolve; });
    const pull = store.prompts.pull.bind(store.prompts);
    const pullSpy = vi.spyOn(store.prompts, "pull").mockImplementation(async (...args) => {
      const batch = await pull(...args);
      if (!batch.prompts.length) empty();
      return batch;
    });
    const pending = worker("pull", { waitMs: 10_000, held: [] });
    try {
      await waiting;
      const userMessageId = randomUUID();
      const receipt = await measure("receipt", () => app.request(`/v1/cloud-v2/workspaces/${workspace.id}/prompts`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: "native-chat", userMessageId,
          agentId: "claude", model: "claude-haiku-5-5", effort: "low", prompt: [{ type: "text", text: "Reply with exactly: ok" }], startedAt: 1234 }),
      }));
      expect(receipt.status).toBe(201);
      const response = await pending;
      expect(response.status).toBe(200);
      const item = (await response.json()).prompts[0];
      expect(item.receipt.userMessageId).toBe(userMessageId);
      expect((await worker("ack", { userMessageId, deliveryId: item.deliveryId })).status).toBe(200);
      const begun = await worker("begin", { userMessageId, deliveryId: item.deliveryId, dispatchId: randomUUID() });
      expect(await begun.json()).toMatchObject({ dispatch: true, state: "dispatching" });
      console.info("Durable prompt cost", samples, { githubCalls: fetcher.mock.calls.length });
      expect(samples.find(row => row.phase === "receipt")?.transactions).toBeLessThanOrEqual(2);
      expect(samples.find(row => row.phase === "pull")?.transactions).toBeLessThanOrEqual(4);
      expect(samples.find(row => row.phase === "ack")?.transactions).toBeLessThanOrEqual(2);
      expect(samples.find(row => row.phase === "begin")?.transactions).toBeLessThanOrEqual(2);
      const queryBudgets: Record<string, number> = { receipt: 10, pull: 14, ack: 6, begin: 7 };
      expect(samples, JSON.stringify(samples)).toSatisfy(values => values.every((value: typeof samples[number]) => value.queries <= queryBudgets[value.phase]!));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      controller.abort(); signals.wakeAll(); await pending; pullSpy.mockRestore();
      await listener.query("UNLISTEN *"); listener.release();
    }
  });

  it("reads a live creator proof without exposing it in workspace documents", async () => {
    const f = await fixture();
    const context = await f.store.promptContext(f.workspace.id, f.userId);
    expect(context.proof).toEqual({ accessEpoch: f.live.accessEpoch, loginRevision: f.live.loginRevision });
    for (const document of [context.workspace, await f.store.get(f.workspace.id, f.userId), ...(await f.store.list(f.organizationId, f.userId))]) {
      expect(document).not.toHaveProperty("accessEpoch");
      expect(document).not.toHaveProperty("loginRevision");
      expect(document).not.toHaveProperty("proof");
    }
    await expect(f.store.promptContext(f.workspace.id, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.userId]);
    await expect(f.store.promptContext(f.workspace.id, f.userId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("leases a full batch in constant database work and preserves delivery IDs on a lost reply", async () => {
    const f = await fixture(), app = f.app();
    const messages = Array.from({ length: 16 }, () => randomUUID());
    for (const [index, userMessageId] of messages.entries()) {
      const response = await app.request(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: `chat-${index}`, userMessageId, agentId: "claude",
          prompt: [{ type: "text", text: "Reply with exactly: ok" }], startedAt: 1234 }),
      });
      expect(response.status).toBe(201);
    }
    const pull = async (held: string[]) => {
      const response = await app.request("/v2/cloud/worker/prompts/pull", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.token}`, "x-zeros-worker-boot": f.boot },
        body: JSON.stringify({ waitMs: 0, held }),
      });
      expect(response.status).toBe(200);
      expect(f.costs.at(-1)?.queriesStarted).toBeLessThanOrEqual(7);
      return (await response.json()).prompts as Array<{ receipt: { userMessageId: string }; deliveryId: string }>;
    };
    const first = await pull([]);
    expect(first.map(item => item.receipt.userMessageId)).toEqual(messages);
    expect(new Set(first.map(item => item.deliveryId)).size).toBe(16);
    expect(await pull([])).toEqual(first);
    expect(await pull(messages.slice(0, 8))).toEqual(first.slice(8));
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses a late creator proof after a newer credential selection was observed", async () => {
    const f = await fixture();
    let reached!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const read = f.store.promptContext.bind(f.store);
    const spy = vi.spyOn(f.store, "promptContext").mockImplementationOnce(async (...args) => {
      const context = await read(...args);
      reached(); await held; return context;
    });
    const pending = f.submit();
    try {
      await reading;
      await f.github.connections.store.save(f.scope, await f.github.connections.store.fingerprint(f.scope), { id: "12", login: "contributor" },
        { method: "pat", accessToken: "replacement-synthetic-pat", expiresAt: null });
      const current = (await f.store.workerSession(f.token, f.boot))!;
      expect(current.loginRevision).not.toBe(f.live.loginRevision);
      await f.github.continueSource(current, current);
      release();
      expect(await (await pending).json()).toEqual({ error: { code: "github_authorization_changed" } });
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
    } finally { release(); await pending; spy.mockRestore(); }
  });

  it("does not reuse a warm source proof after credential disconnection without a notification", async () => {
    const f = await fixture();
    await f.github.connections.store.disconnect(f.scope, await f.github.connections.store.fingerprint(f.scope), "pat");
    const response = await f.submit();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "github_connection_required" } });
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rechecks creator membership under the enqueue lock after source continuation", async () => {
    const f = await fixture();
    const api = f.app(undefined, async (workspace, proof) => {
      const lease = await f.github.continueSource(workspace, proof);
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.userId]);
      return lease;
    });
    expect((await f.submit(api)).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
