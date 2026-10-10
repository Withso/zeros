import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudExecutionBoundary, isCloudPreparedBoundary } from "../cloud-execution-boundary";
import { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";
import { HostExecutionBoundary } from "../host-boundary";

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
function setup(options?: { maxScopes?: number }) {
  const workloads = portableCloudWorkloads(configuration, options); registries.push(workloads);
  const boundary = new CloudExecutionBoundary({ configuration, workloads });
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
    expect((await workloads.inspect()).workloadPids).toContain(siblingChild.pid);
    const fence = workloads.fence();
    expect(() => sibling.wrapSpawn(launch())).toThrow();
    await workloads.drain(fence);
    expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [] });
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
  it("rejects caller cancellation after Host prepared but before cloud admission returns", async () => {
    const { boundary, workloads } = setup(), abort = new AbortController();
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
  it("retains a failed exact retirement and refuses a falsely empty release", async () => {
    const { boundary, workloads } = setup();
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
