import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompleteCheckpointAttempt } from "../cloud-complete-checkpoint-contract";
import type { CompleteCaptureAdapters } from "../cloud-complete-checkpoint-adapter";

const modulePath = path.resolve(import.meta.dirname, "../cloud-complete-checkpoint-adapter.ts");
async function implementation() {
  expect(fs.existsSync(modulePath), "complete capture requires explicit qualified adapters").toBe(true);
  return import("../cloud-complete-checkpoint-adapter");
}
function fixture() {
  const start = 1_000_000;
  const source = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3,
    engineInstanceId: randomUUID(), writerEpoch: randomUUID(), scopeRevision: 1, scopeSha256: "a".repeat(64),
    changeSequence: 2, reconcileSequence: 0 };
  const attempt: CompleteCheckpointAttempt = { id: randomUUID(), source, startedAtMs: start, deadlineAtMs: start + 1000 };
  const authority = { organizationId: source.organizationId, workspaceId: source.workspaceId, generation: source.generation,
    engineInstanceId: source.engineInstanceId, heartbeatEndpoint: "https://control.fixture.test/heartbeat", heartbeatToken: "fixture" };
  let now = start + 1, mono = 1, current = { ...source };
  const cut = { attemptId: attempt.id, source, cutAtMs: start + 1, inventorySha256: "b".repeat(64) };
  const exported = { ...cut, manifestSha256: "c".repeat(64), nativeExportSha256: "d".repeat(64) };
  const receipt = { version: 1 as const, kind: "complete-periodic" as const, ...exported, ackAtMs: start + 2 };
  const trace: string[] = [];
  function operation<T>(name: string, value: T) {
    const operationId = randomUUID();
    return { operationId, attemptId: attempt.id, source, run: vi.fn(async () => { trace.push(`${name}:run`); now++; mono++; return value; }),
      retire: vi.fn(async () => { trace.push(`${name}:retire`); return { status: "retired" as const, operationId, attemptId: attempt.id, source }; }),
      verify: vi.fn(() => { trace.push(`${name}:verify`); }), close: vi.fn(() => { trace.push(`${name}:close`); }) };
  }
  const cutOp = operation("cut", cut), exportOp = operation("export", exported), storeOp = operation("store", receipt);
  const options = { source, currentSource: () => current, now: () => now, monotonicNow: () => mono, cleanupRetryMs: 1,
    qualified: () => true, cut: { prepare: vi.fn((_context: Parameters<CompleteCaptureAdapters["cut"]["prepare"]>[0]) => cutOp) }, export: { prepare: vi.fn(() => exportOp) },
    privateStore: { prepare: vi.fn(() => storeOp) }, observeUnknown: vi.fn() };
  return { options, attempt, authority, cutOp, exportOp, storeOp, source, cut, exported, receipt, trace,
    advance: (n: number) => { now += n; mono += n; }, setSource: (value: typeof source) => { current = value; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe("dormant complete checkpoint capture adapter", () => {
  it("requires explicit qualification and all three ports before acquiring custody", async () => {
    const { createCompleteCheckpointCapture } = await implementation(), f = fixture(); f.options.qualified = () => false;
    const result = await createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal);
    expect(result).toEqual({ status: "failed", retirement: "confirmed", reason: "admission_deferred" });
    expect(f.cutOp.run).not.toHaveBeenCalled(); expect(f.options.cut.prepare).not.toHaveBeenCalled();
  });
  it("commits only after private ACK and every original retirement plus final source/manifest verification", async () => {
    const { createCompleteCheckpointCapture } = await implementation(), f = fixture();
    const result = await createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal);
    expect(result).toEqual({ status: "committed", retirement: "confirmed", receipt: f.receipt });
    expect(f.trace.indexOf("store:run")).toBeGreaterThan(f.trace.indexOf("export:run"));
    expect(f.trace.lastIndexOf("export:verify")).toBeGreaterThan(f.trace.indexOf("cut:retire"));
    expect(f.trace.indexOf("cut:close")).toBeGreaterThan(f.trace.lastIndexOf("export:verify"));
  });
  it.each(["late_scope", "late_stage", "late_deadline", "bad_ack", "missing_ack"] as const)(
    "refuses %s and retains the first failure through positive retirement", async fault => {
      const { createCompleteCheckpointCapture } = await implementation(), f = fixture();
      if (fault === "late_scope") f.storeOp.retire.mockImplementation(async () => { f.setSource({ ...f.source, scopeRevision: 2 });
        return { status: "retired", operationId: f.storeOp.operationId, attemptId: f.attempt.id, source: f.source }; });
      if (fault === "late_stage") f.exportOp.verify.mockImplementation(() => {
        if (f.storeOp.retire.mock.calls.length) throw new Error("closed stage refusal");
      });
      if (fault === "late_deadline") f.storeOp.retire.mockImplementation(async () => { f.advance(2000);
        return { status: "retired", operationId: f.storeOp.operationId, attemptId: f.attempt.id, source: f.source }; });
      if (fault === "bad_ack") f.receipt.nativeExportSha256 = "e".repeat(64);
      if (fault === "missing_ack") f.storeOp.run.mockRejectedValue(new Error("no private ACK"));
      const result = await createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal);
      expect(result.status).toBe("failed"); expect(result.retirement).toBe("confirmed");
      for (const op of [f.cutOp, f.exportOp, f.storeOp]) expect(op.close).toHaveBeenCalledOnce();
    });
  it("keeps post-cut changes dirty without rebinding the captured source", async () => {
    const { createCompleteCheckpointCapture } = await implementation(), f = fixture();
    f.storeOp.retire.mockImplementation(async () => { f.setSource({ ...f.source, changeSequence: 3 });
      return { status: "retired", operationId: f.storeOp.operationId, attemptId: f.attempt.id, source: f.source }; });
    const result = await createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal);
    expect(result.status).toBe("committed");
    if (result.status === "committed") expect(result.receipt.source.changeSequence).toBe(2);
  });
  it("does not settle on a timeout or failed retirement and joins the original operation after repeated cancellation", async () => {
    const { createCompleteCheckpointCapture } = await implementation(), f = fixture();
    const reached = deferred<void>(), joined = deferred<Awaited<ReturnType<typeof f.storeOp.retire>>>();
    f.storeOp.retire.mockImplementationOnce(async () => { reached.resolve(); throw new Error("ambiguous original cleanup"); })
      .mockImplementation(() => joined.promise);
    const controller = new AbortController(); let settled = false;
    const capture = createCompleteCheckpointCapture(f.options);
    const flight = capture(f.attempt, f.authority, controller.signal).then(value => { settled = true; return value; });
    await reached.promise; controller.abort(); f.advance(2000);
    await Promise.resolve(); expect(settled).toBe(false); expect(f.cutOp.close).not.toHaveBeenCalled();
    await expect(capture({ ...f.attempt, id: randomUUID() }, f.authority, new AbortController().signal)).rejects.toThrow("unconfirmed");
    joined.resolve({ status: "retired", operationId: f.storeOp.operationId, attemptId: f.attempt.id, source: f.source });
    expect(await flight).toMatchObject({ status: "failed", retirement: "confirmed" });
    expect(f.options.observeUnknown).toHaveBeenCalledTimes(1);
    expect(f.options.cut.prepare).toHaveBeenCalledOnce();
  });
  it("isolates owners, placements, generations, scope and writer before any work", async () => {
    const { createCompleteCheckpointCapture } = await implementation();
    for (const key of ["organizationId", "workspaceId", "engineInstanceId", "writerEpoch"] as const) {
      const f = fixture(); f.attempt.source = { ...f.source, [key]: randomUUID() };
      await expect(createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal)).rejects.toThrow();
      expect(f.options.cut.prepare).not.toHaveBeenCalled();
    }
  });
  it("joins original cut retirement before native export or private transfer starts", async () => {
    const { createCompleteCheckpointCapture } = await implementation(), f = fixture();
    const reached = deferred<void>(), joined = deferred<Awaited<ReturnType<typeof f.cutOp.retire>>>();
    f.cutOp.retire.mockImplementation(async () => { reached.resolve(); return joined.promise; });
    const flight = createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal);
    await reached.promise;
    const startedEarly = f.options.export.prepare.mock.calls.length + f.options.privateStore.prepare.mock.calls.length;
    joined.resolve({ status: "retired", operationId: f.cutOp.operationId, attemptId: f.attempt.id, source: f.source });
    expect((await flight).status).toBe("committed");
    expect(startedEarly, "immutable staging cannot extend the all-writer pause into export or network IO").toBe(0);
    expect(f.cutOp.close).toHaveBeenCalledOnce();
  });
  it("never lets a port renew the selected attempt or its deadline", async () => {
    const { createCompleteCheckpointCapture } = await implementation(), f = fixture();
    // A wall-clock step can reach the original wall deadline before the
    // independent monotonic budget; neither fence may be renewed by a port.
    f.options.monotonicNow = () => 1;
    f.options.cut.prepare.mockImplementation(context => {
      f.cutOp.run.mockImplementation(async () => {
        try { context.attempt.deadlineAtMs += 10_000; } catch { /* Frozen selection. */ }
        f.advance(2000); return f.cut;
      });
      return f.cutOp;
    });
    const result = await createCompleteCheckpointCapture(f.options)(f.attempt, f.authority, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(f.options.export.prepare).not.toHaveBeenCalled();
    expect(f.cutOp.close).toHaveBeenCalledOnce();
  });
});
