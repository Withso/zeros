import { afterEach, describe, expect, it, vi } from "vitest";

import { SlowOperationReporter } from "../slow-operation-reporter";

afterEach(() => {
  vi.useRealTimers();
});

describe("SlowOperationReporter", () => {
  it("turns a large burst into one notice and one bounded summary", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const reporter = new SlowOperationReporter({
      thresholdMs: 2_000,
      windowMs: 10_000,
      warn,
    });

    for (let index = 0; index < 250; index += 1) {
      reporter.observe("git.diff", 2_001 + index);
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("git.diff");
    vi.advanceTimersByTime(10_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("250 calls");
    expect(warn.mock.calls[1]?.[0]).toContain("git.diff=250");
  });

  it("ignores fast work and bounds the number of operation names in a summary", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const reporter = new SlowOperationReporter({
      thresholdMs: 100,
      windowMs: 1_000,
      maxOperations: 3,
      warn,
    });

    reporter.observe("fast", 99);
    for (let index = 0; index < 8; index += 1) {
      reporter.observe(`op-${index}`, 100 + index);
    }
    vi.advanceTimersByTime(1_000);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("+5 other ops");
  });

  it("starts a fresh diagnostic window after the prior summary", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const reporter = new SlowOperationReporter({
      thresholdMs: 100,
      windowMs: 1_000,
      warn,
    });

    reporter.observe("git.status", 150);
    vi.advanceTimersByTime(1_000);
    reporter.observe("git.diff", 175);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("git.diff");
  });

  it("does not add a redundant summary for one isolated slow operation", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const reporter = new SlowOperationReporter({
      thresholdMs: 100,
      windowMs: 1_000,
      warn,
    });

    reporter.observe("git.status", 150);
    vi.advanceTimersByTime(1_000);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
