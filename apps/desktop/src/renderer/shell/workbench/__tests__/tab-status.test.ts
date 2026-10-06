import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TAB_TYPE_META, type WorkbenchTabType } from "../tab-model";
import {
  describeWorkbenchFailure,
  describeWorkbenchEmptyState,
  describeWorkspaceAvailability,
  WorkbenchStatusSources,
  workbenchStatusKey,
  WORKBENCH_STATUS_ADAPTERS,
} from "../tab-status-model";
import { WorkbenchEmptyState, WorkbenchTabBanner } from "../tab-status";

describe("workbench status contract", () => {
  it("offers a neutral notice only below errors and renders its action once", () => {
    const sources = new WorkbenchStatusSources();
    const action = { label: "Fetch full history", busyLabel: "Fetching…", run: vi.fn(), busy: true };
    const notice = { tone: "neutral" as const, message: "Shallow Git history — older commits and comparisons may be incomplete.", action };
    sources.update("history", { pending: false, notice });
    expect(sources.snapshot().notice).toBe(notice);
    const markup = renderToStaticMarkup(createElement(WorkbenchTabBanner, {
      type: "changes", status: { tone: notice.tone, message: notice.message }, active: true, busy: true, retry: vi.fn(), noticeAction: action,
    }));
    expect(markup.match(/data-workbench-banner=/g)).toHaveLength(1);
    expect(markup).toContain('data-tone="neutral"');
    expect(markup).toContain('aria-label="Fetch full history"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Fetching…");
    sources.update("read", { pending: false, error: "read failed" });
    expect(sources.snapshot().notice).toBeNull();
    sources.remove("read");
    expect(sources.snapshot().notice).toBe(notice);
    sources.update("history", { pending: false, notice, active: false });
    expect(sources.snapshot().notice).toBeNull();
  });

  it.each(Object.keys(TAB_TYPE_META) as WorkbenchTabType[])(
    "gives %s one banner and a quiet centre",
    (type) => {
      const status = describeWorkbenchFailure(
        type,
        new Error("Error: WORKSPACE_REQUEST failed\n    at bridge.ts:12"),
      );
      const banner = renderToStaticMarkup(
        createElement(WorkbenchTabBanner, {
          status,
          active: true,
          retry: () => {},
          busy: false,
          type,
        }),
      );
      const empty = renderToStaticMarkup(
        createElement(WorkbenchEmptyState, { type }),
      );
      expect(banner.match(/data-workbench-banner=/g)).toHaveLength(1);
      expect(banner).toContain('aria-label="Retry loading');
      expect(banner).toContain("line-clamp-2");
      expect(status.message).not.toContain("WORKSPACE_REQUEST");
      expect(empty).toContain("text-fg2");
      expect(empty).toContain("size-10");
      expect(empty).not.toContain("<button");
      expect(empty).not.toContain("text-red");
      for (const message of Object.values(
        WORKBENCH_STATUS_ADAPTERS[type].empty,
      ))
        expect(message.split(/\s+/).length).toBeLessThanOrEqual(9);
    },
  );

  it("presents human copy and sanitizes diagnostic secrets", () => {
    const status = describeWorkbenchFailure(
      "files",
      "Error: Request timeout: engine disconnected Bearer secret-value",
    );
    expect(status.message).toBe("Files took too long to load.");
    expect(status.diagnostic).not.toContain("secret-value");
    expect(
      describeWorkbenchFailure(
        "design",
        "Error: Cloud workspace is setting_up. Wait for setup",
      ),
    ).toMatchObject({
      tone: "pending",
      message: "This cloud workspace is still setting up.",
    });
    expect(
      describeWorkbenchFailure("design", "Cloud workspace is setting_up")
        .action,
    ).toBeUndefined();
  });

  it("prioritizes availability and uses timestamps for reconnect grace and escalation", () => {
    expect(
      describeWorkspaceAvailability(
        {
          cloud: true,
          state: "setting_up",
          connection: "disconnected",
          since: 0,
        },
        25_000,
      ),
    ).toMatchObject({
      tone: "pending",
      message: "This cloud workspace is still setting up.",
    });
    const lost = {
      cloud: true,
      connection: "disconnected" as const,
      since: 100,
      previouslyConnected: true,
    };
    expect(describeWorkspaceAvailability(lost, 2_099)).toBeNull();
    expect(describeWorkspaceAvailability(lost, 2_100)?.message).toBe(
      "Reconnecting to the workspace…",
    );
    expect(describeWorkspaceAvailability(lost, 20_100)).toMatchObject({
      tone: "error",
      message: "Can't reach the workspace.",
      action: "Retry",
    });
    expect(
      describeWorkspaceAvailability(
        { ...lost, connection: "connected" },
        20_100,
      ),
    ).toBeNull();
    expect(
      describeWorkspaceAvailability({ ...lost, rejected: true }, 101)?.tone,
    ).toBe("error");
    expect(
      describeWorkspaceAvailability({ ...lost, cloud: false }, 20_100)?.message,
    ).toBe("Can't reach the Zeros engine.");
  });

  it("makes archived workspaces neutral and never offers a passive wake", () => {
    expect(
      describeWorkspaceAvailability(
        {
          cloud: true,
          state: "archived",
          connection: "disconnected",
          since: 0,
        },
        0,
      ),
    ).toMatchObject({ tone: "neutral" });
    expect(
      describeWorkspaceAvailability(
        { cloud: true, state: "stopped", connection: "disconnected", since: 0 },
        0,
      )?.action,
    ).toBeUndefined();
  });

  it.each(Object.keys(TAB_TYPE_META) as WorkbenchTabType[])(
    "gives %s distinct pending, retryable and unavailable empty copy",
    (type) => {
      const adapter = WORKBENCH_STATUS_ADAPTERS[type];
      expect(Object.keys(adapter.empty).sort()).toEqual([
        "pending",
        "retryable",
        "unavailable",
      ]);
      expect(
        describeWorkbenchEmptyState(type, {
          tone: "pending",
          message: "Starting…",
        }),
      ).toBe(adapter.empty.pending);
      expect(adapter.empty.pending).toContain("when the workspace is ready.");
      expect(
        describeWorkbenchEmptyState(
          type,
          describeWorkbenchFailure(type, "failed"),
        ),
      ).toBe(adapter.empty.retryable);
      expect(adapter.empty.retryable).toMatch(/retry/i);
      for (const status of [
        { tone: "neutral" as const, message: "Archived." },
        {
          tone: "error" as const,
          message: "Setup failed.",
          action: "Open Setup" as const,
        },
      ])
        expect(describeWorkbenchEmptyState(type, status)).toBe(
          adapter.empty.unavailable,
        );
      expect(adapter.empty.unavailable).not.toMatch(/retry/i);
    },
  );

  it("uses file-specific copy for a single-file target", () => {
    const status = describeWorkbenchFailure("files", "Request timeout", true);
    expect(status.message).toBe("This file took too long to load.");
    expect(describeWorkbenchEmptyState("files", status, true)).toBe(
      "Retry to load this file.",
    );
    expect(describeWorkbenchFailure("files", "read failed", true).message).toBe(
      "Couldn't load this file.",
    );
  });

  it.each([true, false])(
    "graces the first connection and uses connecting copy (cloud=%s)",
    (cloud) => {
      const cold = { cloud, connection: "connecting" as const, since: 100 };
      expect(describeWorkspaceAvailability(cold, 2_099)).toBeNull();
      expect(describeWorkspaceAvailability(cold, 2_100)?.message).toBe(
        cloud
          ? "Connecting to the workspace…"
          : "Connecting to the Zeros engine…",
      );
      expect(describeWorkspaceAvailability(cold, 20_100)?.tone).toBe("error");
      expect(
        describeWorkbenchEmptyState(
          "terminal",
          describeWorkspaceAvailability(cold, 2_100),
        ),
      ).toBe("The terminal opens when the workspace is ready.");
      expect(
        describeWorkbenchEmptyState(
          "terminal",
          describeWorkspaceAvailability(
            { ...cold, previouslyConnected: true },
            2_100,
          ),
        ),
      ).toBe("Terminal reconnects automatically.");
    },
  );

  it("presents stopping separately from stopped", () => {
    expect(
      describeWorkspaceAvailability(
        { cloud: true, state: "stopping", connection: "connected", since: 0 },
        0,
      ),
    ).toMatchObject({
      tone: "pending",
      message: "Stopping the cloud workspace…",
    });
  });

  it("keeps the last failure through retry, clears on recovery, and shows recurrence", async () => {
    const sources = new WorkbenchStatusSources();
    sources.update("files", {
      error: "read failed",
      pending: false,
      primary: true,
    });
    sources.update("files", { error: null, pending: true, primary: true });
    expect(sources.snapshot().failure).toBe("read failed");
    sources.update("files", {
      error: null,
      pending: false,
      primary: true,
      hasContent: true,
    });
    expect(sources.snapshot()).toMatchObject({
      failure: null,
      hasContent: true,
    });
    sources.update("files", {
      error: "read failed",
      pending: false,
      primary: true,
      hasContent: true,
    });
    expect(sources.snapshot()).toMatchObject({
      failure: "read failed",
      hasContent: true,
    });
  });

  it("shares a single retry flight and retries every failed source", async () => {
    const sources = new WorkbenchStatusSources();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const primary = vi.fn(() => pending);
    const secondary = vi.fn(async () => {});
    sources.update("primary", {
      error: "primary",
      primary: true,
      pending: false,
      retry: primary,
    });
    sources.update("secondary", {
      error: "secondary",
      pending: false,
      retry: secondary,
    });
    const a = sources.retry();
    const b = sources.retry();
    expect(a).toBe(b);
    expect(sources.snapshot().busy).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    resolve();
    await a;
    expect(sources.snapshot().busy).toBe(false);
  });

  it("reconnects an unavailable frame even before it has data sources", async () => {
    const sources = new WorkbenchStatusSources();
    const reconnect = vi.fn(async () => {});
    await sources.retry(reconnect);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(sources.snapshot().busy).toBe(false);
  });

  it("isolates workspace and comparison keys", () => {
    const tab = {
      id: "changes",
      type: "changes" as const,
      title: "Changes",
      diffScope: "staged" as const,
    };
    expect(workbenchStatusKey("/a", tab)).not.toBe(
      workbenchStatusKey("/b", tab),
    );
    expect(workbenchStatusKey("/a", tab)).not.toBe(
      workbenchStatusKey("/a", { ...tab, diffScope: "unstaged" }),
    );
    const old = new WorkbenchStatusSources();
    const current = new WorkbenchStatusSources();
    old.update("load", { error: "late failure", pending: false });
    expect(current.snapshot().failure).toBeNull();
  });

  it.each(["callback", "source"])(
    "bounds Retry when a %s never settles",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const sources = new WorkbenchStatusSources();
        const retry = vi.fn(() =>
          kind === "callback" ? new Promise<void>(() => {}) : Promise.resolve(),
        );
        sources.update("never", {
          primary: true,
          error: "read failed",
          pending: true,
          retry,
        });
        const flight = sources.retry();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(sources.snapshot().busy).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(sources.snapshot()).toMatchObject({
          busy: false,
          failure: "read failed",
        });
        await flight;
        expect(vi.getTimerCount()).toBe(0);
        sources.remove("never");
        await sources.retry();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "ends the Retry timer when all sources become hidden (pending=%s)",
    async (pending) => {
      vi.useFakeTimers();
      try {
        const sources = new WorkbenchStatusSources();
        sources.update("load", {
          error: pending ? "failed" : null,
          pending,
          retry: () => new Promise(() => {}),
        });
        const flight = sources.retry(() => new Promise(() => {}));
        sources.update("load", {
          error: pending ? "failed" : null,
          pending,
          active: false,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(sources.snapshot().busy).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await flight;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not announce a hidden retained tab", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkbenchTabBanner, {
        status: describeWorkbenchFailure("files", "failed"),
        active: false,
        busy: false,
        type: "files",
        retry: () => {},
      }),
    );
    expect(markup).toContain('aria-live="off"');
    expect(markup).not.toContain('role="alert"');
  });

  it("keeps hidden sources inert without losing their confirmed failure", async () => {
    const sources = new WorkbenchStatusSources();
    const hiddenRetry = vi.fn();
    sources.update("hidden", {
      error: "read failed",
      pending: true,
      active: false,
      retry: hiddenRetry,
    });
    expect(sources.snapshot()).toMatchObject({
      failure: null,
      pending: false,
    });
    await sources.retry();
    expect(hiddenRetry).not.toHaveBeenCalled();
    sources.update("hidden", { error: null, pending: true, active: false });
    expect(sources.snapshot().failure).toBeNull();
    sources.update("hidden", { error: null, pending: true, active: true });
    expect(sources.snapshot().failure).toBe("read failed");
  });

  it("does not mistake an operation verb for workspace availability", () => {
    expect(
      describeWorkbenchFailure("files", "Failed creating file"),
    ).toMatchObject({
      tone: "error",
      message: "Couldn't load files.",
      action: "Retry",
    });
  });
});
