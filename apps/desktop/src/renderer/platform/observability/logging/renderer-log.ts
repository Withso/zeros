
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

export function formatLogArgs(args: unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

const queue: RendererLogRecord[] = [];
let dropped = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let installed = false;

// Back off failed IPC because main can log each rejection back into this same capture stream.

const FLUSH_FAIL_THRESHOLD = 3;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

interface FlushCircuit {
  failures: number;
  openUntil: number;
}
const circuit: FlushCircuit = { failures: 0, openUntil: 0 };

export function flushBackoffMs(failures: number): number {
  if (failures < FLUSH_FAIL_THRESHOLD) return 0;
  const steps = failures - FLUSH_FAIL_THRESHOLD;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** steps);
}

export function circuitAllowsAttempt(c: FlushCircuit, now: number): boolean {
  return now >= c.openUntil;
}

export function recordFlushSuccess(c: FlushCircuit): void {
  c.failures = 0;
  c.openUntil = 0;
}

export function recordFlushFailure(c: FlushCircuit, now: number): void {
  c.failures++;
  const backoff = flushBackoffMs(c.failures);
  c.openUntil = backoff > 0 ? now + backoff : 0;
}

/** Suppressing noisy packaged debug records affects disk and feedback logs, not DevTools. */
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
  else scheduleFlush();
}

function scheduleFlush(): void {
  if (flushing || flushTimer !== null || queue.length === 0) return;
  // Only queued work needs a wakeup; pending IPC will schedule its own successor.
  const delay = Math.max(FLUSH_INTERVAL_MS, circuit.openUntil - Date.now());
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  // Check the backoff before marking busy so the next probe can schedule without consuming the batch.
  if (!circuitAllowsAttempt(circuit, Date.now())) {
    scheduleFlush();
    return;
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
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
      // Drop a failed batch without logging the rejection; re-entering capture could loop.
      recordFlushFailure(circuit, Date.now());
    }
  } finally {
    flushing = false;
    scheduleFlush();
  }
}

/** Mirror to the original console to avoid enqueuing the same structured record twice. */
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
    console.info(line);
  }
}

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
        if (shouldPersistLevel(level, import.meta.env.DEV)) {
          enqueue(level, formatLogArgs(args));
        }
      } catch {
        /* capture must never break console */
      }
      orig[level](...args);
    };
  });

  // Use listeners so shared-log capture can coexist with PostHog error tracking.
  window.addEventListener("error", (e) => {
    if (isBenignWindowError(e.message)) return;
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

  window.addEventListener("pagehide", () => void flush());

  enqueue("info", "renderer log capture installed", ["log-store"]);
}

/** ResizeObserver resizes can defer notifications to the next frame; those browser notices are not failures. */
const BENIGN_WINDOW_ERRORS = [
  /^ResizeObserver loop completed with undelivered notifications\.?$/,
  /^ResizeObserver loop limit exceeded$/,
];

export function isBenignWindowError(message: unknown): boolean {
  return (
    typeof message === "string" &&
    BENIGN_WINDOW_ERRORS.some((pattern) => pattern.test(message.trim()))
  );
}

/** Tests restore the patched console separately. */
export function _resetRendererLogForTests(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  queue.length = 0;
  dropped = 0;
  flushing = false;
  installed = false;
  origLog = null;
  recordFlushSuccess(circuit);
}
