import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudWorkloadTools } from "../cloud-workload-tools";
import { createCloudNativeHome } from "../containment/cloud-native-home";
import type { BoundaryProcess, BoundarySpawnRequest, PreparedBoundary } from "../containment/types";
import { testCloudBootFixture } from "./helpers/test-cloud-boot";
vi.mock("../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("./helpers/test-cloud-runtime")).testCloudRuntime,
}));
vi.mock("../cloud-mcp", async original => ({ ...await original<typeof import("../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-boot-tool-home-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return createCloudNativeHome({ dataRoot: root, provider: "claude", conversationId: "tools", executionId: "native-run" });
}
function workload() {
  const stopped = vi.fn(async () => {});
  const spawn = vi.fn(async (_request: BoundarySpawnRequest): Promise<BoundaryProcess> => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    setTimeout(() => { stdout.end("synthetic tool output"); stderr.end(); }, 1);
    return { pid: 123, stdin: new PassThrough(), stdout, stderr, wait: async () => ({ code: 0, signal: null }),
      signal: async () => {}, stopAndProve: stopped } as BoundaryProcess;
  });
  return { spawn, stopped, domain: { spawn, stopAndProve: vi.fn(async () => {}) } as unknown as PreparedBoundary };
}
describe("genuine boot workload tools", () => {
  it.each(["/srv/zeros/workspace", "/srv/zeros/state/workspaces/managed-worktree"])("uses admitted boot authority and cwd %s without a lease or foreground CP request", async cwd => {
    const f = await testCloudBootFixture(cwd); cleanups.push(f.close);
    const w = workload(), tools = new CloudWorkloadTools(f.authority, w.domain, cwd, await home());
    cleanups.push(() => tools.stopAndProve());
    expect(f.authority).not.toHaveProperty("leaseId"); expect(f.authority).not.toHaveProperty("validate");
    expect(await tools.call({ operation: "exec", command: "synthetic", cwd: "/tmp/caller-root" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await tools.call({ operation: "exec", command: "synthetic" })).toMatchObject({ ok: true, data: { output: "synthetic tool output" } });
    expect(w.spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, env: expect.objectContaining({
      ZEROS_WORKTREE_PATH: cwd, TEST_ADMITTED: "synthetic-actor-setting", GIT_AUTHOR_NAME: "Test member" }) }));
    expect(w.spawn.mock.calls[0]![0].env).not.toHaveProperty("CURSOR_API_KEY");
    expect(f.request.bootstrap).toHaveBeenCalledOnce(); expect(f.request.sync).not.toHaveBeenCalled();
    expect(f.contextRequest).toHaveBeenCalledOnce(); expect(f.legacy.prepare).not.toHaveBeenCalled();
  });
  it("refuses copied helper-shaped boot authority before constructing a tool domain", async () => {
    const f = await testCloudBootFixture(); cleanups.push(f.close); const w = workload(), nativeHome = await home();
    expect(() => new CloudWorkloadTools({ ...f.authority }, w.domain, f.input.cwd, nativeHome)).toThrow();
    expect(w.spawn).not.toHaveBeenCalled();
  });
  it("refuses a valid boot authority paired with a different managed root", async () => {
    const f = await testCloudBootFixture(); cleanups.push(f.close); const w = workload(), nativeHome = await home();
    expect(() => new CloudWorkloadTools(f.authority, w.domain, "/srv/zeros/state/workspaces/another-worktree", nativeHome)).toThrow();
    expect(w.spawn).not.toHaveBeenCalled();
  });
  it("keeps revoked engine authority closed and owns retirement of its tool domain", async () => {
    const f = await testCloudBootFixture(); cleanups.push(f.close); const w = workload();
    const tools = new CloudWorkloadTools(f.authority, w.domain, f.input.cwd, await home()); cleanups.push(() => tools.stopAndProve());
    await f.factory.disposeBoot();
    expect(await tools.call({ operation: "exec", command: "synthetic" })).toEqual({ ok: false, error: "unavailable" });
    expect(w.spawn).not.toHaveBeenCalled(); expect(w.domain.stopAndProve).toHaveBeenCalled();
  });
});
