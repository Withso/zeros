import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: process.execPath,
    supervisor: process.cwd() + "/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs" } }));
vi.mock("../agents/containment/cloud-worker-config", async original => ({ ...await original<object>(),
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
vi.mock("../cloud-idle-stop", async original => ({
  ...await original<object>(), hasCloudUserProcesses: vi.fn(async () => false),
}));
vi.mock("../pty/node-pty-spawn", () => ({
  createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn(),
}));

import { ZerosEngine } from "../zeros-engine";
import { hasCloudUserProcesses } from "../cloud-idle-stop";
import { CloudOwnedWorkloadRegistry, type CloudWorkloadFence } from "../agents/containment/cloud-owned-workloads";
import { HostExecutionBoundary } from "../agents/containment/host-boundary";
import { createCloudWorkloadCustody } from "../agents/containment/cloud-workload-custody";
import { cloudWorkloadKernelFixture } from "../agents/containment/__tests__/helpers/cloud-workload-kernel";
import { ResidentTerminalService } from "../pty/resident-service";
import type { ResidentWorkloadFenceRequest } from "../pty/resident-protocol";
import type { CloudCheckpointDirective } from "../cloud-runtime-registration";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";

const directive: CloudCheckpointDirective = {
  id: "idle-checkpoint", reason: "before_stop", deadlineAtMs: Date.now() + 60_000, idleStop: true,
};
const authority = {} as CloudDurabilityAuthority;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeEach(() => vi.mocked(hasCloudUserProcesses).mockReset().mockResolvedValue(false));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(withResident = false) {
  const kernel = cloudWorkloadKernelFixture();
  const custody = createCloudWorkloadCustody(configuration, { io: kernel.io });
  const registry = new CloudOwnedWorkloadRegistry({ custody });
  cleanups.push(() => registry.drain(registry.fence()));
  const resident = withResident ? new ResidentTerminalService({ hostId: randomUUID(), socketPath: "/unused",
    authority: { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
      generation: 1, fence: 2, token: randomBytes(32).toString("base64url") } }) : null;
  const operations: { op: string; fence: ResidentWorkloadFenceRequest }[] = [];
  if (resident) {
    const client = resident["client"], source = resident["options"].authority;
    vi.spyOn(client, "connect").mockResolvedValue();
    vi.spyOn(client, "list").mockResolvedValue([]);
    vi.spyOn(client, "isConnected").mockReturnValue(true);
    vi.spyOn(client as unknown as { request(value: typeof operations[number]): Promise<unknown> }, "request")
      .mockImplementation(async value => {
        operations.push(value);
        return { ...value.fence, authority: { organizationId: source.organizationId, workspaceId: source.workspaceId,
          engineId: source.engineId, generation: source.generation, fence: source.fence }, scope: "owner-process-groups",
          phase: value.op === "fence-workloads" ? "fenced" : value.op === "join-workloads" ? "joined"
            : value.op === "drain-workloads" ? "drained" : "released" };
      });
    await resident.connect();
    cleanups.push(() => resident.disconnect());
  }
  const state = {
    root: "/tmp", running: true, cloudWorker: configuration, cloudWorkloads: registry,
    residentTerminals: resident, cloudResidentWorkloadOwnerRelease: withResident ? () => {} : null,
    cloudRuntimeCheckpointQuiescing: false, cloudRuntimeHandoffFenced: false, cloudRuntimeAuthorityStopping: false,
    cloudLegacyResidentRequiresFreshView: false, cloudUnresolvedFinalCheckpoint: null,
    cloudFinalCheckpointReconciliationTimer: null as ReturnType<typeof setTimeout> | null,
    cloudIdleReservation: null as (() => boolean) | null, cloudIdleCheckpoint: null,
    cloudWorkloadIdleFence: null as CloudWorkloadFence | null,
    cloudWorkloadCheckpointFence: null as CloudWorkloadFence | null,
    cloudRuntimeRegistration: { idleStopRequest: vi.fn<() => Promise<CloudCheckpointDirective | null>>(async () => directive) },
    cloudCommands: { pauseClaims: vi.fn(), resumeClaims: vi.fn() },
    cloudHumanServices: { pause: vi.fn(async () => {}), resume: vi.fn() },
    cloudLanguageServices: { pause: vi.fn(async () => {}), resume: vi.fn() },
    cloud: { setHumanServicesPaused: vi.fn() },
    cloudCheckpointScheduler: { pause: vi.fn(async () => {}), resume: vi.fn() },
    cloudRecordRuntime: { flush: vi.fn(async () => {}) },
    cloudDurabilityRuntime: { checkpoint: vi.fn(async () => {}) },
    globalDesignAuthorityStarts: new Set<Promise<void>>(), cloudWorkspaceMutations: new Set<Promise<void>>(),
    workspaceProcessStarts: new Map<string, Set<Promise<void>>>(),
    waitForWorkspaceProcessStartSnapshot: vi.fn(async () => {}),
    setup: { stopAllAndProve: vi.fn(async () => {}) }, runs: { stopAllAndProve: vi.fn(async () => {}) },
    retireAllCodeAgentSessionsForTerritoryChange: vi.fn(async () => {}), terminals: { clear: vi.fn() },
  };
  cleanups.push(() => { if (state.cloudFinalCheckpointReconciliationTimer) clearTimeout(state.cloudFinalCheckpointReconciliationTimer); });
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  return { registry, resident, operations, state: state as typeof state & {
    stopIdleCloudWorkspace(authority: CloudDurabilityAuthority, stillIdle: () => boolean): Promise<void>;
    resumeCloudCheckpointAdmission(): Promise<void>;
    sealCloudLocalWriter(): Promise<void>;
    fenceCloudResidentWorkloads(mode: "preserve" | "drain"): unknown;
  } };
}

async function originalTerminal(f: Awaited<ReturnType<typeof fixture>>) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-idle-preserved-"));
  cleanups.unshift(() => rm(root, { recursive: true, force: true }));
  const host = new HostExecutionBoundary({ projectRoot: root,
    supervisorScript: path.resolve("apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs"),
    supervisorRuntime: process.execPath, cloudWorkloadCustody: f.registry.custody! });
  let signal: AbortSignal | undefined;
  const prepare = host.prepare.bind(host);
  vi.spyOn(host, "prepare").mockImplementation((request, control) => {
    signal = control?.signal;
    return prepare(request, control);
  });
  // Activity classification is controlled separately. This is a genuine
  // original Host group, not native cgroup or C3 shell qualification.
  const scope = await f.registry.prepare(host, { executionId: randomUUID(), actor: "repo-code-task", cwd: root,
    workspaceRoot: root }, undefined, { kind: "terminal", role: "workload", terminalIdle: () => true });
  const child = await scope.spawn({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const stopped = vi.spyOn(scope, "stopAndProve");
  const alive = () => {
    expect(signal?.aborted).toBe(false);
    expect(child.child?.exitCode).toBeNull();
    expect(stopped).not.toHaveBeenCalled();
    expect(f.registry.snapshot().scopes).toHaveLength(1);
  };
  return { scope, signal, child, stopped, alive };
}

function resumed(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(false);
  expect(f.state.cloudIdleReservation).toBeNull();
  expect(f.state.cloudCommands.resumeClaims).toHaveBeenCalled();
  expect(f.state.cloudHumanServices.resume).toHaveBeenCalled();
  expect(f.state.cloudLanguageServices.resume).toHaveBeenCalled();
  expect(f.state.cloud.setHumanServicesPaused).toHaveBeenLastCalledWith(false);
}

describe("idle attempt restoration after original fence failures", () => {
  it("restores engine admission flags even when idle ticket release throws", async () => {
    const f = await fixture();
    f.state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValue(null);
    vi.spyOn(f.registry, "resume").mockImplementation(() => { throw new Error("release proof unavailable"); });
    await expect(f.state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("release proof unavailable");
    resumed(f);
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("restores engine admission flags after an original resident fence refuses", async () => {
    const f = await fixture(true);
    vi.spyOn(f.state, "fenceCloudResidentWorkloads").mockImplementation(() => { throw new Error("resident fence unavailable"); });
    await expect(f.state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow();
    resumed(f);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("restores engine admission flags even when an original checkpoint drain cannot prove retirement", async () => {
    const f = await fixture();
    f.state.cloudRuntimeCheckpointQuiescing = true;
    f.state.cloudWorkloadCheckpointFence = f.registry.fence();
    vi.spyOn(f.registry, "drain").mockRejectedValue(new Error("original drain proof unavailable"));
    await expect(f.state.resumeCloudCheckpointAdmission()).rejects.toThrow("original drain proof unavailable");
    resumed(f);
    expect(f.state.cloudWorkloadCheckpointFence).not.toBeNull();
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("retains an independent seal ticket after successful declined-stop restoration", async () => {
    const f = await fixture(), seal = f.registry.fence();
    await f.registry.drain(seal);
    f.state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValue(null);
    await f.state.stopIdleCloudWorkspace(authority, () => true);
    resumed(f);
    expect(() => f.registry.assertAccepting()).toThrow();
    f.registry.resume(seal);
    expect(() => f.registry.assertAccepting()).not.toThrow();
  });

  it("restores after a checkpoint fence throws following the idle reservation transfer", async () => {
    const f = await fixture(), original = f.registry.fence.bind(f.registry);
    let allocated = 0;
    vi.spyOn(f.registry, "fence").mockImplementation(options => {
      if (++allocated === 2) throw new Error("checkpoint fence unavailable");
      return original(options);
    });
    await expect(f.state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("checkpoint fence unavailable");
    resumed(f);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledWith({ kind: "cancel", requestId: directive.id });
    expect(f.state.cloudDurabilityRuntime.checkpoint).not.toHaveBeenCalled();
    expect(() => f.registry.assertAccepting()).not.toThrow();
  });

  it("keeps resident and registry admissions closed when release acknowledgement is unknown", async () => {
    const f = await fixture(true);
    f.state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValue(null);
    vi.spyOn(f.resident!, "resumeWorkloads").mockRejectedValue(new Error("owner release ACK unknown"));
    await expect(f.state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("owner release ACK unknown");
    resumed(f);
    expect(() => f.registry.assertAccepting()).toThrow();
    await expect(f.resident!.create({ sessionId: "fenced", cwd: "/tmp", cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
  });

  it("does not reopen a durably sealed writer", async () => {
    const f = await fixture();
    f.state.cloudRuntimeCheckpointQuiescing = true;
    Object.assign(f.state, { cloudLocalWriterLifecycle: { seal: { sealId: "committed" } } });
    await f.state.resumeCloudCheckpointAdmission();
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
  });
});

describe("idle terminal lifetime through checkpoint commitment", () => {
  // These controls inspect real Linux Host groups; the activity census is injected.
  it.skipIf(process.platform !== "linux")("keeps original terminal groups alive while idle approval is held and then declined", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.state.cloudRuntimeRegistration.idleStopRequest.mockImplementation(async () => { await gate; return null; });
    const stopping = f.state.stopIdleCloudWorkspace(authority, () => true);
    void stopping.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.state.cloudRuntimeRegistration.idleStopRequest).toHaveBeenCalledOnce());
      terminal.alive();
      expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
      release(); await stopping;
      terminal.alive(); resumed(f);
      expect(() => f.registry.assertAccepting()).not.toThrow();
      expect(f.state.terminals.clear).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([stopping]); }
  });

  it.skipIf(process.platform !== "linux")("keeps original terminal groups alive after an idle request fails", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    f.state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValue(new Error("idle request declined"));
    await expect(f.state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("idle request declined");
    terminal.alive(); resumed(f);
    expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
    expect(() => f.registry.assertAccepting()).not.toThrow();
  });

  it.skipIf(process.platform !== "linux")("keeps original terminal groups alive through capture and acknowledged cancellation", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.state.cloudDurabilityRuntime.checkpoint.mockImplementation(async () => { await gate; throw new Error("capture cancelled"); });
    const stopping = f.state.stopIdleCloudWorkspace(authority, () => true), outcome = expect(stopping).rejects.toThrow("capture cancelled");
    void outcome.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledOnce());
      terminal.alive();
      expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
      release(); await outcome;
      terminal.alive(); resumed(f);
      expect(f.state.terminals.clear).not.toHaveBeenCalled();
      expect(() => f.registry.assertAccepting()).not.toThrow();
    } finally { release(); await Promise.allSettled([stopping, outcome]); }
  });

  it.skipIf(process.platform !== "linux")("retires original terminal groups only after the checkpoint commits", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    f.state.cloudDurabilityRuntime.checkpoint.mockImplementation(async () => {
      terminal.alive();
      expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
    });
    await f.state.stopIdleCloudWorkspace(authority, () => true);
    expect(terminal.signal?.aborted).toBe(true);
    expect(f.registry.snapshot().scopes).toEqual([]);
    expect(f.operations.some(value => value.op === "drain-workloads")).toBe(true);
    expect(f.state.terminals.clear).toHaveBeenCalledOnce();
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it.skipIf(process.platform !== "linux")("joins preserved terminal groups before sealing an idle writer", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    Object.assign(f.state, { cloudIdleCaptureId: directive.id,
      cloudAgentBoot: { authorityActive: true, quiesceForSeal: vi.fn(async () => {}),
        executionFactory: { disposeBoot: vi.fn(async () => {}) } },
      cloudLocalNativePump: { dispose: vi.fn(async () => {}) }, cloudLocalMirror: {},
      cloudLocalWriterLifecycle: { drainAndSeal: async (options: { retireNative(): Promise<void> }) => {
        await options.retireNative(); terminal.alive();
        expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
      }, captureCheckpoint: vi.fn(async () => {}) },
    });
    await f.state.sealCloudLocalWriter();
    terminal.alive();
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it.skipIf(process.platform !== "linux")("withdraws after a fresh busy census without retiring the original terminal", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    vi.mocked(hasCloudUserProcesses).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await f.state.stopIdleCloudWorkspace(authority, () => true);
    terminal.alive(); resumed(f);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
    expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
    expect(() => f.registry.assertAccepting()).not.toThrow();
  });

  it.skipIf(process.platform !== "linux")("keeps original terminal groups fenced and alive when commit cancellation is unacknowledged", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValue(new Error("commit reply unknown"));
    f.state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValueOnce(directive).mockRejectedValue(new Error("cancellation not acknowledged"));
    await expect(f.state.stopIdleCloudWorkspace(authority, () => true)).rejects.toThrow("commit reply unknown");
    terminal.alive();
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    expect(f.state.terminals.clear).not.toHaveBeenCalled();
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it.skipIf(process.platform !== "linux")("preserves the terminal through the acknowledged seal and retires it after final commit", async () => {
    const f = await fixture(true), terminal = await originalTerminal(f);
    const lifecycle = { seal: null as { sealId: string } | null,
      drainAndSeal: async (options: { retireNative(): Promise<void> }) => {
        await options.retireNative(); terminal.alive();
        lifecycle.seal = { sealId: "acknowledged" };
      }, captureCheckpoint: vi.fn(async () => {}) };
    Object.assign(f.state, {
      cloudAgentBoot: { authorityActive: true, quiesceForSeal: vi.fn(async () => {}),
        executionFactory: {
          bootScopeActivity: () => ({ complete: true, foreground: 0, reservedLaunches: 0,
            background: 0, idleHosts: 0, scopes: [] }),
          disposeBoot: vi.fn(async () => {}),
        } },
      cloudLocalNativePump: { dispose: vi.fn(async () => {}) }, cloudLocalMirror: {}, cloudLocalWriterLifecycle: lifecycle,
    });
    f.state.cloudDurabilityRuntime.checkpoint.mockImplementation(async () => {
      expect(lifecycle.seal).toEqual({ sealId: "acknowledged" });
      terminal.alive();
      expect(f.operations.some(value => value.fence.mode === "drain")).toBe(false);
    });
    await f.state.stopIdleCloudWorkspace(authority, () => true);
    expect(lifecycle.captureCheckpoint).toHaveBeenCalledOnce();
    expect(terminal.signal?.aborted).toBe(true);
    expect(f.registry.snapshot().scopes).toEqual([]);
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
  });
});
