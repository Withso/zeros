import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";

const sequence = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(),
  writerEpoch: z.string().uuid(), scopeRevision: z.number().int().positive().safe(),
  scopeSha256: digest, changeSequence: sequence, reconcileSequence: sequence,
}).strict();
export type CompleteCheckpointSource = z.infer<typeof sourceSchema>;

const attemptSchema = z.object({
  id: z.string().uuid(), source: sourceSchema, startedAtMs: sequence, deadlineAtMs: sequence,
}).strict().refine(value => value.deadlineAtMs > value.startedAtMs);
export type CompleteCheckpointAttempt = z.infer<typeof attemptSchema>;

const receiptSchema = z.object({
  version: z.literal(1), kind: z.literal("complete-periodic"), attemptId: z.string().uuid(),
  source: sourceSchema, manifestSha256: digest, inventorySha256: digest, nativeExportSha256: digest,
  cutAtMs: sequence, ackAtMs: sequence,
}).strict().refine(value => value.cutAtMs <= value.ackAtMs);
export type CompleteCheckpointReceipt = z.infer<typeof receiptSchema>;

const failureSchema = z.enum([
  "capture_failed", "coverage_unknown", "admission_deferred", "clock_invalid", "deadline",
]);
type CaptureFailure = z.infer<typeof failureSchema>;
export type CompleteCheckpointOutcome =
  | { status: "committed"; retirement: "confirmed"; receipt: CompleteCheckpointReceipt }
  | { status: "failed"; retirement: "confirmed"; reason: CaptureFailure };
// Retirement is a separate proof. A malformed receipt in an otherwise exact
// retired envelope is a failed save; an unrecognized envelope retains custody.
const outcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("committed"), retirement: z.literal("confirmed"), receipt: z.unknown() }).strict(),
  z.object({ status: z.literal("failed"), retirement: z.literal("confirmed"), reason: failureSchema }).strict(),
]);

const journalStateSchema = z.object({
  version: z.literal(1), source: sourceSchema, pending: attemptSchema.nullable(),
  lastComplete: receiptSchema.nullable(), lastStartedAtMs: sequence.nullable(), retryAtMs: sequence.nullable(),
}).strict();
export type CompleteCheckpointJournalState = z.infer<typeof journalStateSchema>;
const journalReadSchema = z.object({ revision: sequence, state: journalStateSchema.nullable() }).strict();

// These are timer representability bounds, not measured production budgets.
// Every policy value is mandatory; enrollment must supply qualified numbers.
const duration = z.number().int().positive().max(2_147_483_647);
const policySchema = z.object({
  debounceMs: duration, maxDirtyAgeMs: duration, minStartIntervalMs: duration,
  retryDelayMs: duration, attemptMs: duration, alertAfterMs: duration,
}).strict().refine(value => value.maxDirtyAgeMs >= value.debounceMs
  && value.maxDirtyAgeMs >= value.minStartIntervalMs);
type CompleteCheckpointPolicy = z.infer<typeof policySchema>;
type EvidenceReason = CaptureFailure | "receipt_invalid" | "journal_unconfirmed" | "capture_unconfirmed" | "source_changed";
export type CompleteCheckpointEvidence = {
  event: "complete" | "deferred" | "stale" | "custody_unknown";
  reason: EvidenceReason | null;
  cutAtMs: number | null; ackAtMs: number | null;
  durableAgeMs: number | null; dirtyAgeMs: number | null;
};

/** Local ports, not a public wire protocol or an enrollment capability.
 * The producer must prove a complete all-writer immutable cut and native export.
 * journal.write(true) means an atomic durable CAS, including directory durability
 * for a file adapter. There is deliberately no default producer/journal adapter.
 * Unknown custody requires external exact-attempt reconciliation before a new
 * coordinator can be used. This component cannot retire that custody itself. */
export type CompleteCheckpointOptions = {
  enabled: true;
  policy: CompleteCheckpointPolicy;
  /** Monotonic counters cover all writers; overflow/unknown coverage advances
   * reconcileSequence. Notifications accelerate work, never prove cleanliness. */
  source: () => CompleteCheckpointSource | null;
  subscribe: (changed: () => void) => () => void;
  monotonicNow: () => number;
  capture: (attempt: CompleteCheckpointAttempt, authority: CloudDurabilityAuthority, signal: AbortSignal) => Promise<CompleteCheckpointOutcome>;
  journal: {
    /** Read-only, bounded and abortable. An aborted read cannot clear custody. */
    read: (signal: AbortSignal) => Promise<{ revision: number; state: CompleteCheckpointJournalState | null }>;
    write: (expectedRevision: number, state: CompleteCheckpointJournalState) => Promise<boolean>;
  };
  /** Bound to the exact workspace by the adapter. Never forward raw failures. */
  observe: (evidence: CompleteCheckpointEvidence) => void;
};

type Dirty = { first: number; last: number; known: boolean };
type Clock = { wall: number; mono: number };
type Running = { attempt: CompleteCheckpointAttempt; start: Clock; controller: AbortController; after: Dirty | null };
const scopeKey = (source: CompleteCheckpointSource) => JSON.stringify([
  source.organizationId, source.workspaceId, source.generation, source.engineInstanceId,
  source.writerEpoch, source.scopeRevision, source.scopeSha256,
]);
const sameSource = (a: CompleteCheckpointSource, b: CompleteCheckpointSource) => scopeKey(a) === scopeKey(b)
  && a.changeSequence === b.changeSequence && a.reconcileSequence === b.reconcileSequence;
const matchesAuthority = (source: CompleteCheckpointSource, authority: CloudDurabilityAuthority) =>
  source.organizationId === authority.organizationId && source.workspaceId === authority.workspaceId
  && source.generation === authority.generation && source.engineInstanceId === authority.engineInstanceId;

/** One instance per exact writer/scope. It never changes owner in place. */
export class CloudCompleteCheckpointCoordinator {
  private readonly policy: CompleteCheckpointPolicy;
  private authority: CloudDurabilityAuthority | null = null;
  private source: CompleteCheckpointSource | null = null;
  private state: CompleteCheckpointJournalState | null = null;
  private revision = 0;
  private initialized = false;
  private loaded = false;
  private blocked = false;
  private paused = false;
  private pauseHolds = 0;
  private pauseWaiters = 0;
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  private cancelRead: (() => void) | null = null;
  private active: Promise<void> | null = null;
  private running: Running | null = null;
  private dirty: Dirty | null = null;
  private dueTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private alertTimer: ReturnType<typeof setTimeout> | null = null;
  private rateAt = 0;
  private retryAt = 0;
  private staleReported = false;
  private ageFloor: { attemptId: string; age: number; mono: number } | null = null;
  private lastMono = 0;

  constructor(private readonly options: CompleteCheckpointOptions, private readonly boundary: {
    now: () => number; eligible: () => boolean;
  }) {
    const policy = policySchema.safeParse(options.policy);
    if (!policy.success) throw new Error("complete checkpoint policy is invalid");
    this.policy = policy.data;
  }

  consider(authority: CloudDurabilityAuthority): void {
    if (this.closed || this.blocked) return;
    const source = this.readSource();
    if (!source || !matchesAuthority(source, authority)) { this.block("source_changed"); return; }
    this.authority = { ...authority };
    if (!this.initialized) this.initialize(source);
    else this.changed();
  }

  private initialize(source: CompleteCheckpointSource | null): void {
    this.initialized = true;
    const clock = this.clock();
    if (!clock) return;
    if (!source) { this.block("source_changed"); return; }
    this.source = source;
    // Restart/silent hints cannot reuse an old clean assertion. The first
    // complete inventory must reconcile it; its prior dirty age is unknown.
    this.dirty = { first: clock.mono, last: clock.mono, known: false };
    try {
      this.unsubscribe = this.options.subscribe(() => this.changed());
      if (typeof this.unsubscribe !== "function") { this.block("source_changed"); return; }
    } catch { this.block("source_changed"); return; }
    if (!this.blocked) this.run(() => this.load());
  }

  async pause(): Promise<void> {
    this.paused = true;
    this.pauseHolds++;
    this.pauseWaiters++;
    this.clearDue();
    try {
      // Final admission can arrive before the first healthy heartbeat. It still
      // has to inspect prior durable custody, without starting a periodic capture.
      if (!this.initialized && !this.blocked) this.initialize(this.readSource());
      this.changed();
      await this.active;
      this.changed();
      if (this.blocked) throw new Error("complete checkpoint custody unconfirmed");
    } finally { this.pauseWaiters--; }
  }

  resume(): void {
    if (this.closed || this.blocked) return;
    // Each final caller pairs its settled pause with one resume. An early
    // resume cannot consume a hold still waiting for background retirement.
    if (this.pauseHolds > this.pauseWaiters) this.pauseHolds--;
    this.paused = this.pauseHolds > 0;
    this.changed();
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.pause(); }
    finally {
      this.clearTimers();
      try { this.unsubscribe?.(); } catch { /* no retirement authority */ }
      this.unsubscribe = null;
      this.authority = null;
    }
  }

  private readSource(): CompleteCheckpointSource | null {
    try {
      const parsed = sourceSchema.safeParse(this.options.source());
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  private clock(): Clock | null {
    let wall: number, mono: number;
    try { wall = this.boundary.now(); mono = this.options.monotonicNow(); }
    catch { this.block("clock_invalid"); return null; }
    if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(mono)
      || mono < this.lastMono || mono > Number.MAX_SAFE_INTEGER) {
      this.block("clock_invalid"); return null;
    }
    this.lastMono = mono;
    return { wall, mono };
  }

  private changed(): void {
    if (!this.initialized || this.blocked) return;
    const next = this.readSource(), previous = this.source;
    if (!next || !previous || scopeKey(next) !== scopeKey(previous)
      || next.changeSequence < previous.changeSequence || next.reconcileSequence < previous.reconcileSequence) {
      this.block("source_changed"); return;
    }
    const clock = this.clock();
    if (!clock) return;
    if (!sameSource(next, previous)) {
      const known = next.reconcileSequence === previous.reconcileSequence;
      this.dirty = this.addDirty(this.dirty, clock.mono, known);
      if (this.running) this.running.after = this.addDirty(this.running.after, clock.mono, known);
      this.source = next;
    }
    this.schedule();
  }

  private addDirty(dirty: Dirty | null, mono: number, known: boolean): Dirty {
    return { first: dirty?.first ?? mono, last: mono, known: (dirty?.known ?? true) && known };
  }

  private run(work: () => Promise<void>): void {
    // Include journal read/write and retirement I/O in the exclusive lane.
    const task = Promise.resolve().then(work).catch(() => this.block("journal_unconfirmed")).finally(() => {
      if (this.active === task) this.active = null;
      this.schedule();
    });
    this.active = task;
  }

  private async load(): Promise<void> {
    const start = this.clock();
    if (!start) return;
    const abandoned = Symbol("journal read abandoned"), controller = new AbortController();
    const cancelled = new Promise<typeof abandoned>(resolve => {
      this.cancelRead = () => { controller.abort(); resolve(abandoned); };
    });
    this.deadlineTimer = setTimeout(() => this.block("journal_unconfirmed"), this.policy.attemptMs);
    this.deadlineTimer.unref?.();
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => this.options.journal.read(controller.signal)), cancelled,
      ]);
      if (this.blocked || raw === abandoned) return;
      const clock = this.clock();
      if (!clock) return;
      if (clock.mono - start.mono >= this.policy.attemptMs || clock.wall - start.wall >= this.policy.attemptMs) {
        this.block("journal_unconfirmed"); return;
      }
      this.loadState(raw);
    } finally {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
      this.cancelRead = null;
    }
  }

  private loadState(raw: unknown): void {
    const loaded = journalReadSchema.safeParse(raw);
    const source = this.source;
    if (!loaded.success || !source) { this.block("journal_unconfirmed"); return; }
    const { state, revision } = loaded.data;
    if (state && (scopeKey(state.source) !== scopeKey(source)
      || state.source.changeSequence > source.changeSequence || state.source.reconcileSequence > source.reconcileSequence
      || (state.pending && !sameSource(state.pending.source, state.source))
      || (state.lastComplete && (scopeKey(state.lastComplete.source) !== scopeKey(source)
        || state.lastComplete.source.changeSequence > source.changeSequence
        || state.lastComplete.source.reconcileSequence > source.reconcileSequence)))) {
      this.block("journal_unconfirmed"); return;
    }
    this.revision = revision;
    this.state = state ?? { version: 1, source, pending: null, lastComplete: null, lastStartedAtMs: null, retryAtMs: null };
    this.loaded = true;
    if (this.blocked) return;
    if (this.state.pending) { this.block("capture_unconfirmed"); return; }
    this.changed();
    const clock = this.clock();
    if (!clock || this.blocked) return;
    // Persisted wall due times are not renewed on restart. A rollback cannot
    // make a future retry fire early or make an acknowledged cut look newer.
    this.retryAt = clock.mono + Math.max(0, (this.state.retryAtMs ?? 0) - clock.wall);
    this.rateAt = clock.mono + Math.max(0, (this.state.lastStartedAtMs === null ? 0
      : this.state.lastStartedAtMs + this.policy.minStartIntervalMs) - clock.wall);
    if (this.state.lastComplete) this.ageFloor = {
      attemptId: this.state.lastComplete.attemptId,
      age: Math.max(clock.wall, this.state.lastComplete.ackAtMs) - this.state.lastComplete.cutAtMs,
      mono: clock.mono,
    };
  }

  private schedule(): void {
    this.clearDue();
    if (this.closed || this.blocked || !this.loaded || !this.dirty) return;
    const clock = this.clock();
    if (!clock) return;
    this.scheduleAlert(clock);
    if (this.active || this.paused || !this.authority || !this.eligible()) return;
    const due = this.due();
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      if (this.closed || this.paused || this.blocked || this.active || !this.eligible()) return;
      this.run(() => this.capture());
    }, Math.max(0, Math.min(2_147_483_647, Math.ceil(due - clock.mono))));
    this.dueTimer.unref?.();
  }

  private due(): number {
    if (!this.dirty) return Infinity;
    return Math.max(this.rateAt, this.retryAt, Math.min(
      this.dirty.last + this.policy.debounceMs, this.dirty.first + this.policy.maxDirtyAgeMs,
    ));
  }

  private eligible(): boolean {
    try { return this.boundary.eligible() === true; }
    catch { this.block("source_changed"); return false; }
  }

  private async capture(): Promise<void> {
    this.changed();
    const clock = this.clock(), source = this.source, authority = this.authority;
    if (!clock || !source || !authority || !this.state || this.blocked || this.closed || this.paused
      || !this.eligible() || !matchesAuthority(source, authority) || clock.mono < this.due()) return;
    const attempt = attemptSchema.safeParse({ id: randomUUID(), source,
      startedAtMs: clock.wall, deadlineAtMs: clock.wall + this.policy.attemptMs });
    if (!attempt.success) { this.block("clock_invalid"); return; }
    const running: Running = { attempt: attempt.data, start: clock, controller: new AbortController(), after: null };
    this.running = running;
    this.rateAt = clock.mono + this.policy.minStartIntervalMs;
    this.deadlineTimer = setTimeout(() => running.controller.abort(), this.policy.attemptMs);
    this.deadlineTimer.unref?.();
    try {
      if (!await this.write({ ...this.state, source, pending: running.attempt, lastStartedAtMs: clock.wall })) return;
      this.changed();
      if (this.blocked) return;
      if (this.expired(running)) { await this.retired(running, "deadline"); return; }
      if (this.closed || this.paused || !this.eligible()) {
        await this.retired(running, "admission_deferred"); return;
      }
      let raw: unknown;
      try {
        // Copies prevent a driver from mutating our exact attempt or authority.
        raw = await this.options.capture(structuredClone(running.attempt), { ...authority }, running.controller.signal);
      } catch { this.block("capture_unconfirmed"); return; }
      this.changed();
      if (this.blocked) return;
      const outcome = outcomeSchema.safeParse(raw);
      if (!outcome.success) { this.block("capture_unconfirmed"); return; }
      if (this.expired(running)) { await this.retired(running, "deadline"); return; }
      if (outcome.data.status === "failed") { await this.retired(running, outcome.data.reason); return; }
      const receipt = receiptSchema.safeParse(outcome.data.receipt);
      const accepted = this.clock();
      if (!accepted) return;
      if (!receipt.success || receipt.data.attemptId !== running.attempt.id
        || !sameSource(receipt.data.source, running.attempt.source)
        || receipt.data.cutAtMs < running.attempt.startedAtMs || receipt.data.ackAtMs > accepted.wall
        || (this.state.lastComplete && receipt.data.cutAtMs < this.state.lastComplete.cutAtMs)) {
        await this.retired(running, "receipt_invalid"); return;
      }
      const previous = this.state.lastComplete;
      if (!await this.write({ ...this.state, pending: null, lastComplete: receipt.data, retryAtMs: null })) return;
      this.changed();
      if (this.blocked) return;
      this.ageFloor = { attemptId: receipt.data.attemptId, age: accepted.wall - receipt.data.cutAtMs, mono: accepted.mono };
      // Do not clear later edits or announce success after terminal journal I/O
      // outlives the original attempt. A valid late record remains recoverable.
      if (this.expired(running)) {
        await this.retired(running, "deadline"); return;
      }
      this.dirty = running.after;
      this.retryAt = 0;
      if (!previous || receipt.data.cutAtMs > previous.cutAtMs) this.staleReported = false;
      if (!this.dirty && this.alertTimer) { clearTimeout(this.alertTimer); this.alertTimer = null; }
      this.emit("complete", null);
    } finally {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
      this.running = null;
    }
  }

  private expired(running: Running): boolean {
    const clock = this.clock();
    const expired = !clock || running.controller.signal.aborted
      || clock.mono - running.start.mono >= this.policy.attemptMs || clock.wall >= running.attempt.deadlineAtMs;
    if (expired) running.controller.abort();
    return expired;
  }

  private async retired(running: Running, reason: EvidenceReason): Promise<void> {
    const clock = this.clock();
    if (!clock || this.blocked || !this.state) return;
    this.retryAt = clock.mono + this.policy.retryDelayMs;
    if (await this.write({ ...this.state, pending: null, retryAtMs: clock.wall + this.policy.retryDelayMs })) {
      this.changed();
      if (!this.blocked) this.emit("deferred", reason);
    }
    // The original signal is never reused for a successor attempt.
    running.controller.abort();
  }

  private async write(state: CompleteCheckpointJournalState): Promise<boolean> {
    const parsed = journalStateSchema.safeParse(state);
    if (!parsed.success || this.revision === Number.MAX_SAFE_INTEGER) { this.block("journal_unconfirmed"); return false; }
    try {
      if (await this.options.journal.write(this.revision, structuredClone(parsed.data)) !== true) {
        this.block("journal_unconfirmed"); return false;
      }
    } catch { this.block("journal_unconfirmed"); return false; }
    this.state = parsed.data;
    this.revision++;
    return true;
  }

  private scheduleAlert(clock: Clock): void {
    if (this.alertTimer || this.staleReported || !this.dirty) return;
    const remaining = this.dirty.first + this.policy.alertAfterMs - clock.mono;
    if (remaining <= 0) { this.staleReported = true; this.emit("stale", null); return; }
    this.alertTimer = setTimeout(() => {
      this.alertTimer = null;
      const next = this.clock();
      if (next && !this.closed && !this.blocked) this.scheduleAlert(next);
    }, Math.ceil(remaining));
    this.alertTimer.unref?.();
  }

  private emit(event: CompleteCheckpointEvidence["event"], reason: EvidenceReason | null): void {
    // Diagnostics are best effort. Neither payloads nor exceptions carry user
    // bytes, paths, credentials or an authority to stop/retire the workspace.
    const receipt = this.state?.lastComplete;
    const mono = this.lastMono;
    let wall: number | null = null;
    try { wall = this.boundary.now(); } catch { /* unknown wall age */ }
    const age = receipt ? Math.max(0, wall !== null && Number.isSafeInteger(wall) ? wall - receipt.cutAtMs : 0,
      this.ageFloor?.attemptId === receipt.attemptId ? this.ageFloor.age + mono - this.ageFloor.mono : receipt.ackAtMs - receipt.cutAtMs) : null;
    if (receipt && age !== null) this.ageFloor = { attemptId: receipt.attemptId, age, mono };
    try { void Promise.resolve(this.options.observe({ event, reason, cutAtMs: receipt?.cutAtMs ?? null, ackAtMs: receipt?.ackAtMs ?? null,
      durableAgeMs: age === null ? null : Math.floor(age),
      dirtyAgeMs: this.dirty?.known ? Math.floor(mono - this.dirty.first) : null })).catch(() => {}); }
    catch { /* reporting cannot release custody or change a retry */ }
  }

  private block(reason: EvidenceReason): void {
    if (this.blocked) return;
    this.blocked = true;
    this.cancelRead?.();
    this.running?.controller.abort();
    this.clearTimers();
    this.emit("custody_unknown", reason);
  }

  private clearDue(): void {
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
  }

  private clearTimers(): void {
    this.clearDue();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.alertTimer) clearTimeout(this.alertTimer);
    this.deadlineTimer = this.alertTimer = null;
  }
}
