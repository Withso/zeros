import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { LiveRecoveryStore } from "./live-recovery-store.js";
import { LiveRecoverySignals } from "./live-recovery-signals.js";
import { CloudV2Store } from "./store.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";
import type { WorkerRoute } from "./worker-connection.js";
import { CloudV2PromptPullReplySchema } from "./prompt-contract.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("live route recovery with PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  async function fixture() {
    const user = randomUUID(), organization = randomUUID(), boot = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [organization, `org-${organization}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organization, user]);
    const store = new CloudV2Store(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: organization, creatorUserId: user,
      name: "Route recovery", repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    await store.setWorkerRoute(workspace.id, "bx_fixture1234", "https://fixture-41783.on.boat.dev", { value: "synthetic-sealed-port" });
    const token = await store.rotateWorkerToken(workspace.id);
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot);
    const route: WorkerRoute = { ...(await store.workerRoute(workspace.id))!, token: "synthetic-port-token" };
    const repair = new LiveRecoveryStore(pool);
    return { user, workspace, store, repair, route, token, boot };
  }

  it("keeps the running workspace and private route while publishing a closed failure condition", async () => {
    const f = await fixture(), before = await f.store.get(f.workspace.id, f.user);
    expect(await f.repair.condition(f.route, true)).toBe(true);
    const failed = await f.store.get(f.workspace.id, f.user);
    expect(failed).toMatchObject({ id: before.id, name: before.name, state: "running", errorCode: "live_connection_unavailable" });
    expect(failed.updatedAt).not.toBe(before.updatedAt);
    expect((await f.store.workerRoute(f.workspace.id))!.portToken).toEqual(f.route.portToken);
    expect(JSON.stringify(await f.store.get(f.workspace.id, f.user))).not.toMatch(/synthetic|on\.boat\.dev/);
    expect(await f.repair.condition(f.route, false)).toBe(true);
    expect((await f.store.get(f.workspace.id, f.user)).errorCode).toBeNull();
  });

  it.each([
    ["Stop", "state='stopping'"], ["boot", "worker_boot_id=gen_random_uuid()"], ["access", "access_epoch=access_epoch+1"],
    ["sandbox", "boat_sandbox_id='bx_successor1234'"], ["token", "worker_token_hash=decode(repeat('b',64),'hex')"],
    ["route credential", "worker_port_token='{\"value\":\"synthetic-successor\"}'::jsonb"], ["archive", "archived_at=clock_timestamp()"],
  ])("does not overwrite a concurrent %s change after verification", async (_name, change) => {
    const f = await fixture();
    await pool.query(`UPDATE cloud_v2_workspaces SET ${change} WHERE id=$1`, [f.workspace.id]);
    expect(await f.repair.condition(f.route, true)).toBe(false);
    expect((await pool.query("SELECT worker_route_url,error_code FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ worker_route_url: f.route.url, error_code: null });
  });

  it("gets fresh outbound proof from another API replica through the real legacy-compatible pull route", async () => {
    const f = await fixture();
    const listenA = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const listenB = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const a = new LiveRecoverySignals(pool, listenA), b = new LiveRecoverySignals(pool, listenB);
    try {
      await Promise.all([a.start(), b.start()]);
      const binding = { workspaceId: f.workspace.id, bootId: f.boot, sandboxId: "bx_fixture1234", accessEpoch: f.route.accessEpoch };
      const query = vi.spyOn(pool, "connect"); await b.worker(binding); expect(query).not.toHaveBeenCalled(); query.mockRestore();
      const app = new Hono();
      app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
      app.route("/", createCloudV2WorkerRoutes({ store: f.store, promptOutbox: true, runtimeSha256: "a".repeat(64),
        config: async () => { throw new Error("Unexpected configuration"); }, githubToken: async () => { throw new Error("Unexpected credential"); },
        outboundProof: input => b.worker(input) }));
      const pull = () => app.request("/v2/cloud/worker/prompts/pull", { method: "POST", headers: { authorization: `Bearer ${f.token}`,
        "x-zeros-worker-boot": f.boot, "content-type": "application/json", "x-zeros-worker-features": "prompt-outbox-v1" }, body: JSON.stringify({ waitMs: 0 }) });
      const first = await a.watch(binding, Date.now() + 60_000);
      await b.worker({ ...binding, bootId: randomUUID() }); expect(first.seen()).toBe(false);
      await vi.waitFor(async () => {
        const response = await pull(); expect(response.status).toBe(200); expect(CloudV2PromptPullReplySchema.safeParse(await response.json()).success).toBe(true);
        expect(first.seen()).toBe(true);
      });
      first.dispose();
      const next = await a.watch(binding, Date.now() + 60_000); expect(next.seen()).toBe(false);
      await vi.waitFor(async () => { expect((await pull()).status).toBe(200); expect(next.seen()).toBe(true); });
      await a.stop(); expect(next.seen()).toBe(false);
    } finally { await Promise.all([a.stop(), b.stop()]); await Promise.all([listenA.end(), listenB.end()]); }
  });
});
