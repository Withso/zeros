import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudExecutionBoundary, isCloudPreparedBoundary } from "../cloud-execution-boundary";
import { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";
import { HostExecutionBoundary } from "../host-boundary";
import { sessionDir, sweepDeadSessions, writeSessionMeta } from "../../session-paths";

const configuration = vi.hoisted(() => ({ uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));
const registries: CloudOwnedWorkloadRegistry[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const registry of registries.splice(0)) await registry.drain(registry.fence());
});
function setup(options?: { maxScopes?: number; retainSessionDirectories?: boolean }) {
  const workloads = portableCloudWorkloads(configuration, options); registries.push(workloads);
  const boundaryOptions = { configuration, workloads, retainSessionDirectories: options?.retainSessionDirectories };
  const boundary = new CloudExecutionBoundary(boundaryOptions);
  return { workloads, boundary };
}
async function completeInspection(workloads: CloudOwnedWorkloadRegistry) {
  let inventory = await workloads.inspect();
  await expect.poll(async () => {
    inventory = await workloads.inspect();
    return inventory.complete;
  }, { timeout: 3000 }).toBe(true);
  return inventory;
}
const request = () => ({ executionId: randomUUID(), actor: "agent-code" as const, cwd: process.cwd(), workspaceRoot: process.cwd() });
const launch = () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } });

describe("same-user cloud Host lifecycle", () => {
  it.skipIf(process.platform !== "linux")("keeps retired qualification metadata visible to sanitation instead of inherited snapshot bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-probe-sanitation-"));
    const previous = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "srv/zeros/state");
    try {
      const { boundary, workloads } = setup({ retainSessionDirectories: true });
      const input = request(), prepared = await boundary.prepare(input);
      const directory = sessionDir(input.executionId), metadata = path.join(directory, "meta.json");
      const inherited = await readFile(metadata), before = await lstat(metadata);
      const child = await prepared.spawn({ ...launch(), args: ["-e", "process.stdout.write('probe')"] });
      child.stdout?.resume(); child.stderr?.resume();
      expect(await child.wait()).toMatchObject({ code: 0 });
      await prepared.stopAndProve();
      expect(await completeInspection(workloads)).toMatchObject({ complete: true, workloadPids: [], pendingLaunches: 0 });

      // Exercise the real base sanitizer after the actual Host scope retires.
      // An incremental saved tree can keep deleted children, so an absent
      // path falls back to its captured bytes rather than proving erasure.
      const sanitized = spawnSync("python3", ["-I", "-B", "-c", `
import importlib.util, os, pathlib, sys
spec = importlib.util.spec_from_file_location("computer_build", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ComputerBuild(root=pathlib.Path(sys.argv[2]), uid=os.getuid(), gid=os.getgid()).clear_directory("/srv/zeros/state")
`, path.resolve("scripts/cloud-workspace-validation/runtime-base-v4/computer-build.py"), root], { encoding: "utf8", timeout: 5000 });
      expect(sanitized.status, sanitized.stderr).toBe(0);
      const saved = await readFile(metadata).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return inherited;
      });
      expect(saved.length, "deleted qualification metadata survived the incremental capture").toBe(0);
      expect(await lstat(metadata)).toMatchObject({ ino: before.ino, dev: before.dev, mode: before.mode });
      expect((await readdir(directory)).sort()).toEqual(["boundary", "env", "log", "meta.json", "telemetry"]);
      for (const name of ["boundary", "env", "log", "telemetry"]) expect(await readdir(path.join(directory, name))).toEqual([]);
      // Idempotent retirement cannot recreate a journal or multiply stubs.
      await prepared.stopAndProve();
      expect(await sweepDeadSessions()).toBe(0);
      expect(await readdir(path.dirname(directory))).toEqual([input.executionId]);
      expect((await readdir(directory)).length).toBe(5);
    } finally {
      if (previous === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["local", "cloud"])("still deletes ordinary %s sessions even with a qualification-like name", async placement => {
    const input = { ...request(), executionId: `human-language-${randomUUID()}` };
    const boundary = placement === "local" ? new HostExecutionBoundary() : setup().boundary;
    const prepared = await boundary.prepare(input);
    const directory = sessionDir(input.executionId);
    expect((await lstat(path.join(directory, "meta.json"))).size).toBeGreaterThan(0);
    await prepared.stopAndProve();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collects valid retained probe metadata only after its owner is dead", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-probe-gc-"));
    const previous = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = root;
    try {
      const { boundary } = setup({ retainSessionDirectories: true });
      const input = request(), prepared = await boundary.prepare(input);
      const metadata = JSON.parse(await readFile(path.join(sessionDir(input.executionId), "meta.json"), "utf8"));
      await prepared.stopAndProve();
      expect(await sweepDeadSessions()).toBe(0);
      // Model the fixed qualification process exiting after native retirement.
      await writeSessionMeta(input.executionId, { ...metadata, pid: 2_147_483_647 });
      expect(await sweepDeadSessions()).toBe(1);
      await expect(lstat(sessionDir(input.executionId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses cloud placement without ORIGINAL delegated kernel custody", () => {
    const workloads = new CloudOwnedWorkloadRegistry();
    expect(() => new CloudExecutionBoundary({ configuration, workloads })).toThrow();
  });
  it("rejects a copied deployment configuration and forged cloud placement", () => {
    const { workloads } = setup();
    expect(() => new CloudExecutionBoundary({ configuration: { ...configuration }, workloads })).toThrow();
    expect(isCloudPreparedBoundary({ status: { backend: "cloud-worker" } })).toBe(false);
  });
  it("uses the pinned Host launch with unchanged selected cwd/env and no sandbox wrappers", async () => {
    const { boundary, workloads } = setup(), input = request();
    const prepared = await boundary.prepare(input);
    expect(isCloudPreparedBoundary(prepared)).toBe(true);
    expect(isCloudPreparedBoundary({ ...prepared })).toBe(false);
    expect(prepared.status).toMatchObject({ backend: "cloud-worker", state: "ready", designProtection: { enforced: false } });
    const descriptor = prepared.wrapSpawn(launch());
    expect(descriptor.command).toBe(process.execPath);
    expect(descriptor.args[0]).toBe(configuration.toolchain.supervisor);
    expect(descriptor.cwd).toBe(input.cwd);
    expect(descriptor.env.PATH).toBe("/usr/bin:/bin");
    expect(descriptor.env.HOME).toBeUndefined();
    expect(descriptor.args.join(" ")).not.toMatch(/zsr|bwrap|setpriv/);
    expect(workloads.snapshot().pendingLaunches).toBe(1);
    prepared.cancelUnstartedLaunch!(descriptor);
    expect(workloads.snapshot().pendingLaunches).toBe(0);
    expect(() => prepared.trackProcessGroup(process.pid)).toThrow();
    await prepared.stopAndProve();
    expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [], pendingLaunches: 0 });
  });
  it("tracks exact cloud groups, retires one session and leaves its sibling live", async () => {
    const { boundary, workloads } = setup();
    const first = await boundary.prepare(request()), sibling = await boundary.prepare(request());
    const firstChild = await first.spawn(launch()), siblingChild = await sibling.spawn(launch());
    const inventory = await completeInspection(workloads);
    expect(inventory.complete).toBe(true);
    expect(inventory.workloadPids).toContain(firstChild.pid);
    expect(inventory.workloadPids).toContain(siblingChild.pid);
    expect(inventory.workloadPids).not.toContain(process.pid);
    await first.stopAndProve();
    // A census spanning real process exit can be incomplete; require its
    // existing positive complete witness before asserting sibling survival.
    expect((await completeInspection(workloads)).workloadPids).toContain(siblingChild.pid);
    const fence = workloads.fence();
    expect(() => sibling.wrapSpawn(launch())).toThrow();
    await workloads.drain(fence);
    expect(await completeInspection(workloads)).toMatchObject({ complete: true, workloadPids: [] });
  });
  it("executes as the actual engine uid/gid in the real checkout with the selected env", async () => {
    const { boundary } = setup(), prepared = await boundary.prepare(request());
    const child = await prepared.spawn({ ...launch(), args: ["-e",
      "process.stdout.write(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),cwd:process.cwd(),marker:process.env.ZEROS_TEST_MARKER,home:process.env.HOME??null}))"],
      env: { ZEROS_TEST_MARKER: "selected" } });
    let output = ""; for await (const chunk of child.stdout!) output += chunk.toString();
    expect(await child.wait()).toMatchObject({ code: 0 });
    expect(JSON.parse(output)).toEqual({ uid: process.geteuid?.(), gid: process.getegid?.(), cwd: process.cwd(), marker: "selected", home: null });
    await prepared.stopAndProve();
  });
  it("exempts original language infrastructure descendants, retains work and refuses interactive infrastructure", async () => {
    const { boundary, workloads } = setup();
    await expect(boundary.prepareOwned(request(), { kind: "ssh", role: "infrastructure" })).rejects.toThrow();
    const prepared = await boundary.prepareOwned(request(), { kind: "language-service", role: "infrastructure" });
    const child = await prepared.spawn({ ...launch(), args: ["-e",
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)" ] });
    const descendantPid = await new Promise<number>((resolve) => child.stdout!.once("data", (bytes) => resolve(Number(bytes.toString().trim()))));
    const inventory = await completeInspection(workloads);
    expect(inventory.complete).toBe(true);
    expect(inventory.workloadPids).not.toContain(child.pid);
    expect(inventory.workloadPids).not.toContain(descendantPid);
    expect(inventory.infrastructurePids).toContain(child.pid);
    expect(inventory.infrastructurePids).toContain(descendantPid);
    const work = await boundary.prepare(request());
    const workChild = await work.spawn({ ...launch(), args: ["-e",
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)" ] });
    const workDescendant = await new Promise<number>((resolve) => workChild.stdout!.once("data", (bytes) => resolve(Number(bytes.toString().trim()))));
    const mixed = await completeInspection(workloads);
    expect(mixed.workloadPids).toContain(workChild.pid);
    expect(mixed.workloadPids).toContain(workDescendant);
    expect(mixed.infrastructurePids).not.toContain(workChild.pid);
    expect(mixed.infrastructurePids).not.toContain(workDescendant);
    await prepared.stopAndProve();
    const retired = await completeInspection(workloads);
    expect(retired.infrastructurePids).not.toContain(child.pid);
    expect(retired.infrastructurePids).not.toContain(descendantPid);
    expect(retired.workloadPids).toContain(workChild.pid);
    expect(retired.workloadPids).toContain(workDescendant);
    await work.stopAndProve();
    expect(await completeInspection(workloads)).toMatchObject({ complete: true, pendingLaunches: 0, workloadPids: [] });
  });
  it("owns delayed prepares before yielding and drains them before empty proof", async () => {
    const { boundary, workloads } = setup();
    const original = HostExecutionBoundary.prototype.prepare;
    let unblock!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(HostExecutionBoundary.prototype, "prepare").mockImplementationOnce(async function (this: HostExecutionBoundary, ...args) {
      await wait; return original.apply(this, args);
    });
    const preparing = boundary.prepare(request());
    const rejection = expect(preparing).rejects.toThrow();
    expect(workloads.snapshot().pendingLaunches).toBe(1);
    const fence = workloads.fence(), draining = workloads.drain(fence);
    expect(() => workloads.assertAccepting()).toThrow();
    expect(() => workloads.resume(fence)).toThrow();
    unblock(); await rejection; await draining;
    expect(workloads.snapshot().scopes).toEqual([]);
    workloads.resume(fence);
    expect(() => workloads.assertAccepting()).not.toThrow();
  });
  it("keeps a concurrent seal fence after idle cancellation resumes its own ticket", async () => {
    const { workloads } = setup();
    const idle = workloads.fence(), seal = workloads.fence();
    await workloads.drain(idle); workloads.resume(idle);
    expect(() => workloads.assertAccepting()).toThrow();
    expect(() => workloads.resume(idle)).toThrow();
    await workloads.drain(seal); workloads.resume(seal);
    expect(() => workloads.assertAccepting()).not.toThrow();
    expect(() => workloads.resume({ ...seal })).toThrow();
  });
  it.each([false, true])("rejects caller cancellation after Host prepared but before cloud admission returns (retain %s)", async retainSessionDirectories => {
    const { boundary, workloads } = setup({ retainSessionDirectories }), abort = new AbortController();
    const original = HostExecutionBoundary.prototype.prepare;
    let prepared!: () => void, unblock!: () => void;
    const reached = new Promise<void>((resolve) => { prepared = resolve; });
    const waiting = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(HostExecutionBoundary.prototype, "prepare").mockImplementationOnce(async function (this: HostExecutionBoundary, ...args) {
      const result = await original.apply(this, args); prepared(); await waiting; return result;
    });
    const admission = boundary.prepare(request(), { signal: abort.signal });
    const rejection = expect(admission).rejects.toThrow();
    await reached; abort.abort(new Error("caller cancelled")); unblock(); await rejection;
    expect(workloads.snapshot().scopes).toEqual([]);
  });
  it("checks the original caller cancellation immediately before registering a native launch", async () => {
    const { boundary, workloads } = setup(), abort = new AbortController();
    const prepared = await boundary.prepare(request(), { signal: abort.signal });
    abort.abort();
    expect(() => prepared.wrapSpawn(launch())).toThrow();
    expect(workloads.snapshot().pendingLaunches).toBe(0);
    await prepared.stopAndProve();
  });
  it("retains one opted-in failed preparation proof after automatic exact Host cleanup", async () => {
    const { boundary } = setup(), abort = new AbortController(), input = request(); abort.abort();
    await expect(boundary.prepare(input, { signal: abort.signal, retainFailedPreparationProof: true })).rejects.toThrow();
    await expect(boundary.proveFailedPreparationStopped(input.executionId)).resolves.toBeUndefined();
    await expect(boundary.proveFailedPreparationStopped(input.executionId)).rejects.toThrow();
    await expect(boundary.proveFailedPreparationStopped("unknown")).rejects.toThrow();
    const activeInput = request(), active = await boundary.prepare(activeInput);
    await expect(boundary.proveFailedPreparationStopped(activeInput.executionId)).rejects.toThrow();
    await active.stopAndProve();
    const unretained = request();
    await expect(boundary.prepare(unretained, { signal: abort.signal })).rejects.toThrow();
    await expect(boundary.proveFailedPreparationStopped(unretained.executionId)).rejects.toThrow();
  });
  it("retries failed cleanup through the exact owning registry without consuming a failed proof", async () => {
    const { boundary, workloads } = setup(), abort = new AbortController(), input = request(); abort.abort();
    const proof = vi.spyOn(HostExecutionBoundary.prototype, "proveFailedPreparationStopped");
    proof.mockRejectedValue(new Error("exact cleanup failed"));
    await expect(boundary.prepare(input, { signal: abort.signal, retainFailedPreparationProof: true })).rejects.toThrow();
    await expect(boundary.proveFailedPreparationStopped(input.executionId)).rejects.toThrow("exact cleanup failed");
    expect(workloads.snapshot().failedRetirements).toBe(1);
    proof.mockRestore();
    await expect(boundary.proveFailedPreparationStopped(input.executionId)).resolves.toBeUndefined();
    expect(workloads.snapshot().scopes).toEqual([]);
    await expect(boundary.proveFailedPreparationStopped(input.executionId)).rejects.toThrow();
  });
  it.each([false, true])("retains a failed exact retirement and refuses a falsely empty release (retain %s)", async retainSessionDirectories => {
    const { boundary, workloads } = setup({ retainSessionDirectories });
    const prepared = await boundary.prepare(request());
    const lifecycle = Object.getPrototypeOf(boundary);
    expect(lifecycle).toBeDefined();
    const original = prepared.stopAndProve;
    // A real original scope's retirement port, rather than an adopted PID.
    vi.spyOn(HostExecutionBoundary.prototype, "proveFailedPreparationStopped").mockRejectedValue(new Error("proof failed"));
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
    await expect(boundary.prepare(request(), { signal: aborted.signal })).rejects.toThrow();
    const fence = workloads.fence();
    await expect(workloads.drain(fence)).rejects.toThrow("proof failed");
    expect(workloads.snapshot().failedRetirements).toBeGreaterThan(0);
    expect(() => workloads.resume(fence)).toThrow();
    vi.restoreAllMocks(); await workloads.drain(fence);
    await original();
  });
  it("refuses bounded inventory overflow without adopting an untracked scope", async () => {
    const { boundary, workloads } = setup({ maxScopes: 1 });
    await boundary.prepare(request());
    await expect(boundary.prepare(request())).rejects.toThrow(/capacity/);
    expect(workloads.snapshot().complete).toBe(false);
    expect(workloads.snapshot().scopes).toHaveLength(1);
  });
});
