import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { requestTiming, type RequestDatabaseCost } from "../request-timing.js";
import { CloudV2Store } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("relay worker activity authority", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));

  async function fixture() {
    const creator = randomUUID(), organization = randomUUID(), store = new CloudV2Store(pool);
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [organization, `org-${organization}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organization, creator]);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: organization, creatorUserId: creator,
      repository: "example/project", branch: "topic", baseBranch: "main", name: "Project", computerBuildId: null });
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.acceptWorkerHello(token, boot);
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()-interval '5 minutes' WHERE id=$1", [workspace.id]);
    const route = (await store.workerRoute(workspace.id))!;
    const proof = { workspaceId: workspace.id, bootId: boot, accessEpoch: route.accessEpoch, workerTokenHash: route.workerTokenHash! };
    return { store, workspace, creator, organization, token, boot, proof };
  }

  it("uses one database round trip for idle safety and hints only durable pending work", async () => {
    const f = await fixture(), costs: RequestDatabaseCost[] = [], app = new Hono();
    const before = await f.store.get(f.workspace.id, f.creator);
    app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: cost => { costs.push(cost); } }));
    app.get("/status", async c => c.json(await f.store.relayActivity(f.proof, true)));
    const response = await app.request("/status");
    expect(await response.json()).toMatchObject({ state: "running", promptsPending: false });
    console.info("Idle relay status cost", costs.map(cost => ({ queries: cost.queriesStarted, transactions: cost.transactions, statements: cost.sqlStatements })));
    expect(costs.at(-1)).toMatchObject({ queriesStarted: 1, transactions: 1, sqlStatements: 5 });
    expect((await f.store.get(f.workspace.id, f.creator)).activeAt).toBe(before.activeAt);
    expect(before).not.toHaveProperty("workerTokenHash");
    await f.store.prompts.enqueue(f.workspace.id, f.creator, { chatId: "chat", userMessageId: randomUUID(),
      agentId: "codex", prompt: [{ type: "text", text: "ok" }], startedAt: 1 });
    expect(await f.store.relayActivity(f.proof, true)).toMatchObject({ promptsPending: true });
    const batch = await f.store.prompts.pull(f.token, f.boot);
    const item = batch.prompts[0]!;
    await f.store.prompts.outcome(f.token, f.boot, { userMessageId: item.receipt.userMessageId, deliveryId: item.deliveryId, state: "failed" });
    expect(await f.store.relayActivity(f.proof, true)).toMatchObject({ promptsPending: false });
    await f.store.prompts.stop(f.workspace.id, f.creator, "chat", "0");
    expect(await f.store.relayActivity(f.proof, true)).toMatchObject({ promptsPending: true });
    await f.store.prompts.ackStop(f.token, f.boot, { chatId: "chat", epoch: "1" });
    expect(await f.store.relayActivity(f.proof, true)).toMatchObject({ promptsPending: false });
  });

  it("does not take a mutation lock while reading idle status", async () => {
    const f = await fixture(), blocker = await pool.connect();
    let done = false, pending: ReturnType<CloudV2Store["relayActivity"]> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      pending = f.store.relayActivity(f.proof, true).finally(() => { done = true; });
      await vi.waitFor(async () => {
        const blocked = (await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
        expect(done || blocked).toBe(true);
      });
      expect(done).toBe(true);
      expect(await pending).toMatchObject({ state: "running" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("refuses an idle status read under another workspace, boot, generation or credential", async () => {
    const f = await fixture();
    for (const delta of [{ workspaceId: randomUUID() }, { bootId: randomUUID() },
      { accessEpoch: (BigInt(f.proof.accessEpoch) + 1n).toString() }, { workerTokenHash: "b".repeat(64) }])
      expect(await f.store.relayActivity({ ...f.proof, ...delta }, true)).toBeNull();
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organization, f.creator]);
    expect(await f.store.relayActivity(f.proof, true)).toBeNull();
  });

  it.each(["boot", "token", "epoch", "membership", "cloud-disabled", "stop"])("rechecks %s after a busy activity waits for the workspace lock", async change => {
    const f = await fixture(), before = await f.store.get(f.workspace.id, f.creator), blocker = await pool.connect();
    let pending: ReturnType<CloudV2Store["relayActivity"]> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      pending = f.store.relayActivity(f.proof, false);
      await vi.waitFor(async () => expect((await pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting).toBe(true));
      if (change === "boot") await blocker.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2 WHERE id=$1", [f.workspace.id, randomUUID()]);
      if (change === "token") await blocker.query("UPDATE cloud_v2_workspaces SET worker_token_hash=decode(repeat('b',64),'hex') WHERE id=$1", [f.workspace.id]);
      if (change === "epoch") await blocker.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspace.id]);
      if (change === "membership") await blocker.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organization, f.creator]);
      if (change === "cloud-disabled") await blocker.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organization]);
      if (change === "stop") await blocker.query("UPDATE cloud_v2_workspaces SET state='stopping' WHERE id=$1", [f.workspace.id]);
      await blocker.query("COMMIT");
      const result = await pending;
      if (change === "stop") expect(result).toMatchObject({ state: "stopping" });
      else expect(result).toBeNull();
      const active = (await pool.query("SELECT active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].active_at;
      expect(active.toISOString()).toBe(before.activeAt);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });
});
