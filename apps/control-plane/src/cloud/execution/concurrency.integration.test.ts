import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("execution fences across held material and database locks", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.login(f.viewer); await f.activate();
    expect((await f.hello()).status).toBe(200); await f.cp.loginChanges.stop(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const changes = {
    member: () => withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])),
    account: () => withSystemTx(pool, tx => tx.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.viewer.id])),
    credential: () => withSystemTx(pool, tx => tx.query("UPDATE cloud_agent_credentials SET revision=revision+1,revoked_at=clock_timestamp() WHERE owner_user_id=$1", [f.viewer.id])),
    source: () => withSystemTx(pool, tx => tx.query("UPDATE cloud_github_source_verifications SET failure_code='github_repository_access_required',failure_status=403 WHERE owner_user_id=$1", [f.viewer.id])),
    stop: () => f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST"),
  };

  it.each(Object.keys(changes) as Array<keyof typeof changes>)("rechecks %s after material resolves and returns no stale credential", async kind => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const material = f.cp.execution.deps.material;
    vi.spyOn(f.cp.execution.deps, "material").mockImplementationOnce(async (...args) => {
      const value = await material(...args); entered(); await held; return value;
    });
    const leasing = f.worker("turn-lease", turn.lease);
    await observed;
    try { await changes[kind](); } finally { release(); }
    const response = await leasing;
    expect([401, 403, 409]).toContain(response.status);
    const body = await response.json();
    for (const field of ["agents", "environment", "api", "mcpServers"]) expect(body).not.toHaveProperty(field);
    expect((await pool.query("SELECT material FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0].material).toBeNull();
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_tokens WHERE context_id=$1", [turn.begun.contextId])).rowCount).toBe(0);
  });

  it.each(["member", "account", "credential"] as const)("finishes a held lease and concurrent %s revocation without reversing the workspace lock order", async kind => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.cp.execution.context.bind(f.cp.execution);
    let holder = 0, heldOnce = false;
    vi.spyOn(f.cp.execution, "context").mockImplementation(async (tx, id, workspace, lock) => {
      const context = await original(tx, id, workspace, lock);
      if (lock && id === turn.begun.contextId && !heldOnce) {
        heldOnce = true; holder = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        entered(); await held;
      }
      return context;
    });
    const leasing = f.worker("turn-lease", turn.lease);
    await observed;
    const revoking = changes[kind]();
    try {
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [holder])).rowCount)
        .toBeGreaterThan(0);
    } finally { release(); }
    const response = await leasing; await revoking;
    expect([200, 401, 403, 409]).toContain(response.status);
    const after = await f.worker("turn-lease", turn.lease);
    expect([401, 403, 409]).toContain(after.status);
    expect((await pool.query("SELECT material FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0].material).toBeNull();
  });

  it("shares workspace-first locking with history, Stop and boot cleanup", async () => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    const tx = await pool.connect();
    await tx.query("BEGIN"); await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
    const holder = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const work = [
      f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: "chat", agentId: "claude", title: "Confirmed" }] }),
      f.worker("execution-leases/" + turn.begun.contextId + "/retired", { retirementId: randomUUID(), reason: "outcome", processes: 0 }),
      f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST"),
    ];
    try {
      await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [holder])).rows[0].n)
        .toBeGreaterThan(0);
    } finally { await tx.query("COMMIT"); tx.release(); }
    const [, retired, stopped] = await Promise.all(work);
    expect((stopped as Response).status).toBe(202);
    expect([200, 401, 409]).toContain((retired as Response).status);
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0].state).not.toBe("active");
  });

  it("finishes reverse-order multi-context renewal and an account revocation without a deadlock", async () => {
    const first = await f.dispatch(f.prompt(randomUUID(), { chatId: "first" }), f.viewer);
    const second = await f.dispatch(f.prompt(randomUUID(), { chatId: "second" }), f.viewer);
    let entered!: () => void, release!: () => void, holder = 0, heldOnce = false;
    const seen = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.cp.execution.context.bind(f.cp.execution);
    vi.spyOn(f.cp.execution, "context").mockImplementation(async (tx, id, workspace, lock) => {
      const row = await original(tx, id, workspace, lock);
      if (lock && id === second.begun.contextId && !heldOnce) {
        heldOnce = true; holder = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        entered(); await held;
      }
      return row;
    });
    const renewal = f.worker("execution-leases/renew", { contextIds: [second.begun.contextId, first.begun.contextId] });
    await seen;
    const revoked = changes.account().then(() => null, error => error);
    try {
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [holder])).rowCount)
        .toBeGreaterThan(0);
    } finally { release(); }
    expect(await revoked).toBeNull();
    expect((await renewal).status).toBe(200);
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=ANY($1::uuid[])", [[first.begun.contextId, second.begun.contextId]])).rows)
      .toEqual([{ state: "revoked" }, { state: "revoked" }]);
  }, 15_000);
});
