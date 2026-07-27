// Repeat coalescing in the app log store (electron/log-store.ts).
//
// The motivating incident: a respawn storm wrote the SAME line thousands of
// times, chewing through both app.jsonl generations and evicting the history
// that would have explained the storm. These tests cover (a) the pure decision
// table (coalesceRepeat / formatRepeatSummary — no filesystem), and (b) the
// store end-to-end: what actually lands in app.jsonl when identical lines
// arrive back-to-back, and how flushLogStore / readRecentLogs surface an
// in-flight run. log-store.ts has no electron imports, so the real store runs
// here against a temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendLogRecord,
  coalesceRepeat,
  flushLogStore,
  formatRepeatSummary,
  initLogStore,
  readRecentLogs,
  _resetLogStoreForTests,
  type LogRecord,
  type RepeatRun,
} from "../log-store";

describe("coalesceRepeat (pure decision table)", () => {
  const line = (text: string, level: "info" | "error" = "info") =>
    ({ origin: "main", level, text }) as const;

  it("writes the first occurrence with nothing to flush", () => {
    const { decision, next } = coalesceRepeat(null, line("boot"));
    expect(decision).toEqual({ kind: "write", flush: null });
    expect(next).toEqual({ origin: "main", level: "info", text: "boot", count: 0 });
  });

  it("suppresses consecutive identical lines and counts them", () => {
    let run: RepeatRun | null = null;
    let r = coalesceRepeat(run, line("engine died"));
    expect(r.decision.kind).toBe("write");
    run = r.next;
    // Three more identical copies — each suppressed, count climbing.
    for (let i = 1; i <= 3; i++) {
      r = coalesceRepeat(run, line("engine died"));
      expect(r.decision).toEqual({ kind: "suppress" });
      run = r.next;
      expect(run.count).toBe(i);
    }
  });

  it("a different line writes AND flushes the previous run's count", () => {
    let run = coalesceRepeat(null, line("engine died")).next;
    run = coalesceRepeat(run, line("engine died")).next;
    run = coalesceRepeat(run, line("engine died")).next; // 2 suppressed
    const { decision, next } = coalesceRepeat(run, line("engine restarted"));
    expect(decision).toEqual({
      kind: "write",
      flush: { origin: "main", level: "info", text: "engine died", count: 2 },
    });
    expect(next.text).toBe("engine restarted");
    expect(next.count).toBe(0);
  });

  it("a different line after a NON-repeated one flushes nothing", () => {
    const run = coalesceRepeat(null, line("a")).next;
    const { decision } = coalesceRepeat(run, line("b"));
    expect(decision).toEqual({ kind: "write", flush: null });
  });

  it("identity is origin+level+text — a level change breaks the run", () => {
    let run = coalesceRepeat(null, line("boom")).next;
    run = coalesceRepeat(run, line("boom")).next; // 1 suppressed
    // Same text at a different level → new run, previous count flushed.
    const { decision, next } = coalesceRepeat(run, line("boom", "error"));
    expect(decision.kind).toBe("write");
    expect(decision.kind === "write" && decision.flush?.count).toBe(1);
    expect(next.level).toBe("error");
  });
});

describe("formatRepeatSummary", () => {
  it("appends the suppressed count to the repeated text", () => {
    expect(formatRepeatSummary("engine died", 4231)).toBe(
      "engine died [repeated 4231×]",
    );
  });
});

describe("log store end-to-end coalescing", () => {
  let dir = "";

  const records = (): LogRecord[] =>
    fs
      .readFileSync(path.join(dir, "app.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LogRecord)
      // Drop the store's own "log store opened …" boot record — it's real
      // output but irrelevant to every assertion below.
      .filter((r) => !r.text.startsWith("log store opened"));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-coalesce-"));
    initLogStore(dir);
  });
  afterEach(() => {
    _resetLogStoreForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a storm of identical lines lands as one copy + one summary", () => {
    for (let i = 0; i < 5; i++) {
      appendLogRecord({ origin: "engine", level: "error", text: "spawn failed" });
    }
    appendLogRecord({ origin: "main", level: "info", text: "recovered" });
    const texts = records().map((r) => r.text);
    // Original once, then the 4 suppressed copies as a single summary, then
    // the line that broke the run — on-disk order mirrors occurrence order.
    expect(texts).toEqual([
      "spawn failed",
      "spawn failed [repeated 4×]",
      "recovered",
    ]);
    // The summary keeps the run's origin/level so grep-by-origin still works.
    const summary = records()[1];
    expect(summary.origin).toBe("engine");
    expect(summary.level).toBe("error");
  });

  it("distinct lines are written verbatim — no summaries, nothing dropped", () => {
    appendLogRecord({ origin: "main", level: "info", text: "a" });
    appendLogRecord({ origin: "main", level: "info", text: "b" });
    appendLogRecord({ origin: "main", level: "info", text: "a" }); // non-consecutive repeat
    expect(records().map((r) => r.text)).toEqual(["a", "b", "a"]);
  });

  it("flushLogStore makes an in-flight run visible without ending it", () => {
    for (let i = 0; i < 3; i++) {
      appendLogRecord({ origin: "main", level: "warn", text: "port busy" });
    }
    flushLogStore(); // e.g. app quitting / user exporting mid-storm
    expect(records().map((r) => r.text)).toEqual([
      "port busy",
      "port busy [repeated 2×]",
    ]);
    // The storm continues after the flush: the run keeps coalescing and a
    // later flush emits a fresh count (not a re-count of flushed copies).
    appendLogRecord({ origin: "main", level: "warn", text: "port busy" });
    appendLogRecord({ origin: "main", level: "warn", text: "port busy" });
    flushLogStore();
    expect(records().at(-1)?.text).toBe("port busy [repeated 2×]");
  });

  it("flushLogStore with no suppressed copies writes nothing", () => {
    appendLogRecord({ origin: "main", level: "info", text: "once" });
    flushLogStore();
    flushLogStore(); // idempotent — a second flush must not re-emit
    expect(records().map((r) => r.text)).toEqual(["once"]);
  });

  it("readRecentLogs flushes first so an export sees the count so far", () => {
    for (let i = 0; i < 3; i++) {
      appendLogRecord({ origin: "main", level: "error", text: "ipc rejected" });
    }
    const tail = readRecentLogs();
    expect(tail).toContain("ipc rejected [repeated 2×]");
  });
});
