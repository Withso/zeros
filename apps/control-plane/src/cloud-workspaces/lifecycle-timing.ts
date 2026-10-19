import { AsyncLocalStorage } from "node:async_hooks";

const phases = ["admission", "claim", "providerResolution", "inspect", "funding", "dispatch", "postDispatchObservation", "resultWritePrecommit"] as const;
export type LifecyclePhase = typeof phases[number];
const phaseNames = new Set<string>(phases);
const databasePhases = ["firstClaimWait", "previousLeaseWait"] as const;
type DatabasePhase = typeof databasePhases[number];
const databasePhaseNames = new Set<string>(databasePhases);
const maximumMs = 86_400_000;
type Durations<K extends string> = Partial<Record<K, number>>;
type Timing = {
  closed: boolean;
  monotonicMs: Durations<LifecyclePhase>;
  databaseElapsedMs: Durations<DatabasePhase>;
};
type Span = { started: number; excludedMs: number; children: number; pausedAt: number; closed: boolean };
const active = new AsyncLocalStorage<{ timing: Timing; span?: Span }>();

/** One day's finite milliseconds, rounded to microsecond precision. Missing
 * or invalid samples stay absent; they are never reported as zero work. */
function milliseconds(value: number): number | undefined {
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(maximumMs, value)) * 1000) / 1000 : undefined;
}

export async function withLifecycleTiming<T>(work: () => Promise<T>): Promise<T> {
  const timing: Timing = { closed: false, monotonicMs: {}, databaseElapsedMs: {} };
  try { return await active.run({ timing }, work); }
  finally { timing.closed = true; }
}

/** Exclusive local spans: measured funding and post-dispatch observation are
 * excluded from their surrounding dispatch. Concurrent children pause their
 * parent only once. Outside lifecycle attempts this calls the original work. */
export async function measureLifecyclePhase<T>(phase: LifecyclePhase, work: () => Promise<T>): Promise<T> {
  const scope = active.getStore();
  if (!scope || scope.timing.closed || !phaseNames.has(phase)) return work();
  const started = performance.now(), parent = scope.span;
  if (parent && !parent.closed && parent.children++ === 0) parent.pausedAt = started;
  const span: Span = { started, excludedMs: 0, children: 0, pausedAt: 0, closed: false };
  try { return await active.run({ timing: scope.timing, span }, work); }
  finally {
    const ended = performance.now();
    if (span.children > 0) span.excludedMs += Math.max(0, ended - span.pausedAt);
    span.closed = true;
    const elapsed = milliseconds(ended - started - span.excludedMs);
    if (!scope.timing.closed && elapsed !== undefined) {
      const total = milliseconds((scope.timing.monotonicMs[phase] ?? 0) + elapsed);
      if (total !== undefined) scope.timing.monotonicMs[phase] = total;
    }
    if (parent && !parent.closed && --parent.children === 0) parent.excludedMs += Math.max(0, ended - parent.pausedAt);
  }
}

/** These intervals are computed by PostgreSQL from existing persisted times.
 * They never participate in local monotonic spans or scheduling decisions. */
export function recordLifecycleDatabaseElapsed(phase: DatabasePhase, value: number | string | null): void {
  const timing = active.getStore()?.timing;
  if (!timing || timing.closed || !databasePhaseNames.has(phase) || value === null) return;
  const elapsed = milliseconds(Number(value));
  if (elapsed !== undefined) timing.databaseElapsedMs[phase] = elapsed;
}

function snapshot(timing: Pick<Timing, "monotonicMs" | "databaseElapsedMs">) {
  return Object.freeze({ version: 1 as const, monotonicMs: Object.freeze({ ...timing.monotonicMs }),
    databaseElapsedMs: Object.freeze({ ...timing.databaseElapsedMs }) });
}

/** Called immediately before the existing audit INSERT. resultWritePrecommit
 * excludes that audit INSERT and COMMIT; the completed transaction uses the
 * database timing hook instead. No cross-clock subtraction is performed. */
export function readLifecycleTiming(resultStarted?: number) {
  const timing = active.getStore()?.timing;
  if (!timing || timing.closed) return undefined;
  const monotonicMs = { ...timing.monotonicMs };
  if (resultStarted !== undefined) {
    const elapsed = milliseconds(performance.now() - resultStarted);
    if (elapsed !== undefined) monotonicMs.resultWritePrecommit = elapsed;
  }
  return snapshot({ monotonicMs, databaseElapsedMs: timing.databaseElapsedMs });
}

/** Admission has its own request lifetime, before the worker's attempt. */
export function lifecycleAdmissionTiming(started: number) {
  const elapsed = milliseconds(performance.now() - started);
  return snapshot({ monotonicMs: elapsed === undefined ? {} : { admission: elapsed }, databaseElapsedMs: {} });
}
