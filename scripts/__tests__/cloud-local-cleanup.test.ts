import { expect, it, vi } from "vitest";
import { completeSandboxInventory } from "../dev-environment/local-cleanup.mjs";

it("requires a complete paginated inventory before certifying a lost create as absent", async () => {
  const request = vi.fn().mockResolvedValueOnce({ sandboxes: [{ id: "bx_22222222", name: "first" }], pageInfo: { hasMore: true, nextCursor: "next/=" } })
    .mockResolvedValueOnce({ sandboxes: [{ id: "bx_33333333", name: "second" }], pageInfo: { hasMore: false } });
  expect(await completeSandboxInventory({ request })).toEqual([
    { id: "bx_22222222", name: "first" }, { id: "bx_33333333", name: "second" },
  ]);
  expect(request.mock.calls[1]?.[0]).toContain("cursor=next%2F%3D");
});

it.each([
  { sandboxes: [], pageInfo: { hasMore: true } },
  { sandboxes: [], pageInfo: {} },
  { sandboxes: [{ id: "not-a-sandbox", name: "bad" }], pageInfo: { hasMore: false } },
])("refuses incomplete or malformed provider inventory", async page => {
  await expect(completeSandboxInventory({ request: vi.fn(async () => page) })).rejects.toThrow(/inventory/);
});

it("bounds repeated cursors instead of assuming the unobserved tail is empty", async () => {
  const request = vi.fn(async () => ({ sandboxes: [], pageInfo: { hasMore: true, nextCursor: "same" } }));
  await expect(completeSandboxInventory({ request })).rejects.toThrow(/inventory/);
  expect(request).toHaveBeenCalledTimes(2);
});

it("deletes a checkpoint retry's fork before the workspace VM, and keeps the workspace pending until Boat confirms it", async () => {
  const { drainLocalCloudResources } = await import("../dev-environment/local-cleanup.mjs");
  const owner = "0123456789abcdef01234567", workspace = "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", attempt = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const name = (kind: string, id: string) => `zeros-local-${owner}-${kind}-${id.slice(0, 8)}`;
  const fork = { attempt, name: `${name("ws", workspace)} fork`, source: "bx_22222222", requestedAt: "2026-10-28T00:00:00.000Z", sandboxId: "bx_33333333" };
  const run = async (confirmFork: boolean) => {
    const queries: { sql: string; params?: unknown[] }[] = [], deleted = new Set<string>();
    const names: Record<string, string> = { bx_22222222: name("ws", workspace), bx_33333333: fork.name };
    const client = { query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM cloud_v2_workspaces w ORDER BY id")) return { rows: [{ id: workspace, state: "stopped", boat_sandbox_id: "bx_22222222", next_attempt_at: null, retry_fork: fork }] };
      if (sql.includes("FROM cloud_v2_computer_builds ORDER BY id")) return { rows: [] };
      return { rows: [] };
    } };
    const runtime = { query: async () => ({ rows: [{ owner, instance_id: "instance" }] }) };
    const provider = { request: vi.fn(async (path: string, input?: { method?: string }) => {
      const id = path.split("/").pop()!;
      if (input?.method === "DELETE") { if (confirmFork || id !== "bx_33333333") deleted.add(id); return {}; }
      if (deleted.has(id)) throw Object.assign(new Error("gone"), { httpStatus: 404 });
      return { sandbox: { id, name: names[id] } };
    }) };
    const result = await drainLocalCloudResources({ runtime, withSystemTx: (_pool: unknown, fn: (c: typeof client) => unknown) => fn(client),
      request: { backendStopped: true, owner, instanceId: "instance" }, provider, snapshotName: () => "unused", sandboxName: name });
    return { result, queries, deletes: provider.request.mock.calls.filter(([, input]) => input?.method === "DELETE").map(([path]) => path) };
  };
  const done = await run(true);
  expect(done.deletes).toEqual(["/sandboxes/bx_33333333", "/sandboxes/bx_22222222"]);
  expect(done.queries.some(q => q.sql.includes("SET checkpoint_retry_fork=NULL") && q.params?.[1] === attempt)).toBe(true);
  expect(done.queries.some(q => q.sql.includes("SET state='deleted'"))).toBe(true);
  // A fork Boat still shows is never forgotten, and its workspace VM is left for the next drain.
  const stuck = await run(false);
  expect(stuck.deletes).toEqual(["/sandboxes/bx_33333333"]);
  expect(stuck.queries.some(q => q.sql.includes("SET checkpoint_retry_fork=NULL"))).toBe(false);
  expect(stuck.result).toEqual({ complete: false, pending: 1 });
});
