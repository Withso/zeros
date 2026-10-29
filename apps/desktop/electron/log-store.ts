// app.jsonl retains source and arrival timestamps separately because renderer
// batches may arrive late; rotation and coalescing bound persistent history.

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
/** Read beyond MAX_EXPORT_CHARS so scrubbing still leaves a useful export tail. */
export const RECENT_LOG_BYTES = 1024 * 1024;

const FILE_NAME = "app.jsonl";

let logDir: string | null = null;
// Synchronous writes avoid losing crash diagnostics in a JS stream buffer;
// suppressed repeat counts still wait for a flush.
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

// Coalesce by origin/level/text so failure storms do not evict useful history;
// varying tags, arguments and timestamps must not split identical runs.

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

/** Count only suppressed copies: five occurrences are one row plus repeated 4×. */
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

/** Never throw or call console: main's patched console routes back here.
 * Suppressed repeats stay buffered until flush. */
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

/** Export and shutdown must flush the final repeat count; retain the run's
 * identity so an ongoing storm continues coalescing afterwards. */
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
  // A private, unique directory prevents another account pre-planting a symlink
  // at the timestamped export path.
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
