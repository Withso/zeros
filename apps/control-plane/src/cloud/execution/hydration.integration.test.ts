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

  it("hydrates with the persisted initiator's own credential", async () => {
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.execLong).toHaveBeenCalledOnce();
    const input = vi.mocked(f.cp.compute.execLong).mock.calls[0]![3];
    expect(input).toBe(`Authorization: Basic ${Buffer.from(`x-access-token:synthetic-${f.viewer.id}`).toString("base64")}\n`);
    expect(f.fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer synthetic-${f.viewer.id}`)).toBe(true);
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

  it("does not deliver the worker token after access changes during checkout", async () => {
    vi.mocked(f.cp.compute.execLong).mockImplementationOnce(async () => {
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      return ready;
    });
    await f.cp.lifecycle!.tick();
    expect(f.cp.compute.execLong).toHaveBeenCalledOnce();
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([, command]) => command.includes("systemctl restart zeros-worker.service"))).toBe(false);
  });

  it("does not deliver the worker token after Stop supersedes a held checkout", async () => {
    vi.mocked(f.cp.compute.execLong).mockImplementationOnce(async () => {
      await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
      return ready;
    });
    await f.cp.lifecycle!.tick();
    expect(vi.mocked(f.cp.compute.exec).mock.calls.some(([, command]) => command.includes("systemctl restart zeros-worker.service"))).toBe(false);
  });
});
