import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInfrastructure } from "../zeros-dev/infrastructure";
import { InfrastructureSchema, initialInfrastructure, INFRASTRUCTURE_DETACHED_MS } from "../zeros-dev/infrastructure-contract";
import { InfrastructureNativeIntentSchema, type InfrastructureNativeTask, type InfrastructureNativeProof } from "../zeros-dev/infrastructure-native";
import { Evidence } from "../zeros-dev/evidence";
import { ZerosDevError } from "../zeros-dev/errors";
import { RunSchema, type RunHandle } from "../zeros-dev/receipts";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";
import { infrastructureTask } from "./zeros-dev-infrastructure-fixture";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function fixture() {
  let elapsed = 0;
  const origin = Date.parse("2026-10-15T00:00:00Z"), calls: string[] = [], snapshots: any[] = [], output: any[] = [], scripts: string[] = [];
  const handle: RunHandle = { run: RunSchema.parse({ version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt: new Date(origin).toISOString(), source: { revision: "b".repeat(40), dirty: false }, prompts: [], lifecycle: [], evidence: [], deletionConfirmed: false,
    hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40), credentials: [], histories: [], activeWindows: [], complete: false,
      infrastructure: initialInfrastructure() } }), save: vi.fn(async () => { snapshots.push(RunSchema.parse(handle.run)); }) };
  const active = computerBuild(), target = { runtimeId: `r1-${"c".repeat(64)}`, baseImageId: "fixture-base" };
  const api = {
    assertFixtureEmpty: vi.fn(async () => { calls.push("empty"); }), ensureRepository: vi.fn(async () => { calls.push("repo"); }),
    computerState: vi.fn(async () => ({ active })), readComputerRuntime: vi.fn(async () => ({ ...target, selected: target })),
    verifyComputerRuntime: vi.fn(async () => "confirmed"), buildComputer: vi.fn(async () => {}), waitComputer: vi.fn(async () => active),
    createWorkspace: vi.fn(async () => {
      calls.push("create"); handle.run.create = { key: randomUUID(), body: { name: `zd-${handle.run.runId}`,
        repository: { forge: "github.com", owner: "fixture", name: "fixture", revision: "main", githubInstallationId: randomUUID() } },
      result: { id: randomUUID(), createdBy: randomUUID(), createdAt: new Date(origin + elapsed).toISOString(), generation: 1 } };
      await handle.save();
    }),
    waitWorkspace: vi.fn(async (_h, state, _signal?: AbortSignal, observe?: (value: unknown) => void) => {
      calls.push(`wait:${state}`); elapsed += 10_000;
      if (state === "running") observe?.({ attempt: 1, claimCount: 1, state: "succeeded", errorCode: null });
    }),
    lifecycle: vi.fn(async (_h, operation: "wake" | "stop") => {
      calls.push(operation);
      handle.run.lifecycle.push({ operation, key: randomUUID(), generation: handle.run.create!.result!.generation, confirmed: true });
      if (operation === "wake") handle.run.create!.result!.generation++;
    }),
    cleanup: vi.fn(async () => { calls.push("cleanup"); handle.run.deletionConfirmed = true; await handle.save(); return { planned: 1, confirmed: 1 }; }),
  };
  const runtimes: any[] = [];
  const connect = vi.fn(async (_run, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false); calls.push("connect");
    const connectionId = randomUUID();
    const runtime = {
      client: {}, scope: {}, prompt: vi.fn(), tail: vi.fn(),
      terminal: vi.fn(async (_handle, input) => {
        calls.push("terminal"); scripts.push(input.script); elapsed += 200;
        return { exitCode: 0, output: "", truncated: false };
      }),
      dispose: vi.fn(async () => { calls.push("dispose"); }),
      detachTransport: vi.fn(() => { calls.push("detach"); }),
      transport: vi.fn(() => ({ connectionId, coverage: "complete", directAttempts: 1, directReady: 1, relayAttempts: 0, relayReady: 0,
        lostConnections: 0, authorityCloses: 0, unexplainedAuthorityCloses: 0 })),
    };
    runtimes.push(runtime); return runtime;
  });
  const helpers: any[] = [];
  const native = vi.fn((runtime, _handle, settings) => {
    const helper = {
      begin: vi.fn(async () => {
        calls.push("begin");
        const created = handle.run.create!.result!;
        const task = infrastructureTask(origin + elapsed, { runId: handle.run.runId, fixtureSha256: handle.run.fixtureSha256,
          workspaceId: created.id, generation: created.generation });
        await settings.persistIntent(InfrastructureNativeIntentSchema.parse((({ firstRow: _first, ...intent }) => intent)(task)));
        expect(snapshots.at(-1).hourly.infrastructure.intent.sessionId).toBe(task.sessionId);
        calls.push("native-allocation"); return task;
      }),
      finish: vi.fn(async (task: InfrastructureNativeTask): Promise<InfrastructureNativeProof> => {
        calls.push("finish"); expect(runtime).toBe(runtimes.at(-1)); expect(runtime).not.toBe(runtimes[3]);
        return { version: 1, kind: "native-terminal-task", scopeSha256: task.scopeSha256, sessionSha256: sha(task.sessionId),
          programSha256: task.programSha256, outputSha256: "d".repeat(64), rowCount: 32, taskDurationMs: 31 * 60_000,
          maxHeartbeatGapMs: 60_000, replayBytes: 6000, replayTruncated: false };
      }),
      cleanup: vi.fn(async () => { calls.push("native-cleanup"); }),
    };
    helpers.push(helper); return helper;
  });
  const prepareDetachedAuth = vi.fn(async (_requiredMs: number) => { calls.push("auth"); return 60 * 60_000; });
  const prepareLaunchAuth = vi.fn(async (requiredMs: number) => {
    const remainingMs = await prepareDetachedAuth(requiredMs), observedAt = origin + elapsed;
    return { observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(observedAt + remainingMs).toISOString(), remainingMs };
  });
  const sleep = vi.fn(async (ms: number) => {
    expect(ms).toBe(INFRASTRUCTURE_DETACHED_MS); expect(calls.at(-1)).toBe("detach");
    const before = [...calls]; elapsed += ms;
    // No actor retirement, CP read, token refresh or native helper invocation
    // may be hidden inside the measured client-disconnected interval.
    expect(calls).toEqual(before);
    expect(runtimes[3].dispose).not.toHaveBeenCalled();
  });
  const options = { handle, api, connect, prepareDetachedAuth, prepareLaunchAuth, native, sleep,
    now: () => origin + elapsed, monotonic: () => elapsed, evidence: new Evidence(handle.run.runId, row => output.push(row), () => elapsed) };
  return { options, handle, api, connect, prepareDetachedAuth, prepareLaunchAuth, sleep, native, helpers, runtimes, snapshots, calls, output, scripts,
    advance: (ms: number) => { elapsed += ms; } };
}

describe("infrastructure-only product lifecycle", () => {
  it("finishes 31 minutes of native detachment with a 300-second launch token and no detached auth work", async () => {
    const f = fixture();
    f.prepareDetachedAuth.mockImplementation(async requiredMs => {
      f.calls.push("auth");
      if (requiredMs >= 300_000) throw new ZerosDevError("detached_auth_window");
      return 300_000;
    });
    await expect(runInfrastructure(f.options as never)).resolves.toBeUndefined();
    expect(f.prepareLaunchAuth).toHaveBeenCalledExactlyOnceWith(120_000);
    const detached = f.handle.run.hourly!.infrastructure!.detached!;
    expect(detached).toMatchObject({ durationMs: 31 * 60_000, launchAuth: { remainingMs: 300_000 } });
    expect(detached).not.toHaveProperty("authRemainingMs");
    if (!("launchAuth" in detached)) throw new Error("missing launch observation");
    expect(Date.parse(detached.launchAuth.expiresAt)).toBeLessThan(Date.parse(detached.completedAt));
    expect(f.calls.filter(value => value === "auth")).toHaveLength(1);
    expect(f.calls.slice(f.calls.indexOf("detach") + 1, f.calls.indexOf("finish"))).toEqual(["connect"]);
    expect(f.handle.run.hourly).toMatchObject({ complete: false, credentials: [], histories: [], infrastructure: { complete: true } });
  });

  it("refuses launch validity below the fixed floor before native allocation", async () => {
    const f = fixture(); f.prepareDetachedAuth.mockResolvedValue(119_999);
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "detached_auth_window" });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.output.find(row => row.outcome === "failed")).toMatchObject({ phase: "detached_auth", code: "detached_auth_window" });
    expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("rechecks short launch validity after startup and checkpointing consume the floor", async () => {
    const f = fixture(), save = f.handle.save;
    f.prepareDetachedAuth.mockResolvedValue(120_001);
    f.handle.save = vi.fn(async () => {
      if (f.handle.run.hourly!.infrastructure!.task && !f.calls.includes("detach")) f.advance(117_002);
      await save();
    });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "detached_auth_window" });
    expect(f.helpers[0].begin).toHaveBeenCalledOnce();
    expect(f.calls).not.toContain("detach"); expect(f.sleep).not.toHaveBeenCalled();
    expect(f.output.find(row => row.outcome === "failed")).toMatchObject({ phase: "detached_disconnect", code: "detached_auth_window" });
    expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("proves create, three first-claim wakes and native detachment without an agent claim", async () => {
    const f = fixture(); await runInfrastructure(f.options as never);
    expect(f.api.createWorkspace).toHaveBeenCalledOnce();
    expect(f.api.lifecycle.mock.calls.map(([, op]) => op)).toEqual(["stop", "wake", "stop", "wake", "stop", "wake"]);
    expect(f.connect).toHaveBeenCalledTimes(5); expect(f.native).toHaveBeenCalledTimes(2);
    expect(f.helpers[0].begin).toHaveBeenCalledOnce(); expect(f.helpers[1].finish).toHaveBeenCalledOnce();
    expect(f.helpers[1].cleanup).toHaveBeenCalledOnce(); expect(f.helpers[0].cleanup).not.toHaveBeenCalled();
    expect(f.calls.indexOf("native-cleanup")).toBeGreaterThan(f.calls.indexOf("finish")); expect(f.calls.at(-1)).toBe("cleanup");
    expect(f.runtimes.every(row => !row.prompt.mock.calls.length && !row.tail.mock.calls.length)).toBe(true);
    expect(f.handle.run.hourly).toMatchObject({ complete: false, credentials: [], histories: [], infrastructure: { complete: true,
      coverage: { agents: "not_covered_owner_section7", detachedAgent: "not_covered_owner_section7" } } });
    const proof = f.handle.run.hourly!.infrastructure!;
    expect(InfrastructureSchema.safeParse(proof).success).toBe(true); expect(proof.transports).toHaveLength(5);
    expect(proof.detached!.durationMs).toBeGreaterThan(30 * 60_000);
    expect(f.handle.run.hourly!.activeWindows).toHaveLength(6);
    for (const window of f.handle.run.hourly!.activeWindows)
      expect(Date.parse(window.workCompletedAt) - Date.parse(window.readyObservedAt)).toBe(window.durationMs);
    expect(f.api.buildComputer).not.toHaveBeenCalled();
    expect(f.api.verifyComputerRuntime).toHaveBeenCalledTimes(3);
  });

  it("executes the four file-continuity scripts in a disposable real checkout", async () => {
    const f = fixture(); await runInfrastructure(f.options as never);
    const root = await mkdtemp(path.join(os.tmpdir(), "zd-infra-files-")); roots.push(root);
    const env = { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
    execFileSync("git", ["init", "-q", root], { env, stdio: "pipe" });
    for (const script of f.scripts) execFileSync("bash", ["-c", script], { cwd: root, env, stdio: "pipe" });
    expect(f.scripts).toHaveLength(4);
    expect(() => execFileSync("bash", ["-c", f.scripts[0]!], { cwd: root, env, stdio: "pipe" })).toThrow();
  });

  it("keeps physical erasure false after exact compute retirement", async () => {
    const f = fixture(); f.api.cleanup.mockImplementation(async () => {
      const retired = retireFixtureCompute(f.handle, new Date(f.options.now()).toISOString());
      retired.generations = Array.from({ length: f.handle.run.create!.result!.generation }, (_, index) => ({ ...retired.generations[0]!, generation: index + 1 }));
      retired.reserved.storageMiB = retired.generations.length * 16_384;
      await f.handle.save(); return { planned: 1, confirmed: 0 };
    });
    await runInfrastructure(f.options as never);
    expect(f.handle.run.deletionConfirmed).toBe(false); expect(f.handle.run.hourly!.infrastructure!.complete).toBe(true);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "storage_pending", outcome: "pending" }));
    expect(f.api.cleanup).toHaveBeenCalledWith(f.handle, true, expect.any(AbortSignal), { allowStoragePending: true });
  });

  it.each(["retried", "missing"] as const)("refuses %s create readiness before a native workload", async kind => {
    const f = fixture(); f.api.waitWorkspace.mockImplementation(async (_h, _state, _signal, observe) => {
      observe?.(kind === "missing" ? undefined : { attempt: 1, claimCount: 2, state: "succeeded", errorCode: null });
    });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: kind === "missing" ? "setup_observation_unavailable" : "setup_retried" });
    expect(f.native).not.toHaveBeenCalled(); expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("keeps the first wake failure and its setup observation through cleanup failure", async () => {
    const f = fixture(), wait = f.api.waitWorkspace.getMockImplementation()!;
    f.api.waitWorkspace.mockImplementation(async (...args) => {
      if (args[1] === "running" && f.api.lifecycle.mock.calls.length) throw new ZerosDevError("deadline", undefined, undefined,
        { attempt: 2, claimCount: 2, state: "queued", errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" });
      return wait(...args);
    });
    f.api.cleanup.mockRejectedValue(new Error("synthetic-private-cleanup"));
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "deadline", setup: { claimCount: 2 } });
    expect(f.output.find(row => row.outcome === "failed")).toMatchObject({ phase: "workspace_resume_wait", code: "deadline" });
    expect(JSON.stringify(f.output)).not.toContain("synthetic-private-cleanup"); expect(f.native).not.toHaveBeenCalled();
  });

  it("keeps a lost native-start ACK as a signed intent and never starts again", async () => {
    const f = fixture(), native = f.native.getMockImplementation()!;
    f.native.mockImplementation((...args) => {
      const helper = native(...args), begin = helper.begin.getMockImplementation()!;
      helper.begin.mockImplementation(async () => { await begin(); throw new ZerosDevError("command_uncertain"); }); return helper;
    });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "command_uncertain" });
    expect(f.handle.run.hourly!.infrastructure!.intent).toBeDefined(); expect(f.handle.run.hourly!.infrastructure!.task).toBeUndefined();
    expect(f.snapshots.some(run => run.hourly.infrastructure.intent)).toBe(true);
    expect(f.api.cleanup).toHaveBeenCalledOnce(); expect(f.calls.filter(value => value === "native-allocation")).toHaveLength(1);
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "operation_conflict" });
    expect(f.calls.filter(value => value === "native-allocation")).toHaveLength(1);
  });

  it.each(["short-auth", "short-wait"] as const)("refuses %s without a detached proof", async kind => {
    const f = fixture();
    if (kind === "short-auth") f.prepareDetachedAuth.mockRejectedValue(new ZerosDevError("detached_auth_window"));
    else f.sleep.mockImplementation(async () => { f.advance(500); });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: kind === "short-auth" ? "detached_auth_window" : "detached_proof_incomplete" });
    expect(f.handle.run.hourly!.infrastructure!.complete).toBe(false); expect(f.handle.run.hourly!.infrastructure!.detached).toBeUndefined();
    expect(f.connect).toHaveBeenCalledTimes(4); expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("records the first native failure before an exact helper cleanup that also fails", async () => {
    const f = fixture(), native = f.native.getMockImplementation()!;
    f.native.mockImplementation((...args) => {
      const helper = native(...args);
      helper.finish.mockRejectedValue(new ZerosDevError("runtime_changed"));
      helper.cleanup.mockImplementation(async () => {
        expect(f.snapshots.at(-1).evidence).toContainEqual(expect.objectContaining({ phase: "detached_native_proof", outcome: "failed", code: "runtime_changed" }));
        throw new ZerosDevError("command_uncertain");
      }); return helper;
    });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "runtime_changed" });
    expect(f.output.filter(row => row.outcome === "failed").map(row => [row.phase, row.code])).toEqual([
      ["detached_native_proof", "runtime_changed"], ["native_cleanup", "command_uncertain"],
    ]);
    expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("checks that selection stayed fixed after native work instead of passing an obsolete target", async () => {
    const f = fixture();
    f.api.verifyComputerRuntime.mockImplementation(async () => {
      if (f.calls.includes("finish")) throw new ZerosDevError("runtime_selection_changed"); return "confirmed";
    });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "runtime_selection_changed" });
    expect(f.api.buildComputer).not.toHaveBeenCalled(); expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it.each(["gap", "foreign-session"])("names a malformed native %s proof with a closed phase", async kind => {
    const f = fixture(), native = f.native.getMockImplementation()!;
    f.native.mockImplementation((...args) => {
      const helper = native(...args), finish = helper.finish.getMockImplementation()!;
      helper.finish.mockImplementation(async task => ({ ...await finish(task),
        ...(kind === "gap" ? { maxHeartbeatGapMs: 90_001 } : { sessionSha256: "e".repeat(64) }) }));
      return helper;
    });
    await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "detached_proof_incomplete" });
    expect(f.output.find(row => row.outcome === "failed")).toMatchObject({ phase: "detached_native_proof", code: "detached_proof_incomplete" });
    expect(f.handle.run.hourly!.infrastructure!.detached).toBeUndefined(); expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("rebuilds once when the qualified selection moved and continues with that pinned target", async () => {
    const f = fixture(), read = f.api.readComputerRuntime.getMockImplementation()!;
    f.api.readComputerRuntime.mockImplementation(async () => ({ ...await read(), runtimeId: `r1-${"f".repeat(64)}` }));
    await runInfrastructure(f.options as never);
    expect(f.api.buildComputer).toHaveBeenCalledOnce(); expect(f.api.waitComputer).toHaveBeenCalledOnce();
    expect(f.handle.run.hourly!.infrastructure!.complete).toBe(true);
  });

  it("passes the phase abort into connect and retires a late connection without native work", async () => {
    const f = fixture(), timeouts: Array<{ ms: number; controller: AbortController }> = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); timeouts.push({ ms, controller }); return controller.signal;
    });
    let seen: AbortSignal | undefined, release: (() => void) | undefined;
    const connect = f.connect.getMockImplementation()!;
    f.connect.mockImplementationOnce(async (...args) => {
      seen = args[1]; const runtime = await connect(...args);
      queueMicrotask(() => timeouts.filter(row => row.ms === 30_000).at(-1)!.controller.abort());
      return new Promise<typeof runtime>(resolve => { release = () => resolve(runtime); });
    });
    try {
      await expect(runInfrastructure(f.options as never)).rejects.toMatchObject({ code: "deadline" });
      expect(seen!.aborted).toBe(true); expect(f.native).not.toHaveBeenCalled();
    } finally { release!(); await Promise.resolve(); await Promise.resolve(); }
    expect(f.runtimes[0].dispose).toHaveBeenCalledOnce();
  });

  it("external cancellation still reaches the reserved exact cleanup without restarting work", async () => {
    const f = fixture(), controller = new AbortController();
    f.sleep.mockImplementation(async () => { controller.abort(); throw new ZerosDevError("deadline"); });
    await expect(runInfrastructure({ ...f.options, signal: controller.signal } as never)).rejects.toMatchObject({ code: "deadline" });
    expect(f.api.cleanup).toHaveBeenCalledOnce(); expect(f.native).toHaveBeenCalledOnce();
    expect(f.runtimes[3].dispose).toHaveBeenCalledOnce(); expect(f.handle.run.hourly!.infrastructure!.complete).toBe(false);
  });
});
