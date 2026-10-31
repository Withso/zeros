import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { createCloudV2WorkerRoutes, type CloudV2WorkerRouteDeps } from "./worker-routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";
import { CloudV2PromptOutbox, CLOUD_V2_PROMPT_LIMITS } from "./prompt-outbox.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable cloud prompt delivery", () => {
  let pool: pg.Pool, store: CloudV2Store, workspace: CloudV2Workspace;
  let creator: string, org: string, token: string, boot: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool); creator = randomUUID(); org = randomUUID(); boot = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator,
      repository: "example/project", branch: "topic", baseBranch: "main", name: "Project", computerBuildId: null });
    token = await store.rotateWorkerToken(workspace.id);
    await store.acceptWorkerHello(token, boot);
  });
  function app(userId = creator, enabled = true) {
    const api = new Hono();
    api.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    api.onError((error, c) => error instanceof HttpError
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: "internal" } }, 500));
    api.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://example.test", promptOutbox: enabled } as CloudV2RouteDeps));
    api.route("/", createCloudV2WorkerRoutes({ store, runtimeSha256: "a".repeat(64), promptOutbox: enabled } as CloudV2WorkerRouteDeps));
    return api;
  }
  const prompt = (userMessageId = randomUUID(), extra: object = {}) => ({
    chatId: "native-chat", userMessageId, agentId: "codex", model: "gpt-6-luna", effort: "low",
    prompt: [{ type: "text", text: "Reply with exactly: ok" }], startedAt: 1234, ...extra,
  });
  function submit(input = prompt(), userId = creator, enabled = true) {
    return app(userId, enabled).request(`/v1/cloud-v2/workspaces/${workspace.id}/prompts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
  }
  function worker(path: string, body: object = {}, bootId = boot, workerToken = token) {
    return app().request(`/v2/cloud/worker/prompts/${path}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${workerToken}`, "x-zeros-worker-boot": bootId },
      body: JSON.stringify(body),
    });
  }
  function status(chatId = "native-chat", userId = creator) {
    return app(userId).request(`/v1/cloud-v2/workspaces/${workspace.id}/prompts?chatId=${encodeURIComponent(chatId)}`);
  }
  function stop(throughEpoch = "0") {
    return app().request(`/v1/cloud-v2/workspaces/${workspace.id}/prompts/stop`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: "native-chat", throughEpoch }),
    });
  }
  async function pull() {
    const response = await worker("pull", { waitMs: 0 }); expect(response.status).toBe(200);
    return await response.json() as { prompts: { receipt: { userMessageId: string; sequence: string; epoch: string }; payload: ReturnType<typeof prompt>; deliveryId: string }[]; stops: { chatId: string; epoch: string }[] };
  }
  async function inbox() {
    const item = (await pull()).prompts[0]!;
    const receipt = await worker("ack", { userMessageId: item.receipt.userMessageId, deliveryId: item.deliveryId });
    expect(receipt.status).toBe(200); expect(await receipt.json()).toMatchObject({ state: "inboxed" });
    return item;
  }

  it("commits before replying, replays the original receipt after a lost reply, and rejects a changed payload", async () => {
    const input = prompt();
    const first = await submit(input); expect(first.status).toBe(201);
    const receipt = await first.json();
    expect(receipt).toMatchObject({ receipt: { workspaceId: workspace.id, chatId: input.chatId, userMessageId: input.userMessageId, epoch: "0", sequence: "1", workspaceState: "running" } });
    const retry = await submit(input); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(receipt);
    expect((await submit({ ...input, prompt: [{ type: "text", text: "different" }] })).status).toBe(409);
    expect((await (await status()).json()).items).toHaveLength(1);
  });

  it("saves without a socket or VM, owns one explicit wake, and passive status never wakes", async () => {
    await store.transition(workspace.id, ["running"], "stopped");
    expect((await status()).status).toBe(200);
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
    const input = prompt(); const first = await submit(input); expect(first.status).toBe(201);
    expect((await store.get(workspace.id, creator)).state).toBe("starting");
    await store.transition(workspace.id, ["starting"], "stopped");
    expect((await submit(input)).status).toBe(200);
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
    expect((await (await status()).json()).items[0].payload).toEqual(input);
  });

  it("can refresh receipt states without reading or retransmitting saved prompt bodies", async () => {
    const input = prompt(); expect((await submit(input)).status).toBe(201);
    const response = await app().request(`/v1/cloud-v2/workspaces/${workspace.id}/prompts?chatId=native-chat&includePayload=false`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items).toMatchObject([{ receipt: { userMessageId: input.userMessageId }, state: "queued", payload: null }]);
    expect(JSON.stringify(result)).not.toContain("Reply with exactly");
    expect((await (await status()).json()).items[0].payload).toEqual(input);
  });

  it("orders concurrent sends per chat and does not dispatch the next before the first settles", async () => {
    const inputs = Array.from({ length: 6 }, () => prompt());
    const responses = await Promise.all(inputs.map(input => submit(input)));
    expect(responses.map(response => response.status)).toEqual(inputs.map(() => 201));
    const receipts = await Promise.all(responses.map(response => response.json()));
    expect(receipts.map(value => Number(value.receipt.sequence)).sort((a,b) => a-b)).toEqual([1,2,3,4,5,6]);
    const first = await inbox();
    expect(first.receipt.sequence).toBe("1"); expect((await pull()).prompts).toEqual([]);
    const dispatchId = randomUUID();
    expect(await (await worker("begin", { userMessageId: first.receipt.userMessageId, deliveryId: first.deliveryId, dispatchId })).json()).toMatchObject({ dispatch: true });
    expect((await pull()).prompts).toEqual([]);
    expect((await worker("outcome", { userMessageId: first.receipt.userMessageId, dispatchId, state: "completed" })).status).toBe(200);
    expect((await pull()).prompts[0]?.receipt.sequence).toBe("2");
  });

  it("separates inbox ACK from provider dispatch and never replays an ambiguous old-boot dispatch", async () => {
    const input = prompt(); expect((await submit(input)).status).toBe(201);
    const first = await inbox();
    expect((await (await status()).json()).items[0].state).toBe("inboxed");
    const dispatchId = randomUUID();
    const begin = { userMessageId: input.userMessageId, deliveryId: first.deliveryId, dispatchId };
    expect(await (await worker("begin", begin)).json()).toMatchObject({ dispatch: true, state: "dispatching" });
    expect(await (await worker("begin", begin)).json()).toMatchObject({ dispatch: true });
    expect((await worker("begin", { ...begin, dispatchId: randomUUID() })).status).toBe(409);
    boot = randomUUID(); await store.acceptWorkerHello(token, boot);
    expect((await pull()).prompts).toEqual([]);
    expect((await (await status()).json()).items[0].state).toBe("interrupted");
    expect((await submit(input)).status).toBe(200);
    expect((await pull()).prompts).toEqual([]);
  });

  it("redelivers an inboxed entry to a new boot with the same message id and a fresh delivery lease", async () => {
    expect((await submit()).status).toBe(201); const first = await inbox(); const previousBoot = boot;
    boot = randomUUID(); await store.acceptWorkerHello(token, boot);
    const second = (await pull()).prompts[0]!;
    expect(second.receipt).toEqual(first.receipt); expect(second.deliveryId).not.toBe(first.deliveryId);
    expect((await worker("ack", { userMessageId: first.receipt.userMessageId, deliveryId: first.deliveryId }, previousBoot)).status).toBe(401);
  });

  it("Stop cancels queued and inboxed rows atomically and fences a claim racing provider handoff", async () => {
    const first = prompt(), second = prompt();
    expect((await submit(first)).status).toBe(201); expect((await submit(second)).status).toBe(201);
    const item = await inbox();
    expect(await (await stop()).json()).toEqual({ chatId: "native-chat", epoch: "1" });
    expect(await (await worker("begin", { userMessageId: first.userMessageId, deliveryId: item.deliveryId, dispatchId: randomUUID() })).json()).toMatchObject({ dispatch: false, state: "cancelled" });
    expect((await (await status()).json()).items.map((item: { state: string }) => item.state)).toEqual(["cancelled", "cancelled"]);
    const next = prompt(); expect((await submit(next)).status).toBe(201);
    expect((await stop()).status).toBe(200); // retry of an old Stop cannot cancel a new epoch
    expect((await pull()).prompts[0]?.receipt.userMessageId).toBe(next.userMessageId);
  });

  it("a session sign-out leaves accepted work deliverable but account or membership loss fences it", async () => {
    const input = prompt(); expect((await submit(input)).status).toBe(201);
    await pool.query(`INSERT INTO security_events(kind,user_id,provider_session_id) VALUES('session.revoked',$1,'signed-out-device')`, [creator]);
    const item = await inbox();
    expect(item.receipt.userMessageId).toBe(input.userMessageId);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, creator]);
    // Both membership-removal paths publish this event in their transaction.
    await pool.query("INSERT INTO security_events(kind,user_id,org_id) VALUES('organization.access_revoked',$1,$2)", [creator, org]);
    expect((await worker("begin", { userMessageId: input.userMessageId, deliveryId: item.deliveryId, dispatchId: randomUUID() })).status).toBe(401);
    expect((await status()).status).toBe(404);
    expect((await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rows[0].state).toBe("cancelled");
  });

  it("fails closed for foreign owners, Personal organizations and an absent capability", async () => {
    expect((await submit(prompt(), randomUUID())).status).toBe(404);
    expect((await submit(prompt(), creator, false)).status).toBe(404);
    const document = await (await app().request(`/v1/cloud-v2/workspaces/${workspace.id}`)).json();
    expect(document.workspace.capabilities.promptOutbox).toBe(1);
    const legacy = await (await app(creator, false).request(`/v1/cloud-v2/workspaces/${workspace.id}`)).json();
    expect(legacy.workspace.capabilities.promptOutbox).toBeUndefined();
    const personal = randomUUID();
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Local',$3,true,false)`, [personal, `personal-${personal}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [personal, creator]);
    await pool.query("UPDATE cloud_v2_workspaces SET org_id=$2 WHERE id=$1", [workspace.id, personal]);
    expect((await submit()).status).toBe(404);
  });

  it("bounds payloads and refuses non-native IDs or unexpected prompt fields before accepting work", async () => {
    for (const extra of [{ chatId: "cloud:foreign:chat" }, { unexpected: true }, { prompt: [{ type: "text", text: 12 }] }, { agentId: "other" }]) {
      expect((await submit(prompt(randomUUID(), extra))).status).toBe(400);
    }
    expect((await submit(prompt(randomUUID(), { prompt: [{ type: "text", text: "a".repeat(8 * 1024 * 1024) }] }))).status).toBe(413);
  });

  it("erases prompt payloads and receipts with chat and workspace deletion", async () => {
    expect((await submit()).status).toBe(201);
    await store.writeHistory(workspace.id, { chatDeletions: ["native-chat"] });
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(0);
    expect((await submit()).status).toBe(409);
    expect((await submit(prompt(randomUUID(), { chatId: "other-chat" }))).status).toBe(201);
    await store.revoke(workspace.id, true);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(0);
  });

  it("resumes a send racing Stop only after Stop completes, and spends that wake once", async () => {
    await store.transition(workspace.id, ["running"], "stopping");
    expect((await submit()).status).toBe(201);
    await store.prompts.wakePending();
    expect((await store.get(workspace.id, creator)).state).toBe("stopping");
    await store.transition(workspace.id, ["stopping"], "stopped");
    await store.prompts.wakePending();
    expect((await store.get(workspace.id, creator)).state).toBe("starting");
    await store.transition(workspace.id, ["starting"], "stopped");
    await store.prompts.wakePending();
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it("rechecks pending work when an idle-stop observation races enqueue", async () => {
    const cutoff = new Date(Date.now() - 60_000);
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=now()-interval '1 hour' WHERE id=$1", [workspace.id]);
    expect(await store.idleSince(cutoff)).toHaveLength(1);
    expect((await submit()).status).toBe(201);
    await store.stopIdle(workspace.id, cutoff);
    expect((await store.get(workspace.id, creator)).state).toBe("running");
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=now()-interval '1 hour' WHERE id=$1", [workspace.id]);
    expect(await store.idleSince(cutoff)).toHaveLength(0);
  });

  it("bounds rows and bytes without rejecting idempotent retries at capacity", async () => {
    const outbox = new CloudV2PromptOutbox(pool, { ...CLOUD_V2_PROMPT_LIMITS, pending: 1, bytes: 1024 });
    const input = prompt();
    await outbox.enqueue(workspace.id, creator, input as never);
    expect((await outbox.enqueue(workspace.id, creator, input as never)).replay).toBe(true);
    await expect(outbox.enqueue(workspace.id, creator, prompt() as never)).rejects.toMatchObject({ code: "prompt_outbox_full" });
    await outbox.stop(workspace.id, creator, "native-chat", "0");
    const byteBound = prompt(randomUUID(), { prompt: [{ type: "text", text: "x".repeat(1024) }] });
    await expect(outbox.enqueue(workspace.id, creator, byteBound as never)).rejects.toMatchObject({ code: "prompt_outbox_full" });
    await new CloudV2PromptOutbox(pool, { ...CLOUD_V2_PROMPT_LIMITS, receipts: 1 }).enqueue(workspace.id, creator, input as never);
    await expect(new CloudV2PromptOutbox(pool, { ...CLOUD_V2_PROMPT_LIMITS, receipts: 1 }).enqueue(workspace.id, creator, prompt() as never))
      .rejects.toMatchObject({ code: "prompt_outbox_full" });
  });

  it("compacts old terminal payloads while retaining idempotency and pending payloads", async () => {
    const input = prompt(); expect((await submit(input)).status).toBe(201);
    await stop();
    await pool.query("UPDATE cloud_v2_prompt_outbox SET terminal_at=now()-interval '8 days' WHERE workspace_id=$1", [workspace.id]);
    expect((await submit(prompt(randomUUID(), { chatId: "another-chat" }))).status).toBe(201);
    await store.prompts.prune();
    const items = (await (await status()).json()).items;
    expect(items[0]).toMatchObject({ state: "cancelled", payload: null });
    expect((await submit(input)).status).toBe(200);
    expect((await submit({ ...input, model: "changed" })).status).toBe(409);
    expect((await pull()).prompts[0]?.payload.chatId).toBe("another-chat");
  });

  it("an explicit workspace Stop cancels earlier undelivered sends instead of waking them again", async () => {
    expect((await submit()).status).toBe(201);
    await store.requestLifecycle(workspace.id, creator, "stop");
    expect((await (await status()).json()).items[0].state).toBe("cancelled");
    await store.transition(workspace.id, ["stopping"], "stopped");
    await store.prompts.wakePending();
    expect((await store.get(workspace.id, creator)).state).toBe("stopped");
  });

  it("requires a durable inbox ACK before provider dispatch and preserves the dispatch outcome", async () => {
    expect((await submit()).status).toBe(201);
    const item = (await pull()).prompts[0]!, dispatchId = randomUUID();
    const begin = { userMessageId: item.receipt.userMessageId, deliveryId: item.deliveryId, dispatchId };
    expect((await worker("begin", begin)).status).toBe(409);
    expect((await worker("ack", begin)).status).toBe(400); // extra fields do not change the contract
    expect((await worker("ack", { userMessageId: begin.userMessageId, deliveryId: begin.deliveryId })).status).toBe(200);
    expect((await worker("begin", begin)).status).toBe(200);
    expect((await worker("outcome", { userMessageId: begin.userMessageId, dispatchId, state: "accepted" })).status).toBe(200);
    expect((await (await status()).json()).items[0].state).toBe("accepted");
    await stop();
    expect(await (await worker("begin", begin)).json()).toMatchObject({ dispatch: false });
    expect((await worker("outcome", { userMessageId: begin.userMessageId, dispatchId, state: "cancelled" })).status).toBe(200);
    expect(await (await worker("outcome", { userMessageId: begin.userMessageId, dispatchId, state: "accepted" })).json()).toEqual({ state: "cancelled" });
  });

  it("revalidates membership after waiting for a concurrent authority transaction", async () => {
    const held = await pool.connect();
    let sending: Promise<Response> | undefined;
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspace.id]);
      sending = Promise.resolve(submit());
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()");
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      await held.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, creator]);
      await held.query("INSERT INTO security_events(kind,user_id,org_id) VALUES('organization.access_revoked',$1,$2)", [creator, org]);
      await held.query("COMMIT");
      expect((await sending).status).toBe(404);
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(0);
    } finally { await held.query("ROLLBACK"); held.release(); await sending; }
  });

  it("bounds payload bytes on pulls and status pages before reading bodies from PostgreSQL", async () => {
    const outbox = new CloudV2PromptOutbox(pool, { ...CLOUD_V2_PROMPT_LIMITS, readBytes: 600 });
    for (const chatId of ["one", "one", "two", "three"]) {
      await outbox.enqueue(workspace.id, creator, prompt(randomUUID(), { chatId, prompt: [{ type: "text", text: "x".repeat(200) }] }) as never);
    }
    const pulled = await outbox.pull(token, boot);
    expect(pulled.prompts).toHaveLength(1);
    const first = await outbox.list(workspace.id, creator, "one");
    expect(first.items).toHaveLength(1); expect(first.nextAfter).toBe("1");
    const second = await outbox.list(workspace.id, creator, "one", first.nextAfter!);
    expect(second.items).toHaveLength(1); expect(second.nextAfter).toBeNull();
  });

  it("makes a new queued chat discoverable after app quit without manufacturing transcript order", async () => {
    await store.transition(workspace.id, ["running"], "stopped");
    const input = prompt(); expect((await submit(input)).status).toBe(201);
    expect(await store.listChats(workspace.id)).toMatchObject({ chats: [{ id: input.chatId, agentId: "codex", folder: "/home/user/example/project" }] });
    expect((await store.messageWindow(workspace.id, input.chatId, { limit: 100 })).messages).toEqual([]);
    expect((await (await status()).json()).items[0]).toMatchObject({ payload: input, state: "queued" });
  });

  it("settles a refused inbox or cold start without inventing provider acceptance", async () => {
    const input = prompt(); await submit(input); const item = await inbox();
    const outcome = { userMessageId: input.userMessageId, deliveryId: item.deliveryId, state: "failed" };
    expect((await worker("outcome", { ...outcome, deliveryId: randomUUID() })).status).toBe(409);
    expect((await worker("outcome", { ...outcome, state: "accepted" })).status).toBe(400);
    expect((await worker("outcome", outcome)).status).toBe(200);
    expect((await (await status()).json()).items[0]).toMatchObject({ state: "failed", payload: input });
    await submit(prompt()); expect((await pull()).prompts[0]?.receipt.sequence).toBe("2");
  });

  it("repairs a missed terminal report from disk after reboot without permitting dispatch", async () => {
    const input = prompt(); await submit(input); const item = await inbox(), dispatchId = randomUUID();
    await worker("begin", { userMessageId: input.userMessageId, deliveryId: item.deliveryId, dispatchId });
    boot = randomUUID(); await store.acceptWorkerHello(token, boot); await pull();
    expect((await worker("outcome", { userMessageId: input.userMessageId, dispatchId: randomUUID(), state: "completed" })).status).toBe(409);
    expect((await worker("outcome", { userMessageId: input.userMessageId, dispatchId, state: "accepted" })).status).toBe(409);
    expect((await worker("outcome", { userMessageId: input.userMessageId, dispatchId, state: "completed" })).status).toBe(200);
    expect((await (await status()).json()).items[0].state).toBe("completed");
    expect((await pull()).prompts).toEqual([]);
  });

  it("offers a steering message during the preceding turn but never overtakes queued work", async () => {
    await submit(); const item = await inbox();
    await worker("begin", { userMessageId: item.receipt.userMessageId, deliveryId: item.deliveryId, dispatchId: randomUUID() });
    const steer = prompt(randomUUID(), { mode: "steer" }); await submit(steer);
    expect((await pull()).prompts[0]?.receipt.userMessageId).toBe(steer.userMessageId);
    await submit(prompt()); await submit(prompt(randomUUID(), { mode: "steer" }));
    expect((await pull()).prompts).toEqual([]);
  });

  it("redelivers a lost pull response promptly while excluding the current worker's confirmed inbox", async () => {
    await submit(); const first = (await pull()).prompts[0]!;
    const retry = await worker("pull", { waitMs: 0, held: [] });
    expect(retry.status).toBe(200);
    expect((await retry.json()).prompts[0]).toEqual(first);
    const held = await worker("pull", { waitMs: 0, held: [first.receipt.userMessageId] });
    expect((await held.json()).prompts).toEqual([]);
  });

  it("lets the current worker durably fence an older desktop's bridge Stop", async () => {
    await submit(); await submit();
    expect((await worker("stop", { chatId: "native-chat", throughEpoch: "0" })).status).toBe(200);
    expect((await (await status()).json()).items.map((item: { state: string }) => item.state)).toEqual(["cancelled", "cancelled"]);
    const next = prompt(); await submit(next);
    await worker("stop", { chatId: "native-chat", throughEpoch: "0" });
    expect((await pull()).prompts[0]?.receipt.userMessageId).toBe(next.userMessageId);
  });
});
