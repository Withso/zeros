import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("current Creator availability survives missed notifications", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true }); await f.cp.loginChanges.stop(); await f.login(); await f.activate();
    const hello = await f.hello(); expect(hello.status).toBe(200);
    const id = (await hello.json()).config.bootstrapContextId;
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(200);
    expect((await f.worker(`execution-leases/${id}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const config = async () => {
    const result = await f.worker("config", undefined, { method: "GET", features: `${f.features},creator-agent-logins-v1` });
    expect(result.status).toBe(200); return (await result.json()).config;
  };
  const nMinusOne = async (sql: string, values: unknown[]) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      expect((await tx.query(sql, values)).rowCount).toBe(1);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  };

  it.each(["membership", "account", "disconnect"])("advances availability at the next heartbeat after an N-1 %s writer with no listener", async action => {
    const before = await config(); expect(before.agentLogins).toEqual({ claude: true });
    if (action === "membership") await nMinusOne("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]);
    else if (action === "account") await nMinusOne("UPDATE users SET auth_status='suspended',auth_revision=auth_revision+1 WHERE id=$1", [f.creator.id]);
    else await nMinusOne("UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',revision=revision+1 WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]);
    if (action === "disconnect") expect(await f.cp.store.loginRevision(f.workspace.id)).toBe(before.loginRevision);
    const heartbeat = await f.worker("activity", { idle: true }); expect(heartbeat.status).toBe(200);
    expect(BigInt((await heartbeat.json()).loginRevision)).toBeGreaterThan(BigInt(before.loginRevision));
    const after = await config(); expect(after.agentLogins).toEqual({});
    const next = await config(); expect(next.loginRevision).toBe(after.loginRevision);
  });

  it("detects clock-driven Hold without a writer or listener and leaves B's work admitted", async () => {
    for (let n = 0; n < 5; n++) {
      const id = randomUUID();
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',now()-interval '1 day')", [f.organizationId, id]);
    }
    await pool.query("UPDATE account_entitlements SET valid_until=clock_timestamp()+interval '2 seconds' WHERE user_id=$1", [f.creator.id]);
    const before = await config(); expect(before.agentLogins).toEqual({ claude: true });
    const held = async () => (await withSystemTx(pool, tx => tx.query("SELECT organization_member_on_hold($1,$2,10,5) AS held", [f.organizationId,f.creator.id]))).rows[0].held;
    expect(await held()).toBe(false);
    await expect.poll(held, { timeout: 4000 }).toBe(true);
    expect(await f.cp.store.loginRevision(f.workspace.id)).toBe(before.loginRevision);
    const heartbeat = await f.worker("activity", { idle: true }); expect(heartbeat.status).toBe(200);
    expect(BigInt((await heartbeat.json()).loginRevision)).toBeGreaterThan(BigInt(before.loginRevision));
    expect((await config()).agentLogins).toEqual({});
    expect(await f.cp.execution.maintenance.due()).toContain(f.workspace.id);
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    expect((await pool.query("SELECT creator_user_id,creator_absent_reason FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ creator_user_id: null, creator_absent_reason: "hold" });
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" })).status).toBe(200);
  });

  it("cannot replace a newer Creator map with a late replica's older snapshot", async () => {
    await config(); await f.login(f.admin, "cursor");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const logins = f.cp.execution.deps.logins, read = logins.availability.bind(logins);
    vi.spyOn(logins, "availability").mockImplementationOnce(async (...args) => {
      const value = await read(...args); entered.resolve(); await release.promise; return value;
    });
    const old = logins.refreshAvailability(f.workspace.id);
    try {
      await entered.promise;
      await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id,f.admin.id]));
      const newer = await logins.refreshAvailability(f.workspace.id);
      release.resolve();
      expect(BigInt((await old)!)).toBeLessThanOrEqual(BigInt(newer!));
      expect((await pool.query("SELECT creator_agent_logins FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].creator_agent_logins).toEqual({ cursor: true });
    } finally { release.resolve(); await old; }
  });
});
