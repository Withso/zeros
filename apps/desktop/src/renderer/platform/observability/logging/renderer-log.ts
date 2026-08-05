// ──────────────────────────────────────────────────────────
// Renderer log capture → main-process app.jsonl store
// ──────────────────────────────────────────────────────────
//
// Every renderer console line (plus window errors and
// unhandled rejections) becomes a structured record {level, text, tags,
// clientTimestamp} and is batched over the `log_submit` IPC command into the
// same JSONL stream as main-process + engine output (apps/desktop/electron/log-store.ts,
// origin "frontend"). That stream is what the feedback form shares and what
// its View button opens. Packaged builds persist every level EXCEPT `debug`
// (see shouldPersistLevel) — dev captures all five.
//
// Design constraints:
//   • Never louder than the app: the original console methods still run, so
//     DevTools behavior is unchanged.
//   • Never a feedback loop: flush failures are swallowed silently (an error
//     toast or console.error here would re-enter the capture).
//   • Bounded: queue caps at MAX_QUEUE (oldest dropped, drop count noted in a
//     synthetic record) and each arg's serialization is size-capped.
// ──────────────────────────────────────────────────────────

import { isElectron, nativeInvoke } from "@/renderer/platform/runtime";

export type RendererLogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface RendererLogRecord {
  level: RendererLogLevel;
  text: string;
  tags?: string[];
  clientTimestamp: string;
}

const MAX_ARG_CHARS = 5_000;
const MAX_QUEUE = 2_000;
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_AT = 100;

/** Serialize one console argument into the record's flat `text`
 *  field: strings verbatim, Errors as name+message+stack, everything
 *  else as JSON (cycle-safe), all size-capped. Pure — exported for tests. */
export function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return cap(arg);
  if (arg instanceof Error) {
    return cap(arg.stack || `${arg.name}: ${arg.message}`);
  }
  if (arg === undefined) return "undefined";
  if (typeof arg === "function") return `[function ${arg.name || "anonymous"}]`;
  try {
    const seen = new WeakSet<object>();
    return cap(
      JSON.stringify(arg, (_k, v: unknown) => {
        if (typeof v === "bigint") return `${v}n`;
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }) ?? String(arg),
    );
  } catch {
    return cap(String(arg));
  }
}

function cap(s: string): string {
  return s.length > MAX_ARG_CHARS
    ? `${s.slice(0, MAX_ARG_CHARS)}…[truncated]`
    : s;
}

/** Render a console call's args into one text line. Pure — exported for tests. */
export function formatLogArgs(args: unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

const queue: RendererLogRecord[] = [];
let dropped = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let installed = false;

// ── Flush circuit breaker ───────────────────────────────
//
// A persistently unavailable/rejecting main must NOT be hammered once per
// FLUSH_INTERVAL_MS. Three real cases produce a run of `log_submit` rejections:
//   • a stale dev main that predates the command (worktree instances don't
//     hot-restart main — you'd see 100+ "unknown command log_submit" errors,
//     which is exactly what motivated this),
//   • a prod main briefly gone during an auto-update swap,
//   • a broken IPC bridge.
// Each rejection is itself logged by main and captured back into this stream,
// so naive per-second retries COMPOUND the noise. After a short run of failures
// we open the circuit and back off exponentially, probing occasionally until a
// flush succeeds — then we snap back to normal. Kept as pure helpers so the
// state machine is unit-tested without the Electron-only console patch / timer.

const FLUSH_FAIL_THRESHOLD = 3; // consecutive failures before backing off
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

interface FlushCircuit {
  /** Consecutive failed flushes; reset to 0 on any success. */
  failures: number;
  /** Epoch ms before which no flush is attempted (0 = closed). */
  openUntil: number;
}
const circuit: FlushCircuit = { failures: 0, openUntil: 0 };

/** Back-off for the Nth consecutive failure: 0 below the threshold (keep trying
 *  at the normal cadence), then 2s, 4s, 8s … capped at 60s. Pure — exported for
 *  tests. */
export function flushBackoffMs(failures: number): number {
  if (failures < FLUSH_FAIL_THRESHOLD) return 0;
  const steps = failures - FLUSH_FAIL_THRESHOLD; // 0, 1, 2, …
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** steps);
}

/** May we attempt a flush right now? False while the circuit is open (backing
 *  off). Pure — exported for tests. */
export function circuitAllowsAttempt(c: FlushCircuit, now: number): boolean {
  return now >= c.openUntil;
}

/** A flush landed — snap the circuit shut. Pure — exported for tests. */
export function recordFlushSuccess(c: FlushCircuit): void {
  c.failures = 0;
  c.openUntil = 0;
}

/** A flush was rejected — grow the failure run and (past the threshold) open
 *  the circuit for the next back-off window. Pure — exported for tests. */
export function recordFlushFailure(c: FlushCircuit, now: number): void {
  c.failures++;
  const backoff = flushBackoffMs(c.failures);
  c.openUntil = backoff > 0 ? now + backoff : 0;
}

/** Should a console call at `level` be PERSISTED into app.jsonl? Packaged
 *  builds drop `debug`: console.debug is chatty-by-design tracing that used to
 *  land on every user's disk (and pad the ~500 KB feedback export) despite
 *  DevTools hiding it by default. Dev keeps all five levels — there the log
 *  stream IS the debugging surface. The gate only affects persistence; the
 *  real console methods run for every level either way. Pure — exported for
 *  tests. */
export function shouldPersistLevel(
  level: RendererLogLevel,
  dev: boolean,
): boolean {
  return dev || level !== "debug";
}

function enqueue(level: RendererLogLevel, text: string, tags?: string[]): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    dropped++;
  }
  queue.push({
    level,
    text,
    ...(tags && tags.length ? { tags } : {}),
    clientTimestamp: new Date().toISOString(),
  });
  if (queue.length >= FLUSH_AT) void flush();
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  // Backing off after a run of failures — don't splice, don't drop, don't
  // touch IPC. The queue keeps filling (bounded by MAX_QUEUE) until a probe
  // is due. Checked BEFORE `flushing` so we never early-return while "busy".
  if (!circuitAllowsAttempt(circuit, Date.now())) return;
  flushing = true;
  try {
    if (dropped > 0) {
      queue.push({
        level: "warn",
        text: `renderer log queue overflow — ${dropped} records dropped`,
        tags: ["log-store"],
        clientTimestamp: new Date().toISOString(),
      });
      dropped = 0;
    }
    const batch = queue.splice(0, 500);
    try {
      await nativeInvoke("log_submit", { records: batch });
      recordFlushSuccess(circuit);
    } catch {
      // Drop this batch (best-effort — retrying or logging the failure here
      // could loop; the IPC bridge itself may be what's broken) and register
      // the failure so a persistent outage trips the circuit instead of
      // re-hammering main every tick.
      recordFlushFailure(circuit, Date.now());
    }
  } finally {
    flushing = false;
  }
}

/** Explicit structured logging for instrumented sites (agent lifecycle,
 *  session sync, …). Mirrors to DevTools via the ORIGINAL console.log (the
 *  patched one would double-enqueue). */
let origLog: ((...args: unknown[]) => void) | null = null;
export function logEvent(
  text: string,
  data?: Record<string, unknown>,
  tags?: string[],
): void {
  const line = data ? `${text} ${formatLogArg(data)}` : text;
  if (installed) {
    enqueue("info", line, tags);
    origLog?.(line);
  } else {
    // Browser-dev (non-Electron) — plain console so nothing is lost.
    console.info(line);
  }
}

/** Patch console.* + window error events and start the batch flusher.
 *  Electron-only; idempotent. Call as early as possible (main.tsx). */
export function initRendererLogCapture(): void {
  if (installed || !isElectron()) return;
  installed = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  origLog = orig.log;

  (["log", "info", "warn", "error", "debug"] as const).forEach((level) => {
    console[level] = (...args: unknown[]) => {
      try {
        // Packaged builds skip persisting `debug` (see shouldPersistLevel).
        // import.meta.env.DEV is the renderer's existing dev-vs-packaged
        // signal (Vite statically inlines it; cf. apps/desktop/src/renderer/config/release-channel.ts).
        if (shouldPersistLevel(level, import.meta.env.DEV)) {
          enqueue(level, formatLogArgs(args));
        }
      } catch {
        /* capture must never break console */
      }
      orig[level](...args);
    };
  });

  // Uncaught window errors / rejections — PostHog's boot.tsx captures these
  // for error tracking; this capture puts the same signal into the shareable
  // log stream (addEventListener, so both consumers coexist).
  window.addEventListener("error", (e) => {
    enqueue(
      "error",
      `window.onerror: ${e.message} (${e.filename ?? "?"}:${e.lineno ?? "?"})`,
      ["window-error"],
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    enqueue("error", `unhandledrejection: ${formatLogArg(e.reason)}`, [
      "window-error",
    ]);
  });

  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // Last-gasp flush — fire-and-forget; whatever lands, lands.
  window.addEventListener("pagehide", () => void flush());

  enqueue("info", "renderer log capture installed", ["log-store"]);
}

/** Test-only: restore pristine state. Does NOT unpatch console (tests stub
 *  console themselves); clears queue/timer/flags. */
export function _resetRendererLogForTests(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  queue.length = 0;
  dropped = 0;
  flushing = false;
  installed = false;
  origLog = null;
  recordFlushSuccess(circuit);
}
