/** Static SQLCommenter dimensions only. Never use an owner, lock key, SQL
 * argument, provider name supplied by a caller, or raw URL as a dimension. */
export const ADVISORY_LOCK_PURPOSES = [
  "agent-credential-owner", "auth-email", "auth-identity", "workos-authentication",
  "workos-provider", "workos-user-event", "workos-organization-event", "browser-session-refresh",
  "security-event-publish", "schema-migration", "zeros-dev-auth-rate",
  "dev-connection-outbox", "dev-connection-generation", "dev-connection-bootstrap", "dev-connection-migration",
  "object-storage", "runtime-qualification", "diagnostic-retention", "computer-image-retirement",
  "computer-version", "computer-gc", "workspace-fork", "codex-auth-renewal", "customization",
  "release-canary", "runtime-image-retirement", "device-key-rotation", "replica-command", "replica-receipt",
  "capability-key", "actor-session-capacity", "cloud-v2-computer-build", "cloud-v2-workspace-create", "cloud-v2-retention-save",
  "mcp-configuration", "mcp-authorization-start", "mcp-repository-admission",
] as const;
export type AdvisoryLockPurpose = typeof ADVISORY_LOCK_PURPOSES[number];
const purposes = new Set<string>(ADVISORY_LOCK_PURPOSES);

/** Read only a primitive SQL string or a data property on a QueryConfig.
 * Values and getter-backed configs never participate in observation. */
export function advisoryLockPurpose(value: unknown): AdvisoryLockPurpose | null {
  let sql: unknown = value;
  if (typeof sql !== "string") {
    if (sql === null || typeof sql !== "object") return null;
    try { sql = Object.getOwnPropertyDescriptor(sql, "text")?.value; } catch { return null; }
  }
  if (typeof sql !== "string" || sql.length > 65_536 || !/\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared)?\s*\(/.test(sql)) return null;
  const tags = [...sql.matchAll(/\/\*\s*lock_purpose='([a-z][a-z0-9-]{1,63})'\s*\*\//g)];
  const purpose = tags.length === 1 ? tags[0]![1] : undefined;
  return purpose && purposes.has(purpose) ? purpose as AdvisoryLockPurpose : null;
}

export type DatabaseTimingSpan = Readonly<{
  kind: "pool-wait" | "transaction" | "advisory-lock";
  offsetMs: number; durationMs: number; purpose: AdvisoryLockPurpose | null;
  /** A transaction's existing timing hook does not distinguish commit from rollback. */
  failed: boolean | null;
}>;
export type RequestDatabaseTiming = Readonly<{
  version: 1; scope: "transaction-helpers-and-provider-locks";
  method: string; route: string; status: number | "error";
  spans: readonly DatabaseTimingSpan[]; droppedSpans: number;
}>;

// Disjoint histogram buckets. The final null means >60s, never a finite p99.
export const DATABASE_TIMING_BUCKETS_MS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, null] as const;
type Series = {
  method: string; route: string; kind: DatabaseTimingSpan["kind"]; purpose: AdvisoryLockPurpose | null;
  count: number; failed: number; unknownOutcome: number; sumMs: number; maxMs: number; buckets: number[];
};

/** One bounded, payload-free histogram report per active minute. No DB query
 * or idle polling; raw spans are delivered only to an injected local observer.
 * Quantiles derived from buckets are upper bounds, not exact latency samples. */
export function createDatabaseTimingReporter(options: {
  log?: (line: string) => void; intervalMs?: number; maxSeries?: number;
} = {}) {
  const log = options.log ?? ((line: string) => console.info(line));
  const intervalMs = options.intervalMs ?? 60_000, maxSeries = options.maxSeries ?? 128;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || !Number.isSafeInteger(maxSeries) || maxSeries < 1 || maxSeries > 128)
    throw new RangeError("Invalid database timing bounds");
  const series = new Map<string, Series>();
  let timer: ReturnType<typeof setTimeout> | undefined, started = 0, droppedSpans = 0;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (!series.size && !droppedSpans) return;
    const report = { version: 1, scope: "transaction-helpers-and-provider-locks", windowMs: Math.max(0, performance.now() - started),
      bucketUpperBoundsMs: DATABASE_TIMING_BUCKETS_MS, series: [...series.values()], droppedSpans };
    series.clear(); droppedSpans = 0;
    try { log(`[database] timing ${JSON.stringify(report)}`); } catch { /* Telemetry cannot break a request or timer. */ }
  };
  const observe = (request: RequestDatabaseTiming) => {
    if (!request.spans.length && !request.droppedSpans) return;
    if (!timer) { started = performance.now(); timer = setTimeout(flush, intervalMs); timer.unref(); }
    droppedSpans += request.droppedSpans;
    for (const span of request.spans) {
      const key = JSON.stringify([request.method, request.route, span.kind, span.purpose]);
      let value = series.get(key);
      if (!value) {
        if (series.size >= maxSeries) { droppedSpans++; continue; }
        value = { method: request.method, route: request.route, kind: span.kind, purpose: span.purpose,
          count: 0, failed: 0, unknownOutcome: 0, sumMs: 0, maxMs: 0, buckets: DATABASE_TIMING_BUCKETS_MS.map(() => 0) };
        series.set(key, value);
      }
      value.count++; value.failed += Number(span.failed === true); value.unknownOutcome += Number(span.failed === null);
      value.sumMs += span.durationMs; value.maxMs = Math.max(value.maxMs, span.durationMs);
      const bucket = DATABASE_TIMING_BUCKETS_MS.findIndex(bound => bound === null || span.durationMs <= bound);
      value.buckets[bucket] = value.buckets[bucket]! + 1;
    }
  };
  return { observe, flush };
}
