import { describe, expect, it } from "vitest";

import { UplinkIdleDecision } from "./uplink-idle.js";

const quiet = (windowMs: number) => ({ clients: 0, runningTurns: 0, liveTerminals: 0, windowMs });

describe("uplink idle decision (idle.v1)", () => {
  it("is due one idle interval after the reported quiet start, and never without a quiet report", () => {
    const decision = new UplinkIdleDecision(600_000);
    expect(decision.dueAtMs()).toBeNull();
    expect(decision.report(quiet(60_000), 1_000_000)).toBe(1_540_000);
    // A later report of the same stretch (transit jitter) keeps the start.
    expect(decision.report(quiet(120_002), 1_060_000)).toBe(1_540_000);
    for (const busy of [{ clients: 1 }, { runningTurns: 1 }, { liveTerminals: 1 }, { windowMs: 0 }])
      expect(new UplinkIdleDecision(600_000).report({ ...quiet(60_000), ...busy }, 1_000_000)).toBeNull();
    expect(decision.report({ ...quiet(60_000), runningTurns: 1 }, 1_100_000)).toBeNull();
    expect(decision.dueAtMs()).toBeNull();
  });

  it("restarts on a later quiet start, except at the window cap", () => {
    const decision = new UplinkIdleDecision(600_000);
    decision.report(quiet(60_000), 1_000_000);
    expect(decision.report(quiet(10_000), 1_060_000)).toBe(1_650_000);
    const capped = new UplinkIdleDecision(600_000);
    capped.report(quiet(3_600_000), 10_000_000);
    expect(capped.report(quiet(3_600_000), 10_060_000)).toBe(7_000_000);
  });

  it("backs off after declined or unavailable, waits an interval after requested, and stops after authority", () => {
    const decision = new UplinkIdleDecision(600_000);
    decision.report(quiet(600_000), 1_000_000);
    decision.attempted(1_000_000, "declined");
    expect(decision.dueAtMs()).toBe(1_015_000);
    decision.attempted(1_015_000, "unavailable");
    expect(decision.dueAtMs()).toBe(1_045_000);
    for (let i = 0; i < 4; i++) decision.attempted(2_000_000, "declined");
    expect(decision.dueAtMs()).toBe(2_120_000);
    decision.attempted(2_000_000, "requested");
    expect(decision.dueAtMs()).toBe(2_600_000);
    decision.attempted(2_000_000, "authority");
    expect(decision.dueAtMs()).toBe(Number.POSITIVE_INFINITY);
    // Activity clears the backoff; a new quiet stretch starts fresh.
    decision.report({ ...quiet(0), clients: 1 }, 2_100_000);
    expect(decision.report(quiet(1_000), 2_200_000)).toBe(2_799_000);
  });
});
