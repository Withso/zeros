import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeWorkspaceAvailability,
  WorkbenchStatusSources,
} from "../tab-status-model";

describe("calm workbench status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
  });
  afterEach(() => vi.useRealTimers());

  it.each([true, false])(
    "uses the same gap thresholds (cloud=%s)",
    async (cloud) => {
      const gap = {
        cloud,
        connection: "disconnected" as const,
        previouslyConnected: true,
        since: Date.now(),
      };
      await vi.advanceTimersByTimeAsync(9_999);
      expect(describeWorkspaceAvailability(gap, Date.now())).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(describeWorkspaceAvailability(gap, Date.now())).toMatchObject({
        tone: "pending",
        connectionPhase: "reconnecting",
      });
      await vi.advanceTimersByTimeAsync(34_999);
      expect(describeWorkspaceAvailability(gap, Date.now())?.tone).toBe(
        "pending",
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(describeWorkspaceAvailability(gap, Date.now())).toMatchObject({
        tone: "error",
        action: "Retry",
      });
      expect(
        describeWorkspaceAvailability(
          { ...gap, connection: "connected" },
          Date.now(),
        ),
      ).toBeNull();
    },
  );

  it.each([true, false])(
    "graces normal cold startup (cloud=%s)",
    async (cloud) => {
      const cold = {
        cloud,
        connection: "connecting" as const,
        since: Date.now(),
      };
      await vi.advanceTimersByTimeAsync(9_999);
      expect(describeWorkspaceAvailability(cold, Date.now())).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(describeWorkspaceAvailability(cold, Date.now())?.message).toBe(
        "Connecting…",
      );
    },
  );

  it.each([
    "setting_up",
    "starting",
    "stopping",
    "stopped",
    "sleeping",
    "archived",
    "failed",
  ])("shows explicit %s state immediately", (state) =>
    expect(
      describeWorkspaceAvailability(
        {
          cloud: true,
          connection: "disconnected",
          since: Date.now(),
          state,
        },
        Date.now(),
      ),
    ).not.toBeNull(),
  );

  it.each([false, true])(
    "silently retries a first read failure (retained=%s)",
    async (hasContent) => {
      const sources = new WorkbenchStatusSources();
      const retry = vi.fn(async () => {
        sources.update("read", {
          pending: false,
          primary: true,
          hasContent: true,
          retry,
        });
      });
      sources.update("read", {
        error: "first failure",
        pending: false,
        primary: true,
        hasContent,
        retry,
      });
      expect(sources.snapshot()).toMatchObject({
        failure: null,
        hasContent,
        busy: false,
      });
      await vi.advanceTimersByTimeAsync(1_499);
      expect(retry).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(sources.snapshot()).toMatchObject({
        failure: null,
        hasContent: true,
        busy: false,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps the retry silent until it settles, then exposes a second failure", async () => {
    const sources = new WorkbenchStatusSources();
    let settle!: () => void;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    sources.update("read", {
      error: "first",
      pending: false,
      primary: true,
      hasContent: true,
      retry,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sources.snapshot()).toMatchObject({
      failure: null,
      busy: false,
      hasContent: true,
    });
    sources.update("read", {
      error: "second",
      pending: false,
      primary: true,
      hasContent: true,
      retry,
    });
    expect(sources.snapshot().failure).toBeNull();
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(sources.snapshot()).toMatchObject({
      failure: "second",
      busy: false,
      hasContent: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("lets the next automatic revalidation recover before the silent retry", async () => {
    const sources = new WorkbenchStatusSources();
    const retry = vi.fn();
    sources.update("read", {
      error: "refresh failed",
      pending: false,
      primary: true,
      hasContent: true,
      retry,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    sources.update("read", {
      pending: true,
      primary: true,
      hasContent: true,
      retry,
    });
    sources.update("read", {
      pending: false,
      primary: true,
      hasContent: true,
      retry,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(retry).not.toHaveBeenCalled();
    expect(sources.snapshot().failure).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one automatic flight for equivalent consumers and failed sources", async () => {
    const sources = new WorkbenchStatusSources();
    const retry = vi.fn(async () => {});
    const failed = { error: "failed", pending: false, retry };
    sources.update("one", failed);
    sources.update("two", failed);
    sources.update("one", failed);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(sources.snapshot().failure).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels hidden timers and never retries a successor key", async () => {
    const old = new WorkbenchStatusSources();
    const current = new WorkbenchStatusSources();
    const retry = vi.fn();
    old.update("read", { error: "old", pending: false, retry });
    await vi.advanceTimersByTimeAsync(1_000);
    old.update("read", { error: "old", pending: false, retry, active: false });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retry).not.toHaveBeenCalled();
    expect(current.snapshot().failure).toBeNull();
    old.remove("read");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an exact read once when equivalent consumers fail a few milliseconds apart", async () => {
    const sources = new WorkbenchStatusSources();
    const retry = vi.fn(async () => {});
    sources.update("pane-a", {
      error: "failed",
      pending: false,
      retry: () => retry(),
      retryKey: "exact-read",
    });
    await vi.advanceTimersByTimeAsync(10);
    sources.update("pane-b", {
      error: "failed",
      pending: false,
      retry: () => retry(),
      retryKey: "exact-read",
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(sources.snapshot().failure).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
