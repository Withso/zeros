import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCheckpointScheduler } from "../cloud-checkpoint-scheduler";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
import type {
  CompleteCheckpointAttempt,
  CompleteCheckpointEvidence,
  CompleteCheckpointJournalState,
  CompleteCheckpointOptions,
  CompleteCheckpointOutcome,
  CompleteCheckpointReceipt,
  CompleteCheckpointSource,
} from "../cloud-complete-checkpoint-coordinator";

const authority: CloudDurabilityAuthority = {
  heartbeatEndpoint: "https://control.example.test/heartbeat", heartbeatToken: "fixture",
  organizationId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002", generation: 1,
  engineInstanceId: "30000000-0000-4000-8000-000000000003",
};
const policy = {
  debounceMs: 2_000, maxDirtyAgeMs: 6_000, minStartIntervalMs: 1_000,
  retryDelayMs: 4_000, attemptMs: 10_000, alertAfterMs: 8_000,
};
const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function receipt(attempt: CompleteCheckpointAttempt, cutAtMs = Date.now()): CompleteCheckpointReceipt {
  return { version: 1, kind: "complete-periodic", attemptId: attempt.id,
    source: structuredClone(attempt.source), manifestSha256: "a".repeat(64),
    inventorySha256: "b".repeat(64), nativeExportSha256: "c".repeat(64),
    cutAtMs, ackAtMs: Date.now() };
}
const committed = (value: CompleteCheckpointReceipt): CompleteCheckpointOutcome =>
  ({ status: "committed", retirement: "confirmed", receipt: value });

function fixture(checkpointPolicy = policy) {
  let source: CompleteCheckpointSource | null = {
    organizationId: authority.organizationId, workspaceId: authority.workspaceId,
    generation: authority.generation, engineInstanceId: authority.engineInstanceId,
    writerEpoch: "40000000-0000-4000-8000-000000000004", scopeRevision: 1,
    scopeSha256: "d".repeat(64), changeSequence: 1, reconcileSequence: 0,
  };
  let allowed = true, revision = 0, stored: CompleteCheckpointJournalState | null = null;
  const listeners = new Set<() => void>();
  const read = vi.fn(async () => ({ revision, state: structuredClone(stored) }));
  const write = vi.fn(async (expected: number, state: CompleteCheckpointJournalState) => {
    if (expected !== revision) return false;
    stored = structuredClone(state); revision++; return true;
  });
  const capture = vi.fn(async (attempt: CompleteCheckpointAttempt,
    _authority: CloudDurabilityAuthority, _signal: AbortSignal): Promise<CompleteCheckpointOutcome> => committed(receipt(attempt)));
  const observations: CompleteCheckpointEvidence[] = [];
  const observe = vi.fn((value: CompleteCheckpointEvidence) => { observations.push(value); });
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  });
  const complete: CompleteCheckpointOptions = { enabled: true, policy: checkpointPolicy, source: () => source,
    monotonicNow: () => performance.now(), subscribe, capture, journal: { read, write }, observe };
  const legacy = vi.fn(async () => {});
  // Passing a variable also exercises the unchanged consumer on the parent:
  // it ignores the new option and fails behavior assertions, not an import.
  const options = { capture: legacy, eligible: () => allowed, now: () => Date.now(), complete };
  const scheduler = new CloudCheckpointScheduler(options);
  return { scheduler, options, complete, capture, legacy, observe, observations, read, write, subscribe, listeners,
    source: () => source!, stored: () => structuredClone(stored),
    change(patch: Partial<CompleteCheckpointSource> = {}) {
      source = { ...source!, changeSequence: source!.changeSequence + 1, ...patch };
      for (const listener of listeners) listener();
    },
    replace(value: CompleteCheckpointSource | null) { source = value; for (const listener of listeners) listener(); },
    allow(value: boolean) { allowed = value; },
    start() { scheduler.consider(authority); },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("dormant complete checkpoint coordination", () => {
  it("keeps the ordinary partial scheduler unchanged while the flag is off", async () => {
    const f = fixture();
    const scheduler = new CloudCheckpointScheduler({ ...f.options, complete: { enabled: false } });
    scheduler.consider(authority); await tick(300_000); scheduler.consider(authority); await tick();
    expect(f.legacy).toHaveBeenCalledOnce(); expect(f.capture).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled(); expect(f.subscribe).not.toHaveBeenCalled();
    await scheduler.close(); await f.scheduler.close();
  });

  it("captures after the quiet interval, journals before I/O, then has no clean timers", async () => {
    const f = fixture(); f.start(); await tick(1_999);
    expect(f.capture).not.toHaveBeenCalled(); await tick(1);
    expect(f.capture).toHaveBeenCalledOnce(); expect(f.legacy).not.toHaveBeenCalled();
    const attempt = f.capture.mock.calls[0]![0];
    expect(f.write.mock.calls[0]![1].pending).toEqual(attempt);
    expect(f.write.mock.invocationCallOrder[0]).toBeLessThan(f.capture.mock.invocationCallOrder[0]!);
    expect(f.stored()).toMatchObject({ pending: null, lastComplete: { attemptId: attempt.id, cutAtMs: Date.now() } });
    expect(f.observations.at(-1)).toMatchObject({ event: "complete", durableAgeMs: 0 });
    await tick(600_000); f.start(); await tick();
    expect(f.capture).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await f.scheduler.close(); expect(f.listeners.size).toBe(0);
  });

  it("cannot postpone the oldest dirty deadline with continuous edits", async () => {
    const f = fixture(); f.start();
    for (let i = 0; i < 5; i++) { await tick(1_000); f.change(); }
    expect(f.capture).not.toHaveBeenCalled(); await tick(1_000);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.capture.mock.calls[0]![0].source.changeSequence).toBe(6);
    await f.scheduler.close();
  });

  it("keeps one capture and preserves edits that arrive after its cut", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    let first!: CompleteCheckpointReceipt;
    f.capture.mockImplementationOnce(async attempt => { first = receipt(attempt); return pending.promise; });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    await tick(500); f.change(); await tick(500); f.change(); f.start(); await tick();
    expect(f.capture).toHaveBeenCalledOnce();
    pending.resolve(committed({ ...first, ackAtMs: Date.now() })); await tick();
    expect(f.stored()!.lastComplete!.source.changeSequence).toBe(1);
    await tick(1_999); expect(f.capture).toHaveBeenCalledOnce(); await tick(1);
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.stored()!.lastComplete!.source.changeSequence).toBe(3);
    await f.scheduler.close();
  });

  it("reports the data cut age, not the time an old upload was acknowledged", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    let first!: CompleteCheckpointReceipt;
    f.capture.mockImplementationOnce(async attempt => { first = receipt(attempt); return pending.promise; });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce(); await tick(5_000);
    pending.resolve(committed({ ...first, ackAtMs: Date.now() })); await tick();
    expect(f.observations.at(-1)).toMatchObject({ event: "complete", durableAgeMs: 5_000,
      cutAtMs: first.cutAtMs, ackAtMs: Date.now() });
    await f.scheduler.close();
  });

  it("does not rejuvenate an accepted cut when wall time moves backwards", async () => {
    const f = fixture(); f.start(); await tick(2_000); await tick(5_000);
    const before = Date.now(); vi.setSystemTime(before - 60_000); f.change();
    f.capture.mockResolvedValue({ status: "failed", retirement: "confirmed", reason: "clock_invalid" });
    await tick(2_000);
    expect(f.observations.at(-1)).toMatchObject({ event: "deferred", durableAgeMs: 7_000 });
    await f.scheduler.close();
  });

  it("retains dirt and the previous complete receipt while a retired failure backs off", async () => {
    const f = fixture(); f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const previous = f.stored()!.lastComplete;
    f.capture.mockResolvedValueOnce({ status: "failed", retirement: "confirmed", reason: "capture_failed" });
    f.change(); await tick(2_000);
    expect(f.capture).toHaveBeenCalledTimes(2); expect(f.stored()!.lastComplete).toEqual(previous);
    f.change(); await tick(3_999); expect(f.capture).toHaveBeenCalledTimes(2); await tick(1);
    expect(f.capture).toHaveBeenCalledTimes(3);
    await f.scheduler.close();
  });

  it("retains a durable unknown attempt across close and a new coordinator", async () => {
    const f = fixture(); f.capture.mockRejectedValue(new Error("private diagnostic must not escape"));
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const held = f.stored()!.pending; expect(held).not.toBeNull();
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
    const restarted = new CloudCheckpointScheduler(f.options);
    restarted.consider(authority); await tick(60_000); restarted.consider(authority); await tick();
    expect(f.capture).toHaveBeenCalledOnce(); expect(f.stored()!.pending).toEqual(held);
    expect(JSON.stringify(f.observations)).not.toContain("private diagnostic");
    expect(f.observations).toContainEqual(expect.objectContaining({ event: "custody_unknown" }));
    await expect(restarted.close()).rejects.toThrow("custody unconfirmed");
  });

  it("does not dispatch before the attempt journal is durably acknowledged", async () => {
    const f = fixture(), journal = deferred<void>(), commit = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (revision, state) => { await journal.promise; return commit(revision, state); });
    f.start(); await tick(2_000); expect(f.write).toHaveBeenCalledOnce(); expect(f.capture).not.toHaveBeenCalled();
    journal.resolve(); await tick(); expect(f.capture).toHaveBeenCalledOnce();
    await f.scheduler.close();
  });

  it.each(["reject", "conflict"] as const)("refuses new capture on %s of the journal fence", async kind => {
    const f = fixture();
    if (kind === "reject") f.write.mockRejectedValue(new Error("storage"));
    else f.write.mockResolvedValue(false);
    f.start(); await tick(60_000); f.start(); await tick();
    expect(f.capture).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
    expect(f.observations).toContainEqual(expect.objectContaining({ event: "custody_unknown", reason: "journal_unconfirmed" }));
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("keeps the original deadline while journal I/O is held", async () => {
    const f = fixture(), journal = deferred<void>(), commit = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (revision, state) => { await journal.promise; return commit(revision, state); });
    f.start(); await tick(2_000); expect(f.write).toHaveBeenCalledOnce();
    const original = f.write.mock.calls[0]![1].pending!;
    await tick(10_000); journal.resolve(); await tick();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.observations).toContainEqual(expect.objectContaining({ event: "deferred", reason: "deadline" }));
    expect(original.deadlineAtMs - original.startedAtMs).toBe(policy.attemptMs);
    await f.scheduler.close();
  });

  it("does not free an expired capture lane before positive retirement", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    f.capture.mockImplementationOnce(() => pending.promise);
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const signal = f.capture.mock.calls[0]![2];
    await tick(10_000); expect(signal.aborted).toBe(true); f.change(); f.start(); await tick(20_000);
    expect(f.capture).toHaveBeenCalledOnce();
    let paused = false; const pause = f.scheduler.pause().then(() => { paused = true; });
    await tick(); expect(paused).toBe(false);
    pending.resolve({ status: "failed", retirement: "confirmed", reason: "deadline" });
    await pause; expect(paused).toBe(true); expect(f.stored()!.pending).toBeNull();
    await f.scheduler.close();
  });

  it("requires final pause to join capture and never turns periodic proof into a final seal", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    let value!: CompleteCheckpointReceipt;
    f.capture.mockImplementationOnce(async attempt => { value = receipt(attempt); return pending.promise; });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce(); let paused = false;
    const pause = f.scheduler.pause().then(() => { paused = true; }); f.change(); await tick(1_000);
    expect(paused).toBe(false); pending.resolve(committed({ ...value, ackAtMs: Date.now() })); await pause;
    await tick(30_000); expect(f.capture).toHaveBeenCalledOnce();
    expect(f.stored()!.lastComplete!.kind).toBe("complete-periodic");
    expect(f.stored()!.lastComplete).not.toHaveProperty("finalSeal");
    f.scheduler.resume(); await tick(); expect(f.capture).toHaveBeenCalledTimes(2);
    await f.scheduler.close();
  });

  it("prevents a queued background start after final pause or authority loss", async () => {
    const f = fixture(); f.start(); await tick(1_999); await f.scheduler.pause(); await tick(1);
    expect(f.capture).not.toHaveBeenCalled(); f.scheduler.resume(); f.allow(false); await tick();
    expect(f.capture).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    // Ineligible dirty work still owns one bounded operator-staleness alarm.
    expect(vi.getTimerCount()).toBe(1);
    f.allow(true); f.start(); await tick(); expect(f.capture).toHaveBeenCalledOnce();
    await f.scheduler.close();
  });

  it("rejects a late completion after source A to B to A, retaining the original journal", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    let first!: CompleteCheckpointReceipt;
    f.capture.mockImplementationOnce(async attempt => { first = receipt(attempt); return pending.promise; });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const initial = structuredClone(f.source());
    f.replace({ ...initial, workspaceId: "50000000-0000-4000-8000-000000000005" }); f.replace(initial);
    pending.resolve(committed(first)); await tick();
    expect(f.stored()!.lastComplete).toBeNull();
    expect(f.observations).not.toContainEqual(expect.objectContaining({ event: "complete" }));
    f.start(); await tick(60_000); expect(f.capture).toHaveBeenCalledOnce();
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it.each(["partial", "future-cut", "wrong-scope", "newer-sequence", "wrong-attempt", "extra-field"] as const)(
    "never accepts %s as a complete exact-attempt receipt", async mutation => {
      const f = fixture();
      f.capture.mockImplementationOnce(async attempt => {
        const value: any = receipt(attempt);
        if (mutation === "partial") value.kind = "projection";
        if (mutation === "future-cut") value.cutAtMs = Date.now() + 1;
        if (mutation === "wrong-scope") value.source.scopeSha256 = "e".repeat(64);
        if (mutation === "newer-sequence") value.source.changeSequence++;
        if (mutation === "wrong-attempt") value.attemptId = "60000000-0000-4000-8000-000000000006";
        if (mutation === "extra-field") value.finalSeal = "not-authority";
        return committed(value);
      });
      f.start(); await tick(2_000);
      expect(f.capture).toHaveBeenCalledOnce(); expect(f.stored()!.lastComplete).toBeNull();
      expect(f.observations).toContainEqual(expect.objectContaining({ event: "deferred", reason: "receipt_invalid" }));
      await f.scheduler.close();
    });

  it("reconciles an unknown watcher interval even without another change sequence", async () => {
    const f = fixture(); f.start(); await tick(2_000);
    f.replace({ ...f.source(), reconcileSequence: 1 }); await tick(2_000);
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.capture.mock.calls[1]![0].source).toMatchObject({ changeSequence: 1, reconcileSequence: 1 });
    await f.scheduler.close();
  });

  it("alerts operators once per stale interval and preserves the real cut age", async () => {
    const f = fixture(); f.start(); await tick(2_000);
    f.capture.mockResolvedValue({ status: "failed", retirement: "confirmed", reason: "capture_failed" });
    f.change(); await tick(12_000); f.start(); f.start(); await tick();
    const alerts = f.observations.filter(value => value.event === "stale");
    expect(alerts).toHaveLength(1); expect(alerts[0]!.durableAgeMs).toBeGreaterThanOrEqual(8_000);
    expect(alerts[0]!.dirtyAgeMs).toBeGreaterThanOrEqual(8_000);
    expect(f.stored()!.lastComplete!.cutAtMs).toBe(Date.parse("2026-01-01T00:00:02.000Z"));
    await f.scheduler.close();
  });

  it("does not let broken operator reporting change journal, retirement or retry", async () => {
    const f = fixture(); f.observe.mockImplementation(() => { throw new Error("observer" ); });
    f.capture.mockResolvedValueOnce({ status: "failed", retirement: "confirmed", reason: "capture_failed" });
    f.start(); await tick(2_000); await tick(4_000);
    expect(f.capture).toHaveBeenCalledTimes(2); expect(f.stored()!.lastComplete).not.toBeNull();
    await f.scheduler.close();
  });

  it("reconciles a prior complete inventory after restart even when hints are silent", async () => {
    const f = fixture(); f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const previous = f.stored()!.lastComplete; await f.scheduler.close();
    const restarted = new CloudCheckpointScheduler(f.options);
    restarted.consider(authority); await tick(1_999); expect(f.capture).toHaveBeenCalledOnce();
    await tick(1); expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.stored()!.lastComplete!.attemptId).not.toBe(previous!.attemptId);
    await restarted.close();
  });

  it("lets only one coordinator dispatch after both read the same journal revision", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    f.capture.mockImplementationOnce(() => pending.promise);
    const other = new CloudCheckpointScheduler(f.options);
    f.start(); other.consider(authority); await tick(2_000);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.stored()!.pending!.id).toBe(f.capture.mock.calls[0]![0].id);
    await expect(other.close()).rejects.toThrow("custody unconfirmed");
    pending.resolve(committed(receipt(f.capture.mock.calls[0]![0]))); await tick();
    await f.scheduler.close();
  });

  it("keeps the prior retry time when the coordinator restarts", async () => {
    const f = fixture();
    f.capture.mockResolvedValueOnce({ status: "failed", retirement: "confirmed", reason: "capture_failed" });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    await f.scheduler.close(); const restarted = new CloudCheckpointScheduler(f.options);
    restarted.consider(authority); await tick(3_999); expect(f.capture).toHaveBeenCalledOnce();
    await tick(1); expect(f.capture).toHaveBeenCalledTimes(2);
    await restarted.close();
  });

  it.each(["rejected", "conflicted"] as const)("retains the original attempt when terminal journaling is %s", async kind => {
    const f = fixture(), commit = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(commit).mockImplementationOnce(async () => {
      if (kind === "rejected") throw new Error("private journal error");
      return false;
    });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    expect(f.stored()).toMatchObject({ pending: f.capture.mock.calls[0]![0], lastComplete: null });
    expect(f.observations).not.toContainEqual(expect.objectContaining({ event: "complete" }));
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("retains and persists backoff when terminal journal I/O exceeds the original deadline", async () => {
    const f = fixture(), gate = deferred<void>(), commit = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(commit).mockImplementationOnce(async (revision, state) => {
      await gate.promise; return commit(revision, state);
    });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    await tick(policy.attemptMs); gate.resolve(); await tick();
    expect(f.observations).not.toContainEqual(expect.objectContaining({ event: "complete" }));
    expect(f.stored()!.retryAtMs).toBe(Date.now() + policy.retryDelayMs);
    await f.scheduler.close();
    const restarted = new CloudCheckpointScheduler(f.options);
    restarted.consider(authority); await tick(3_999); expect(f.capture).toHaveBeenCalledOnce();
    await tick(1); expect(f.capture).toHaveBeenCalledTimes(2); await restarted.close();
  });

  it("rechecks a long persisted due time after the maximum representable timer", async () => {
    const f = fixture();
    f.read.mockResolvedValue({ revision: 1, state: { version: 1, source: structuredClone(f.source()),
      pending: null, lastComplete: null, lastStartedAtMs: Date.now(), retryAtMs: Date.now() + 2_147_483_700 } });
    f.start(); await tick(2_147_483_648);
    expect(f.capture).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    await f.scheduler.close();
  });

  it("does not announce a completion after source replacement during terminal journal I/O", async () => {
    const f = fixture(), gate = deferred<void>(), commit = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(commit).mockImplementationOnce(async (revision, state) => {
      await gate.promise; return commit(revision, state);
    });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    f.replace({ ...f.source(), writerEpoch: "70000000-0000-4000-8000-000000000007" });
    gate.resolve(); await tick();
    expect(f.observations).not.toContainEqual(expect.objectContaining({ event: "complete" }));
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it.each(["read-error", "unknown-field", "wrong-owner", "unknown-retirement"] as const)(
    "fails closed on %s without exposing its diagnostic", async kind => {
      const f = fixture();
      if (kind === "read-error") f.read.mockRejectedValue(new Error("private credential"));
      if (kind === "unknown-field") f.read.mockResolvedValue({ revision: 0, state: null, private: "credential" } as never);
      if (kind === "wrong-owner") f.read.mockResolvedValue({ revision: 1,
        state: { version: 1, source: { ...f.source(), organizationId: "80000000-0000-4000-8000-000000000008" },
          pending: null, lastComplete: null, lastStartedAtMs: null, retryAtMs: null } });
      if (kind === "unknown-retirement") f.capture.mockResolvedValue({ status: "failed", retirement: "unknown", reason: "capture_failed" } as never);
      f.start(); await tick(60_000); f.start(); await tick();
      expect(f.capture).toHaveBeenCalledTimes(kind === "unknown-retirement" ? 1 : 0);
      expect(f.observations).toContainEqual(expect.objectContaining({ event: "custody_unknown" }));
      expect(JSON.stringify(f.observations)).not.toContain("credential");
      await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
    });

  it("refuses a monotonic-clock rollback without resetting attempt authority", async () => {
    const f = fixture(); f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    f.complete.monotonicNow = () => 1;
    f.change(); await tick(60_000);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.observations).toContainEqual(expect.objectContaining({ event: "custody_unknown", reason: "clock_invalid" }));
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("reports a throwing clock through the closed refusal path", async () => {
    const f = fixture(); f.complete.monotonicNow = () => { throw new Error("private clock"); };
    expect(() => f.start()).not.toThrow();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.observations).toContainEqual(expect.objectContaining({ event: "custody_unknown", reason: "clock_invalid" }));
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("bounds an unknown initial journal read and refuses its late result", async () => {
    const f = fixture(), read = deferred<{ revision: number; state: null }>();
    f.read.mockImplementationOnce(() => read.promise);
    f.start(); await tick(policy.attemptMs);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.observations).toContainEqual(expect.objectContaining({ event: "custody_unknown", reason: "journal_unconfirmed" }));
    await expect(f.scheduler.pause()).rejects.toThrow("custody unconfirmed");
    read.resolve({ revision: 0, state: null }); await tick(60_000);
    expect(f.capture).not.toHaveBeenCalled();
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("checks prior custody before a final pause even before the first heartbeat", async () => {
    const f = fixture();
    const attempt: CompleteCheckpointAttempt = { id: "90000000-0000-4000-8000-000000000009",
      source: structuredClone(f.source()), startedAtMs: Date.now(), deadlineAtMs: Date.now() + policy.attemptMs };
    await f.write(0, { version: 1, source: attempt.source, pending: attempt, lastComplete: null,
      lastStartedAtMs: attempt.startedAtMs, retryAtMs: null });
    await expect(f.scheduler.pause()).rejects.toThrow("custody unconfirmed");
    expect(f.capture).not.toHaveBeenCalled(); expect(f.stored()!.pending).toEqual(attempt);
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("samples source authority again before releasing a final pause with no active capture", async () => {
    const f = fixture(); f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    // A dropped notification is not proof that writer authority is unchanged.
    f.source().writerEpoch = "90000000-0000-4000-8000-000000000009";
    await expect(f.scheduler.pause()).rejects.toThrow("custody unconfirmed");
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("keeps final admission paused until every overlapping final caller releases it", async () => {
    const f = fixture(); f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    await Promise.all([f.scheduler.pause(), f.scheduler.pause()]);
    f.change(); f.scheduler.resume(); await tick(10_000);
    expect(f.capture).toHaveBeenCalledOnce();
    f.scheduler.resume(); await tick(); expect(f.capture).toHaveBeenCalledTimes(2);
    await f.scheduler.close();
  });

  it("does not let an early resume undo a final pause still joining admitted work", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    f.capture.mockImplementationOnce(() => pending.promise);
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const attempt = f.capture.mock.calls[0]![0]; const paused = f.scheduler.pause();
    f.change(); f.scheduler.resume();
    pending.resolve(committed(receipt(attempt))); await paused; await tick(4_000);
    expect(f.capture).toHaveBeenCalledOnce();
    f.scheduler.resume(); await tick(); expect(f.capture).toHaveBeenCalledTimes(2);
    await f.scheduler.close();
  });

  it("never makes a previously observed cut younger after a forward then backward wall-clock jump", async () => {
    const f = fixture(); f.start(); await tick(2_000);
    f.capture.mockResolvedValue({ status: "failed", retirement: "confirmed", reason: "capture_failed" });
    vi.setSystemTime(Date.now() + 60_000); f.change(); await tick(2_000);
    const age = f.observations.at(-1)!.durableAgeMs!;
    expect(age).toBe(62_000);
    vi.setSystemTime(Date.now() - 60_000); await tick(4_000);
    expect(f.observations.at(-1)!.durableAgeMs).toBeGreaterThanOrEqual(age + 4_000);
    await f.scheduler.close();
  });

  it("enforces the separate start-rate floor without throwing away later dirt", async () => {
    const f = fixture({ ...policy, minStartIntervalMs: 5_000 });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    f.change(); await tick(4_999); expect(f.capture).toHaveBeenCalledOnce();
    await tick(1); expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.capture.mock.calls[1]![0].source.changeSequence).toBe(2);
    await f.scheduler.close();
  });

  it("contains an asynchronously rejected operator observation", async () => {
    const f = fixture(); f.observe.mockImplementation(async () => { throw new Error("private observer"); });
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    expect(f.stored()).toMatchObject({ pending: null, lastComplete: { kind: "complete-periodic" } });
    await f.scheduler.close();
  });

  it("leaves the admitted lane owned when its authority is revoked", async () => {
    const f = fixture(), pending = deferred<CompleteCheckpointOutcome>();
    f.capture.mockImplementationOnce(() => pending.promise);
    f.start(); await tick(2_000); expect(f.capture).toHaveBeenCalledOnce();
    const attempt = f.capture.mock.calls[0]![0]; f.replace(null);
    expect(f.capture.mock.calls[0]![2].aborted).toBe(true);
    pending.resolve(committed(receipt(attempt))); await tick();
    expect(f.stored()).toMatchObject({ pending: attempt, lastComplete: null });
    await expect(f.scheduler.close()).rejects.toThrow("custody unconfirmed");
  });

  it("requires explicit bounded policy and never substitutes unmeasured defaults", () => {
    const f = fixture();
    expect(() => new CloudCheckpointScheduler({ ...f.options, complete: {
      ...f.complete, enabled: true, policy: { ...policy, maxDirtyAgeMs: 999 },
    } })).toThrow("complete checkpoint policy");
  });

  it.each([undefined, null, 0, 1, "true"])("refuses malformed complete selection %s without a partial fallback", enabled => {
    const f = fixture();
    expect(() => new CloudCheckpointScheduler({ ...f.options, complete: { enabled } as never }))
      .toThrow("complete checkpoint selection");
    expect(f.legacy).not.toHaveBeenCalled();
  });
});
