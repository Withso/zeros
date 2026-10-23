import { describe, it, expect, vi } from "vitest";
import { drainHostedWorkers, validateHostedDatabaseRequest } from "../dev-environment/hosted-database.mjs";
import * as database from "../dev-environment/hosted-database.mjs";
import * as services from "../dev-environment/hosted-services.mjs";
const owner = "a".repeat(24), generation = "11111111-1111-4111-8111-111111111111";
const request = { owner, generation, backendStopped: true };
function fixture(workspaces: any[] = [], builds: any[] = [], computers: any[] = []) {
  const pool = { query: vi.fn(async () => ({ rows: [{ owner, generation }] })) };
  const queries: string[] = [];
  const withSystemTx = vi.fn(async (_pool, fn) => fn({ query: async (sql: string) => {
    queries.push(sql);
    return { rows: sql.includes("SELECT") ? sql.includes("FROM cloud_v2_workspaces") ? workspaces :
      sql.includes("FROM cloud_v2_computer_builds") ? builds : sql.includes("FROM cloud_v2_computers") ? computers : [] : [] };
  } }));
  const provider = { delete: vi.fn(async () => {}), deleteSnapshot: vi.fn(async () => {}) };
  return { pool, withSystemTx, provider, request, queries };
}
describe("Dev database archive", () => {
  it("repairs expired runtime authority for archive and retries interrupted grants before draining", async () => {
    const lease: any = { state: { steps: { backendStopped: true, railwayDeleted: true } }, save: vi.fn() };
    const calls: string[] = [];
    const dependencies = { verify: vi.fn(async () => { calls.push("verify"); throw new Error("expired"); }),
      ensure: vi.fn(async () => { calls.push("rotate"); }), repair: vi.fn(async () => { calls.push("grant"); throw new Error("interrupted"); }),
      retire: vi.fn(async () => { calls.push("retire-migration"); }) };
    await expect((services as any).ensureHostedDrainAuthority(lease, dependencies)).rejects.toThrow("interrupted");
    expect(lease.state.drainRuntimeRepair).toBe(true);
    dependencies.verify.mockResolvedValue(undefined); dependencies.repair.mockResolvedValue(undefined);
    await (services as any).ensureHostedDrainAuthority(lease, dependencies);
    expect(dependencies.repair).toHaveBeenCalledTimes(2); expect(dependencies.verify).toHaveBeenCalledOnce();
    expect(lease.state.drainRuntimeRepair).toBeUndefined();
    expect(calls.slice(0, 4)).toEqual(["verify", "rotate", "grant", "retire-migration"]);
  });
  it("fences repair to the stopped backend and exact DB owner before granting runtime access", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ owner, generation: "other" }] })) };
    const input = { ...request, roles: { runtime: { baseUsername: "pscale_api_runtime" } } };
    await expect((database as any).repairHostedRuntimeAuthority(pool, input)).rejects.toThrow(/generation/);
    expect(pool.query).toHaveBeenCalledOnce();
    pool.query.mockClear();
    await expect((database as any).repairHostedRuntimeAuthority(pool, { ...input, backendStopped: false })).rejects.toThrow(/Stop/);
    expect(pool.query).not.toHaveBeenCalled();
    pool.query.mockResolvedValue({ rows: [{ owner, generation }] });
    await (database as any).repairHostedRuntimeAuthority(pool, input);
    expect(pool.query.mock.calls.map(args => args[0])).toContain('GRANT zeros_app TO "pscale_api_runtime"');
    expect(pool.query.mock.calls.map(args => args[0]).join("\n")).not.toMatch(/CREATE TABLE|INSERT/);
  });

  it("refuses another generation before any query can supersede work", async () => {
    const f = fixture(); f.pool.query.mockResolvedValue({ rows: [{ owner, generation: "different" }] });
    await expect(drainHostedWorkers(f)).rejects.toThrow(/generation/);
    expect(f.withSystemTx).not.toHaveBeenCalled(); expect(f.provider.delete).not.toHaveBeenCalled();
  });

  it("deletes v2 workspace VMs, builders and each snapshot once before completing archive", async () => {
    const f = fixture([{ id: "workspace", state: "running", boat_sandbox_id: "bx_workspace" }],
      [{ id: "build", state: "succeeded", builder_sandbox_id: "bx_builder", snapshot_id: "org-computer" }],
      [{ snapshot_name: "org-computer" }]);
    expect(await drainHostedWorkers(f)).toEqual({ complete: true, pending: 0 });
    expect(f.provider.delete.mock.calls).toEqual([["bx_workspace"], ["bx_builder"]]);
    expect(f.provider.deleteSnapshot.mock.calls).toEqual([["org-computer"]]);
    expect(f.queries.some(sql => sql.includes("state='deleted'"))).toBe(true);
    expect(f.queries.some(sql => sql.includes("DELETE FROM cloud_v2_tokens"))).toBe(true);
  });
  it("retains workspace and snapshot rows when provider cleanup fails", async () => {
    const f = fixture([{ id: "workspace", state: "running", boat_sandbox_id: "bx_workspace" }]);
    f.provider.delete.mockRejectedValue(new Error("provider unavailable"));
    await expect(drainHostedWorkers(f)).rejects.toThrow("provider unavailable");
    expect(f.queries.some(sql => sql.includes("state='deleted'"))).toBe(false);
  });
  it("refuses archive when a stopped backend left an unconfirmed create", async () => {
    const f = fixture([{ id: "workspace", state: "creating", boat_sandbox_id: null }]);
    await expect(drainHostedWorkers(f)).rejects.toThrow(/unconfirmed/);
    expect(f.provider.delete).not.toHaveBeenCalled();
  });
  it("pins direct branch connections and requires backend shutdown", () => {
    const url = new URL("postgresql://aws-us-west-2-1.pg.psdb.cloud:5432/postgres?sslmode=verify-full");
    url.username = "pscale_api_runtime.branch"; url.password = "synthetic-test-password";
    const runtime = { username: "pscale_api_runtime.branch", baseUsername: "pscale_api_runtime", url: url.toString() };
    const input = { ...request, buildRoot: "/private/source", action: "drain", roles: { runtime } };
    expect(validateHostedDatabaseRequest(input)).toBe(input);
    expect(() => validateHostedDatabaseRequest({ ...input, backendStopped: false })).toThrow(/Stop/);
    expect(() => validateHostedDatabaseRequest({ ...input, roles: { runtime: { ...runtime, url: runtime.url.replace(":5432", ":6432") } } })).toThrow(/routing/);
  });
});
