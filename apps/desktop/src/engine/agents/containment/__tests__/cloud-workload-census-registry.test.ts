import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";
import { createCloudWorkloadCustody } from "../cloud-workload-custody";
import * as hostModule from "../host-boundary";
import type { PreparedBoundary } from "../types";
import type { ResidentWorkloadClassification, ResidentWorkloadCensusRequest } from "../../../pty/resident-protocol";
import { cloudWorkloadKernelFixture, common, engine, identity, kernelProcess, workload } from "./helpers/cloud-workload-kernel";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: "/opt/zeros/node", supervisor: "/opt/zeros/host-process-supervisor.mjs" } }));
vi.mock("../cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
const authority = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  engineId: "33333333-3333-4333-8333-333333333333", generation: 1, fence: 2 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
function setup(kind: "engine" | "resident" = "engine") {
  const f = cloudWorkloadKernelFixture();
  if (kind === "resident") f.io.identity = () => ({ pid: 102, uid: 10003, gid: 10003, euid: 10003, egid: 10003 });
  const custody = createCloudWorkloadCustody(configuration, { io: f.io });
  const registry = new CloudOwnedWorkloadRegistry({ custody });
  return { ...f, custody, registry };
}
function terminal(f: ReturnType<typeof setup>, owner = 102) {
  const root = { ...kernelProcess(301, workload), parent: owner, tty: 9, foreground: 302 };
  const shell = { ...kernelProcess(302, workload), parent: 301, session: 301, tty: 9, foreground: 302 };
  f.processes.set(root.pid, root); f.processes.set(shell.pid, shell); f.groups.get(workload)!.pids.push(root.pid, shell.pid);
  return { root, shell, proof: { executionId: "original-terminal", generation: "original-generation",
    supervisor: { pid: 301, startToken: "3010" }, shell: { pid: 302, startToken: "3020" },
    targetExecutable: shell.executable!, noRecentInput: true as const } };
}
function owner(f: ReturnType<typeof setup>, change?: (reply: ResidentWorkloadClassification) => void,
  awaiting?: () => Promise<void>) {
  const t = terminal(f);
  const channel = { authority, owner: { pid: 102, startToken: "1020" }, assertLive: vi.fn(),
    async classifyWorkloads(request: ResidentWorkloadCensusRequest): Promise<ResidentWorkloadClassification> {
      await awaiting?.();
      const reply: ResidentWorkloadClassification = { ...request, authority, owner: this.owner,
        complete: true, pendingLaunches: 0, failedRetirements: 0, quietTerminals: [t.proof] };
      change?.(reply); return reply;
    } };
  f.registry.registerOwner(channel);
  return { ...t, channel };
}

describe("ORIGINAL registry joined to complete shared kernel census (fake kernel IO)", () => {
  it("rejects copied custody and counts detached work with no local Host record", async () => {
    const f = setup();
    expect(() => new CloudOwnedWorkloadRegistry({ custody: { ...f.custody } })).toThrow();
    f.groups.get(workload)!.pids.push(401); f.processes.set(401, kernelProcess(401, workload));
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [401], infrastructurePids: [101, 102] });
  });
  it("counts engine-leaf and new-sibling jobs without PID adoption", async () => {
    const f = setup(), sibling = `${common}/user-created`;
    f.groups.set(sibling, { identity: identity("89"), pids: [402] });
    f.groups.get(engine)!.pids.push(401);
    f.processes.set(401, kernelProcess(401, engine)); f.processes.set(402, kernelProcess(402, sibling));
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [401, 402] });
  });
  it("allows live exact controllers through pre-seal quiescence, but refuses a detached job", async () => {
    const f = setup(), ticket = f.registry.fence();
    f.groups.get(workload)!.pids.push(401); f.processes.set(401, kernelProcess(401, workload));
    await expect(f.registry.drain(ticket)).rejects.toThrow();
    expect(() => f.registry.resume(ticket)).toThrow();
    f.groups.get(workload)!.pids = []; f.processes.delete(401);
    await f.registry.drain(ticket); f.registry.resume(ticket);
    expect(f.processes.has(101)).toBe(true);
  });
  it("distinguishes owner group retirement from detached-work aggregate quiescence", async () => {
    const f = setup("resident"), ownerTicket = f.registry.fence(), sealTicket = f.registry.fence();
    f.groups.get(workload)!.pids.push(401); f.processes.set(401, kernelProcess(401, workload));
    const proof = await f.registry.drainOwned(ownerTicket);
    expect(proof).toEqual({ kind: "owner-process-groups", fenceId: ownerTicket.id, owner: f.custody.controller });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [401] });
    expect(() => f.registry.resume(ownerTicket)).toThrow();
    expect(() => f.registry.resumeOwned({ ...ownerTicket })).toThrow();
    f.registry.resumeOwned(ownerTicket);
    expect(() => f.registry.assertAccepting()).toThrow(); // independent seal remains fenced
    await expect(f.registry.drain(sealTicket)).rejects.toThrow();
    expect(() => f.registry.resume(sealTicket)).toThrow();
    f.groups.get(workload)!.pids = []; f.processes.delete(401);
    await f.registry.drain(sealTicket); f.registry.resume(sealTicket);
    expect(() => f.registry.assertAccepting()).not.toThrow();
    expect(() => f.registry.resumeOwned(ownerTicket)).toThrow();
  });
  it("refuses owner-group success for stale custody or failed original retirement", async () => {
    const f = setup("resident"), host = new hostModule.HostExecutionBoundary({ cloudWorkloadCustody: f.custody });
    const prepare = host.prepare.bind(host);
    let original!: PreparedBoundary;
    vi.spyOn(host, "prepare").mockImplementationOnce(async (...args) => { original = await prepare(...args); return original; });
    await f.registry.prepare(host, { executionId: randomUUID(), actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() },
      undefined, { kind: "service", role: "workload" });
    vi.spyOn(original, "stopAndProve").mockRejectedValueOnce(new Error("original group proof failed"));
    const ticket = f.registry.fence();
    await expect(f.registry.drainOwned(ticket)).rejects.toThrow("original group proof failed");
    expect(f.registry.snapshot().failedRetirements).toBe(1);
    expect(() => f.registry.resumeOwned(ticket)).toThrow();
    await f.registry.drainOwned(ticket);
    const birth = f.processes.get(102)!;
    f.processes.set(102, { ...birth, startToken: "9999" });
    expect(() => f.registry.resumeOwned(ticket)).toThrow();
    f.processes.set(102, birth);
    f.registry.resumeOwned(ticket);
  });
  it("uses actual resident ownership only for an exact quiet two-member terminal", async () => {
    const f = setup(); owner(f);
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [], quietTerminalPids: [301, 302] });
    f.groups.get(workload)!.pids.push(401); f.processes.set(401, kernelProcess(401, workload));
    expect((await f.registry.inspect()).workloadPids).toEqual([401]);
  });
  it.each(["running", "exec", "extra-child", "wrong-parent", "no-tty", "background", "pid-reuse"])(
    "never subtracts a resident terminal with %s evidence", async condition => {
      const f = setup(), t = owner(f);
      if (condition === "running") f.processes.set(302, { ...t.shell, state: "R" });
      if (condition === "exec") f.processes.set(302, { ...t.shell, executable: { dev: "4", ino: "100" } });
      if (condition === "wrong-parent") f.processes.set(301, { ...t.root, parent: 101 });
      if (condition === "no-tty") f.processes.set(302, { ...t.shell, tty: 0 });
      if (condition === "background") f.processes.set(302, { ...t.shell, foreground: 399 });
      if (condition === "pid-reuse") f.processes.set(302, { ...t.shell, startToken: "99999" });
      if (condition === "extra-child") {
        f.groups.get(workload)!.pids.push(401); f.processes.set(401, { ...kernelProcess(401, workload), parent: 301, session: 301 });
      }
      const result = await f.registry.inspect();
      expect(result.workloadPids).toContain(301); expect(result.workloadPids).toContain(302);
    });
  it.each(["request", "census", "scope", "authority", "owner", "pending", "failed", "incomplete", "overlap"])(
    "refuses a %s remote classification without clearing work", async condition => {
      const f = setup(); owner(f, reply => {
        if (condition === "request") reply.requestId = randomUUID();
        if (condition === "census") reply.censusSha256 = "f".repeat(64);
        if (condition === "scope") reply.common = { ...reply.common, ino: "99" };
        if (condition === "authority") reply.authority = { ...reply.authority, fence: 3 };
        if (condition === "owner") reply.owner = { ...reply.owner, startToken: "99" };
        if (condition === "pending") reply.pendingLaunches = 1;
        if (condition === "failed") reply.failedRetirements = 1;
        if (condition === "incomplete") reply.complete = false;
        if (condition === "overlap") reply.quietTerminals.push({ ...reply.quietTerminals[0]! });
      });
      const result = await f.registry.inspect();
      expect(result.complete).toBe(false); expect(result.workloadPids).toContain(302);
    });
  it("rechecks owner authority and same-census births after the remote await", async () => {
    const f = setup(), t = owner(f, undefined, async () => {
      f.groups.get(engine)!.pids.push(401); f.processes.set(401, kernelProcess(401, engine));
    });
    const result = await f.registry.inspect();
    expect(result.complete).toBe(false); expect(result.workloadPids).toContain(401);
    expect(t.channel.assertLive).toHaveBeenCalledTimes(3); // admission, before and after the await
  });
  it("rechecks C3 state after the remote await even when census membership is unchanged", async () => {
    const f = setup();
    const original = f.custody.inspect().censusSha256;
    const t = owner(f, undefined, async () => {
      const shell = f.processes.get(302)!;
      f.processes.set(302, { ...shell, state: "R" });
    });
    const before = f.custody.inspect().censusSha256;
    expect(before).not.toBe(original);
    const result = await f.registry.inspect();
    expect(f.custody.inspect().censusSha256).toBe(before);
    expect(result.complete).toBe(true);
    expect(result.quietTerminalPids).toEqual([]);
    expect(result.workloadPids).toEqual([301, 302]);
    expect(t.channel.assertLive).toHaveBeenCalledTimes(3);
  });
  it("stale owner channels stay unknown and never mint infrastructure", async () => {
    const f = setup(), t = owner(f);
    t.channel.assertLive.mockImplementation(() => { throw new Error("attachment lost"); });
    expect(await f.registry.inspect()).toMatchObject({ complete: false, workloadPids: [301, 302], infrastructurePids: [101, 102] });
    const clone = { ...t.channel, owner: { pid: 301, startToken: "3010" } };
    expect(() => f.registry.registerOwner(clone)).toThrow();
  });
  it("produces classifications only from its ORIGINAL current Host scope and controller", async () => {
    const f = setup(), t = terminal(f, 101), host = new hostModule.HostExecutionBoundary({ cloudWorkloadCustody: f.custody });
    const prepare = host.prepare.bind(host), snapshots = new Map<PreparedBoundary, hostModule.HostOwnedLifecycleSnapshot>();
    const snapshot = hostModule.hostOwnedLifecycleSnapshot;
    vi.spyOn(hostModule, "hostOwnedLifecycleSnapshot").mockImplementation(boundary => snapshots.get(boundary) ?? snapshot(boundary));
    vi.spyOn(host, "prepare").mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args);
      snapshots.set(prepared, { pendingLaunches: 0, groups: [{ pid: 301, startTicks: "3010", targetExecutable: t.shell.executable }] });
      return prepared;
    });
    const prepared = await f.registry.prepare(host, { executionId: randomUUID(), actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() },
      undefined, { kind: "terminal", role: "workload", terminalIdle: () => true });
    cleanups.push(async () => { f.groups.get(workload)!.pids = []; f.processes.delete(301); f.processes.delete(302); await prepared.stopAndProve(); });
    const census = f.custody.inspect(), request: ResidentWorkloadCensusRequest = { version: 1, requestId: randomUUID(),
      censusSha256: census.censusSha256!, common: census.common };
    const reply = await f.registry.classifyWorkloads(request, authority);
    expect(reply).toMatchObject({ ...request, complete: true, owner: { pid: 101, startToken: "1010" }, quietTerminals: [{
      executionId: expect.any(String), generation: prepared.generation, supervisor: t.proof.supervisor, shell: t.proof.shell,
      targetExecutable: t.proof.targetExecutable, noRecentInput: true }] });
    expect((await f.registry.classifyWorkloads({ ...request, censusSha256: "e".repeat(64) }, authority)).complete).toBe(false);
    expect((await f.registry.inspect()).workloadPids).toEqual([]);
  });
});
