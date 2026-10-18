import { afterEach, describe, expect, it, vi } from "vitest";
const monitor = vi.hoisted(() => ({
  create: vi.fn(), histogram: { enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), max: 450_000_000 },
}));
vi.mock("node:perf_hooks", async (original) => ({
  ...await original<typeof import("node:perf_hooks")>(),
  monitorEventLoopDelay: monitor.create,
}));
import { SlowOperationReporter } from "../slow-operation-reporter";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("slow-operation event-loop attribution", () => {
  it("samples only while Local operations have an active observation", () => {
    vi.useFakeTimers();
    monitor.create.mockReturnValue(monitor.histogram);
    const warn = vi.fn();
    const reporter = new SlowOperationReporter({ thresholdMs: 100, windowMs: 1_000, warn });
    expect(monitor.create).not.toHaveBeenCalled();
    const endA = reporter.beginEventLoopObservation();
    const endB = reporter.beginEventLoopObservation();
    expect(monitor.create).toHaveBeenCalledTimes(1);
    expect(monitor.histogram.enable).toHaveBeenCalledTimes(1);
    const lag = endA();
    expect(lag).toBe(450);
    expect(monitor.histogram.disable).not.toHaveBeenCalled();
    reporter.observe("git.status", 700, lag);
    reporter.observe("git.diff", 800, endB());
    expect(monitor.histogram.disable).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("eventLoopMax=450ms");
    vi.advanceTimersByTime(1_000);
    expect(warn.mock.calls[1]?.[0]).toContain("eventLoopMax=450ms");
    endA(); endB();
    expect(monitor.histogram.disable).toHaveBeenCalledTimes(1);
    const next = reporter.beginEventLoopObservation();
    expect(monitor.histogram.reset).toHaveBeenCalledTimes(2);
    next();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps uninstrumented/cloud callers unchanged and degrades when the runtime lacks monitoring", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const reporter = new SlowOperationReporter({ thresholdMs: 100, windowMs: 1_000, warn });
    reporter.observe("git.status", 500);
    expect(monitor.create).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).not.toContain("eventLoop");
    monitor.create.mockImplementationOnce(() => { throw new Error("unsupported"); });
    expect(reporter.beginEventLoopObservation()()).toBeNull();
    reporter.flush();
  });

  it.each(["max", "disable"])("never fails an operation when histogram %s throws", (failure) => {
    const histogram = {
      enable: vi.fn(), reset: vi.fn(),
      disable: vi.fn(() => { if (failure === "disable") throw new Error("unavailable"); }),
      get max() { if (failure === "max") throw new Error("unavailable"); return 100_000_000; },
    };
    monitor.create.mockReturnValueOnce(histogram);
    const reporter = new SlowOperationReporter({ thresholdMs: 100, windowMs: 1_000 });
    const end = reporter.beginEventLoopObservation();
    expect(() => end()).not.toThrow();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(() => reporter.dispose()).not.toThrow();
  });
});
