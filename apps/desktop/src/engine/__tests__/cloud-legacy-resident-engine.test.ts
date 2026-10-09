import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { ResidentTerminalService } from "../pty/resident-service";
import { ResidentLegacyControlClient } from "../pty/resident-client";
import { ResidentPtyError, type ResidentLegacyRetirementReceipt } from "../pty/resident-protocol";
import { CloudOwnedWorkloadRegistry } from "../agents/containment/cloud-owned-workloads";
import { createCloudWorkloadCustody } from "../agents/containment/cloud-workload-custody";
import { cloudWorkloadKernelFixture, kernelProcess, resident, workload } from "../agents/containment/__tests__/helpers/cloud-workload-kernel";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: "/opt/zeros/node", supervisor: "/opt/zeros/host-process-supervisor.mjs" } }));
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/containment/cloud-worker-config", async original => ({ ...await original<object>(),
  isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }) }));
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); });

async function fixture() {
  const kernel = cloudWorkloadKernelFixture();
  // The original dedicated legacy scope is outside the modern common tree.
  // The explicit fake kernel projection does not import its PID/exemption.
  kernel.projection.infrastructure = kernel.projection.infrastructure.filter(value => value.kind === "engine");
  kernel.groups.delete(resident); kernel.processes.delete(102);
  const custody = createCloudWorkloadCustody(configuration, { io: kernel.io }), registry = new CloudOwnedWorkloadRegistry({ custody });
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2,
    engineInstanceId: "11111111-1111-4111-8111-111111111111" };
  const authority = { organizationId: scope.organizationId, workspaceId: scope.workspaceId, engineId: scope.engineInstanceId,
    generation: scope.generation, fence: 5, token: randomBytes(32).toString("base64url") };
  const hostId = randomUUID(), runtime = { runtimeId: `r1-${"a".repeat(64)}`, bootId: randomUUID(), supervisorSessionId: randomUUID(),
    cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" };
  const service = new ResidentTerminalService({ hostId, socketPath: "/unused", authority, legacyControl: { runtime } });
  const client = service["client"];
  vi.spyOn(client, "connect").mockResolvedValue(); vi.spyOn(client, "list").mockResolvedValue([]);
  vi.spyOn(client, "isConnected").mockReturnValue(true);
  vi.spyOn(client, "inspectWorkloads").mockRejectedValue(new ResidentPtyError("request_rejected"));
  const root = vi.spyOn(ResidentLegacyControlClient.prototype, "retire").mockImplementation(async requestId => ({
    version: 1, operation: "retire-legacy-resident", requestId,
    source: { hostId, authority: { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
      runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
      scope: { directory: `${runtime.cgroupRoot}/engine-workload-${hostId}`, dev: "7", ino: "99" } },
    phase: "retired", proof: { kind: "dedicated-resident-cgroup", populated: 0 }, replacement: "fresh-view-required",
  } satisfies ResidentLegacyRetirementReceipt));
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const registration = { readiness: () => ({ version: 1, instanceId: scope.engineInstanceId, health: "ready", durableRecordConnected: true }),
    hasRuntimeHandoffAuthority: () => true, localCommandsNegotiated: () => false, verifyClientAdmission: vi.fn(), stop: vi.fn() };
  const state = Object.assign(Object.create(ZerosEngine.prototype), { running: true, cloudWorker: configuration,
    cloudRuntimeRegistration: registration, cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId } },
    cloudWorkloads: registry, residentTerminals: service, residentConfiguration: { hostId, authority },
    cloudResidentWorkloadOwnerRelease: null, terminals: { add: vi.fn() },
    cloudLegacyResidentUserActivity: { at: 0 }, cloudLegacyResidentRequiresFreshView: false,
    cloudLegacyResidentFence: null, cloudLegacyResidentFlight: null, cloudLegacyResidentRetryTimer: null,
    cloudCommands: { pauseClaims: vi.fn(), resumeClaims: vi.fn() },
    cloudHumanServices: { pause: vi.fn(async () => undefined), resume: vi.fn() },
    cloudLanguageServices: { pause: vi.fn(async () => undefined), resume: vi.fn() },
    cloud: { setHumanServicesPaused: vi.fn() }, cloudIdleBusy: vi.fn(() => false),
  });
  cleanups.push(() => { clearTimeout(state.cloudLegacyResidentRetryTimer); service.disconnect(); });
  return { state, registry, kernel, service, root, registration, scope, setNow: (value: number) => { now = value; } };
}

function installStopPorts(state: Awaited<ReturnType<typeof fixture>>["state"]) {
  Object.assign(state, { cloudIdleStop: { close: vi.fn() },
    agents: { revokeSessionTools: vi.fn(), dispose: vi.fn() }, pty: { killAll: vi.fn() },
    terminals: { add: vi.fn(), clear: vi.fn() }, watcher: { stop: vi.fn() }, transports: [],
    removePortFile: vi.fn(), clearBusy: vi.fn(),
  });
  state.cloudCommands.close = vi.fn();
  state.cloudRuntimeRegistration.stop.mockImplementation(() => {
    state.cloudRuntimeRegistration.hasRuntimeHandoffAuthority = () => false;
  });
}

describe("engine bounded original legacy resident convergence (explicit fake kernel IO)", () => {
  it("retains unsupported attachment as unknown and fenced instead of adopting legacy metadata", async () => {
    const f = await fixture();
    await f.state.restoreResidentTerminals();
    expect(await f.state.cloudIdleUserProcesses()).toBe(true);
    expect(() => f.registry.assertAccepting()).toThrow();
    expect(f.state.cloudRuntimeReadiness()).toBeNull(); expect(f.state.terminals.add).not.toHaveBeenCalled();
    await f.state.retireObservedLegacyResident(); expect(f.root).not.toHaveBeenCalled();
  });

  it("retires only the original root leaf after ten user-quiet minutes, keeping fresh-view and independent fences", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals();
    const seal = f.registry.fence();
    f.setNow(599_999); await f.state.retireObservedLegacyResident(); expect(f.root).not.toHaveBeenCalled();
    f.setNow(600_000); await f.state.retireObservedLegacyResident();
    expect(f.root).toHaveBeenCalledOnce(); expect(f.service.legacyRetirementReceipt).not.toBeNull();
    expect(await f.state.cloudIdleUserProcesses()).toBe(false);
    expect(() => f.registry.assertAccepting()).toThrow(); expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    expect(f.state.cloudRuntimeReadiness()).toBeNull();
    const local = f.registry.fence();
    expect(f.state.fenceCloudResidentWorkloads("drain")).toBeNull();
    await f.state.drainCloudWorkloads(local, null); f.registry.resume(local);
    expect(() => f.registry.assertAccepting()).toThrow();
    await f.registry.drain(seal); f.registry.resume(seal);
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("never turns a dedicated old-leaf receipt into current shared-tree empty proof", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); f.setNow(600_000);
    await f.state.retireObservedLegacyResident();
    f.kernel.groups.get(workload)!.pids.push(401); f.kernel.processes.set(401, kernelProcess(401, workload));
    expect(await f.state.cloudIdleUserProcesses()).toBe(true);
    await expect(f.state.drainCloudWorkloads(f.registry.fence(), null)).rejects.toThrow("positively empty");
  });

  it("does not send a root effect when user activity or foreground work races the eligibility read", async () => {
    for (const change of ["activity", "foreground"] as const) {
      const f = await fixture(); await f.state.restoreResidentTerminals(); f.setNow(600_000);
      const read = f.service.readLegacyRetirementCandidate.bind(f.service);
      vi.spyOn(f.service, "readLegacyRetirementCandidate").mockImplementationOnce(async () => {
        const result = await read();
        if (change === "activity") f.state.cloudLegacyResidentUserActivity = { at: 600_000 };
        else f.state.cloudIdleBusy.mockReturnValue(true);
        return result;
      });
      await f.state.retireObservedLegacyResident(); expect(f.root).not.toHaveBeenCalled();
    }
  });

  it("keeps unknown root ACK fenced and retries the exact original body", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); f.setNow(600_000);
    f.root.mockRejectedValueOnce(new ResidentPtyError("host_unavailable"));
    await expect(f.state.retireObservedLegacyResident()).rejects.toThrow("host_unavailable");
    expect(await f.state.cloudIdleUserProcesses()).toBe(true); expect(f.state.cloudRuntimeReadiness()).toBeNull();
    await f.state.retireObservedLegacyResident();
    expect(f.root.mock.calls[1]![0]).toBe(f.root.mock.calls[0]![0]);
    expect(f.service.legacyRetirementReceipt).not.toBeNull(); expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("does not expose clients or re-open claims after checkpoint cancellation requires a fresh view", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); f.setNow(600_000);
    await f.state.retireObservedLegacyResident();
    f.state.cloudWorkloadCheckpointFence = f.registry.fence(); f.state.cloudRuntimeCheckpointQuiescing = true;
    await f.state.resumeCloudCheckpointAdmission();
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    expect(f.state.cloudHumanServices.resume).not.toHaveBeenCalled(); expect(() => f.registry.assertAccepting()).toThrow();
    expect(await f.state.verifyCloudActorClient("unused")).toBeNull();
    expect(f.registration.verifyClientAdmission).not.toHaveBeenCalled();
  });

  it("keeps a modern unsupported host and kernel-empty snapshot insufficient on root refusal", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); f.setNow(600_000);
    f.root.mockRejectedValue(new ResidentPtyError("host_unavailable"));
    await expect(f.state.retireObservedLegacyResident()).rejects.toThrow("host_unavailable");
    expect((await f.registry.inspect()).workloadPids).toEqual([]);
    expect(await f.state.cloudIdleUserProcesses()).toBe(true); expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("keeps Local and organization-local outside the root legacy path", async () => {
    const f = await fixture(); f.state.cloudWorker = null;
    f.setNow(600_000); await f.state.retireObservedLegacyResident(); expect(f.root).not.toHaveBeenCalled();
  });

  it("joins the exact pending root retirement and clears retry before registration shutdown", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); installStopPorts(f.state); f.setNow(600_000);
    const original = f.root.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.root.mockImplementationOnce(async requestId => { await gate; return original(requestId); });
    const timer = setTimeout(() => undefined, 60_000); timer.unref(); f.state.cloudLegacyResidentRetryTimer = timer;
    const retiring = f.state.retireObservedLegacyResident();
    await expect.poll(() => f.root.mock.calls.length).toBe(1);
    const stopping = f.state.stop();
    void stopping.catch(() => undefined);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.registration.stop).not.toHaveBeenCalled();
      expect(f.state.cloudLegacyResidentRetryTimer).toBeNull();
      expect(() => f.registry.assertAccepting()).toThrow();
      release(); await retiring; await stopping;
      expect(f.service.legacyRetirementReceipt).not.toBeNull();
      expect(f.registration.stop).toHaveBeenCalledOnce(); expect(f.root).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([retiring, stopping]); clearTimeout(timer); }
  });

  it("reconciles an unknown original root ACK during Stop without releasing its fence", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); installStopPorts(f.state); f.setNow(600_000);
    f.root.mockRejectedValueOnce(new ResidentPtyError("host_unavailable"));
    await expect(f.state.retireObservedLegacyResident()).rejects.toThrow("host_unavailable");
    await expect(f.state.stop()).resolves.toBeUndefined();
    expect(f.root).toHaveBeenCalledTimes(2);
    expect(f.root.mock.calls[1]![0]).toBe(f.root.mock.calls[0]![0]);
    expect(f.service.legacyRetirementReceipt).not.toBeNull();
    expect(f.state.cloudLegacyResidentRetryTimer).toBeNull(); expect(() => f.registry.assertAccepting()).toThrow();
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
  });

  it("replays the saved root receipt when its reply is lost while Stop joins the pending request", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); installStopPorts(f.state); f.setNow(600_000);
    const original = f.root.getMockImplementation()!;
    let release!: () => void, committed: ResidentLegacyRetirementReceipt | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.root.mockImplementationOnce(async requestId => {
      await gate; committed = await original(requestId);
      throw new ResidentPtyError("host_unavailable");
    }).mockImplementation(async requestId => {
      expect(committed?.requestId).toBe(requestId);
      expect(f.registration.hasRuntimeHandoffAuthority()).toBe(true);
      expect(f.registration.stop).not.toHaveBeenCalled();
      return committed!;
    });
    const retiring = f.state.retireObservedLegacyResident(); void retiring.catch(() => undefined);
    await expect.poll(() => f.root.mock.calls.length).toBe(1);
    const source = f.state.cloudLegacyResidentSource, request = f.service["legacyRetirementState"];
    const stopping = f.state.stop(); void stopping.catch(() => undefined);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.registration.stop).not.toHaveBeenCalled();
      expect(() => f.registry.assertAccepting()).toThrow();
      release(); await Promise.allSettled([retiring, stopping]);
      expect(f.root).toHaveBeenCalledTimes(2);
      expect(f.root.mock.calls[1]![0]).toBe(f.root.mock.calls[0]![0]);
      expect(f.state.cloudLegacyResidentSource).toBe(source);
      expect(f.service["legacyRetirementState"]).toBe(request);
      expect(f.service.legacyRetirementReceipt).toEqual(committed);
      await expect(stopping).resolves.toBeUndefined();
      expect(f.registration.stop).toHaveBeenCalledOnce();
      expect(f.state.cloudLegacyResidentRetryTimer).toBeNull();
      expect(() => f.registry.assertAccepting()).toThrow();
      expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([retiring, stopping]); }
  });

  it("does not start a root effect when the joined preparation fails before saving a request", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); installStopPorts(f.state); f.setNow(600_000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const join = vi.spyOn(f.registry, "joinPending").mockImplementationOnce(async () => {
      await gate; throw new Error("Original pending preparation failed");
    });
    const retiring = f.state.retireObservedLegacyResident(); void retiring.catch(() => undefined);
    await expect.poll(() => join.mock.calls.length).toBe(1);
    const stopping = f.state.stop(); void stopping.catch(() => undefined);
    try {
      expect(f.service.requiresFreshView()).toBe(false);
      release(); await Promise.allSettled([retiring, stopping]);
      await expect(stopping).rejects.toThrow("Zeros engine teardown failed");
      expect(f.root).not.toHaveBeenCalled();
      expect(f.service.requiresFreshView()).toBe(false);
      expect(f.service.legacyRetirementReceipt).toBeNull();
      expect(() => f.registry.assertAccepting()).toThrow();
      expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([retiring, stopping]); }
  });

  it.each(["source", "custody"] as const)("refuses pending lost-reply replay after original %s changes", async change => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); installStopPorts(f.state); f.setNow(600_000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.root.mockImplementationOnce(async () => { await gate; throw new ResidentPtyError("host_unavailable"); });
    const retiring = f.state.retireObservedLegacyResident(); void retiring.catch(() => undefined);
    await expect.poll(() => f.root.mock.calls.length).toBe(1);
    const stopping = f.state.stop(); void stopping.catch(() => undefined);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (change === "source") f.state.cloudRuntimeConfig = { ...f.state.cloudRuntimeConfig };
      else f.kernel.processes.set(101, { ...f.kernel.processes.get(101)!, startToken: "replaced" });
      release(); await Promise.allSettled([retiring, stopping]);
      await expect(stopping).rejects.toThrow("Zeros engine teardown failed");
      expect(f.root).toHaveBeenCalledOnce();
      expect(f.service.legacyRetirementReceipt).toBeNull();
      expect(() => f.registry.assertAccepting()).toThrow();
      expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([retiring, stopping]); }
  });

  it("rejects a retained old-host proof after replacing the original engine scope", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals(); f.setNow(600_000);
    await f.state.retireObservedLegacyResident();
    f.state.cloudRuntimeConfig = { ...f.state.cloudRuntimeConfig,
      execution: { ...f.scope, generation: f.scope.generation + 1 } };
    expect(await f.state.cloudIdleUserProcesses()).toBe(true);
    await expect(f.state.drainCloudWorkloads(f.registry.fence(), null)).rejects.toThrow("original fence");
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("does not dispatch an already-admitted goal while the original view requires replacement", async () => {
    const f = await fixture(); await f.state.restoreResidentTerminals();
    const claim = { commandId: randomUUID(), payload: { agentId: "codex", operation: { kind: "goal", action: "clear" } }, executionId: randomUUID() };
    f.state.cloudCommandSessions = new Map([[claim.commandId, { claim, controller: new AbortController() }]]);
    f.state.agents = { cloudNativeCapabilities: vi.fn(), clearGoal: vi.fn(), getGoal: vi.fn() };
    f.state.cloudGoals = { revision: vi.fn(), confirm: vi.fn(), flush: vi.fn(async () => ({ goal: null })) };
    await expect(f.state.dispatchCloudCommand(claim)).rejects.toThrow("fresh view");
    expect(f.state.agents.cloudNativeCapabilities).not.toHaveBeenCalled();
    expect(f.state.agents.clearGoal).not.toHaveBeenCalled();
  });
});
