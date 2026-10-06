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

  it("does not spend a read's silent retry during a known transport gap", async () => {
    const sources = new WorkbenchStatusSources();
    const retry = vi.fn();
    const read = {
      error: "transport disconnected",
      pending: false,
      primary: true,
      hasContent: true,
      retry,
      retryAvailable: false,
    };
    sources.update("read", read);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(retry).not.toHaveBeenCalled();
    expect(sources.snapshot().failure).toBeNull();
    sources.update("read", { ...read, pending: true, retryAvailable: true });
    expect(sources.snapshot().failure).toBeNull();
    sources.update("read", {
      ...read,
      error: undefined,
      retryAvailable: true,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(retry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an interrupted silent retry to waiting without counting an offline failure", async () => {
    const sources = new WorkbenchStatusSources();
    let settle!: () => void;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const read = { error: "read failed", pending: false, retry };
    sources.update("read", read);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(retry).toHaveBeenCalledTimes(1);
    sources.update("read", { ...read, retryAvailable: false });
    expect(vi.getTimerCount()).toBe(0);
    settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sources.snapshot().failure).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
    retry.mockImplementation(async () => {
      sources.update("read", { pending: false, retry, retryAvailable: true });
    });
    sources.update("read", { ...read, retryAvailable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledTimes(2);
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

  it("publishes persistent information immediately without retrying its action", async () => {
    const sources = new WorkbenchStatusSources();
    const run = vi.fn();
    const notice = {
      tone: "neutral" as const,
      message: "Shallow Git history",
      action: {
        label: "Fetch full history",
        busyLabel: "Fetching…",
        busy: false,
        run,
      },
    };
    sources.update("history", { pending: false, notice });
    expect(sources.snapshot().notice).toBe(notice);
    expect(sources.snapshot().failure).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources.snapshot().notice).toBe(notice);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    sources.update("history", { pending: false, notice, active: false });
    expect(sources.snapshot().notice).toBeNull();
  });

  it("hides information behind every read failure, including a quiet first failure", async () => {
    const sources = new WorkbenchStatusSources();
    const notice = { tone: "neutral" as const, message: "Shallow Git history" };
    const retry = vi.fn(async () => {});
    sources.update("history", { pending: false, notice });
    sources.update("read", { pending: false, error: "read failed", retry });
    expect(sources.snapshot().failure).toBeNull();
    expect(sources.snapshot().notice).toBeNull();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sources.snapshot().failure).toBe("read failed");
    expect(sources.snapshot().notice).toBeNull();
    sources.update("read", { pending: false, retry });
    expect(sources.snapshot().failure).toBeNull();
    expect(sources.snapshot().notice).toBe(notice);
  });
});
