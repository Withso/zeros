// ──────────────────────────────────────────────────────────
// IPC commands: structured app logs (feedback / debugging)
// ──────────────────────────────────────────────────────────
//
// Three commands over the app.jsonl store (apps/desktop/electron/log-store.ts):
//
//   log_submit       — renderer batches its console/error records here so
//                      frontend logs land in the same JSONL stream as main +
//                      engine output (origin "frontend").
//   logs_recent      — the recent tail (≤512 KB), SECRET-SCRUBBED, for the
//                      feedback form's "Include recent app logs" payload.
//   logs_export_open — writes that same scrubbed tail to a temp
//                      zeros-feedback-logs-<ts>.jsonl and opens it (TextEdit
//                      on macOS) — the feedback form's "View" button. The
//                      viewed file is byte-identical to what a submission
//                      would share.
//
// Scrubbing uses redactLogSecrets (NOT the aggressive analytics scrubber):
// credentials/JWTs/API keys are removed, but session ids, paths, and SHAs
// survive so the logs stay debuggable. The checkbox label warns the user
// that personal data may remain.
// ──────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { shell } from "electron";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import {
  appendLogRecord,
  exportLogsToTemp,
  readRecentLogs,
  type LogLevel,
  type LogRecordInput,
} from "../../log-store";
import type { CommandHandler } from "../router";

const LEVELS = new Set<LogLevel>(["log", "info", "warn", "error", "debug"]);
/** Per-batch cap — a renderer bug can't flood the store in one invoke. */
const MAX_BATCH = 500;
const MAX_TAGS = 8;

/** Post-scrub character ceiling on the shared/exported tail (~500 KB — enough
 *  to diagnose a session, small enough to upload). Matches the feedback
 *  Worker's MAX_LOGS (and the renderer's own client-side slice), and — because
 *  BOTH logs_recent
 *  (submission payload) and logs_export_open (the "View" button) apply it
 *  identically — guarantees the viewed file is byte-for-byte what a submission
 *  shares. RECENT_LOG_BYTES (the raw read tail) is deliberately larger so
 *  scrubbing has headroom before this cap engages. */
const MAX_EXPORT_CHARS = 500_000;

/** The scrubbed recent tail, capped to MAX_EXPORT_CHARS (newest kept) and
 *  trimmed to whole lines so a truncated tail stays valid JSONL. Single source
 *  for both the submission payload and the View export. */
function scrubbedRecentTail(): string {
  const scrubbed = redactLogSecrets(readRecentLogs());
  if (scrubbed.length <= MAX_EXPORT_CHARS) return scrubbed;
  const tail = scrubbed.slice(-MAX_EXPORT_CHARS);
  // Slicing by chars can start mid-record — drop the leading partial line.
  const nl = tail.indexOf("\n");
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}

/** Coerce one untrusted renderer record into a safe LogRecordInput, or null.
 *  Origin is forced to "frontend" — the renderer must not be able to forge
 *  main/engine records. Exported for tests. */
export function sanitizeRendererRecord(raw: unknown): LogRecordInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || r.text.length === 0) return null;
  const level = LEVELS.has(r.level as LogLevel) ? (r.level as LogLevel) : "log";
  const tags = Array.isArray(r.tags)
    ? r.tags
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .slice(0, MAX_TAGS)
    : undefined;
  const ts =
    typeof r.clientTimestamp === "string" &&
    !Number.isNaN(Date.parse(r.clientTimestamp))
      ? r.clientTimestamp
      : undefined;
  return {
    origin: "frontend",
    level,
    text: r.text,
    ...(tags && tags.length ? { tags } : {}),
    ...(ts ? { clientTimestamp: ts } : {}),
  };
}

export const logSubmit: CommandHandler = async (args) => {
  const records = Array.isArray(args.records) ? args.records : [];
  for (const raw of records.slice(0, MAX_BATCH)) {
    const rec = sanitizeRendererRecord(raw);
    if (rec) appendLogRecord(rec);
  }
  return { accepted: Math.min(records.length, MAX_BATCH) };
};

export const logsRecent: CommandHandler = async () => {
  return { text: scrubbedRecentTail() };
};

export const logsExportOpen: CommandHandler = async () => {
  const content = scrubbedRecentTail();
  const file = exportLogsToTemp(content);
  if (process.platform === "darwin") {
    // TextEdit specifically — the default .jsonl handler is often an IDE or
    // nothing at all; TextEdit opens instantly and is universally present.
    const child = spawn("open", ["-a", "TextEdit", file], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // If TextEdit is somehow unavailable (`open` exits non-zero) or the spawn
    // itself fails, fall back to the OS default handler so the button never
    // silently does nothing.
    child.on("exit", (code) => {
      if (code !== 0) void shell.openPath(file);
    });
    child.on("error", () => void shell.openPath(file));
  } else {
    const err = await shell.openPath(file);
    if (err) throw new Error(`Couldn't open log file: ${err}`);
  }
  return { path: file };
};
