// Structured log store + logs IPC commands.
//
// Covers the retention/export contract the feedback form depends on:
//   • append → valid JSONL with the full record shape (id/origin/level/
//     text/clientTimestamp/submittedAt)
//   • rotation at the size cap (one prior generation kept)
//   • readRecentLogs spans the rotation boundary, oldest → newest
//   • renderer records are sanitized (origin forced to "frontend")
//   • logs_recent / logs_export_open scrub secrets but keep session ids
//     (the debuggability contract of redactLogSecrets)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// logs.ts pulls in electron (shell.openPath) — stub the module surface.
const electronMock = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
}));
vi.mock("electron", () => ({ shell: { openPath: electronMock.openPath } }));

import {
  _resetLogStoreForTests,
  appendLogRecord,
  initLogStore,
  readRecentLogs,
  type LogRecord,
} from "../../../log-store";
import { logsExportOpen, logsRecent, logSubmit, sanitizeRendererRecord } from "../logs";

const call = async (
  handler: unknown,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> =>
  (await (handler as (a: Record<string, unknown>) => Promise<unknown>)(
    args,
  )) as Record<string, unknown>;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zeros-logs-"));
  initLogStore(dir);
});
afterEach(() => {
  _resetLogStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

const readRecords = (): LogRecord[] =>
  readFileSync(path.join(dir, "app.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogRecord);

describe("log-store append", () => {
  it("writes JSONL records with monotonic ids", () => {
    appendLogRecord({ origin: "main", level: "info", text: "hello" });
    appendLogRecord({
      origin: "frontend",
      level: "error",
      text: "boom",
      tags: ["session:abc"],
    });
    const records = readRecords();
    // Record 1 is the init marker; then ours.
    expect(records.length).toBe(3);
    const [, hello, boom] = records;
    expect(hello.text).toBe("hello");
    expect(hello.origin).toBe("main");
    expect(boom.level).toBe("error");
    expect(boom.tags).toEqual(["session:abc"]);
    expect(boom.id).toBe(hello.id + 1);
    expect(Date.parse(boom.clientTimestamp)).not.toBeNaN();
    expect(Date.parse(boom.submittedAt)).not.toBeNaN();
  });

  it("caps runaway single-record text", () => {
    appendLogRecord({ origin: "main", level: "log", text: "x".repeat(50_000) });
    const last = readRecords().at(-1)!;
    expect(last.text.length).toBeLessThan(11_000);
    expect(last.text).toContain("[truncated");
  });

  it("rotates past the size cap and keeps one prior generation", () => {
    // ~10 KB per record → ~850 records cross the 8 MB cap.
    const big = "y".repeat(9_990);
    for (let i = 0; i < 900; i++) {
      appendLogRecord({ origin: "main", level: "log", text: `${i} ${big}` });
    }
    expect(existsSync(path.join(dir, "app.jsonl.1"))).toBe(true);
    // Current file restarted small; tail-read spans the boundary.
    const tail = readRecentLogs(64 * 1024);
    const lines = tail.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Every line is whole/parseable (no partial first record).
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // Newest record is last.
    const lastParsed = JSON.parse(lines.at(-1)!) as LogRecord;
    expect(lastParsed.text.startsWith("899 ")).toBe(true);
  });
});

describe("sanitizeRendererRecord", () => {
  it("forces origin to frontend and validates fields", () => {
    const rec = sanitizeRendererRecord({
      origin: "main", // forged — must be overridden
      level: "error",
      text: "t",
      tags: ["a", 7, "b"],
      clientTimestamp: "2026-07-22T09:00:00.000Z",
    });
    expect(rec).toEqual({
      origin: "frontend",
      level: "error",
      text: "t",
      tags: ["a", "b"],
      clientTimestamp: "2026-07-22T09:00:00.000Z",
    });
  });

  it("rejects records without text and coerces bad levels/timestamps", () => {
    expect(sanitizeRendererRecord(null)).toBeNull();
    expect(sanitizeRendererRecord({ level: "info" })).toBeNull();
    const rec = sanitizeRendererRecord({
      text: "x",
      level: "verbose",
      clientTimestamp: "not-a-date",
    });
    expect(rec).toEqual({ origin: "frontend", level: "log", text: "x" });
  });
});

describe("log_submit + logs_recent", () => {
  it("appends renderer batches and returns a scrubbed, debuggable tail", async () => {
    await call(logSubmit, {
      records: [
        {
          level: "info",
          text: "session 00000000-0000-0000-0000-000000000000 token=super-secret-value",
          tags: ["session:00000000"],
        },
      ],
    });
    const res = await call(logsRecent);
    const text = res.text as string;
    // Secret scrubbed…
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("token=[redacted]");
    // …but the session UUID survives (debuggability contract).
    expect(text).toContain("00000000-0000-0000-0000-000000000000");
    expect(text).toContain('"origin":"frontend"');
  });

  it("exports the scrubbed tail to a temp .jsonl and opens it (View button)", async () => {
    // Non-darwin path in CI: shell.openPath (mocked) is the opener.
    appendLogRecord({
      origin: "main",
      level: "info",
      text: "boot ok api_key=abc123 session 00000000-0000-0000-0000-000000000000",
    });
    const res = await call(logsExportOpen);
    const file = res.path as string;
    expect(path.basename(file)).toMatch(/^zeros-feedback-logs-\d+\.jsonl$/);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("api_key=[redacted]");
    expect(content).toContain("00000000-0000-0000-0000-000000000000");
    if (process.platform !== "darwin") {
      expect(electronMock.openPath).toHaveBeenCalledWith(file);
    }
    rmSync(file, { force: true });
  });

  it("caps a single batch at 500 records", async () => {
    const records = Array.from({ length: 600 }, (_, i) => ({
      level: "log",
      text: `r${i}`,
    }));
    const res = await call(logSubmit, { records });
    expect(res.accepted).toBe(500);
    const all = readRecords();
    // init marker + 500 accepted
    expect(all.length).toBe(501);
  });

  it("caps the shared tail identically for submit and View (View ⊆ nothing extra)", async () => {
    // Exceed the 500k-char export cap so it actually engages (~10 KB/record).
    const big = "z".repeat(9_990);
    for (let i = 0; i < 70; i++) {
      appendLogRecord({ origin: "main", level: "log", text: `rec${i} ${big}` });
    }
    const recent = (await call(logsRecent)).text as string;
    // Capped to the export ceiling…
    expect(recent.length).toBeLessThanOrEqual(500_000);
    expect(recent.length).toBeGreaterThan(450_000); // the cap really engaged
    // …and every line stays whole/parseable (no leading partial record).
    const lines = recent.split("\n").filter(Boolean);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // The "View" export is byte-identical to what a submission shares.
    const res = await call(logsExportOpen);
    const file = res.path as string;
    expect(readFileSync(file, "utf8")).toBe(recent);
    rmSync(file, { force: true });
  });
});
