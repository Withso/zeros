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
const ptyHost = vi.hoisted(() => ({ birth: null as { pid: number; parent: number; startToken: string } | null }));
vi.mock("../../../pty/pty-host-client", async original => ({ ...await original<object>(), currentPtyHostBirth: () => ptyHost.birth }));
vi.mock("../cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
const authority = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  engineId: "33333333-3333-4333-8333-333333333333", generation: 1, fence: 2 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); ptyHost.birth = null; vi.restoreAllMocks(); });
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
function sharedPtyHost(f: ReturnType<typeof setup>) {
  const member = { ...kernelProcess(201, engine), parent: 101, group: 101, session: 101 };
  f.groups.get(engine)!.pids.push(member.pid); f.processes.set(member.pid, member);
  ptyHost.birth = { pid: member.pid, parent: member.parent, startToken: member.startToken };
  return member;
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
async function infrastructureScope(f: ReturnType<typeof setup>, kind: "language-service" | "service" = "language-service") {
  const supervisor = { ...kernelProcess(301, workload), parent: 101 };
  const target = { ...kernelProcess(302, workload), parent: 301, group: 301, session: 301 };
  const worker = { ...kernelProcess(303, workload), parent: 302, group: 303, session: 301 };
  for (const member of [supervisor, target, worker]) {
    f.processes.set(member.pid, member); f.groups.get(workload)!.pids.push(member.pid);
  }
  const host = new hostModule.HostExecutionBoundary({ cloudWorkloadCustody: f.custody });
  const prepare = host.prepare.bind(host), snapshots = new Map<PreparedBoundary, hostModule.HostOwnedLifecycleSnapshot>();
  let original!: PreparedBoundary;
  const snapshot = hostModule.hostOwnedLifecycleSnapshot;
  vi.spyOn(hostModule, "hostOwnedLifecycleSnapshot").mockImplementation(boundary => snapshots.get(boundary) ?? snapshot(boundary));
  vi.spyOn(host, "prepare").mockImplementationOnce(async (...args) => {
    const prepared = original = await prepare(...args);
    snapshots.set(prepared, { pendingLaunches: 0, groups: [{ pid: supervisor.pid, startTicks: supervisor.startToken, targetExecutable: target.executable }] });
    return prepared;
  });
  const prepared = await f.registry.prepare(host,
    { executionId: randomUUID(), actor: "repo-code-task", cwd: process.cwd(), workspaceRoot: process.cwd() },
    undefined, { kind, role: "infrastructure" });
  cleanups.push(async () => {
    for (const member of [supervisor, target, worker]) f.processes.delete(member.pid);
    f.groups.get(workload)!.pids = f.groups.get(workload)!.pids.filter(pid => ![301, 302, 303].includes(pid));
    await prepared.stopAndProve();
  });
  return { supervisor, target, worker, prepared, original, snapshots };
}

describe("ORIGINAL registry joined to complete shared kernel census (fake kernel IO)", () => {
  it("does not keep an empty original engine-owned PTY transport busy after its sessions end", async () => {
    const f = setup(); sharedPtyHost(f);
    const t = terminal(f, 201);
    expect((await f.registry.inspect()).workloadPids).toEqual(expect.arrayContaining([301, 302]));
    f.groups.get(workload)!.pids = []; f.processes.delete(t.root.pid); f.processes.delete(t.shell.pid);
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101, 102, 201] });
  });
  it.each(["recycled", "moved", "wrong-parent", "root", "lost-owner", "different-controller"])(
    "does not exempt a shared PTY transport with %s evidence", async condition => {
      const f = setup(), host = sharedPtyHost(f);
      if (condition === "recycled") f.processes.set(201, { ...host, startToken: "99999" });
      if (condition === "wrong-parent") f.processes.set(201, { ...host, parent: 102 });
      if (condition === "root") f.processes.set(201, { ...host, uid: 0 });
      if (condition === "lost-owner") ptyHost.birth = null;
      if (condition === "different-controller") ptyHost.birth = { ...ptyHost.birth!, parent: 102 };
      if (condition === "moved") {
        f.groups.get(engine)!.pids = [101]; f.groups.get(workload)!.pids.push(201);
        f.processes.set(201, { ...host, directory: workload });
      }
      expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [201], infrastructurePids: [101, 102] });
    });
  it.each([true, false])("retains C3 shell activity under the original PTY transport (recent-input quiet=%s)", async idle => {
    const f = setup(); sharedPtyHost(f);
    const t = terminal(f, 201), host = new hostModule.HostExecutionBoundary({ cloudWorkloadCustody: f.custody });
    const prepare = host.prepare.bind(host), snapshots = new Map<PreparedBoundary, hostModule.HostOwnedLifecycleSnapshot>();
    const snapshot = hostModule.hostOwnedLifecycleSnapshot;
    vi.spyOn(hostModule, "hostOwnedLifecycleSnapshot").mockImplementation(boundary => snapshots.get(boundary) ?? snapshot(boundary));
    vi.spyOn(host, "prepare").mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args);
      snapshots.set(prepared, { pendingLaunches: 0, groups: [{ pid: 301, startTicks: "3010", targetExecutable: t.shell.executable }] });
      return prepared;
    });
    const prepared = await f.registry.prepare(host,
      { executionId: randomUUID(), actor: "repo-code-task", cwd: process.cwd(), workspaceRoot: process.cwd() },
      undefined, { kind: "terminal", role: "workload", terminalIdle: () => idle });
    cleanups.push(async () => { f.groups.get(workload)!.pids = []; f.processes.delete(301); f.processes.delete(302); await prepared.stopAndProve(); });
    expect(await f.registry.inspect()).toMatchObject({ complete: true, infrastructurePids: [101, 102, 201],
      workloadPids: idle ? [] : [301, 302], quietTerminalPids: idle ? [301, 302] : [] });
  });
  it.each(["language-service", "service"] as const)("exempts only the original active %s infrastructure scope and its workers", async kind => {
    const f = setup(); await infrastructureScope(f, kind);
    expect(await f.registry.inspect()).toMatchObject({ complete: true, pendingLaunches: 0,
      workloadPids: [], infrastructurePids: [101, 102, 301, 302, 303] });
  });
  it("keeps unrelated engine-leaf and detached jobs busy beside language infrastructure", async () => {
    const f = setup(); await infrastructureScope(f);
    f.groups.get(engine)!.pids.push(401); f.processes.set(401, { ...kernelProcess(401, engine), parent: 101 });
    f.groups.get(workload)!.pids.push(402); f.processes.set(402, kernelProcess(402, workload));
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [401, 402],
      infrastructurePids: [101, 102, 301, 302, 303] });
  });
  it("never grants an infrastructure exemption to a recycled original Host root", async () => {
    const f = setup(), scope = await infrastructureScope(f);
    f.processes.set(301, { ...scope.supervisor, startToken: "99999" });
    const result = await f.registry.inspect();
    expect(result.workloadPids).toEqual([301, 302, 303]);
    expect(result.infrastructurePids).toEqual([101, 102]);
  });
  it.each([false, true])("keeps a new member of a reused leaderless group busy (old group observed=%s)", async observed => {
    const f = setup();
    await infrastructureScope(f);
    if (observed) expect((await f.registry.inspect()).workloadPids).toEqual([]);
    // The original group is gone. A later group reuses its numeric PGID,
    // loses its new leader, and leaves an unrelated child in the shared pool.
    for (const pid of [301, 302, 303]) f.processes.delete(pid);
    const unrelated = { ...kernelProcess(404, workload), parent: 1, group: 301, session: 301 };
    f.processes.set(unrelated.pid, unrelated);
    f.groups.get(workload)!.pids = [unrelated.pid];
    try {
      const result = await f.registry.inspect();
      expect(result.workloadPids).toContain(unrelated.pid);
      expect(result.infrastructurePids).not.toContain(unrelated.pid);
    } finally {
      f.processes.delete(unrelated.pid);
      f.groups.get(workload)!.pids = [];
    }
  });
  it("still exempts a currently matched original leader and its descendants", async () => {
    const f = setup(); await infrastructureScope(f);
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101, 102, 301, 302, 303] });
  });
  it("still exempts a previously witnessed original worker after its leader exits", async () => {
    const f = setup(), scope = await infrastructureScope(f);
    expect((await f.registry.inspect()).infrastructurePids).toContain(scope.worker.pid);
    f.processes.delete(301); f.processes.delete(302);
    f.processes.set(303, { ...scope.worker, parent: 1, group: 303, session: 303 });
    f.groups.get(workload)!.pids = [303];
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101, 102, 303] });
  });
  it("never learns a leaderless reused-group birth as infrastructure on a later scan", async () => {
    const f = setup(); await infrastructureScope(f);
    for (const pid of [301, 302, 303]) f.processes.delete(pid);
    const unrelated = { ...kernelProcess(404, workload), parent: 1, group: 301, session: 301 };
    f.processes.set(404, unrelated); f.groups.get(workload)!.pids = [404];
    expect((await f.registry.inspect()).workloadPids).toEqual([404]);
    f.processes.set(404, { ...unrelated, group: 404, session: 404 });
    expect((await f.registry.inspect()).workloadPids).toEqual([404]);
    expect((await f.registry.inspect()).infrastructurePids).toEqual([101, 102]);
  });
  it("keeps a recycled witnessed worker and its new descendants busy", async () => {
    const f = setup(), scope = await infrastructureScope(f);
    expect((await f.registry.inspect()).workloadPids).toEqual([]);
    f.processes.delete(301); f.processes.delete(302);
    f.processes.set(303, { ...scope.worker, parent: 1, group: 301, session: 301, startToken: "99999" });
    f.processes.set(404, { ...kernelProcess(404, workload), parent: 303, group: 303, session: 301 });
    f.groups.get(workload)!.pids = [303, 404];
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [303, 404], infrastructurePids: [101, 102] });
  });
  it("can prove a new descendant through a previously witnessed reparented worker", async () => {
    const f = setup(), scope = await infrastructureScope(f);
    expect((await f.registry.inspect()).workloadPids).toEqual([]);
    f.processes.delete(301); f.processes.delete(302);
    f.processes.set(303, { ...scope.worker, parent: 1, group: 303, session: 303 });
    f.processes.set(404, { ...kernelProcess(404, workload), parent: 303, group: 404, session: 303 });
    f.groups.get(workload)!.pids = [303, 404];
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101, 102, 303, 404] });
  });
  it("retains original infrastructure-worker births after reparenting, then removes the exemption on scope retirement", async () => {
    const f = setup(), scope = await infrastructureScope(f);
    expect((await f.registry.inspect()).workloadPids).toEqual([]);
    f.groups.get(workload)!.pids = [303]; f.processes.delete(301); f.processes.delete(302);
    f.processes.set(303, { ...scope.worker, parent: 1, session: 303 });
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101, 102, 303] });
    await scope.prepared.stopAndProve();
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [303], infrastructurePids: [101, 102] });
  });
  it("keeps aborted infrastructure visible until its original groups are retired", async () => {
    const f = setup(); await infrastructureScope(f); f.registry.fence();
    expect(await f.registry.inspect()).toMatchObject({ complete: true, workloadPids: [301, 302, 303], infrastructurePids: [101, 102] });
  });
  it("retains pending launches as busy even when the current language process is infrastructure", async () => {
    const f = setup(), scope = await infrastructureScope(f);
    scope.snapshots.set(scope.original, { pendingLaunches: 1, groups: [{ pid: 301, startTicks: "3010", targetExecutable: scope.target.executable }] });
    const result = await f.registry.inspect();
    expect(result.complete).toBe(false); expect(result.pendingLaunches).toBe(1);
  });
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
