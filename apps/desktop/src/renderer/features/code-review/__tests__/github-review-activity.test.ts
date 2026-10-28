import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchStatusSources, describeWorkbenchFailure } from "../../../shell/workbench/tab-status-model";

const fixture = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, read: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../../platform/github-review", () => ({
  getPrInlineReview: fixture.read, postPrLineComment: vi.fn(), replyPrReviewThread: vi.fn(), setPrReviewThreadResolved: vi.fn(),
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: () => () => {} }));
let useGithubReview: typeof import("../use-github-review").useGithubReview;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
const cleanups: Array<() => void> = [];
function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
function Fixture(cwd = "/personal/project", workspaceId = "personal-workspace", active = true) {
  const value = useGithubReview({ cwd, workspaceId, prNumber: 42, active });
  for (const effect of fixture.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return value;
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  fixture.effects.length = 0; fixture.read.mockReset().mockResolvedValue({ headSha: "a", baseSha: "b", threads: [], annotations: [] });
  ({ useGithubReview } = await import("../use-github-review"));
  focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page); vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { unmount(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Local inline review activity", () => {
  it.each([
    ["/personal/project", "hidden"], ["/personal/project", "blurred"],
    ["/organization/project", "hidden"], ["/organization/project", "blurred"],
  ])("keeps %s inert while %s", async (cwd, mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    Fixture(cwd); await vi.advanceTimersByTimeAsync(60_000);
    console.info(JSON.stringify({ mode, cwd, reads: fixture.read.mock.calls.length, timers: vi.getTimerCount() }));
    expect(fixture.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains confirmed data through blur and reads once on return", async () => {
    Fixture(); await vi.advanceTimersByTimeAsync(0); unmount();
    focused = false;
    const retained = Fixture().snapshot;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    unmount(); focused = true;
    expect(Fixture().snapshot).toBe(retained);
    await vi.advanceTimersByTimeAsync(0); expect(fixture.read).toHaveBeenCalledTimes(2);
  });
  it.each(["hidden", "blurred", "visible"])("keeps unavailable cloud inline review inert while %s", async mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    const review = Fixture("cloud://organization/workspace", "cloud://organization/workspace");
    await review.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(review.source).toBeUndefined();
  });

  it.each([
    ["cloud://organization/workspace", "workspace"],
    ["/checkout", "cloud://organization/workspace"],
    ["/checkout", "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:workspace"],
  ])("does not publish stale unsupported errors for %s / %s", async (cwd, workspaceId) => {
    const { githubReviewCache, githubReviewKey } = await import("../github-review-cache");
    await githubReviewCache.load(githubReviewKey(workspaceId, 42), async () => {
      throw new Error("CLOUD_V2_UNSUPPORTED");
    }).catch(() => {});
    const review = Fixture(cwd, workspaceId);
    const status = new WorkbenchStatusSources();
    status.update("changes", { primary: true, hasContent: true, pending: false });
    status.update("comparison-sources", { error: review.source?.error, pending: false });
    expect(status.snapshot()).toMatchObject({ hasContent: true, failure: null, pending: false });
    expect(review.source).toBeUndefined();
    // Genuine Git failures still own the banner even with loaded diffs.
    status.update("changes", { primary: true, hasContent: true, pending: false, error: "Git read failed" });
    expect(describeWorkbenchFailure("changes", status.snapshot().failure)).toMatchObject({
      message: "Couldn't load changes.", action: "Retry", diagnostic: "Git read failed",
    });
  });

  it.each(["/personal/project", "/organization/project"])("keeps real inline-review failures visible in %s", async cwd => {
    fixture.read.mockRejectedValue(new Error("GitHub read denied"));
    Fixture(cwd); await vi.advanceTimersByTimeAsync(0); unmount();
    expect(Fixture(cwd).source?.error).toBe("GitHub read denied");
    expect(fixture.read).toHaveBeenCalled();
  });

  // A signed-out or refused GitHub connection is not a file, Changes or Review
  // read failure: those reads succeeded. Retry cannot fix it; Settings can.
  it.each([
    ["/personal/project", "NOT_AUTHENTICATED", "Not signed in to GitHub",
      "Connect GitHub in Settings → Integrations to show pull request comments."],
    ["/organization/project", "NOT_AUTHENTICATED", "GitHub no longer accepts this connection.",
      "Connect GitHub in Settings → Integrations to show pull request comments."],
    ["/personal/project", "GITHUB_SSO_REQUIRED", "GitHub requires organization sign-in for this connection.",
      "Check your GitHub connection in Settings → Integrations to show pull request comments."],
    ["/organization/project", "GITHUB_REPO_NOT_INSTALLED", "This repository is not available to the selected connection.",
      "Check your GitHub connection in Settings → Integrations to show pull request comments."],
  ])("shows a connection notice instead of a load failure in %s for %s", async (cwd, code, message, notice) => {
    fixture.read.mockRejectedValue(Object.assign(new Error(message), { code }));
    Fixture(cwd); await vi.advanceTimersByTimeAsync(0); unmount();
    const review = Fixture(cwd);
    expect(review.error).toBeUndefined();
    expect(review.notice).toBe(notice);
    expect(review.source).toMatchObject({ notice });
    expect(review.source).not.toHaveProperty("error");
    for (const [tab, source] of [["files", "github-comments"], ["changes", "comparison-sources"], ["review", "review-resources"]] as const) {
      const status = new WorkbenchStatusSources();
      status.update(tab, { primary: true, hasContent: true, pending: false });
      status.update(source, { error: review.source?.error, pending: false, retry: review.refresh });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(status.snapshot()).toMatchObject({ hasContent: true, failure: null });
    }
    expect(fixture.read).toHaveBeenCalled();
  });

  it("restores exact Local review data across a cloud visit without a cloud read", async () => {
    Fixture(); await vi.advanceTimersByTimeAsync(0); unmount();
    const confirmed = Fixture().snapshot; unmount();
    expect(Fixture("cloud://organization/workspace", "cloud://organization/workspace").source).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0); unmount();
    expect(Fixture().snapshot).toBe(confirmed);
    expect(fixture.read).toHaveBeenCalledExactlyOnceWith({ workspaceId: "personal-workspace", prNumber: 42 });
  });
});
