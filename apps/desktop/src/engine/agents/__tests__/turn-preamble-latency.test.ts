// A slow "hi" was attributed to the pre-turn worktree snapshot on the strength
// of a 3.8s measurement, then re-measured at 0.4s once the filesystem cache was
// warm — same repo, same command. Both readings fit the 3-5s gap the log
// actually showed, so the attribution was a guess wearing a number. These tests
// pin the behaviour that stops that: phases, and a named dominant one.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREAMBLE_SLOW_MS,
  TurnPreambleLatency,
  turnPreambleSlowMs,
} from "../turn-preamble-latency";

/** Drive the clock explicitly — a latency test that reads Date.now() measures
 *  the test runner. */
function preamble(slowMs = DEFAULT_PREAMBLE_SLOW_MS) {
  let now = 1_000;
  const timer = new TurnPreambleLatency("codex", slowMs, now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    mark: (name: string) => timer.mark(name, now),
    report: () => timer.report(now),
  };
}

describe("TurnPreambleLatency", () => {
  it("says nothing about an ordinary preamble", () => {
    const p = preamble();
    p.advance(40);
    p.mark("persist");
    p.advance(120);
    p.mark("snapshot");

    // Quiet by default is what makes this safe to leave on: a fast turn must
    // not add a line to every log.
    expect(p.report()).toBeNull();
  });

  it("names the phase that owned the time, not just the total", () => {
    const p = preamble();
    p.advance(60);
    p.mark("persist");
    p.advance(3_600);
    p.mark("snapshot");
    p.advance(90);
    p.mark("admit");

    const line = p.report();
    expect(line).toContain("turn preamble 3750ms");
    expect(line).toContain("mostly snapshot");
    // The per-phase numbers have to survive: "mostly snapshot" is the headline,
    // but the others are how you rule them out.
    expect(line).toContain("persist=60ms");
    expect(line).toContain("snapshot=3600ms");
    expect(line).toContain("admit=90ms");
  });

  it("blames persistence when persistence is the slow one", () => {
    // The same total with a different shape must read differently, or the line
    // sends the next reader to the wrong file.
    const p = preamble();
    p.advance(3_000);
    p.mark("persist");
    p.advance(100);
    p.mark("snapshot");

    expect(p.report()).toContain("mostly persist");
  });

  it("reports a slow preamble that has no phases at all", () => {
    const p = preamble();
    p.advance(2_000);

    const line = p.report();
    expect(line).toContain("turn preamble 2000ms");
    expect(line).not.toContain("mostly");
  });

  it("carries the agent id so three providers stay distinguishable", () => {
    const timer = new TurnPreambleLatency("cursor", 10, 0);
    timer.mark("persist", 50);
    expect(timer.report(50)).toMatch(/^\[cursor\] /);
  });

  it("takes the threshold from the environment", () => {
    expect(turnPreambleSlowMs({ ZEROS_TURN_PREAMBLE_SLOW_MS: "250" })).toBe(
      250,
    );
    // A junk or non-positive override must not silence the instrument.
    expect(
      turnPreambleSlowMs({ ZEROS_TURN_PREAMBLE_SLOW_MS: "nonsense" }),
    ).toBe(DEFAULT_PREAMBLE_SLOW_MS);
    expect(turnPreambleSlowMs({ ZEROS_TURN_PREAMBLE_SLOW_MS: "0" })).toBe(
      DEFAULT_PREAMBLE_SLOW_MS,
    );
    expect(turnPreambleSlowMs({})).toBe(DEFAULT_PREAMBLE_SLOW_MS);
  });
});
