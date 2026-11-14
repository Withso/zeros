import { randomUUID } from "node:crypto";
import { Hono, type ErrorHandler } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { CloudV2PromptPullReplySchema } from "./prompt-contract.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite.each(["active", "legacy"] as const)("%s prompt writers take the workspace fence first", mode => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const actor = () => mode === "active" ? f.viewer : f.creator;
  const input = (chatId = "a") => f.prompt(`message-${chatId}`, { chatId });
  const statuses = async () => (await pool.query("SELECT chat_id,state,cancel_requested FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 ORDER BY chat_id", [f.workspace.id])).rows;
  const revision = async (chatId = "a") => Number((await pool.query("SELECT revision::text FROM cloud_v2_prompt_cache WHERE workspace_id=$1 AND chat_id=$2", [f.workspace.id, chatId])).rows[0]?.revision ?? 0);
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login();
    if (mode === "active") await f.activate();
    expect((await f.hello(`${f.features},creator-agent-logins-v1`)).status).toBe(200);
    await f.cp.loginChanges.stop();
    for (const chat of ["a", "b"]) expect((await f.send(input(chat), actor())).status).toBe(201);
  });

  async function blocked<T>(work: () => Promise<T>): Promise<T> {
    const owner = await pool.connect();
    let pending: Promise<PromiseSettledResult<T>> | undefined;
    try {
      await owner.query("BEGIN");
      const pid = (await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await owner.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      let settled = false;
      pending = work().then(value => { settled = true; return { status: "fulfilled", value } as const; }, reason => {
        settled = true; return { status: "rejected", reason } as const;
      });
      await vi.waitFor(async () => {
        expect(settled).toBe(false);
        expect((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount).toBeGreaterThan(0);
      }, { timeout: 3000 });
      await owner.query("COMMIT");
      const result = await pending;
      if (result.status === "rejected") throw result.reason;
      return result.value;
    } finally {
      await owner.query("ROLLBACK"); owner.release();
      await pending;
    }
  }

  async function delivery() {
    const response = await f.worker("prompts/pull", { waitMs: 0, held: [] });
    expect(response.status).toBe(200);
    const row = CloudV2PromptPullReplySchema.parse(await response.json()).prompts.find(prompt => prompt.payload.chatId === "a")!;
    return { userMessageId: row.payload.userMessageId, deliveryId: row.deliveryId };
  }

  it("waits before enqueue and then commits the new receipt and cache revision", async () => {
    expect((await blocked(() => f.send(input("c"), actor()))).status).toBe(201);
    expect(await revision("c")).toBeGreaterThan(0);
    expect((await statuses()).find(row => row.chat_id === "c").state).toBe("queued");
  });

  it("waits before worker pull/claim, including old-boot interruption across chats", async () => {
    await pool.query("UPDATE cloud_v2_prompt_outbox SET state='dispatching',worker_boot_id=$2,dispatch_id=$3 WHERE workspace_id=$1 AND chat_id='a'", [f.workspace.id, randomUUID(), randomUUID()]);
    const before = await revision();
    const response = await blocked(() => f.worker("prompts/pull", { waitMs: 0, held: [] }));
    expect(response.status).toBe(200);
    expect(CloudV2PromptPullReplySchema.parse(await response.json()).prompts.map(row => row.payload.chatId)).toEqual(["b"]);
    expect((await statuses())[0].state).toBe("interrupted");
    expect(await revision()).toBeGreaterThan(before);
  });

  it("waits before ACK and then records the inboxed state", async () => {
    const claim = await delivery(), before = await revision();
    expect((await blocked(() => f.worker("prompts/ack", claim))).status).toBe(200);
    expect((await statuses())[0].state).toBe("inboxed");
    expect(await revision()).toBeGreaterThan(before);
  });

  it("waits before begin and then dispatches the saved message", async () => {
    const claim = await delivery();
    expect((await f.worker("prompts/ack", claim)).status).toBe(200);
    const before = await revision();
    expect((await blocked(() => f.worker("prompts/begin", { ...claim, dispatchId: randomUUID() }))).status).toBe(200);
    expect((await statuses())[0].state).toBe("dispatching");
    expect(await revision()).toBeGreaterThan(before);
  });

  it("waits before outcome and then commits the terminal receipt", async () => {
    const claim = await delivery(), dispatchId = randomUUID();
    expect((await f.worker("prompts/ack", claim)).status).toBe(200);
    expect((await f.worker("prompts/begin", { ...claim, dispatchId })).status).toBe(200);
    const before = await revision();
    expect((await blocked(() => f.worker("prompts/outcome", { userMessageId: claim.userMessageId, dispatchId, state: "completed" }))).status).toBe(200);
    expect((await statuses())[0].state).toBe("completed");
    expect(await revision()).toBeGreaterThan(before);
  });

  it.each(["user", "worker"] as const)("waits before %s cancel and then advances the chat epoch", async caller => {
    const before = await revision(), body = { chatId: "a", throughEpoch: "0" };
    const response = await blocked(() => caller === "worker" ? f.worker("prompts/stop", body)
      : f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", body, actor(), { "X-Zeros-Team-Sharing": "1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chatId: "a", epoch: "1" });
    expect((await statuses())[0]).toMatchObject({ state: "cancelled", cancel_requested: true });
    expect(await revision()).toBeGreaterThan(before);
  });

  it("waits before workspace Stop and then cancels both chats", async () => {
    const before = await revision();
    expect((await blocked(() => f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST", undefined, actor(), { "X-Zeros-Team-Sharing": "1" }))).status).toBe(202);
    expect((await statuses()).map(row => row.state)).toEqual(["cancelled", "cancelled"]);
    expect(await revision()).toBeGreaterThan(before);
  });

  it("waits before the checkout-failure access-epoch cut and then cancels both chats", async () => {
    const before = await revision();
    expect(await blocked(() => f.cp.store.failWorkerCheckout(f.token, f.boot))).toBe(true);
    expect((await statuses()).map(row => row.state)).toEqual(["cancelled", "cancelled"]);
    expect(await revision()).toBeGreaterThan(before);
  });

  if (mode === "active") {
    it("waits before execution maintenance reconciles a member cut", async () => {
      await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
      const before = await revision();
      await blocked(() => f.cp.execution.maintenance.workspace(f.workspace.id));
      expect((await statuses()).map(row => row.state)).toEqual(["cancelled", "cancelled"]);
      expect(await revision()).toBeGreaterThan(before);
    });

    it("names a missed prompt fence by route without logging PostgreSQL context or request data", async () => {
      const app = new Hono();
      app.onError((f.app as unknown as { errorHandler: ErrorHandler }).errorHandler);
      app.post("/test-prompt-fence/:id", async c => {
        await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_prompt_outbox SET state='inboxed' WHERE workspace_id=$1 AND chat_id='a'", [f.workspace.id]));
        return c.json({ ok: true });
      });
      const owner = await pool.connect(), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const sentinel = "private-request-value";
      try {
        await owner.query("BEGIN");
        await owner.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
        const response = await app.request(`/test-prompt-fence/${sentinel}?detail=${sentinel}`, { method: "POST", body: sentinel });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
        expect(warn).toHaveBeenCalledExactlyOnceWith("[cloud-v2] prompt_cache_workspace_fence_missed", {
          method: "POST", route: "/test-prompt-fence/:id", sqlState: "55P03",
        });
        const logged = JSON.stringify([warn.mock.calls, error.mock.calls]);
        expect(logged).not.toContain(sentinel);
        expect(logged).not.toContain(f.workspace.id);
        expect(logged).not.toContain("UPDATE cloud_v2_prompt_outbox");
      } finally { await owner.query("ROLLBACK"); owner.release(); }
    });
  }
});
