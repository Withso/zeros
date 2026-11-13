import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("persisted lifecycle execution identity", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const ready = { exitCode: 0, stdout: "", timedOut: false };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { lifecycle: true });
    // This suite drives one lifecycle tick. Drain notification maintenance so
    // its workspace lock cannot make that tick's SKIP LOCKED claim miss.
    await f.cp.loginChanges.stop();
    await f.activate(f.viewer);
    await pool.query("UPDATE cloud_v2_workspaces SET state='creating',lease_renewed_at=clock_timestamp() WHERE id=$1", [f.workspace.id]);
    vi.spyOn(f.cp.compute, "exec").mockResolvedValue(ready);
    vi.spyOn(f.cp.compute, "execLong").mockResolvedValue(ready);
    vi.spyOn(f.cp.compute, "hostPort").mockResolvedValue({ url: "https://worker.example.test", token: "synthetic-port-value" });
    vi.spyOn(f.cp.store, "workspaceImage").mockResolvedValue({ from: "fixture", prune: [], checkout: false });
    vi.spyOn(f.cp.runtimeUpdates, "tick").mockResolvedValue();
    f.fetcher.mockClear();
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("authorizes the persisted initiator and leaves personal checkout material to the clean worker", async () => {
    const admission = vi.spyOn(f.cp.execution.deps.authority, "admit");
    await f.cp.lifecycle!.tick();
    expect(admission).toHaveBeenCalled();
    expect(admission.mock.calls.every(([id, user]) => id === f.workspace.id && user === f.viewer.id)).toBe(true);
    expect(f.cp.compute.execLong).not.toHaveBeenCalled();
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([, command]) => command.includes("systemctl restart zeros-worker.service"))).toBe(true);
    expect(JSON.stringify(vi.mocked(f.cp.compute.exec).mock.calls)).not.toContain(`synthetic-${f.viewer.id}`);
  });

  it("never falls back to the Creator when the initiator has gone", async () => {
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.execLong).not.toHaveBeenCalled();
    expect(f.cp.compute.exec).not.toHaveBeenCalled();
  });

  it("does not revive a persisted intent after the initiator leaves and rejoins while the listener is down", async () => {
    await f.cp.loginChanges.stop();
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.organizationId, f.viewer.id]);
    const scope = { organizationId: f.organizationId, userId: f.viewer.id };
    await f.github.connections.store.save(scope, await f.github.connections.store.fingerprint(scope),
      { id: "12", login: "fixture" }, { method: "pat", accessToken: `synthetic-${f.viewer.id}`, expiresAt: null });
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.execLong).not.toHaveBeenCalled();
    expect(f.cp.compute.exec).not.toHaveBeenCalled();
  });

  it("does not deliver the worker token after access changes during runtime installation", async () => {
    vi.mocked(f.cp.compute.exec).mockImplementationOnce(async () => {
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      return ready;
    });
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.execLong).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int n FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])).rows[0].n).toBe(0);
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([, command]) => command.includes("systemctl restart zeros-worker.service"))).toBe(false);
  });

  it("does not deliver the worker token after Stop supersedes runtime installation", async () => {
    vi.mocked(f.cp.compute.exec).mockImplementationOnce(async () => {
      await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
      return ready;
    });
    await f.cp.lifecycle!.tick();
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].state).toBe("stopping");
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([, command]) => command.includes("systemctl restart zeros-worker.service"))).toBe(false);
  });
});
