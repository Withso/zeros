import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudFinalSaveRequest, CloudFinalSaveResponse } from "@zeros/protocol/cloud-final-save";
import { canonicalCloudLocalCommandHistoryJson } from "@zeros/protocol/cloud-local-mirror";
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
import { CloudCommandRuntimeError } from "../cloud-command-client";
import * as database from "../db/database";
import { openSqlite } from "../db/sqlite";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";

const directive: CloudCheckpointDirective = {
  id: "idle-checkpoint", reason: "before_stop", deadlineAtMs: Date.now() + 60_000, idleStop: true,
};
const authority = {} as CloudDurabilityAuthority;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
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
    cloudRuntimeRegistration: { idleStopRequest: vi.fn<() => Promise<CloudCheckpointDirective | null>>(async () => directive),
      hasRuntimeHandoffAuthority: () => true },
    cloudCommands: { pauseClaims: vi.fn(), resumeClaims: vi.fn() },
    cloudHumanServices: { pause: vi.fn(async () => {}), resume: vi.fn() },
    cloudLanguageServices: { pause: vi.fn(async () => {}), resume: vi.fn() },
    cloud: { setHumanServicesPaused: vi.fn() },
    cloudCheckpointScheduler: { pause: vi.fn(async () => {}), resume: vi.fn() },
    cloudRecordRuntime: { flush: vi.fn(async () => {}) },
    cloudDurabilityRuntime: { checkpoint: vi.fn<(directive: CloudCheckpointDirective, authority: CloudDurabilityAuthority, stillIdle?: () => boolean, assertCurrent?: (mutation?: boolean) => void) => Promise<void>>(async () => {}) },
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
    handleCloudCheckpointRequest(directive: CloudCheckpointDirective, authority: CloudDurabilityAuthority): Promise<void>;
    resumeCloudCheckpointAdmission(): Promise<void>;
    sealCloudLocalWriter(): Promise<void>;
    fenceCloudResidentWorkloads(mode: "preserve" | "drain"): unknown;
  } };
}

describe("closed checkpoint progress before cleanup", () => {
  it("dispatches a closed idle refusal before entering its early cancellation barrier", async () => {
    const f = await fixture(), scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
    Object.assign(f.state, { cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId },
      registration: { endpoint: "https://control.test/internal/v1/cloud-workspaces/engine/register" } } });
    const checkpointAuthority = { ...scope, heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
      heartbeatToken: `zwh_${"h".repeat(43)}` };
    const request: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000, idleStop: true };
    const order: string[] = [], posted: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const report = JSON.parse(String(init?.body)); posted.push(report); order.push(String(report.state));
      return new Response(null, { status: 202 });
    });
    let finishCancel!: () => void;
    const barrier = new Promise<void>(resolve => { finishCancel = resolve; });
    f.state.cloudRuntimeRegistration.idleStopRequest.mockImplementation(async () => {
      order.push("cancel"); await barrier; return null;
    });
    const flight = f.state.handleCloudCheckpointRequest(request, checkpointAuthority); void flight.catch(() => {});
    try {
      expect(order).toEqual(["running", "failed", "cancel"]);
      expect(posted.at(-1)).toMatchObject({ ...scope, requestId: request.id, state: "failed", reason: "pending_work" });
      expect(f.state.cloudDurabilityRuntime.checkpoint).not.toHaveBeenCalled();
    } finally {
      finishCancel(); await expect(flight).rejects.toThrow("Cloud workspace is no longer idle"); f.state.running = false;
    }
  });

  it.each([true, false])("finishes checkpoint work independently of held diagnostics (cloud=%s)", async cloud => {
    const f = await fixture(), scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
    Object.assign(f.state, { cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId },
      registration: { endpoint: "https://control.test/internal/v1/cloud-workspaces/engine/register" } },
    ...(cloud ? {} : { cloudWorker: null }) });
    const checkpointAuthority = { ...scope, heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
      heartbeatToken: `zwh_${"h".repeat(43)}` };
    const request: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    const requestFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    try {
      await expect(f.state.handleCloudCheckpointRequest(request, checkpointAuthority)).resolves.toBeUndefined();
      expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledWith(request, checkpointAuthority, undefined, ...(cloud ? [expect.any(Function)] : []));
      // Local Personal and organization-local use the same non-cloud boundary:
      // even a stale cloud callback cannot create diagnostic network traffic.
      expect(requestFetch).toHaveBeenCalledTimes(cloud ? 1 : 0);
    } finally {
      f.state.running = false;
      const observed = f.state as unknown as { cloudCheckpointProgress?: { reporter: { dispose(): void } } };
      observed.cloudCheckpointProgress?.reporter.dispose();
    }
  });

  it.each(["setup_stop", "record_flush"] as const)("reports a blocked %s gate and preserves its first closed failure", async stage => {
    const f = await fixture(), scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
    Object.assign(f.state, { cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId },
      registration: { endpoint: "https://control.test/internal/v1/cloud-workspaces/engine/register" } } });
    const checkpointAuthority = { ...scope, heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
      heartbeatToken: `zwh_${"h".repeat(43)}` };
    const request: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    const posted: Array<Record<string, unknown>> = [], order: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://control.test/internal/v1/cloud-workspaces/engine/checkpoint-progress");
      const body = JSON.parse(String(init?.body)); posted.push(body); order.push(String(body.state));
      return new Response(null, { status: 204 });
    });
    let failGate!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => { failGate = reject; });
    if (stage === "setup_stop") f.state.setup.stopAllAndProve.mockReturnValueOnce(gate);
    else f.state.cloudRecordRuntime.flush.mockReturnValueOnce(gate);
    f.state.cloudRuntimeRegistration.idleStopRequest.mockImplementation(async () => {
      order.push("cleanup"); throw new Error("private-cleanup-canary");
    });
    const flight = f.state.handleCloudCheckpointRequest(request, checkpointAuthority); void flight.catch(() => {});
    try {
      await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ ...scope, requestId: request.id,
        stage, state: "running", reason: "none" })));
      expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
      failGate(new CloudCommandRuntimeError("command_storage_unavailable"));
      await expect(flight).rejects.toMatchObject({ code: "command_storage_unavailable" });
      await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ stage, state: "failed", reason: "storage" })));
      expect(posted.filter(value => value.state === "failed")).toHaveLength(1);
      expect(order).toContain("failed");
      expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
      expect(JSON.stringify(posted)).not.toContain("private-cleanup-canary");
    } finally {
      failGate(new CloudCommandRuntimeError("command_storage_unavailable")); await Promise.allSettled([flight]);
      f.state.running = false;
    }
  });
});

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

async function frozenWriterFixture() {
  const f = await fixture(true), directory = await mkdtemp(path.join(tmpdir(), "zeros-final-retry-"));
  cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true });
  cleanups.push(() => actors.dispose());
  const normal = openSqlite(path.join(directory, "normal.sqlite"));
  normal.pragma("journal_mode = WAL"); normal.pragma("synchronous = NORMAL");
  normal.exec("CREATE TABLE sync_meta(id INTEGER PRIMARY KEY,next_rev INTEGER); INSERT INTO sync_meta VALUES(0,8)");
  cleanups.push(() => { normal.close(); });
  const file = path.join(directory, "queue.sqlite");
  const queue = new CloudLocalCommandQueue({ file, scope, actors, engineLive: () => true, ready: () => true,
    history: () => ({ recordSequence: 7, eventSequence: 0 }) });
  cleanups.push(() => queue.close());
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true });
  cleanups.push(() => events.close());
  const normalDb = vi.fn(() => {
    if (!normal.open) throw new Error("Synthetic NORMAL writer must stay closed");
    return normal;
  });
  const lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue, normalDb,
    assertQuiescent: () => { if (!f.state.cloudRuntimeCheckpointQuiescing) throw new Error("Not quiescent"); },
    heads: (db = normal) => ({ recordSequence: (db.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev,
      eventSequence: events.head }) });
  cleanups.push(() => lifecycle.close());
  const capture = lifecycle.captureCheckpoint.bind(lifecycle);
  // Real file-pair capture, redirected only into this fixture's fresh directory.
  vi.spyOn(lifecycle, "captureCheckpoint").mockImplementation(() => capture(path.join(directory, "checkpoint")));
  const freeze = vi.spyOn(database, "sealZerosDbForRuntimeHandoff").mockImplementation(() => { normal.close(); });
  const recordFlush = f.state.cloudRecordRuntime.flush.mockImplementation(async () => {
    if (!normal.open) throw new Error("Record flush tried to reopen a sealed NORMAL writer");
  });
  const sealRequest = vi.fn(async (seal: NonNullable<typeof lifecycle.seal>) => {
    const { scope: _scope, ...descriptor } = seal;
    return { ...descriptor, writerEpoch: scope.writerEpoch };
  });
  const recordHandoff = vi.fn(async () => {});
  Object.assign(f.state.cloudRuntimeRegistration, { pauseRecordForRuntimeHandoff: recordHandoff,
    resumeRecordAfterRuntimeHandoff: vi.fn(), localCommandSealRequest: sealRequest });
  f.state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValue(null);
  Object.assign(f.state.cloudCommands, { lifecycleDrained: () => true });
  const boot = { scope, authorityActive: true, quiesceForSeal: vi.fn(async () => {}),
    executionFactory: { disposeBoot: vi.fn(async () => {}),
      bootScopeActivity: () => ({ complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] }) } };
  Object.assign(f.state, { root: directory, cloudLocalWriterLifecycle: lifecycle, cloudLocalMirror: { flush: async () => {} },
    cloudLocalNativePump: { dispose: vi.fn(async () => {}) },
    cloudAgentBoot: boot,
    cloudActions: { hasActiveWork: () => false }, cloudEvents: { flush: vi.fn(async () => {}) },
    cloudCheckpointProgressUnsupported: true,
    cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId } },
  });
  const authority: CloudDurabilityAuthority = { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
    generation: scope.generation, engineInstanceId: scope.engineInstanceId,
    heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat", heartbeatToken: `zwh_${"h".repeat(43)}` };
  return { ...f, normal, normalDb, lifecycle, queue, recordFlush, recordHandoff, freeze, sealRequest, authority, boot };
}

describe("final checkpoint retry against an irreversible writer seal", () => {
  it.each(["capture", "seal_ack"] as const)("retries the original request after failed %s without reopening the exact frozen writer", async boundary => {
    const f = await frozenWriterFixture();
    if (boundary === "capture") f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic superseded capture"));
    else f.sealRequest.mockRejectedValueOnce(new Error("Synthetic seal acknowledgement lost"));
    const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    await expect(f.state.handleCloudCheckpointRequest(first, f.authority)).rejects.toThrow("Synthetic");
    const seal = f.lifecycle.seal;
    expect(seal).not.toBeNull(); expect(f.normal.open).toBe(false);
    expect(f.queue.accepting).toBe(false);
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
    const normalOpens = f.normalDb.mock.calls.length, flushes = f.recordFlush.mock.calls.length;
    const next: CloudCheckpointDirective = { ...first };
    await expect(f.state.handleCloudCheckpointRequest(next, f.authority)).resolves.toBeUndefined();
    expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenLastCalledWith(next, f.authority, undefined, expect.any(Function));
    expect(f.lifecycle.readAcknowledgedSeal()).toEqual(seal);
    expect(f.lifecycle.captureCheckpoint).toHaveBeenCalled();
    expect(f.normalDb).toHaveBeenCalledTimes(normalOpens);
    expect(f.recordFlush).toHaveBeenCalledTimes(flushes);
    expect(f.normal.open).toBe(false); expect(f.queue.accepting).toBe(false);
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    expect(f.state.cloudHumanServices.resume).not.toHaveBeenCalled();
    expect(() => f.registry.assertAccepting()).toThrow();
  });
});

describe("final control remains fenced", () => {
  it("keeps admission closed when record handoff fails before an immutable seal exists", async () => {
    const f = await frozenWriterFixture();
    f.recordHandoff.mockRejectedValueOnce(new Error("Synthetic handoff flush failure"));
    const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    await expect(f.state.handleCloudCheckpointRequest(first, f.authority)).rejects.toThrow("Synthetic handoff");
    expect(f.lifecycle.seal).toBeNull(); expect(f.normal.open).toBe(true);
    expect(f.queue.accepting).toBe(false); expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
    expect(f.state.cloudHumanServices.resume).not.toHaveBeenCalled();
    const next: CloudCheckpointDirective = { ...first };
    await f.state.handleCloudCheckpointRequest(next, f.authority);
    expect(f.recordHandoff).toHaveBeenLastCalledWith({ retryFailedFlush: true });
    expect(f.lifecycle.readAcknowledgedSeal()).not.toBeNull();
    expect(f.queue.accepting).toBe(false); expect(f.normal.open).toBe(false);
  });

  it.each(["manual", "before_fork", "idle", "generation", "workspace", "engine", "funding", "boot", "registration",
    "retired", "expired", "runtime_handoff"] as const)("refuses %s without changing frozen custody", async change => {
    const f = await frozenWriterFixture();
    f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic capture failure"));
    const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    await expect(f.state.handleCloudCheckpointRequest(first, f.authority)).rejects.toThrow("Synthetic");
    const seal = f.lifecycle.seal;
    const next: CloudCheckpointDirective = { ...first };
    const authority = { ...f.authority };
    if (change === "manual" || change === "before_fork") next.reason = change;
    if (change === "idle") { next.reason = "before_stop"; next.idleStop = true; }
    if (change === "generation") authority.generation++;
    if (change === "workspace") authority.workspaceId = randomUUID();
    if (change === "engine") authority.engineInstanceId = randomUUID();
    if (change === "funding") f.boot.scope = { ...f.boot.scope, fundingOwnerEpoch: 2 };
    if (change === "boot") Object.assign(f.state, { cloudAgentBoot: { ...f.boot } });
    if (change === "registration") f.state.cloudRuntimeRegistration = { ...f.state.cloudRuntimeRegistration };
    if (change === "retired") f.state.cloudRuntimeRegistration.hasRuntimeHandoffAuthority = () => false;
    if (change === "expired") next.deadlineAtMs = Date.now() - 1;
    if (change === "runtime_handoff") f.state.cloudRuntimeHandoffFenced = true;
    await expect(f.state.handleCloudCheckpointRequest(next, authority)).rejects.toThrow();
    expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.seal).toEqual(seal); expect(f.normal.open).toBe(false);
    expect(f.queue.accepting).toBe(false); expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
  });

  it("keeps a different final request out while retrying the original accepted request", async () => {
    const f = await frozenWriterFixture();
    f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic capture response lost"));
    f.state.cloudRuntimeRegistration.idleStopRequest.mockRejectedValueOnce(new Error("Synthetic cancellation response lost"));
    const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    const next: CloudCheckpointDirective = { ...first, id: randomUUID(), reason: "before_delete" };
    await expect(f.state.handleCloudCheckpointRequest(first, f.authority)).rejects.toThrow("Synthetic capture");
    await expect(f.state.handleCloudCheckpointRequest(next, f.authority)).rejects.toThrow(/custody|reconciliation/);
    expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
    await f.state.handleCloudCheckpointRequest(first, f.authority);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
    expect(f.lifecycle.readAcknowledgedSeal()).not.toBeNull();
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
  });

  it("keeps a later request out of a still-running final capture, then retries from its frozen writer", async () => {
    const f = await frozenWriterFixture();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.state.cloudDurabilityRuntime.checkpoint.mockImplementationOnce(async () => { await pending; throw new Error("Synthetic supersession"); });
    const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
    const next: CloudCheckpointDirective = { ...first, id: randomUUID(), reason: "before_delete" };
    const flight = f.state.handleCloudCheckpointRequest(first, f.authority); void flight.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1));
      await expect(f.state.handleCloudCheckpointRequest(next, f.authority)).rejects.toThrow("already in progress");
      expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
      finish(); await expect(flight).rejects.toThrow("Synthetic supersession");
      await expect(f.state.handleCloudCheckpointRequest(next, f.authority)).rejects.toThrow(/custody/);
      await f.state.handleCloudCheckpointRequest(first, f.authority);
      expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(2);
      expect(f.normal.open).toBe(false); expect(f.queue.accepting).toBe(false);
    } finally { finish(); await Promise.allSettled([flight]); }
  });

  it("drains original preserved terminal tickets for an explicit delete after a cancelled idle seal", async () => {
    const f = await frozenWriterFixture();
    f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic idle capture cancelled"));
    f.state.cloudRuntimeRegistration.idleStopRequest.mockResolvedValueOnce(directive).mockResolvedValue(null);
    await expect(f.state.stopIdleCloudWorkspace(f.authority, () => true)).rejects.toThrow("Synthetic idle");
    expect(f.lifecycle.seal).not.toBeNull();
    expect(f.operations.some(operation => operation.fence.mode === "drain")).toBe(false);
    const next: CloudCheckpointDirective = { id: randomUUID(), reason: "before_delete", deadlineAtMs: Date.now() + 60_000 };
    await f.state.handleCloudCheckpointRequest(next, f.authority);
    expect(f.operations.some(operation => operation.op === "drain-workloads" && operation.fence.mode === "drain")).toBe(true);
    expect(f.operations.some(operation => operation.op === "resume-workloads")).toBe(false);
    expect(f.normal.open).toBe(false); expect(f.queue.accepting).toBe(false);
  });
});

it("retries an explicit final capture on its original deadline without idle cancellation or reopening services", async () => {
  const f = await frozenWriterFixture();
  const request: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
  f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic capture failed"));
  await expect(f.state.handleCloudCheckpointRequest(request, f.authority)).rejects.toThrow("Synthetic capture failed");
  expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
  expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
  expect(f.normal.open).toBe(false);
  await f.state.handleCloudCheckpointRequest(request, f.authority);
  expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(2);
  expect(f.state.cloudRecordRuntime.flush).toHaveBeenCalledTimes(1);
  expect(f.state.cloudDurabilityRuntime.checkpoint.mock.calls.every(call => call[0].deadlineAtMs === request.deadlineAtMs)).toBe(true);
});

it("rechecks final authority after the original workload drain settles", async () => {
  const f = await frozenWriterFixture();
  f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic capture failed"));
  const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
  await expect(f.state.handleCloudCheckpointRequest(first, f.authority)).rejects.toThrow("Synthetic");
  f.state.terminals.clear.mockImplementationOnce(async () => {
    f.state.cloudRuntimeRegistration.hasRuntimeHandoffAuthority = () => false;
  });
  const next: CloudCheckpointDirective = { ...first };
  await expect(f.state.handleCloudCheckpointRequest(next, f.authority)).rejects.toMatchObject({ code: "engine_authority_rejected" });
  expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
  expect(f.normal.open).toBe(false); expect(f.queue.accepting).toBe(false);
});

it("freezes the exact final directive and transport authority before preparation awaits", async () => {
  const f = await frozenWriterFixture();
  const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
  const authority = { ...f.authority }, expected = structuredClone(first), expectedAuthority = { ...authority };
  const entered = deferred(), release = deferred();
  f.state.setup.stopAllAndProve.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
  const task = f.state.handleCloudCheckpointRequest(first, authority); void task.catch(() => undefined);
  try {
    await entered.promise;
    first.deadlineAtMs += 300_000; authority.heartbeatEndpoint = "https://replacement.test/heartbeat";
    release.resolve(); await task;
    expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledWith(expected, expectedAuthority, undefined, expect.any(Function));
  } finally { release.resolve(); await Promise.allSettled([task]); }
});

async function negotiatedWriterFixture() {
  const f = await frozenWriterFixture();
  const source = { ...f.boot.scope, runtimeId: `r1-${"a".repeat(64)}`, authorityEpoch: 1,
    registeredAtMs: Date.now(), allocationLeaseId: randomUUID(), providerResourceId: "fixture-resource" };
  const request: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000,
    finalSave: { version: 1, recoveryId: randomUUID(), attemptOrdinal: 0, predecessorRequestId: null, source,
      sourceSha256: createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(source)).digest("hex"), custodyId: null, retirementId: null } };
  const echo = (input: CloudFinalSaveRequest) => ({ version: 1 as const, recoveryId: input.recoveryId, requestId: input.requestId,
    attemptOrdinal: input.attemptOrdinal, sourceSha256: input.sourceSha256, custodyId: input.custodyId });
  const report = vi.fn<(input:CloudFinalSaveRequest)=>Promise<CloudFinalSaveResponse>>(async (input) => ({ ...echo(input), state: "blocked" as const,
    reason: "authority" as const, retryAtMs: Date.now() + 5_000 }));
  const consume = vi.fn(async () => undefined);
  Object.assign(f.state.cloudRuntimeRegistration, { matchesFinalSaveSource: () => true, supportsFinalSaveRecovery: () => true, reportFinalSave: report });
  Object.assign(f.state.cloudDurabilityRuntime, { readFinalSaveCommit: vi.fn(async () => null), consumeFinalSaveResponse: consume });
  return { ...f, request, echo, report, consume };
}

it("keeps reconciling an expired attempt after a bounded blocked reply without recapturing", async () => {
  const f = await negotiatedWriterFixture();
  f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("Synthetic capture failed"));
  await expect(f.state.handleCloudCheckpointRequest(f.request, f.authority)).rejects.toThrow("Synthetic");
  vi.spyOn(Date, "now").mockReturnValue(f.request.deadlineAtMs + 1);
  await f.state.handleCloudCheckpointRequest(f.request, f.authority);
  await f.state.handleCloudCheckpointRequest(f.request, f.authority);
  expect(f.report).toHaveBeenCalledTimes(3);
  expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
  expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
});

it("joins held capture before retirement and consumes one successor with the same sealed writer and drain ticket",async()=>{
  const f=await negotiatedWriterFixture(),entered=deferred(),release=deferred(),retirementId=randomUUID();
  const clock=vi.spyOn(Date,"now");
  f.state.cloudDurabilityRuntime.checkpoint.mockImplementationOnce(async()=>{entered.resolve();await release.promise;throw new Error("held capture failed");});
  f.report.mockImplementation(async input=>({...f.echo(input),state:"retired",retirementId,retryAtMs:Date.now()+5000}));
  const first=f.state.handleCloudCheckpointRequest(f.request,f.authority);void first.catch(()=>undefined);
  try{
    await entered.promise;const fence=f.state.cloudWorkloadCheckpointFence;
    clock.mockReturnValue(f.request.deadlineAtMs+1);
    const premature={...f.request,id:randomUUID()};
    await expect(f.state.handleCloudCheckpointRequest(premature,f.authority)).rejects.toThrow("already in progress");
    expect(f.report).not.toHaveBeenCalled();expect(f.consume).not.toHaveBeenCalled();
    expect(f.normal.open).toBe(false);expect(f.queue.accepting).toBe(false);
    release.resolve();await expect(first).rejects.toThrow("held capture failed");
    expect(f.report).toHaveBeenCalledOnce();expect(f.consume).toHaveBeenCalledOnce();
    const old=f.report.mock.calls[0]![0];
    const successor:CloudCheckpointDirective={...f.request,id:randomUUID(),deadlineAtMs:Date.now()+240_000,
      finalSave:{...f.request.finalSave!,attemptOrdinal:1,predecessorRequestId:f.request.id,custodyId:old.custodyId,retirementId}};
    await f.state.handleCloudCheckpointRequest(successor,f.authority);
    expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(2);
    expect(f.state.cloudDurabilityRuntime.checkpoint.mock.calls[1]![0]).toEqual(successor);
    expect(f.state.cloudWorkloadCheckpointFence).toBe(fence);
    expect(f.state.cloudRecordRuntime.flush).toHaveBeenCalledTimes(1);
    expect(f.normal.open).toBe(false);expect(f.queue.accepting).toBe(false);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
  }finally{release.resolve();await Promise.allSettled([first]);}
});

it("refuses a late retirement response after original native boot replacement",async()=>{
  const f=await negotiatedWriterFixture(),entered=deferred(),release=deferred();
  f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("capture failed"));
  f.report.mockImplementationOnce(async input=>{entered.resolve();await release.promise;return {...f.echo(input),
    state:"retired",retirementId:randomUUID(),retryAtMs:Date.now()+5000};});
  const first=f.state.handleCloudCheckpointRequest(f.request,f.authority);void first.catch(()=>undefined);
  try{
    await entered.promise;
    Object.assign(f.state,{cloudAgentBoot:{...f.boot}});
    release.resolve();await expect(first).rejects.toThrow("capture failed");
    expect(f.consume).not.toHaveBeenCalled();expect(f.state.cloudDurabilityRuntime.checkpoint).toHaveBeenCalledTimes(1);
    expect(f.normal.open).toBe(false);expect(f.queue.accepting).toBe(false);
  }finally{release.resolve();await Promise.allSettled([first]);}
});

it.each(["workload", "resident", "resident_owner", "resident_release"] as const)(
  "refuses late retirement after replacement of the original %s control", async control => {
    const f = await negotiatedWriterFixture(), entered = deferred(), release = deferred();
    f.state.cloudDurabilityRuntime.checkpoint.mockRejectedValueOnce(new Error("capture failed"));
    f.report.mockImplementationOnce(async input => {
      entered.resolve(); await release.promise;
      return { ...f.echo(input), state: "retired", retirementId: randomUUID(), retryAtMs: Date.now() + 5_000 };
    });
    const first = f.state.handleCloudCheckpointRequest(f.request, f.authority); void first.catch(() => undefined);
    try {
      await entered.promise;
      if (control === "workload") f.state.cloudWorkloadCheckpointFence = f.registry.fence();
      else if (control === "resident") Object.assign(f.state, { cloudResidentCheckpointFence: f.state.fenceCloudResidentWorkloads("drain") });
      else if (control === "resident_owner") f.state.residentTerminals = null;
      else f.state.cloudResidentWorkloadOwnerRelease = () => {};
      release.resolve(); await expect(first).rejects.toThrow("capture failed");
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.normal.open).toBe(false); expect(f.queue.accepting).toBe(false);
    } finally { release.resolve(); await Promise.allSettled([first]); }
  },
);

it("joins both preparation siblings and retains the first failure without retiring the explicit source", async () => {
  const f = await frozenWriterFixture(), entered = deferred(), release = deferred();
  const authorityLost = vi.fn(); Object.assign(f.state, { handleCloudRuntimeAuthorityLoss: authorityLost });
  const first: CloudCheckpointDirective = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
  f.state.cloudHumanServices.pause.mockRejectedValueOnce(new Error("first preparation failure"));
  f.state.cloudLanguageServices.pause.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error("late preparation failure"); });
  let settled = false;
  const task = f.state.handleCloudCheckpointRequest(first, f.authority); void task.finally(() => { settled = true; }).catch(() => undefined);
  try {
    await entered.promise; await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(authorityLost).not.toHaveBeenCalled();
    release.resolve(); await expect(task).rejects.toThrow("first preparation failure");
    expect(authorityLost).not.toHaveBeenCalled();
    expect(f.state.cloudRuntimeCheckpointQuiescing).toBe(true);
    expect(f.state.cloudRuntimeRegistration.idleStopRequest).not.toHaveBeenCalled();
    expect(f.state.cloudCommands.resumeClaims).not.toHaveBeenCalled();
  } finally { release.resolve(); await Promise.allSettled([task]); }
});
