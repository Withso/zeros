import { describe, it, expect, vi } from "vitest";
import { drainHostedWorkers, validateHostedDatabaseRequest, retireHostedWorkerStorage } from "../dev-environment/hosted-database.mjs";
import * as database from "../dev-environment/hosted-database.mjs";
import * as services from "../dev-environment/hosted-services.mjs";
const owner = "a".repeat(24), generation = "11111111-1111-4111-8111-111111111111";
const request = { owner, generation, backendStopped: true };
function fixture(records: any[] = []) {
  const pool = { query: vi.fn(async () => ({ rows: [{ owner, generation }] })) };
  const withSystemTx = vi.fn(async (_pool, fn) => fn({ query: async () => ({ rows: records }) }));
  const provider = { delete: vi.fn(), verifyAbsence: vi.fn(async () => true) };
  return { pool, withSystemTx, provider, request, accountScope: "dev-account" };
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
  it("can transfer a bound, irreversibly retired worker receipt out of the disposable DB", async () => {
    const id = "bx_test123", operation = "bdop_" + "a".repeat(32);
    const record = { resourceId: id, deletionRequestedAt: new Date(), deletionOperationId: operation };
    const boat = vi.fn(async (_method: string, route: string) => route.startsWith("/deletion-operations/")
      ? { status: 200, body: { operation: { id: operation, kind: "sandbox", targetId: id, status: "blocked", stage: "waiting_for_uploads", expectedBy: new Date(Date.now() + 3600_000).toISOString() } } }
      : { status: 404 });
    expect(await retireHostedWorkerStorage(record, boat)).toMatchObject({ id, deletionOperationId: operation, deletionStage: "waiting_for_uploads" });
    boat.mockResolvedValue({ status: 404 } as any);
    await expect(retireHostedWorkerStorage(record, boat)).rejects.toThrow(/receipt/);
    await expect(retireHostedWorkerStorage({ ...record, deletionOperationId: null }, boat)).rejects.toThrow(/receipt/);
  });
  it("never transfers an accessible sandbox, unknown retention stage or another target", async () => {
    const id = "bx_test123", operation = "bdop_" + "a".repeat(32);
    const record = { resourceId: id, deletionRequestedAt: new Date(), deletionOperationId: operation };
    for (const altered of [{ stage: "unknown" }, { targetId: "bx_other" }, { expectedBy: null }, {}]) {
      const boat = vi.fn(async (_method: string, route: string) => route.startsWith("/deletion-operations/")
        ? { status: 200, body: { operation: { id: operation, kind: "sandbox", targetId: id, status: "blocked", stage: "waiting_for_uploads", expectedBy: new Date().toISOString(), ...altered } } }
        : { status: 200, body: { sandbox: { id } } });
      await expect(retireHostedWorkerStorage(record, boat)).rejects.toThrow();
    }
  });
  it("retains transferred cleanup receipts even while an independent uncertain create blocks archive", async () => {
    const f = fixture([{ provider: "boat", account_scope: "dev-account", workspace_id: "workspace", generation: 1, resource_id: null },
      { provider: "boat", account_scope: "dev-account", workspace_id: "workspace", generation: 2, resource_id: "resource" }]);
    f.provider.verifyAbsence.mockResolvedValue(false); f.provider.delete.mockRejectedValue({ code: "provider_deletion_blocked" });
    const retired = { id: "resource", deletionOperationId: "provider-receipt" };
    expect(await drainHostedWorkers({ ...f, retirePending: async () => retired })).toEqual({ complete: false, pending: 1, retired: [retired] });
  });
  it("refuses another generation before any query can supersede work", async () => {
    const f = fixture(); f.pool.query.mockResolvedValue({ rows: [{ owner, generation: "different" }] });
    await expect(drainHostedWorkers(f)).rejects.toThrow(/generation/);
    expect(f.withSystemTx).not.toHaveBeenCalled(); expect(f.provider.delete).not.toHaveBeenCalled();
  });
  it("retains unallocated uncertain creates and pending physical deletions", async () => {
    const f = fixture([{ provider: "boat", account_scope: "dev-account", workspace_id: "workspace", generation: 1, resource_id: null },
      { provider: "boat", account_scope: "dev-account", workspace_id: "workspace", generation: 2, resource_id: "resource" }]);
    f.provider.verifyAbsence.mockResolvedValue(false);
    f.provider.delete.mockRejectedValue({ code: "provider_deletion_pending" });
    expect(await drainHostedWorkers(f)).toEqual({ complete: false, pending: 2 });
    f.provider.verifyAbsence.mockResolvedValue(true); f.provider.delete.mockResolvedValue(undefined);
    expect(await drainHostedWorkers(f)).toEqual({ complete: true, pending: 0 });
  });
  it("does not delete foreign provider resources", async () => {
    const f = fixture([{ provider: "boat", account_scope: "other", resource_id: "resource" }]);
    await expect(drainHostedWorkers(f)).rejects.toThrow(/unexpected provider/); expect(f.provider.delete).not.toHaveBeenCalled();
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
