import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TAB_TYPE_META, type WorkbenchTabType } from "../tab-model";
import {
  describeWorkbenchFailure,
  describeWorkspaceAvailability,
  WorkbenchStatusSources,
  workbenchStatusKey,
  WORKBENCH_STATUS_ADAPTERS,
} from "../tab-status-model";
import { WorkbenchEmptyState, WorkbenchTabBanner } from "../tab-status";

describe("workbench status contract", () => {
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
      expect(
        WORKBENCH_STATUS_ADAPTERS[type].empty.split(/\s+/).length,
      ).toBeLessThanOrEqual(8);
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

  it("routes cloud connection failures to persistent status instead of a toast", () => {
    const source = readFileSync(
      "apps/desktop/src/renderer/state/cloud-workspace-lifecycle.tsx",
      "utf8",
    );
    expect(source).not.toContain(
      'toast.error("Couldn\'t connect to this cloud workspace"',
    );
  });

  it("does not also toast a persistent Local engine rejection", () => {
    const source = readFileSync(
      "apps/desktop/src/renderer/platform/bridge/use-bridge.tsx",
      "utf8",
    );
    expect(source).not.toContain("toast.error(copy.headline");
  });
});
