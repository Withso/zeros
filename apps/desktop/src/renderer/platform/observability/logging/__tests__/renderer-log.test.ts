// Renderer log serialization — the pure half of renderer-log.ts. (The
// console patch + IPC flusher are Electron-runtime-only; what matters for the
// log CONTENT is that arbitrary console args serialize into stable, bounded,
// single-line text for the record's flat `text` field.)

import { describe, it, expect } from "vitest";
import {
  circuitAllowsAttempt,
  flushBackoffMs,
  formatLogArg,
  formatLogArgs,
  recordFlushFailure,
  recordFlushSuccess,
} from "../renderer-log";

describe("formatLogArg", () => {
  it("passes strings through and JSON-serializes objects", () => {
    expect(formatLogArg("plain")).toBe("plain");
    expect(formatLogArg({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(formatLogArg([1, 2])).toBe("[1,2]");
    expect(formatLogArg(null)).toBe("null");
    expect(formatLogArg(undefined)).toBe("undefined");
    expect(formatLogArg(42)).toBe("42");
    expect(formatLogArg(true)).toBe("true");
  });

  it("renders Errors as their stack", () => {
    const err = new Error("kaboom");
    const out = formatLogArg(err);
    expect(out).toContain("kaboom");
    expect(out).toContain("Error");
  });

  it("survives circular references and BigInt", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    expect(formatLogArg(obj)).toContain("[circular]");
    expect(formatLogArg({ n: 10n })).toBe('{"n":"10n"}');
  });

  it("renders functions without throwing", () => {
    expect(formatLogArg(function namedFn() {})).toBe("[function namedFn]");
  });

  it("caps oversized args", () => {
    const out = formatLogArg("z".repeat(20_000));
    expect(out.length).toBeLessThan(6_000);
    expect(out).toContain("…[truncated]");
  });
});

describe("formatLogArgs", () => {
  it("joins mixed args into one line (console.log style)", () => {
    expect(formatLogArgs(["count:", 3, { id: "abc" }])).toBe(
      'count: 3 {"id":"abc"}',
    );
  });
});

describe("flush circuit breaker", () => {
  it("stays closed below the failure threshold, then backs off exponentially", () => {
    // First two failures keep the normal cadence (no back-off) so a single
    // spurious rejection doesn't stall logging.
    expect(flushBackoffMs(1)).toBe(0);
    expect(flushBackoffMs(2)).toBe(0);
    // Third failure opens the circuit; then it doubles each time.
    expect(flushBackoffMs(3)).toBe(2_000);
    expect(flushBackoffMs(4)).toBe(4_000);
    expect(flushBackoffMs(5)).toBe(8_000);
  });

  it("caps the back-off at 60s no matter how long the outage runs", () => {
    expect(flushBackoffMs(8)).toBe(60_000); // 2s<<5 = 64s → capped
    expect(flushBackoffMs(50)).toBe(60_000);
  });

  it("opens the circuit only after the threshold and reopens with the next window", () => {
    const c = { failures: 0, openUntil: 0 };
    // Two failures: still allowed to attempt every tick (no storm-worthy delay).
    recordFlushFailure(c, 1_000);
    expect(circuitAllowsAttempt(c, 1_000)).toBe(true);
    recordFlushFailure(c, 2_000);
    expect(circuitAllowsAttempt(c, 2_000)).toBe(true);
    // Third failure at t=3_000 → open for 2s.
    recordFlushFailure(c, 3_000);
    expect(circuitAllowsAttempt(c, 3_000)).toBe(false);
    expect(circuitAllowsAttempt(c, 4_999)).toBe(false);
    expect(circuitAllowsAttempt(c, 5_000)).toBe(true); // window elapsed → probe
  });

  it("snaps shut on the first success after an outage", () => {
    const c = { failures: 0, openUntil: 0 };
    for (let i = 0; i < 6; i++) recordFlushFailure(c, i * 1_000);
    expect(c.failures).toBe(6);
    expect(circuitAllowsAttempt(c, 6_000)).toBe(false);
    recordFlushSuccess(c);
    expect(c.failures).toBe(0);
    expect(circuitAllowsAttempt(c, 6_000)).toBe(true);
  });
});
