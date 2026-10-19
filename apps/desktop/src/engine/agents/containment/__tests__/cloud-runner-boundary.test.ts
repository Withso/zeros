import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRunnerBoundary } from "../cloud-runner-boundary";
import { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";
import { HostExecutionBoundary } from "../host-boundary";
import type { CloudRunnerNativeClient } from "../cloud-runner-native";
import type { CloudRunnerIntent, CloudRunnerProof, CloudRunnerScope } from "../cloud-runner-contract";
import type { BoundarySpawnRequest } from "../types";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const id = "11111111-1111-4111-8111-111111111111";
const scope: Omit<CloudRunnerScope, "executionId"> = { version: 1, organizationId: id, workspaceId: id, generation: 1,
  engineInstanceId: id, bootId: id, writerEpoch: id, runtimeId: `r1-${"a".repeat(64)}`, owner: { pid: 100, startToken: "1000" },
  workload: { directory: "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload", dev: "1", ino: "2" } };
const material = { command: "/qualified/provider", args: ["private-provider-argument"], cwd: "/private-checkout",
  env: { PROVIDER_TEST_KEY: "synthetic-private-runner-material" } };
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "runner-boundary-")), registry = new CloudOwnedWorkloadRegistry();
  const workload = await registry.prepare(new HostExecutionBoundary(), { executionId: randomUUID(), actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() },
    undefined, { kind: "agent", role: "workload" });
  vi.spyOn(workload, "wrapSpawn").mockImplementation(request => ({ ...request, stdio: "pipe" }));
  vi.spyOn(workload, "cancelUnstartedLaunch").mockImplementation(() => {});
  const hostStop = vi.fn(async () => {});
  vi.spyOn(workload, "trackProcess").mockImplementation(child => ({ pid: child.pid!, child,
    stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, signal: async () => {}, stopAndProve: hostStop,
    wait: async () => ({ code: 0, signal: null }) }));
  let live = true, unknownRetirement = false;
  const proof = (intent: CloudRunnerIntent): CloudRunnerProof => ({ version: 1, attemptId: intent.attemptId, bootId: scope.bootId,
    unit: `zeros-agent-runner@${intent.scope.executionId}.service`, invocationId: "b".repeat(32), pid: 200, startToken: "2000",
    cgroup: { directory: `${scope.workload.directory}/runner-${scope.bootId}/zeros-agent-runner@${intent.scope.executionId}.service`, dev: "1", ino: "3" } });
  const client = { arguments: vi.fn(execution => ["/tmp/zeros-runners-abcdef", "150", "1500", "1", "5", "100", "1000", id, scope.runtimeId, execution, "1", "2"]),
    inspect: vi.fn(async (intent: CloudRunnerIntent) => ({ state: "running", proof: proof(intent) })),
    retire: vi.fn(async (intent: CloudRunnerIntent) => {
      if (unknownRetirement) throw new Error("unknown native retirement");
      const p = proof(intent);
      return { version: 1, attemptId: p.attemptId, bootId: p.bootId, unit: p.unit, invocationId: p.invocationId, cgroup: p.cgroup,
        originalStartSettled: true, originalProcessGone: true, complete: true, populated: false };
    }) };
  const assertCurrent = vi.fn(() => { if (!live) throw new Error("source authority changed"); });
  const boundary = new CloudRunnerBoundary({ workload, scope, journalDirectory: directory, client: client as unknown as CloudRunnerNativeClient, assertCurrent });
  const capture = vi.fn<() => BoundarySpawnRequest>(() => structuredClone(material));
  const children: { input: PassThrough; output: PassThrough; error: PassThrough }[] = [];
  const launch = () => {
    const descriptor = boundary.wrapSpawn(capture), input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: 123, spawnfile: descriptor.command, spawnargs: [descriptor.command, ...descriptor.args], stdin: input, stdout: output, stderr: error }) as unknown as ChildProcess;
    const frames: { type: string; intent?: CloudRunnerIntent; request?: unknown }[] = [];
    input.on("data", bytes => { frames.push(JSON.parse(bytes.toString())); });
    const process = boundary.trackProcess(child);
    child.stdin!.on("error", () => {});
    children.push({ input, output, error });
    const begin = async () => { await expect.poll(() => frames[0]?.type).toBe("start"); return frames[0]!.intent!; };
    const frame = (type: string) => output.write(JSON.stringify({ type, proof: proof(frames[0]!.intent!) }) + "\n");
    const admit = async () => { await begin(); frame("native"); frame("hello"); await expect.poll(() => frames.some(frame => frame.type === "launch")).toBe(true); frame("ack"); await expect.poll(() => boundary.snapshot().pendingLaunches).toBe(0); };
    return { descriptor, child, process, frames, begin, frame, admit };
  };
  cleanup.push(async () => { live = true; unknownRetirement = false; await boundary.stopAndProve(); await registry.drain(registry.fence());
    for (const child of children) { child.input.destroy(); child.output.destroy(); child.error.destroy(); } rmSync(directory, { recursive: true, force: true }); });
  return { registry, workload, boundary, capture, client, hostStop, launch, revoke: () => { live = false; }, uncertain: (value: boolean) => { unknownRetirement = value; } };
}
describe("systemd adapter on original Host scope", () => {
  it("keeps synchronous SDK argv/env clean and captures provider material only after original proof", async () => {
    const f = await fixture(), child = f.launch();
    expect(f.capture).not.toHaveBeenCalled();
    for (const value of [material.command, material.cwd, material.args[0], material.env.PROVIDER_TEST_KEY]) expect(JSON.stringify(child.descriptor)).not.toContain(value);
    expect(f.registry.snapshot()).toMatchObject({ complete: false, pendingLaunches: 1 });
    await child.admit();
    expect(f.capture).toHaveBeenCalledOnce(); expect(child.frames.filter(frame => frame.type === "launch")).toHaveLength(1);
    expect(child.frames.find(frame => frame.type === "launch")!.request).toEqual(material);
    await child.process.stopAndProve();
    expect(f.client.retire).toHaveBeenCalledOnce(); expect(f.hostStop).toHaveBeenCalledOnce();
    expect(f.registry.snapshot()).toMatchObject({ complete: true, pendingLaunches: 0, failedRetirements: 0 });
  });
  it("does not send material after authority changes while the independent proof is pending", async () => {
    const f = await fixture(), child = f.launch();
    await child.begin(); f.revoke(); child.frame("native"); child.frame("hello");
    await expect.poll(() => f.client.retire.mock.calls.length).toBe(1);
    await expect.poll(() => f.hostStop.mock.calls.length).toBe(1);
    expect(f.capture).not.toHaveBeenCalled();
    expect(child.frames.some(frame => frame.type === "launch")).toBe(false);
  });
  it("joins Stop with an unacknowledged start and never replays it", async () => {
    const f = await fixture(), child = f.launch(); await child.begin();
    const stopping = child.process.stopAndProve();
    await stopping;
    expect(f.client.retire).toHaveBeenCalledOnce(); expect(f.capture).not.toHaveBeenCalled();
    child.frame("native"); child.frame("hello");
    expect(child.frames.filter(frame => frame.type === "start")).toHaveLength(1);
    expect(child.frames.some(frame => frame.type === "launch")).toBe(false);
  });
  it("retains unknown native retirement in the registry and keeps the Host transport alive", async () => {
    const f = await fixture(), child = f.launch(); await child.admit(); f.uncertain(true);
    await expect(child.process.stopAndProve()).rejects.toThrow();
    expect(f.hostStop).not.toHaveBeenCalled();
    expect(f.registry.snapshot()).toMatchObject({ complete: false, failedRetirements: 1 });
    f.uncertain(false); await child.process.stopAndProve();
    expect(f.hostStop).toHaveBeenCalledOnce(); expect(f.registry.snapshot().complete).toBe(true);
    expect(child.frames.filter(frame => frame.type === "launch")).toHaveLength(1);
  });
  it("gives multiple native children of one SDK scope distinct one-use unit identities", async () => {
    const f = await fixture(), one = f.launch(), two = f.launch();
    const [a, b] = await Promise.all([one.begin(), two.begin()]);
    expect(a.scope.executionId).not.toBe(b.scope.executionId); expect(a.attemptId).not.toBe(b.attemptId);
    await one.process.stopAndProve(); await two.process.stopAndProve();
    expect(f.client.retire).toHaveBeenCalledTimes(2); expect(f.capture).not.toHaveBeenCalled();
  });
  it("cancels an untracked transport before returning a preserved admission fence", async () => {
    const f = await fixture();
    f.boundary.wrapSpawn(f.capture);
    expect(f.registry.snapshot().pendingLaunches).toBe(1);
    const fence = f.registry.fence({ preserveActive: true });
    await f.registry.joinPending(fence);
    expect(f.registry.snapshot().pendingLaunches).toBe(0); expect(f.client.retire).not.toHaveBeenCalled();
    f.registry.resume(fence);
  });
  it("joins positive native retirement before returning a transport exit", async () => {
    const f = await fixture(), child = f.launch(); await child.admit();
    const retire = f.client.retire.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.client.retire.mockImplementation(async intent => { await pending; return retire(intent); });
    let done = false;
    const waiting = child.process.wait().then(exit => { done = true; return exit; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(f.client.retire).not.toHaveBeenCalled();
      child.child.emit("close", 0, null);
      await new Promise(resolve => setImmediate(resolve));
      expect(done).toBe(false);
      expect(f.boundary.originalGroups()).toHaveLength(1); expect(f.client.retire).toHaveBeenCalledOnce();
    } finally { child.child.emit("close", 0, null); release(); await waiting; }
    expect(await waiting).toEqual({ code: 0, signal: null });
    expect(f.boundary.originalGroups()).toHaveLength(0); expect(f.client.retire).toHaveBeenCalledOnce();
  });
});
