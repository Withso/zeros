import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boatImageAdapter, buildBoatImage, runtimeOwnerAdapter } from "./worker-adapters";
import { workerExecutionConfig } from "./worker-config";
import { workerEnvironment } from "./worker-test-fixtures";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";

const sourceSha = "a".repeat(40), buildSha256 = "b".repeat(64);
const input = { sourceSha, directory: "/tmp/zeros-worker-fake", baseSnapshot: "test-base", maxUsedHours: 1 };
const environment = workerEnvironment(), config = workerExecutionConfig(environment).config;
const ownerRoute = `/databases/${config.database}/branches/${config.databaseBranch}/roles`;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const branch = { status: 200, body: { name: config.databaseBranch, production: true } };
const lease = () => ({ save: vi.fn(async () => {}), fence: vi.fn(async () => {}) });
describe("retired worker image producer and historical cleanup", () => {
  it.each([{}, { installStarted: true, attestationStarted: true }])("refuses fresh and resumed builds before calling the shared image kit (%j)", async state => {
    const call = vi.fn(async () => ({}));
    await expect(buildBoatImage({ ...input, state }, { kit: call, nameSnapshot: async () => "test-new" })).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(call).not.toHaveBeenCalled();
  });
  it("refuses the adapter build before provider reads, admission reservation, or source restoration", async () => {
    const request = vi.fn(), reserve = vi.fn(), release = vi.fn(), call = vi.fn();
    const record = { sourceCommit: sourceSha, snapshotId: "test-new" };
    const adapter = await boatImageAdapter(config, environment, "/tmp/unused-retired-worker", {
      lease: lease(), record, profile: {}, maxUsedHours: 1, snapshotName: record.snapshotId, request, reserve, release, kit: call,
    });
    await expect(adapter.build()).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(request).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it("discards large build-only recovery files after candidate readiness and physical builder deletion while refusing further builds", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-worker-adapter-test-")); directories.push(directory);
    const candidate = { snapshotId: "test-new", sourceCommit: sourceSha, buildSha256, architecture: "linux/amd64" as const, storageMiB: 4096 };
    const record: any = { sourceCommit: sourceSha, snapshotId: candidate.snapshotId, candidate, qualified: true,
      builder: { id: "bx_test", deleted: true, deletionOperationId: `bdop_${"c".repeat(32)}` }, kitFiles: { "builder.json": "{}" } };
    const request = vi.fn(async (_method: string, route: string) => {
      if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: 0 } };
      if (route.startsWith("/deletion-operations/")) return { status: 200, body: { operation: { id: record.builder.deletionOperationId,
        kind: "sandbox", targetId: record.builder.id, status: "completed", completedAt: new Date(Date.now() - 1000).toISOString() } } };
      if (route === `/sandboxes/${record.builder.id}`) return { status: 404 };
      return { status: 200, body: { snapshot: { name: candidate.snapshotId, sourceSandboxId: record.builder.id, status: "ready" } } };
    });
    const retained = lease(), reserve = vi.fn(), release = vi.fn(), call = vi.fn();
    const context = { lease: retained, record, profile: {}, maxUsedHours: 1, snapshotName: candidate.snapshotId, request, reserve, release, kit: call };
    const first = await boatImageAdapter(config, environment, path.join(directory, "first"), context);
    expect(await first.cleanup()).toMatchObject({ kind: "physically-deleted", sandboxId: record.builder.id, deletionOperationId: record.builder.deletionOperationId });
    expect(record.kitFiles).toBeUndefined();
    const resumed = await boatImageAdapter(config, environment, path.join(directory, "resumed"), context);
    await expect(resumed.build()).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(call).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
 });

describe("worker approval login recovery", () => {
  it("does not infer noncreation or create a second owner role after a lost response and empty inventory", async () => {
    const run: any = { operationId: "11111111-1111-4111-8111-111111111111" }, retained = lease();
    const request = vi.fn(async (method: string, route: string) => {
      if (method === "POST") throw new Error("synthetic lost role response");
      if (route.startsWith(`${ownerRoute}?`)) return { status: 200, body: { data: [] } };
      return branch;
    });
    const owner = runtimeOwnerAdapter(config, environment, { lease: retained, run, request });
    await expect(owner(async () => true)).rejects.toThrow();
    expect(run.ownerRole.deleted).not.toBe(true);
    await expect(owner(async () => true)).rejects.toThrow("reconcile");
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });
  it("deletes a uniquely recovered role before creating a new login, and proves deletion of both", async () => {
    const run: any = { ownerRole: { name: "zeros-worker-old", phase: "dispatched" } }, retained = lease();
    const roles = new Map<string, any>([["old-id", { id: "old-id", name: "zeros-worker-old", username: "old-login" }]]);
    const events: string[] = [];
    const request = vi.fn(async (method: string, route: string, body?: any) => {
      if (route === ownerRoute && method === "POST") {
        events.push("create");
        const role = { id: "new-id", name: body.name, username: "new-login", password: "synthetic-password", access_host_url: "postgresql://example.invalid/test" };
        roles.set(role.id, role); return { status: 201, body: role };
      }
      if (route.startsWith(`${ownerRoute}?`)) return { status: 200, body: { data: [...roles.values()] } };
      if (route.startsWith(`${ownerRoute}/`)) {
        const id = route.slice(ownerRoute.length + 1);
        if (method === "DELETE") { events.push(`delete:${id}`); roles.delete(id); return { status: 204 }; }
        return roles.has(id) ? { status: 200, body: roles.get(id) } : { status: 404 };
      }
      return branch;
    });
    const end = vi.fn(async () => {}), pool = vi.fn(() => ({ end })) as any;
    const owner = runtimeOwnerAdapter(config, environment, { lease: retained, run, request, pool });
    expect(await owner(async session => { events.push("action"); expect(session.loginIdentity).toBe("new-login"); return "approved"; })).toEqual({ value: "approved", deleted: true });
    expect(events).toEqual(["delete:old-id", "create", "action", "delete:new-id"]);
    expect(end).toHaveBeenCalledOnce(); expect(run.ownerRole.credentials).toBeUndefined();
  });
  it("permits retry only after an authenticated denial proves the new role was not created", async () => {
    const run: any = {}, request = vi.fn(async (method: string) => method === "POST" ? { status: 403 } : branch);
    const owner = runtimeOwnerAdapter(config, environment, { lease: lease(), run, request });
    await expect(owner(async () => true)).rejects.toThrow();
    expect(run.ownerRole).toMatchObject({ phase: "rejected", deleted: true });
    await expect(owner(async () => true)).rejects.toThrow();
    expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(2);
  });
});
