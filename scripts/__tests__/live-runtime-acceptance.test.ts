import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runAcceptance } from "../cloud-workspace-validation/live-update-acceptance/runner";
import { writeJournal } from "../cloud-workspace-validation/live-update-acceptance/cli.mts";
import type { AlphaLiveUpdateAdapter, Device, Journal, Observation, Preflight } from "../cloud-workspace-validation/live-update-acceptance/contract";

function fixture() {
  let time = 0, created = false, released = false;
  let finish: (() => void) | null = null;
  const organizationId = randomUUID(), workspaceId = randomUUID();
  const evidence: Preflight = { version: 1, channel: "alpha", staff: true, organizationId,
    sourceRuntimeId: "r1-11111111", targetRuntimeId: "r1-22222222", capabilities: {
      residentHandoff: true, freshProofs: true, rollbackPair: true, heldTurn: true,
      inputAcknowledgements: true, healthFailureInjection: true, idempotentCreateAndCleanup: true } };
  const observation: Observation = { organizationId, workspaceId,
    engine: { instanceId: randomUUID(), generation: 1, runtimeId: evidence.sourceRuntimeId, authorityEpoch: 1,
      proofId: randomUUID(), residentFence: 1, hostId: randomUUID(), allocationId: randomUUID(), bootId: randomUUID(),
      controllerRuntimeId: evidence.sourceRuntimeId, hostRuntimeId: evidence.sourceRuntimeId },
    workload: { terminalPid: 123, serverPid: 124, serverCounter: 0, fileDigest: "a".repeat(64), inputs: [] },
    turn: { operationId: randomUUID(), state: "running", executions: 1, runtimeId: evidence.sourceRuntimeId }, commands: [] };
  const journal: Journal[] = [];
  const devices: Device[] = [0, 1].map(() => ({
    startWorkload: vi.fn(async input => { observation.turn.operationId = input.operationId; }),
    observe: vi.fn(async () => { time++; observation.workload.serverCounter++; return structuredClone(observation); }),
    input: vi.fn(async operationId => {
      let input = observation.workload.inputs.find(row => row.operationId === operationId);
      if (!input) { input = { operationId, applications: 1 }; observation.workload.inputs.push(input); }
      return { ...input };
    }),
    enqueue: vi.fn(async operationId => {
      let command = observation.commands.find(row => row.operationId === operationId);
      if (!command) { command = { operationId, commandId: randomUUID(), state: "queued", starts: 0, completions: 0, runtimeId: null }; observation.commands.push(command); }
      return { commandId: command.commandId };
    }),
    releaseTurn: vi.fn(async () => { released = true; observation.turn.state = "completed"; finish?.(); }),
    close: vi.fn(async () => {}),
  }));
  const adapter: AlphaLiveUpdateAdapter = {
    preflight: vi.fn(async () => structuredClone(evidence)),
    provision: vi.fn(async operation => {
      expect(journal[0]).toMatchObject({ operationId: operation.operationId, phase: "allocated" });
      expect(operation.name).toMatch(/^zeros-v2-test-lu-/); created = true;
      return { organizationId, workspaceId };
    }),
    connect: vi.fn(async (_workspace, device) => devices[device === "a" ? 0 : 1]),
    stage: vi.fn(async () => {}),
    handoff: vi.fn(async request => {
      if (!released) await new Promise<void>(resolve => { finish = resolve; });
      observation.engine.instanceId = randomUUID(); observation.engine.proofId = randomUUID();
      observation.engine.authorityEpoch++; observation.engine.residentFence++;
      if (!request.failTargetHealth) {
        observation.engine.runtimeId = request.targetRuntimeId; observation.engine.generation++;
        for (const command of observation.commands) Object.assign(command, { state: "completed", starts: 1, completions: 1, runtimeId: request.targetRuntimeId });
      }
      return request.failTargetHealth ? "rolled_back" : "updated";
    }),
    cleanup: vi.fn(async () => { created = false; return { complete: true, remainingResources: 0 }; }),
  };
  return { adapter, evidence, observation, devices, journal, now: () => time,
    jump: () => { time += 3000; }, created: () => created,
    run: () => runAcceptance(adapter, { journal: async record => { journal.push(structuredClone(record)); },
      now: () => time, pollMs: 1, timeoutMs: 2000, probeTimeoutMs: 50, cleanupTimeoutMs: 100 }) };
}

describe("Alpha live runtime acceptance runner", () => {
  it("checks two devices, active-turn drain, duplicate input/queue, PID survival, rollback and cleanup", async () => {
    const f = fixture(); const report = await f.run();
    expect(report).toMatchObject({ outcome: "passed", cleaned: true });
    expect(f.adapter.handoff).toHaveBeenCalledTimes(2);
    expect(f.devices[1].observe).toHaveBeenCalled();
    expect(f.devices.every(device => vi.mocked(device.close).mock.calls.length === 1)).toBe(true);
    expect(f.journal.at(-1)?.phase).toBe("cleaned"); expect(f.created()).toBe(false);
  });
  it.each(["channel", "qualification"])("refuses %s before creating any resources", async kind => {
    const f = fixture();
    if (kind === "channel") f.evidence.channel = "production" as "alpha";
    else f.evidence.capabilities.freshProofs = false as true;
    expect(await f.run()).toMatchObject({ outcome: "blocked", cleaned: true });
    expect(f.adapter.provision).not.toHaveBeenCalled(); expect(f.adapter.cleanup).not.toHaveBeenCalled();
    expect(f.journal).toEqual([]);
  });
  it("recovers a lost create reply with the same journaled operation", async () => {
    const f = fixture(), provision = f.adapter.provision;
    f.adapter.provision = vi.fn().mockImplementationOnce(async (...args: Parameters<typeof provision>) => {
      await provision(...args); throw new Error("synthetic private diagnostic");
    }).mockImplementation(provision);
    expect(await f.run()).toMatchObject({ outcome: "passed", cleaned: true });
    const calls = vi.mocked(f.adapter.provision).mock.calls;
    expect(calls[0][0]).toEqual(calls[1][0]);
  });
  it("cleans up by operation when every create response is lost", async () => {
    const f = fixture(), provision = f.adapter.provision;
    f.adapter.provision = vi.fn(async (...args) => { await provision(...args); throw new Error("private diagnostic"); });
    const report = await f.run();
    expect(report).toMatchObject({ outcome: "failed", cleaned: true });
    expect(f.created()).toBe(false); expect(JSON.stringify(report)).not.toContain("private diagnostic");
  });
  it.each(["pid", "boot", "scope", "proof", "gap", "queue", "input"])("fails closed on %s loss while still cleaning up", async kind => {
    const f = fixture(), handoff = f.adapter.handoff, before = structuredClone(f.observation.engine);
    f.adapter.handoff = vi.fn(async (...args) => {
      const result = await handoff(...args);
      if (kind === "pid") f.observation.workload.terminalPid++;
      if (kind === "boot") f.observation.engine.bootId = randomUUID();
      if (kind === "scope") f.observation.organizationId = randomUUID();
      if (kind === "proof") f.observation.engine.proofId = before.proofId;
      if (kind === "gap") f.jump();
      if (kind === "queue") f.observation.commands[0].starts = 2;
      if (kind === "input") f.observation.workload.inputs[0].applications = 2;
      return result;
    });
    const report = await f.run(); expect(report.outcome).toBe("failed"); expect(report.cleaned).toBe(true);
  });
  it("does not call an acknowledged deletion complete while inventory remains", async () => {
    const f = fixture(); f.adapter.cleanup = vi.fn(async () => ({ complete: true, remainingResources: 1 }));
    expect(await f.run()).toMatchObject({ outcome: "cleanup_required", cleaned: false });
    expect(f.journal.at(-1)?.phase).toBe("cleanup_required");
  });
  it("rejects rollback that reuses the original engine identity or proof", async () => {
    const f = fixture(), handoff = f.adapter.handoff, original = structuredClone(f.observation.engine);
    f.adapter.handoff = vi.fn(async (request, signal) => {
      const result = await handoff(request, signal);
      if (request.failTargetHealth) {
        f.observation.engine.instanceId = original.instanceId; f.observation.engine.proofId = original.proofId;
      }
      return result;
    });
    expect(await f.run()).toMatchObject({ outcome: "failed", code: "fresh_proof_missing", cleaned: true });
  });
  it("never mutates when the initial journal cannot be made durable", async () => {
    const f = fixture();
    const report = await runAcceptance(f.adapter, { journal: async () => { throw new Error("private path"); } });
    expect(report.outcome).toBe("failed"); expect(f.adapter.provision).not.toHaveBeenCalled();
  });
  it("rejects a transition that completes before the held turn is released", async () => {
    const f = fixture(); f.adapter.handoff = vi.fn(async () => "updated");
    expect(await f.run()).toMatchObject({ outcome: "failed", code: "handoff_did_not_drain", cleaned: true });
  });
  it("cancels pending handoff work before deleting the workspace after a failed assertion", async () => {
    const f = fixture(); let transitionSignal: AbortSignal | undefined;
    f.adapter.handoff = vi.fn(async (_input, signal) => {
      transitionSignal = signal; return new Promise(() => {});
    });
    f.devices[1].enqueue = vi.fn(async () => ({ commandId: randomUUID() }));
    const cleanup = f.adapter.cleanup;
    f.adapter.cleanup = vi.fn(async (...args) => { expect(transitionSignal?.aborted).toBe(true); return cleanup(...args); });
    expect(await f.run()).toMatchObject({ outcome: "failed", cleaned: true });
  });
  it("retains a durable private journal and rejects overwriting another allocation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-lu-journal-"));
    const operationId = randomUUID(), name = `zeros-v2-test-lu-${operationId}`;
    const record: Journal = { version: 1, operationId, name, phase: "allocated" };
    try {
      await writeJournal(directory, record);
      const file = path.join(directory, `${name}.json`);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(writeJournal(directory, record)).rejects.toThrow();
      await writeJournal(directory, { ...record, phase: "cleaned" });
      expect(JSON.parse(await readFile(file, "utf8")).phase).toBe("cleaned");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("the CLI refuses a missing adapter without reading credentials or exposing arguments", () => {
    const cli = "scripts/cloud-workspace-validation/live-update-acceptance/cli.mts";
    for (const args of [[], ["--unsupported", "synthetic-private-argument"]]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8" });
      expect(result.status).toBe(2); expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ outcome: "blocked", code: "adapter_not_configured", cleaned: true });
      expect(result.stdout).not.toContain("synthetic-private-argument");
    }
  });
});
