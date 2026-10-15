import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runGate0 } from "../zeros-dev/gate0";
import { Gate0Schema, GATE0_WORK_MS, GATE0_DETACHED_MS } from "../zeros-dev/gate0-contract";
import { Evidence } from "../zeros-dev/evidence";
import { ZerosDevError } from "../zeros-dev/errors";
import type { RunHandle } from "../zeros-dev/receipts";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";

function fixture() {
  let elapsed = 0, rejectTask: (error: unknown) => void = () => {};
  const origin = Date.parse("2026-10-14T00:00:00Z"), calls: string[] = [], output: any[] = [];
  const handle: RunHandle = { run: { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt: new Date(origin).toISOString(), source: { revision: "b".repeat(40), dirty: false }, prompts: [], lifecycle: [], evidence: [], deletionConfirmed: false,
    hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40), credentials: [], histories: [], activeWindows: [], complete: false,
      rehearsal: { version: 1, complete: false, models: [], cycles: [], transports: [] } } }, save: vi.fn(async () => {}) };
  const active = computerBuild(), target = { runtimeId: `r1-${"c".repeat(64)}`, baseImageId: "fixture-base" };
  const api = {
    assertFixtureEmpty: vi.fn(async () => { calls.push("empty"); }), ensureRepository: vi.fn(async () => { calls.push("repo"); }),
    computerState: vi.fn(async () => ({ active })), readComputerRuntime: vi.fn(async () => ({ ...target, selected: target })),
    verifyComputerRuntime: vi.fn(async () => "confirmed"), buildComputer: vi.fn(), waitComputer: vi.fn(),
    createWorkspace: vi.fn(async () => { calls.push("create"); handle.run.create = { key: randomUUID(), body: {
      name: `zd-${handle.run.runId}`, repository: { forge: "github.com", owner: "fixture", name: "fixture", revision: "main", githubInstallationId: randomUUID() } },
      result: { id: randomUUID(), createdBy: randomUUID(), createdAt: new Date(origin).toISOString(), generation: 1 } }; }),
    waitWorkspace: vi.fn(async (_h, state, _signal?: AbortSignal, observe?: (value: unknown) => void) => {
      calls.push(`wait:${state}`); elapsed += 10_000;
      if (state === "running") observe?.({ attempt: 1, claimCount: 1, state: "succeeded", errorCode: null });
    }),
    lifecycle: vi.fn(async (_h, op) => { calls.push(op); }),
    cleanup: vi.fn(async () => { calls.push("cleanup"); handle.run.deletionConfirmed = true; return { planned: 1, confirmed: 1 }; }),
  };
  const credentials = { install: vi.fn(async () => { calls.push("install"); }), cleanup: vi.fn(async () => { calls.push("revoke"); }) };
  const runtimes: any[] = [];
  const connect = vi.fn(async (_run, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false); calls.push("connect");
    const connectionId = randomUUID();
    const runtime = {
      prompt: vi.fn(async (h: RunHandle, input) => {
        calls.push(`prompt:${input.agent}`);
        const row = { id: input.id, conversationId: randomUUID(), sha256: "d".repeat(64), agent: input.agent, model: input.model, state: "succeeded" as const };
        h.run.prompts.push(row); return row;
      }),
      terminal: vi.fn(async () => { calls.push("terminal"); return { exitCode: 0, output: "", truncated: false }; }),
      tail: vi.fn(async () => [{ msgId: "m", kind: "text", payload: JSON.stringify({ role: "assistant", text: "ZEROS_DEV_OK" }), createdAt: 1 }]),
      dispose: vi.fn(async () => { calls.push("dispose"); }),
      detachTransport: vi.fn(() => { calls.push("detach"); rejectTask(new ZerosDevError("command_uncertain")); }),
      transport: vi.fn(() => ({ connectionId, coverage: "complete", directAttempts: 1, directReady: 1, relayAttempts: 0, relayReady: 0,
        lostConnections: 0, authorityCloses: 0, unexplainedAuthorityCloses: 0 })),
    };
    runtimes.push(runtime); return runtime;
  });
  const models = ["claude", "codex", "cursor"].map(agent => ({ agent, selectedModel: "fixture-model", allowedCount: 1,
    unavailableCount: 0, eligible: true, scopeSha256: "a".repeat(64) }));
  const probe = { models: vi.fn(async () => models), begin: vi.fn(async () => {
    calls.push("begin"); return { completion: new Promise((_resolve, reject) => { rejectTask = reject; }) };
  }), finish: vi.fn(async () => {
    calls.push("finish"); return { durationMs: 31 * 60_000, heartbeatCount: 32, maxHeartbeatGapMs: 60_000,
      commandSha256: "a".repeat(64), scopeSha256: "b".repeat(64), historySha256: "c".repeat(64), historyRows: 8, replayEvents: 17, cursorSha256: "d".repeat(64) };
  }) };
  const prepareDetachedAuth = vi.fn(async () => { calls.push("auth"); return 60 * 60_000; });
  const sleep = vi.fn(async (ms: number) => {
    if (ms === GATE0_DETACHED_MS) {
      expect(calls.at(-1)).toBe("detach");
      // The entire disconnected interval is this wait; it performs no client,
      // token refresh, CP polling, provider operation or simulated reconnect.
      const before = calls.length; elapsed += ms; expect(calls).toHaveLength(before);
    } else elapsed += ms;
  });
  const options = { handle, api, credentials, connect, prepareDetachedAuth, probe: () => probe, sleep,
    now: () => origin + elapsed, monotonic: () => elapsed, evidence: new Evidence(handle.run.runId, row => output.push(row), () => elapsed) };
  return { options, handle, api, credentials, connect, prepareDetachedAuth, sleep, probe, runtimes, calls, output };
}

describe("Gate 0 manual rehearsal through product ports", () => {
  it("can complete compute cleanup while the signed exact storage deletion stays pending", async () => {
    const f = fixture();
    f.api.cleanup.mockImplementation(async () => {
      retireFixtureCompute(f.handle, new Date(f.options.now()).toISOString());
      return { planned: 1, confirmed: 0 };
    });
    await expect(runGate0(f.options as never)).resolves.toBeUndefined();
    expect(f.handle.run.hourly).toMatchObject({ complete: true, rehearsal: { complete: true } });
    expect(f.handle.run.deletionConfirmed).toBe(false);
    expect(f.handle.run.lifecycle.at(-1)).toMatchObject({ operation: "delete", confirmed: false });
    expect(f.credentials.cleanup).toHaveBeenCalledOnce();
  });

  it("does one create, a real-duration hour, three wakes and one 30-minute client gap before exact cleanup", async () => {
    const f = fixture(); await runGate0(f.options as never);
    expect(f.api.createWorkspace).toHaveBeenCalledOnce();
    expect(f.api.lifecycle.mock.calls.map(([, op]) => op)).toEqual(["stop", "wake", "stop", "wake", "stop", "wake"]);
    expect(f.connect).toHaveBeenCalledTimes(5);
    expect(f.runtimes.flatMap(value => value.prompt.mock.calls)).toHaveLength(13);
    expect(f.probe.begin).toHaveBeenCalledOnce(); expect(f.probe.finish).toHaveBeenCalledOnce();
    expect(f.sleep.mock.calls.filter(([ms]) => ms === GATE0_DETACHED_MS)).toHaveLength(1);
    expect(f.calls.slice(-2)).toEqual(["cleanup", "revoke"]);
    const proof = f.handle.run.hourly!.rehearsal!;
    expect(Gate0Schema.safeParse(proof).success).toBe(true);
    expect(proof).toMatchObject({ complete: true, workload: { durationMs: GATE0_WORK_MS, samples: 13, fileChecks: 13 },
      detached: { durationMs: GATE0_DETACHED_MS, taskDurationMs: 31 * 60_000 }, cycles: [expect.anything(), expect.anything(), expect.anything()] });
    expect(proof.transports).toHaveLength(5);
    expect(f.handle.run.hourly!.complete).toBe(true); expect(f.api.buildComputer).not.toHaveBeenCalled();
  });
  it("retains the first closed resume setup failure through cleanup failure", async () => {
    const f = fixture(), read = f.api.waitWorkspace.getMockImplementation()!;
    f.api.waitWorkspace.mockImplementation(async (handle, state, signal, observe) => {
      if (state === "running" && f.api.lifecycle.mock.calls.length) throw new ZerosDevError("deadline", undefined, undefined,
        { attempt: 2, claimCount: 2, state: "queued", errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" });
      return read(handle, state, signal, observe);
    });
    f.credentials.cleanup.mockRejectedValue(new Error("synthetic-private-cleanup"));
    await expect(runGate0(f.options as never)).rejects.toMatchObject({ code: "deadline", setup: { claimCount: 2 } });
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "workspace_resume_wait", outcome: "failed", code: "deadline", setup: { attempt: 2, claimCount: 2, state: "queued", errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" } }));
    expect(f.probe.begin).not.toHaveBeenCalled(); expect(f.api.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.output)).not.toContain("synthetic-private-cleanup");
  });
  it.each(["retried", "missing"] as const)("cannot claim first-try readiness with %s setup evidence", async kind => {
    const f = fixture();
    f.api.waitWorkspace.mockImplementation(async (_handle, state, _signal, observe) => {
      if (state === "running") observe?.(kind === "missing" ? undefined : {
        attempt: 1, claimCount: 2, state: "succeeded", errorCode: null,
      });
    });
    const code = kind === "missing" ? "setup_observation_unavailable" : "setup_retried";
    await expect(runGate0(f.options as never)).rejects.toMatchObject({ code });
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "workspace_create_wait", outcome: "failed", code }));
    expect(f.connect).not.toHaveBeenCalled(); expect(f.api.cleanup).toHaveBeenCalledOnce();
  });
  it("refuses short auth validity before it detaches any device", async () => {
    const f = fixture(); f.prepareDetachedAuth.mockRejectedValue(new ZerosDevError("detached_auth_window"));
    await expect(runGate0(f.options as never)).rejects.toMatchObject({ code: "detached_auth_window" });
    expect(f.probe.begin).not.toHaveBeenCalled(); expect(f.runtimes.every(row => !row.detachTransport.mock.calls.length)).toBe(true);
    expect(f.api.cleanup).toHaveBeenCalledOnce();
  });
  it("cannot turn a short timer or incomplete VM work into a disconnected pass", async () => {
    const f = fixture(), original = f.sleep.getMockImplementation()!;
    f.sleep.mockImplementation(ms => original(ms === GATE0_DETACHED_MS ? 500 : ms));
    await expect(runGate0(f.options as never)).rejects.toMatchObject({ code: "detached_proof_incomplete" });
    expect(f.probe.finish).not.toHaveBeenCalled(); expect(f.handle.run.hourly!.complete).toBe(false);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "detached_wait", outcome: "failed", code: "detached_proof_incomplete" }));
  });
  it("reports incomplete final proof with a closed phase instead of a schema exception", async () => {
    const f = fixture(), finish = f.probe.finish.getMockImplementation()!;
    f.probe.finish.mockImplementation(async () => ({ ...await finish(), replayEvents: 0 }));
    await expect(runGate0(f.options as never)).rejects.toMatchObject({ code: "detached_proof_incomplete" });
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "rehearsal_proof", outcome: "failed", code: "detached_proof_incomplete" }));
  });
  it("keeps missing model eligibility and unexpected transport loss terminal", async () => {
    const f = fixture(); f.probe.models.mockRejectedValue(new ZerosDevError("model_eligibility_unconfirmed"));
    await expect(runGate0(f.options as never)).rejects.toMatchObject({ code: "model_eligibility_unconfirmed" });
    expect(f.runtimes[0].prompt).not.toHaveBeenCalled(); expect(f.api.cleanup).toHaveBeenCalledOnce();
    const g = fixture(), connect = g.connect.getMockImplementation()!;
    g.connect.mockImplementation(async (...args) => {
      const runtime = await connect(...args), sample = runtime.transport();
      runtime.transport.mockReturnValue({ ...sample, lostConnections: 1 }); return runtime;
    });
    await expect(runGate0(g.options as never)).rejects.toMatchObject({ code: "transport_interrupted" });
    expect(g.runtimes[0].prompt).not.toHaveBeenCalled(); expect(g.api.cleanup).toHaveBeenCalledOnce();
  });
});
