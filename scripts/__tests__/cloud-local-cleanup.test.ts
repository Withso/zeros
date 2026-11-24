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
      request: { backendStopped: true, owner, instanceId: "instance" }, provider, snapshotName: () => "unused", sandboxName: name,
      sharedBasePrefix: `zeros-local-${owner}-base-` });
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

it("deletes this instance's shared bases and their builders by its exact prefix, never another instance's or a channel's", async () => {
  const { drainLocalCloudResources } = await import("../dev-environment/local-cleanup.mjs");
  const owner = "0123456789abcdef01234567", other = "76543210fedcba9876543210";
  const org = "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", build = "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
  const ownBuild = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", pendingBuild = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f", recentBuild = "4d5e6f7a-8b9c-4dae-9f1a-3b4c5d6e7f8a";
  const name = (kind: string, id: string) => `zeros-local-${owner}-${kind}-${id.slice(0, 8)}`;
  const base = (scope: string, suffix: string) => `zeros-${scope}-base-0123456789ab${suffix}`;
  const row = (values: Record<string, unknown>) => ({ state: "ready", builder_sandbox_id: null, builder_create_pending: false, builder_deleted_at: null,
    deleted_at: null, heartbeat_at: null, created_at: new Date("2026-11-01T00:00:00Z"), ...values });
  const run = async (bases: Record<string, unknown>[]) => {
    const queries: { sql: string; params?: unknown[] }[] = [], gone = new Set<string>();
    const client = { query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM cloud_v2_computer_builds ORDER BY id")) return { rows: [{ id: build, org_id: org, version: 1, builder_sandbox_id: null,
        builder_create_pending: false, snapshot_id: `${base(`local-${owner}`, "")}@${build}`, operation_until: null, base_shared: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ present: true }] };
      if (sql.includes("UPDATE cloud_v2_shared_bases SET state='deleted'")) gone.add(`row:${String(params?.[0])}`);
      if (sql.includes("FROM cloud_v2_shared_bases") && sql.trimStart().startsWith("SELECT name")) return { rows: bases.filter(b => !gone.has(`row:${String(b.name)}`)) };
      return { rows: [] };
    } };
    const runtime = { query: async () => ({ rows: [{ owner, instance_id: "instance" }] }) };
    const sandboxes: Record<string, string> = { bx_44444444: name("build", ownBuild), bx_55555555: name("build", pendingBuild) };
    const provider = { request: vi.fn(async (path: string, input?: { method?: string }) => {
      if (path.startsWith("/sandboxes?")) return { sandboxes: Object.entries(sandboxes).filter(([id]) => !gone.has(id)).map(([id, n]) => ({ id, name: n })), pageInfo: { hasMore: false } };
      const id = decodeURIComponent(path.split("/").pop()!);
      if (input?.method === "DELETE") { gone.add(id); return {}; }
      if (gone.has(id)) throw Object.assign(new Error("gone"), { httpStatus: 404 });
      return path.startsWith("/sandboxes/") ? { sandbox: { id, name: sandboxes[id] } } : { snapshot: { name: id } };
    }) };
    const result = await drainLocalCloudResources({ runtime, withSystemTx: (_pool: unknown, fn: (c: typeof client) => unknown) => fn(client),
      request: { backendStopped: true, owner, instanceId: "instance" }, provider, snapshotName: () => "unused", sandboxName: name,
      sharedBasePrefix: `zeros-local-${owner}-base-` });
    return { result, queries, calls: provider.request.mock.calls.map(([path, input]) => `${input?.method ?? "GET"} ${path}`) };
  };
  const own = row({ name: base(`local-${owner}`, ""), build_id: ownBuild, builder_sandbox_id: "bx_44444444" });
  const lost = row({ name: base(`local-${owner}`, "-r2"), state: "failed", build_id: pendingBuild, builder_create_pending: true });
  const foreign = [row({ name: base(`local-${other}`, ""), build_id: recentBuild }), row({ name: base("alpha", ""), build_id: recentBuild })];
  const done = await run([own, lost, ...foreign]);
  expect(done.calls.filter(call => call.startsWith("DELETE"))).toEqual([
    "DELETE /sandboxes/bx_44444444", `DELETE /named-snapshots/${own.name}`, "DELETE /sandboxes/bx_55555555", `DELETE /named-snapshots/${lost.name}`]);
  expect(done.calls.some(call => call.includes(other) || call.includes("zeros-alpha"))).toBe(false);
  expect(done.queries.find(q => q.sql.trimStart().startsWith("SELECT name"))?.params).toEqual([`zeros-local-${owner}-base-`]);
  expect(done.queries.filter(q => q.sql.includes("UPDATE cloud_v2_shared_bases SET state='deleted'")).map(q => q.params?.[0])).toEqual([own.name, lost.name]);
  // The organization's build only refers to the base: its reference goes with no provider call of its own.
  expect(done.calls.some(call => call.includes(build))).toBe(false);
  expect(done.queries.some(q => q.sql.includes("SET snapshot_id=NULL") && q.params?.[0] === build)).toBe(true);
  expect(done.result).toEqual({ complete: true, pending: 0 });
  // A build that beat within the dispatch horizon may still save its snapshot: it is left for the next drain.
  const recent = await run([row({ name: base(`local-${owner}`, "-r3"), state: "building", build_id: recentBuild, heartbeat_at: new Date() })]);
  expect(recent.calls.filter(call => call.includes("-r3") || call.startsWith("DELETE /sandboxes"))).toEqual([]);
  expect(recent.result).toEqual({ complete: false, pending: 1 });
});

it.each(["zeros-alpha-base-", "zeros-local-0123456789abcdef01234567-", "zeros-local-0123456789abcdef01234567-base"])(
  "refuses a shared base prefix that is not one local instance's (%s)", async sharedBasePrefix => {
    const { drainLocalCloudResources } = await import("../dev-environment/local-cleanup.mjs");
    await expect(drainLocalCloudResources({ runtime: {}, withSystemTx: vi.fn(), request: { backendStopped: true, owner: "0123456789abcdef01234567" },
      provider: { request: vi.fn() }, snapshotName: () => "", sandboxName: () => "", sharedBasePrefix })).rejects.toThrow(/shared base prefix/);
  });
