// ──────────────────────────────────────────────────────────
// Structured app log store (JSONL)
// ──────────────────────────────────────────────────────────
//
// main.log stays the human-tailable plain-text mirror; THIS store is the
// machine-readable one: every console line from the main process, the engine
// sidecar (whose stdout/stderr already flow through main's console), and the
// renderer (forwarded over the `log_submit` IPC command) lands here as one
// JSON record per line in <logDir>/app.jsonl.
//
// The record shape is chosen so the everyday debugging habits keep working —
// grep by tag / session id / origin, or paste a slice straight into an agent:
//
//   {"id":42,"origin":"frontend","level":"info","text":"…","tags":["…"],
//    "clientTimestamp":"…","submittedAt":"…"}
//
//   origin          — which process produced it: "main" | "frontend" | "engine"
//   clientTimestamp — when the producing process logged it
//   submittedAt     — when this store wrote it (≠ clientTimestamp for
//                     renderer batches, which arrive in coalesced bursts —
//                     two stamps let you tell "logged late" from "sent late")
//   id              — monotonic per-run sequence (restarts at each launch)
//
// Retention (the "how long are logs available" decision): the live file
// rotates at 8 MB into app.jsonl.1 and ONE prior generation is kept — up to
// ~16 MB of history, which in practice is hours-to-days of use and survives
// app restarts (a run log parked in $TMPDIR would lose its history to temp
// cleanup; disk under Logs/ is the more durable choice). Consecutive
// identical lines are additionally coalesced into a single summary record (see
// "Repeat coalescing" below) so a failure storm can't burn through both
// generations and evict the useful history. The feedback export ("View" /
// "Include recent app logs") reads the most recent ~1 MB and then, after
// scrubbing, shares the last ~500k chars (see MAX_EXPORT_CHARS in
// electron/ipc/commands/logs.ts) — enough context to diagnose a session
// without turning every report into a multi-megabyte upload.
//
// This module deliberately has NO electron imports (dir is injected by
// main.ts) so it stays unit-testable under plain vitest.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogOrigin = "main" | "frontend" | "engine";
export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface LogRecordInput {
  origin: LogOrigin;
  level: LogLevel;
  /** Rendered message — already stringified/joined by the producer. */
  text: string;
  /** Optional structured payload — the raw console args, kept beside the
   *  rendered `text` so a reader can recover the original objects. */
  args?: unknown[];
  /** Optional routing tags, e.g. "session:<id>", "msg-lifecycle". */
  tags?: string[];
  /** Producer-side timestamp; defaults to write time. */
  clientTimestamp?: string;
}

export interface LogRecord extends LogRecordInput {
  id: number;
  clientTimestamp: string;
  submittedAt: string;
}

/** Rotate past this size; one prior generation kept → ~2× on disk. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Cap a single record's text so one runaway line can't dominate the file. */
const MAX_TEXT_CHARS = 10_000;
/** Raw read-tail size pulled before scrubbing + the export cap are applied.
 *  Kept comfortably above MAX_EXPORT_CHARS (electron/ipc/commands/logs.ts) so
 *  scrubbing has headroom and the shared export reliably reaches its ~500 KB
 *  ceiling. */
export const RECENT_LOG_BYTES = 1024 * 1024;

const FILE_NAME = "app.jsonl";

let logDir: string | null = null;
// A raw fd + writeSync (not a WriteStream): every record is durably on disk
// the moment appendLogRecord returns — load-bearing for CRASH diagnostics,
// where a buffered stream would lose exactly the lines that matter. The
// volume (console lines + 1 renderer batch/sec) makes the sync write cost
// negligible.
let fd: number | null = null;
let bytesInFile = 0;
let nextId = 1;

function filePath(): string {
  return path.join(logDir!, FILE_NAME);
}

function openFile(): void {
  try {
    bytesInFile = fs.statSync(filePath()).size;
  } catch {
    bytesInFile = 0;
  }
  fd = fs.openSync(filePath(), "a");
}

function rotateIfNeeded(): void {
  if (bytesInFile <= MAX_FILE_BYTES) return;
  try {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
    fs.renameSync(filePath(), `${filePath()}.1`); // overwrites any prior .1
  } catch {
    /* rename raced — reopen below regardless */
  }
  openFile();
}

// ── Repeat coalescing ─────────────────────────────────────
//
// During failure storms (engine respawn loops, IPC-rejection loops) the SAME
// line is emitted thousands of times back-to-back; writing every copy is what
// let a single storm chew through megabytes of log and evict the history that
// would have explained it. So consecutive records with identical
// origin+level+text collapse: the first occurrence is written normally,
// subsequent identical copies only bump a counter, and when a DIFFERENT line
// arrives (or flushLogStore() runs — feedback export / shutdown) one summary
// record `"<text> [repeated N×]"` is written at the run's origin/level.
//
// Identity is deliberately origin+level+text only: args/tags/clientTimestamp
// vary per copy but carry no extra debugging signal for a storm line, and
// comparing three fields keeps the hot path allocation-free. The decision is a
// pure function (state in → decision + next state out) so vitest covers the
// table without touching the filesystem (electron/__tests__/log-coalesce.test.ts).

export interface RepeatRun {
  origin: LogOrigin;
  level: LogLevel;
  /** Text of the line the run tracks — already capped (post-MAX_TEXT_CHARS). */
  text: string;
  /** Copies suppressed AFTER the first occurrence (which was written). */
  count: number;
}

export type CoalesceDecision =
  /** Identical to the previous line — buffer it, write nothing. */
  | { kind: "suppress" }
  /** Write the incoming record; if `flush` is set, a summary for the previous
   *  run's suppressed copies must be written FIRST (so order on disk mirrors
   *  order of occurrence). */
  | { kind: "write"; flush: RepeatRun | null };

/** The coalescing decision for one incoming record, given the previous run.
 *  Pure — exported for tests. */
export function coalesceRepeat(
  run: RepeatRun | null,
  incoming: Pick<LogRecordInput, "origin" | "level" | "text">,
): { decision: CoalesceDecision; next: RepeatRun } {
  if (
    run &&
    run.origin === incoming.origin &&
    run.level === incoming.level &&
    run.text === incoming.text
  ) {
    return {
      decision: { kind: "suppress" },
      next: { ...run, count: run.count + 1 },
    };
  }
  return {
    decision: { kind: "write", flush: run && run.count > 0 ? run : null },
    next: {
      origin: incoming.origin,
      level: incoming.level,
      text: incoming.text,
      count: 0,
    },
  };
}

/** One-line stand-in for a run's suppressed copies. N counts the SUPPRESSED
 *  copies — the first occurrence was already written normally, so a line seen
 *  5 times reads as the original plus `"… [repeated 4×]"`. Pure — exported
 *  for tests. */
export function formatRepeatSummary(text: string, count: number): string {
  return `${text} [repeated ${count}×]`;
}

let repeatRun: RepeatRun | null = null;

/** Initialize the store. Idempotent per dir; safe to call before/without
 *  Electron. On failure the store degrades to a no-op (logging must never
 *  block app startup). */
export function initLogStore(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logDir = dir;
    openFile();
    rotateIfNeeded();
    appendLogRecord({
      origin: "main",
      level: "info",
      text: `log store opened pid=${process.pid} platform=${process.platform}`,
      tags: ["log-store"],
    });
  } catch {
    logDir = null;
    fd = null;
  }
}

/** Build + write one record to disk unconditionally (no coalescing). Internal:
 *  callers go through appendLogRecord / flushLogStore, which own the repeat
 *  state. May throw — callers catch. */
function writeRecord(input: LogRecordInput): void {
  const now = new Date().toISOString();
  const record: LogRecord = {
    id: nextId++,
    origin: input.origin,
    level: input.level,
    text: input.text,
    ...(input.args && input.args.length ? { args: input.args } : {}),
    ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    clientTimestamp: input.clientTimestamp ?? now,
    submittedAt: now,
  };
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    // args held something unserializable (cycle, BigInt) — drop args,
    // keep the message.
    delete record.args;
    line = `${JSON.stringify(record)}\n`;
  }
  const buf = Buffer.from(line, "utf8");
  fs.writeSync(fd!, buf);
  bytesInFile += buf.byteLength;
  rotateIfNeeded();
}

/** Append one structured record. Best-effort and re-entrancy-safe: never
 *  throws, never calls console.* (main's console is patched to call US).
 *  Consecutive identical lines are coalesced — see "Repeat coalescing" above —
 *  so a suppressed copy returns without touching the disk. */
export function appendLogRecord(input: LogRecordInput): void {
  if (fd === null || !logDir) return;
  try {
    // Cap BEFORE coalescing so identity is compared on what would actually be
    // written (two over-long lines that cap identically ARE the same line as
    // far as the file is concerned).
    const text =
      input.text.length > MAX_TEXT_CHARS
        ? `${input.text.slice(0, MAX_TEXT_CHARS)}…[truncated ${input.text.length - MAX_TEXT_CHARS} chars]`
        : input.text;
    const { decision, next } = coalesceRepeat(repeatRun, {
      origin: input.origin,
      level: input.level,
      text,
    });
    // Advance the run state before writing so a failed write below can't
    // double-count or re-flush on the next call.
    repeatRun = next;
    if (decision.kind === "suppress") return;
    if (decision.flush) {
      writeRecord({
        origin: decision.flush.origin,
        level: decision.flush.level,
        text: formatRepeatSummary(decision.flush.text, decision.flush.count),
      });
    }
    writeRecord({ ...input, text });
  } catch {
    /* logging is best-effort */
  }
}

/** Write out any buffered repeat summary NOW. Called where a coalesced run in
 *  progress must become visible: before the feedback export reads the tail
 *  (readRecentLogs) and at shutdown (main.ts before-quit) — otherwise the
 *  storm's final count would sit in memory and die with the process. The run
 *  identity survives the flush (count resets to 0), so an ongoing storm keeps
 *  coalescing afterwards and simply emits another summary later. */
export function flushLogStore(): void {
  if (fd === null || !logDir) return;
  const run = repeatRun;
  if (!run || run.count === 0) return;
  repeatRun = { ...run, count: 0 };
  try {
    writeRecord({
      origin: run.origin,
      level: run.level,
      text: formatRepeatSummary(run.text, run.count),
    });
  } catch {
    /* logging is best-effort */
  }
}

/** Read the tail (last byte of a file) up to `maxBytes`, trimmed to whole
 *  lines (drops a leading partial record). */
function readTail(file: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    if (want <= 0) return "";
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    let text = buf.toString("utf8");
    if (want < size) {
      // Started mid-line — drop the partial first record.
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

/** The most recent `maxBytes` of JSONL history, spanning the rotation
 *  boundary (older generation first) so the export reads oldest → newest. */
export function readRecentLogs(maxBytes: number = RECENT_LOG_BYTES): string {
  if (!logDir) return "";
  // A storm may be mid-run right when the user exports logs — flush the
  // buffered repeat summary first so the export shows the count so far.
  flushLogStore();
  const current = readTail(filePath(), maxBytes);
  const remaining = maxBytes - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  const prior = readTail(`${filePath()}.1`, remaining);
  return prior + current;
}

/** Write the recent tail to a timestamped temp .jsonl for viewing. Caller
 *  scrubs the content first so the viewed file matches, byte for byte, what a
 *  feedback submission would share — no surprises after the fact. */
export function exportLogsToTemp(content: string): string {
  // SECURITY: the name used to be `zeros-feedback-logs-${Date.now()}.jsonl`
  // directly in the shared temp dir — fully predictable, so another local
  // account could pre-create that path as a symlink and redirect this write
  // (CodeQL js/insecure-temporary-file). mkdtempSync creates a 0700 directory
  // with an unguessable suffix and fails outright if it already exists, so the
  // file inside it cannot be pre-planted. The timestamp stays in the filename
  // because it is what makes successive exports readable to a human.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-feedback-"));
  const file = path.join(dir, `zeros-feedback-logs-${Date.now()}.jsonl`);
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** Test-only: drop state so a fresh initLogStore() starts clean. */
export function _resetLogStoreForTests(): void {
  try {
    if (fd !== null) fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  fd = null;
  logDir = null;
  bytesInFile = 0;
  nextId = 1;
  repeatRun = null;
}
