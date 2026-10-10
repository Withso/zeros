import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentPtyHost } from "../resident-host";
import { ResidentPtyClient } from "../resident-client";
import { createCloudWorkloadCustody } from "../../agents/containment/cloud-workload-custody";
import { nativeCloudWorkloadIO } from "../../agents/containment/cloud-workload-cgroup.mjs";
import { CloudOwnedWorkloadRegistry } from "../../agents/containment/cloud-owned-workloads";
import { cloudWorkloadKernelFixture, kernelProcess, common, engine, resident, workload } from "../../agents/containment/__tests__/helpers/cloud-workload-kernel";
import type { ResidentEngineAuthority, ResidentWorkloadCensusRequest } from "../resident-protocol";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: process.execPath,
    supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
vi.mock("../../agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
vi.mock("node:fs/promises", async original => {
  const source = await original<typeof import("node:fs/promises")>();
  return { ...source, realpath: vi.fn(source.realpath) };
});
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "resident-census-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const kernel = cloudWorkloadKernelFixture(), actual = nativeCloudWorkloadIO.process(process.pid)!;
  kernel.projection.infrastructure[1] = { kind: "resident", pid: process.pid, startToken: actual.startToken };
  kernel.io.identity = () => ({ pid: process.pid, uid: 10003, gid: 10003, euid: 10003, egid: 10003 });
  kernel.groups.get(resident)!.pids = [process.pid];
  kernel.processes.delete(102);
  kernel.processes.set(process.pid, { ...actual, directory: resident, uid: 10003 });
  const custody = createCloudWorkloadCustody(configuration, { io: kernel.io });
  const authority: ResidentEngineAuthority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 1, fence: 1, token: randomBytes(32).toString("base64url") };
  const host = new ResidentPtyHost({ root, socketPath: path.join(root, "host.sock"),
    organizationId: authority.organizationId, workspaceId: authority.workspaceId,
    shell: "/bin/bash", identity: { uid: process.getuid!(), gid: process.getgid!() }, custody });
  cleanups.push(() => host.stop());
  const read = kernel.io.read;
  kernel.io.read = (directory, name) => {
    if (directory === common && name === "cgroup.procs") {
      // Real ORIGINAL Host groups and /proc topology, explicit FAKE membership.
      // This does not qualify native cgroup entry or detached-child custody.
      const roots = new Set(host["workloads"].snapshot().scopes.flatMap(scope => scope.processGroups));
      const all = readdirSync("/proc").filter(value => /^[1-9]\d*$/.test(value))
        .map(value => nativeCloudWorkloadIO.process(Number(value))).filter(value => value !== null);
      const selected = new Set(all.filter(member => roots.has(member.group)).map(member => member.pid));
      for (let index = 0; index < all.length; index++) {
        const count = selected.size;
        for (const member of all) if (selected.has(member.parent)) selected.add(member.pid);
        if (count === selected.size) break;
      }
      for (const pid of kernel.groups.get(workload)!.pids) kernel.processes.delete(pid);
      const members = all.filter(member => selected.has(member.pid));
      kernel.groups.get(workload)!.pids = members.map(member => member.pid);
      for (const member of members) kernel.processes.set(member.pid, { ...member, uid: 10003, directory: workload });
      const current = nativeCloudWorkloadIO.process(process.pid)!;
      kernel.processes.set(process.pid, { ...current, uid: 10003, directory: resident });
    }
    return read(directory, name);
  };
  await host.start(); host.authorize(authority);
  const client = new ResidentPtyClient({ socketPath: path.join(root, "host.sock"), authority });
  cleanups.push(async () => client.disconnect()); await client.connect();
  const request = (): ResidentWorkloadCensusRequest => {
    const census = custody.inspect();
    if (!census.complete || !census.censusSha256) throw new Error("fixture census unavailable");
    return { version: 1, requestId: randomUUID(), censusSha256: census.censusSha256, common: census.common };
  };
  return { root, kernel, custody, authority, host, client, request };
}

describe.runIf(process.platform === "linux")("original resident classification producer (real Host, fake cgroup IO)", () => {
  it("drains a preserved original shell through successor RPC without claiming the successor tree empty", async () => {
    const f = await setup();
    await f.client.create({ sessionId: "retained-shell", cwd: f.root, cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin" } });
    const preserve = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
    await f.client.fenceWorkloads(preserve); await f.client.joinPendingWorkloads(preserve);
    const replacement = { ...f.authority, engineId: randomUUID(), generation: 2, fence: 2 };
    f.kernel.groups.get(engine)!.pids = [103]; f.kernel.processes.delete(101);
    f.kernel.processes.set(103, kernelProcess(103, engine));
    f.kernel.projection.infrastructure[0] = { kind: "engine", pid: 103, startToken: "1030" };
    const successorCustody = createCloudWorkloadCustody(configuration, { io: { ...f.kernel.io,
      identity: () => ({ pid: 103, uid: 10003, gid: 10003, euid: 10003, egid: 10003 }) } });
    f.host.authorize(replacement);
    const client = new ResidentPtyClient({ socketPath: path.join(f.root, "host.sock"), authority: replacement });
    cleanups.push(async () => client.disconnect()); await client.connect();
    const drain = { version: 1 as const, requestId: randomUUID(), mode: "drain" as const };
    await client.fenceWorkloads(drain);
    expect(await client.drainWorkloads(drain)).toMatchObject({ phase: "drained", scope: "owner-process-groups" });
    expect(f.host["workloads"].snapshot().scopes).toEqual([]);
    expect((await f.host["workloads"].inspect()).workloadPids).toContain(103);
    const successor = new CloudOwnedWorkloadRegistry({ custody: successorCustody });
    const ticket = successor.fence(); await successor.drain(ticket);
    expect((await successor.inspect()).workloadPids).toEqual([]);
    await client.resumeWorkloads(drain); successor.resume(ticket);
  });

  it("refuses higher root authority before preserve join, then releases only the joined original owner", async () => {
    const f = await setup(), fence = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
    const replacement = { ...f.authority, engineId: randomUUID(), generation: 2, fence: 2 };
    await f.client.fenceWorkloads(fence);
    expect(() => f.host.authorize(replacement)).toThrow("authority_rejected");
    await expect(f.client.create({ sessionId: "fenced", cwd: f.root, cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
    await f.client.joinPendingWorkloads(fence);
    f.host.authorize(replacement);
    const successor = new ResidentPtyClient({ socketPath: path.join(f.root, "host.sock"), authority: replacement });
    cleanups.push(async () => successor.disconnect()); await successor.connect();
    await expect(successor.fenceWorkloads(fence)).rejects.toThrow("request_rejected");
    await successor.create({ sessionId: "successor", cwd: f.root, cols: 80, rows: 24, env: {}, command: "exec sleep 60" });
    await successor.close("successor");
  });

  it("retains host-committed preserve join across a lost response and root revoke", async () => {
    const f = await setup(), fence = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
    await f.client.fenceWorkloads(fence);
    const send = f.host["send"].bind(f.host); let committed = false;
    vi.spyOn(f.host as unknown as { send: typeof send }, "send").mockImplementation((connection, frame) => {
      if (frame.kind === "reply" && typeof frame.result === "object" && frame.result !== null &&
        "phase" in frame.result && frame.result.phase === "joined") { committed = true; return; }
      send(connection, frame);
    });
    const joining = f.client.joinPendingWorkloads(fence), rejected = expect(joining).rejects.toThrow();
    await expect.poll(() => committed).toBe(true);
    f.host.revoke(2); f.host.authorize({ ...f.authority, engineId: randomUUID(), generation: 2, fence: 3 });
    await rejected;
  });

  it("does not release a full drain or overlapping Stop ticket at higher authorize", async () => {
    const f = await setup(), preserve = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
    await f.client.fenceWorkloads(preserve); await f.client.joinPendingWorkloads(preserve);
    const stop = { version: 1 as const, requestId: randomUUID(), mode: "drain" as const };
    await f.client.fenceWorkloads(stop);
    expect(() => f.host.authorize({ ...f.authority, engineId: randomUUID(), fence: 2 })).toThrow("authority_rejected");
    await expect(f.client.fenceWorkloads({ ...preserve, mode: "drain" })).rejects.toThrow("request_rejected");
  });

  it("rechecks native input after its original serialization await", async () => {
    const f = await setup();
    await f.client.create({ sessionId: "queued-input", cwd: f.root, cols: 80, rows: 24, env: {}, command: "exec sleep 60" });
    const session = f.host["sessions"].get("queued-input")!;
    let release!: () => void;
    session.tail = new Promise<void>(resolve => { release = resolve; });
    const native = vi.spyOn(session.proc, "write"), serialized = vi.spyOn(f.host as unknown as {
      serialize: typeof f.host["serialize"];
    }, "serialize");
    const writing = f.client.write("queued-input", { producerId: randomUUID(), sequence: 1, data: "never deliver" });
    const refused = expect(writing).rejects.toThrow("host_unavailable");
    await expect.poll(() => serialized.mock.calls.length).toBeGreaterThan(0);
    const fence = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
    await f.client.fenceWorkloads(fence); release(); await refused;
    expect(native).not.toHaveBeenCalled();
    await f.client.joinPendingWorkloads(fence); await f.client.resumeWorkloads(fence);
    // Delayed retry cannot rearm the released ticket.
    await f.client.fenceWorkloads(fence);
    await f.client.resize("queued-input", 90, 30);
    await f.client.close("queued-input");
  });

  it("joins and rejects a create already awaiting cwd before the host fence ACK", async () => {
    const f = await setup(), original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).realpath;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const resolving = vi.mocked(filesystem.realpath).mockClear().mockImplementationOnce(async value => { await gate; return original(value); });
    const creating = f.client.create({ sessionId: "late-create", cwd: f.root, cols: 80, rows: 24, env: {}, command: "exec sleep 60" });
    const refused = expect(creating).rejects.toThrow("host_unavailable");
    await expect.poll(() => resolving.mock.calls.length).toBe(1);
    const fence = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
    await f.client.fenceWorkloads(fence);
    let joined = false;
    const joining = f.client.joinPendingWorkloads(fence).then(() => { joined = true; });
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(joined).toBe(false); }
    finally { release(); }
    await refused; await joining;
    expect(f.host["workloads"].snapshot().scopes).toEqual([]);
    await f.client.resumeWorkloads(fence);
  });

  it("returns only the exact original resident controller and root-issued authority", async () => {
    const f = await setup(), request = f.request();
    const reply = await f.client.classifyWorkloads(request);
    expect(reply).toMatchObject({ ...request, complete: true,
      owner: { pid: f.custody.controller.pid, startToken: f.custody.controller.startToken },
      pendingLaunches: 0, failedRetirements: 0, quietTerminals: [] });
    expect(reply.authority).not.toHaveProperty("token");
  });

  it("classifies a real quiet shell only from its original Host scope", async () => {
    const f = await setup();
    await f.client.create({ sessionId: "original-quiet-shell", cwd: f.root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin", HOME: f.root } });
    await expect.poll(async () => (await f.client.classifyWorkloads(f.request())).quietTerminals.length).toBe(1);
    const row = (await f.client.classifyWorkloads(f.request())).quietTerminals[0]!;
    expect(row.shell.pid).not.toBe(row.supervisor.pid);
    expect(row.noRecentInput).toBe(true);
    expect(row.executionId).toBe(f.host["workloads"].snapshot().scopes[0]!.executionId);
    await f.client.close("original-quiet-shell");
    expect((await f.client.classifyWorkloads(f.request())).quietTerminals).toEqual([]);
  });

  it("counts a create awaiting cwd resolution before it registers any native scope", async () => {
    const f = await setup(), original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).realpath;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const resolving = vi.mocked(filesystem.realpath).mockClear().mockImplementationOnce(async value => {
      await wait; return original(value);
    });
    const creating = f.client.create({ sessionId: "pending-before-registry", cwd: f.root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin" }, command: "exec sleep 60" });
    try {
      await expect.poll(() => resolving.mock.calls.length).toBe(1);
      const reply = await f.client.classifyWorkloads(f.request());
      expect(reply).toMatchObject({ complete: false, pendingLaunches: 1, quietTerminals: [] });
    } finally { release(); resolving.mockRestore(); }
    await creating; await f.client.close("pending-before-registry");
  });

  it("does not publish a classification from an attachment replaced during the callback", async () => {
    const f = await setup(), original = f.host["workloads"].classifyWorkloads.bind(f.host["workloads"]);
    const replacement = vi.spyOn(f.host["workloads"], "classifyWorkloads").mockImplementationOnce((...args) => {
      const result = original(...args);
      f.host.authorize({ ...f.authority, engineId: randomUUID(), generation: 2, fence: 2 });
      return result;
    });
    await expect(f.client.classifyWorkloads(f.request())).rejects.toThrow();
    expect(replacement).toHaveBeenCalledOnce();
  });
});
