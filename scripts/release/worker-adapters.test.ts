import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boatImageAdapter, buildBoatImage, runtimeOwnerAdapter } from "./worker-adapters";
import { workerExecutionConfig } from "./worker-config";
import { workerEnvironment } from "./worker-test-fixtures";

const sourceSha = "a".repeat(40), buildSha256 = "b".repeat(64);
const input = { sourceSha, directory: "/tmp/zeros-worker-fake", baseSnapshot: "test-base", maxUsedHours: 1 };
const environment = workerEnvironment(), config = workerExecutionConfig(environment).config;
const ownerRoute = `/databases/${config.database}/branches/${config.databaseBranch}/roles`;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const branch = { status: 200, body: { name: config.databaseBranch, production: true } };
const lease = () => ({ save: vi.fn(async () => {}), fence: vi.fn(async () => {}) });
const kit = async (args: string[]) => {
  if (args[0] === "attestation") return { finished: true, qualified: true, matchesCommit: true, sourceCommit: sourceSha, measuredStorageMiB: 4096, buildSha256 };
  if (args[1] === "status") return { state: "ready", wallet: "billing-org" };
  if (args[2]?.endsWith("build-hash.sh")) return JSON.stringify({ commit: sourceSha });
  if (args[2]?.endsWith("build-status.sh")) return JSON.stringify({ result: { passed: true } });
  return {};
};

describe("worker kit recovery", () => {
  it("discards large build-only recovery files after candidate readiness and physical builder deletion without breaking resume", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-worker-adapter-test-")); directories.push(directory);
    const candidate = { snapshotId: "test-new", sourceCommit: sourceSha, buildSha256, architecture: "linux/amd64" as const, storageMiB: 4096 };
    const record: any = { sourceCommit: sourceSha, snapshotId: candidate.snapshotId, candidate, qualified: true,
      builder: { id: "bx_test", deleted: true, deletionOperationId: `bdop_${"c".repeat(32)}` }, kitFiles: { "builder.json": "{}" } };
    const request = vi.fn(async (_method: string, route: string) => route.startsWith("/limits") ? { status: 200, body: { creditUsedSeconds: 0 } } :
      { status: 200, body: { snapshot: { name: candidate.snapshotId, sourceSandboxId: record.builder.id, status: "ready" } } });
    const retained = lease(), reserve = vi.fn(), release = vi.fn(), call = vi.fn();
    const context = { lease: retained, record, profile: {}, maxUsedHours: 1, snapshotName: candidate.snapshotId, request, reserve, release, kit: call };
    const first = await boatImageAdapter(config, environment, path.join(directory, "first"), context);
    expect(await first.cleanup()).toBe(true); expect(record.kitFiles).toBeUndefined();
    const resumed = await boatImageAdapter(config, environment, path.join(directory, "resumed"), context);
    expect(await resumed.build()).toEqual(candidate);
    expect(call).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("keeps a kit file the interrupted build wrote and refuses a symlinked recovery file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-worker-adapter-test-")); directories.push(directory);
    const kitDirectory = path.join(directory, "kit"); await mkdir(kitDirectory, { recursive: true });
    await writeFile(path.join(kitDirectory, "builder.json"), '{"written":"by the build"}');
    await writeFile(path.join(directory, "elsewhere.json"), "{}");
    await symlink(path.join(directory, "elsewhere.json"), path.join(kitDirectory, "builder-intent.json"));
    const record: any = { sourceCommit: sourceSha, snapshotId: "test-new", kitFiles: { "builder.json": '{"from":"receipt"}' } };
    const request = vi.fn(async (_method: string, route: string) => route.startsWith("/limits") ? { status: 200, body: { creditUsedSeconds: 0 } } : { status: 503, body: {} });
    const context = { lease: lease(), record, profile: {}, maxUsedHours: 1, snapshotName: "test-new", request, reserve: vi.fn(), release: vi.fn(), kit: vi.fn(kit) };
    const adapter = await boatImageAdapter(config, environment, kitDirectory, context);
    expect(await readFile(path.join(kitDirectory, "builder.json"), "utf8")).toBe('{"written":"by the build"}');
    await expect(adapter.build()).rejects.toThrow("Invalid worker kit recovery file");
  });
  it("refuses a recovered source manifest without its archive before allocating or uploading", async () => {
    const call = vi.fn(kit);
    await expect(buildBoatImage(input, { kit: call, nameSnapshot: async () => "test-new", exists: file => path.basename(file) === "source.json" })).rejects.toThrow("archive");
    expect(call).not.toHaveBeenCalled();
  });
  it("resumes an acknowledged install without requiring or redispatching the source archive", async () => {
    const call = vi.fn(kit);
    const candidate = await buildBoatImage({ ...input, state: { installStarted: true, attestationStarted: true } }, {
      kit: call, nameSnapshot: async () => "test-new", exists: file => path.basename(file) !== "source.tar.gz", pause: async () => {},
    });
    expect(candidate).toMatchObject({ sourceCommit: sourceSha, buildSha256 });
    expect(call.mock.calls.map(([args]) => args.join(" "))).not.toContain("builder create");
    expect(call.mock.calls.map(([args]) => args.join(" "))).not.toContain("builder upload");
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
