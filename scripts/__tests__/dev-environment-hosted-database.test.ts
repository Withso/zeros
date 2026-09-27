import { describe, it, expect, vi } from "vitest";
import { drainHostedWorkers, validateHostedDatabaseRequest } from "../dev-environment/hosted-database.mjs";
const owner = "a".repeat(24), generation = "11111111-1111-4111-8111-111111111111";
const request = { owner, generation, backendStopped: true };
function fixture(records: any[] = []) {
  const pool = { query: vi.fn(async () => ({ rows: [{ owner, generation }] })) };
  const withSystemTx = vi.fn(async (_pool, fn) => fn({ query: async () => ({ rows: records }) }));
  const provider = { delete: vi.fn(), verifyAbsence: vi.fn(async () => true) };
  return { pool, withSystemTx, provider, request, accountScope: "dev-account" };
}
describe("Dev database archive", () => {
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
