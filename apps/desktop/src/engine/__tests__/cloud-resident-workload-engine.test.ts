import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { ResidentTerminalService } from "../pty/resident-service";
import { CloudOwnedWorkloadRegistry } from "../agents/containment/cloud-owned-workloads";
import { createCloudWorkloadCustody } from "../agents/containment/cloud-workload-custody";
import type { ResidentWorkloadFenceRequest } from "../pty/resident-protocol";
import { cloudWorkloadKernelFixture, kernelProcess, resident, workload } from "../agents/containment/__tests__/helpers/cloud-workload-kernel";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: "/opt/zeros/node", supervisor: "/opt/zeros/host-process-supervisor.mjs" } }));
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/containment/cloud-worker-config", async original => ({ ...await original<object>(),
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const kernel = cloudWorkloadKernelFixture();
  const custody = createCloudWorkloadCustody(configuration, { io: kernel.io });
  const registry = new CloudOwnedWorkloadRegistry({ custody });
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 1, fence: 2, token: randomBytes(32).toString("base64url") };
  const service = new ResidentTerminalService({ hostId: resident.slice(resident.lastIndexOf("engine-workload-") + 16),
    socketPath: "/unused", authority });
  const client = service["client"];
  vi.spyOn(client, "connect").mockResolvedValue(); vi.spyOn(client, "list").mockResolvedValue([]);
  vi.spyOn(client, "isConnected").mockReturnValue(true);
  const classify = vi.spyOn(client, "classifyWorkloads").mockImplementation(async request => ({
    ...request, authority: { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
    owner: { pid: 102, startToken: "1020" }, complete: true, pendingLaunches: 0, failedRetirements: 0, quietTerminals: [],
  }));
  const legacy = vi.spyOn(service, "inspectWorkloads").mockResolvedValue(false);
  const engine = Object.assign(Object.create(ZerosEngine.prototype), { cloudWorker: configuration,
    cloudWorkloads: registry, residentTerminals: service, terminals: { add: vi.fn() } });
  const raw = vi.spyOn(client as unknown as { request(value: { op: string; fence: ResidentWorkloadFenceRequest }): Promise<unknown> }, "request")
    .mockImplementation(async value => ({ ...value.fence, authority: { organizationId: authority.organizationId,
      workspaceId: authority.workspaceId, engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
      scope: "owner-process-groups", phase: value.op === "fence-workloads" ? "fenced" : value.op === "join-workloads" ? "joined"
        : value.op === "drain-workloads" ? "drained" : "released" }));
  return { kernel, registry, service, client, classify, legacy, engine, raw };
}

describe("engine original resident owner aggregation (explicit fake kernel IO)", () => {
  it("joins original owner retirement before proving aggregate current-engine quiescence", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    f.kernel.groups.get(workload)!.pids.push(401); f.kernel.processes.set(401, kernelProcess(401, workload));
    const local = f.registry.fence(), remote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), original = f.raw.getMockImplementation()!;
    f.raw.mockImplementation(async value => {
      if (value.op === "drain-workloads") {
        await gate; f.kernel.groups.get(workload)!.pids = []; f.kernel.processes.delete(401);
      }
      return original(value);
    });
    let drained = false;
    const draining = f.engine.drainCloudWorkloads(local, remote).then(() => { drained = true; });
    await expect.poll(() => f.raw.mock.calls.some(([value]) => value.op === "drain-workloads")).toBe(true);
    expect(drained).toBe(false); expect(() => f.registry.assertAccepting()).toThrow();
    release(); await draining;
    expect((await f.registry.inspect()).workloadPids).toEqual([]);
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("refuses unknown owner ACK even if a later kernel census looks empty", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    const local = f.registry.fence(), remote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    const original = f.raw.getMockImplementation()!;
    f.raw.mockImplementation(async value => {
      if (value.op === "drain-workloads") throw new Error("owner ACK unknown");
      return original(value);
    });
    await expect(f.engine.drainCloudWorkloads(local, remote)).rejects.toThrow("owner ACK unknown");
    expect(() => f.registry.assertAccepting()).toThrow();
    await expect(f.service.create({ sessionId: "closed", cwd: "/tmp", cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
  });

  it("refuses detached work after an explicit owner-group retirement receipt", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    f.kernel.groups.get(workload)!.pids.push(401); f.kernel.processes.set(401, kernelProcess(401, workload));
    const local = f.registry.fence(), remote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    await expect(f.engine.drainCloudWorkloads(local, remote)).rejects.toThrow("positively empty");
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("releases both checkpoint/idle owner tickets while preserving independent seal tickets", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    const checkpoint = f.registry.fence(), idle = f.registry.fence(), seal = f.registry.fence();
    const checkpointRemote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    const idleRemote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    const sealRemote = f.service.fenceWorkloads("drain");
    Object.assign(f.engine, { cloudWorkloadCheckpointFence: checkpoint, cloudWorkloadIdleFence: idle,
      cloudResidentCheckpointFence: checkpointRemote, cloudResidentIdleFence: idleRemote,
      cloudRuntimeCheckpointQuiescing: true, running: false });
    await f.engine.resumeCloudCheckpointAdmission();
    expect(f.engine.cloudWorkloadCheckpointFence).toBeNull(); expect(f.engine.cloudWorkloadIdleFence).toBeNull();
    expect(f.engine.cloudResidentCheckpointFence).toBeNull(); expect(f.engine.cloudResidentIdleFence).toBeNull();
    expect(() => f.registry.assertAccepting()).toThrow();
    await expect(f.service.create({ sessionId: "seal-held", cwd: "/tmp", cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
    await f.registry.drain(seal); f.registry.resume(seal);
    await f.service.drainWorkloads(sealRemote); await f.service.resumeWorkloads(sealRemote);
    expect(() => f.registry.assertAccepting()).not.toThrow();
  });

  it("reconciles a lost second release ACK without losing the first original owner receipt", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    const checkpoint = f.registry.fence(), idle = f.registry.fence();
    const checkpointRemote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    const idleRemote = { owner: f.service, ticket: f.service.fenceWorkloads("drain") };
    Object.assign(f.engine, { cloudWorkloadCheckpointFence: checkpoint, cloudWorkloadIdleFence: idle,
      cloudResidentCheckpointFence: checkpointRemote, cloudResidentIdleFence: idleRemote,
      cloudRuntimeCheckpointQuiescing: true, running: false });
    const original = f.raw.getMockImplementation()!; let lost = true;
    f.raw.mockImplementation(async value => {
      if (value.op === "resume-workloads" && value.fence.requestId === idleRemote.ticket.requestId && lost) {
        lost = false; throw new Error("second release ACK unknown");
      }
      return original(value);
    });
    await expect(f.engine.resumeCloudCheckpointAdmission()).rejects.toThrow("second release ACK unknown");
    expect(() => f.registry.assertAccepting()).toThrow();
    await expect(f.engine.resumeCloudCheckpointAdmission()).resolves.toBeUndefined();
    expect(f.engine.cloudResidentCheckpointFence).toBeNull(); expect(f.engine.cloudResidentIdleFence).toBeNull();
    expect(() => f.registry.assertAccepting()).not.toThrow();
  });

  it("uses preserved admission join separately from owner/full-tree drain", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    const local = f.registry.fence({ preserveActive: true });
    const remote = { owner: f.service, ticket: f.service.fenceWorkloads("preserve") };
    await f.engine.joinCloudPreservedWorkloads(local, remote);
    expect(f.raw.mock.calls.map(([value]) => value.op)).toEqual(["fence-workloads", "join-workloads"]);
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("joins the actual attachment before relying on a complete kernel census", async () => {
    const f = fixture();
    await f.engine.restoreResidentTerminals();
    expect(await f.engine.cloudIdleUserProcesses()).toBe(false);
    expect(f.classify).toHaveBeenCalledOnce();
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("keeps an uninstalled resident attachment unknown even when its legacy boolean says idle", async () => {
    const f = fixture();
    expect(await f.engine.cloudIdleUserProcesses()).toBe(true);
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("keeps detached members busy without treating the remote owner as a blanket exemption", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    f.kernel.groups.get(workload)!.pids.push(401);
    f.kernel.processes.set(401, kernelProcess(401, workload));
    expect(await f.engine.cloudIdleUserProcesses()).toBe(true);
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("rechecks the actual owner after the remote await", async () => {
    const f = fixture(); await f.engine.restoreResidentTerminals();
    f.classify.mockImplementation(async request => {
      f.service.disconnect();
      return { ...request, authority: { organizationId: f.service["options"].authority.organizationId,
        workspaceId: f.service["options"].authority.workspaceId, engineId: f.service["options"].authority.engineId,
        generation: 1, fence: 2 }, owner: { pid: 102, startToken: "1020" }, complete: true,
        pendingLaunches: 0, failedRetirements: 0, quietTerminals: [] };
    });
    expect(await f.engine.cloudIdleUserProcesses()).toBe(true);
  });
});
