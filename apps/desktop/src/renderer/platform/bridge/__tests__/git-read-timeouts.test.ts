import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeGitStatus,
  bridgeGitChangeCounts,
  bridgeGitChangeLineCounts,
  bridgeGitHasChanges,
  bridgeGitDiff,
  bridgeGitShow,
  bridgeGitLog,
  workspaceOp,
} from "../workspace-bridge";
import type { RuntimeClient } from "../ws-client";

const reads = [
  ["git.status", (bridge: RuntimeClient) => bridgeGitStatus(bridge, "ws-a")],
  [
    "git.changeCounts",
    (bridge: RuntimeClient) => bridgeGitChangeCounts(bridge, "ws-a"),
  ],
  [
    "git.changeLineCounts",
    (bridge: RuntimeClient) => bridgeGitChangeLineCounts(bridge, "ws-a"),
  ],
  [
    "git.hasChanges",
    (bridge: RuntimeClient) => bridgeGitHasChanges(bridge, "ws-a"),
  ],
  [
    "git.diff",
    (bridge: RuntimeClient) =>
      bridgeGitDiff(bridge, {
        workspaceId: "ws-a",
        mode: "worktree-vs-base",
        rawPatch: true,
      }),
  ],
  [
    "git.show",
    (bridge: RuntimeClient) =>
      bridgeGitShow(bridge, { workspaceId: "ws-a", sha: "a".repeat(40) }),
  ],
  [
    "git.log",
    (bridge: RuntimeClient) => bridgeGitLog(bridge, { workspaceId: "ws-a" }),
  ],
] as const;

/** Simulate a busy engine using the budget the helper supplies to the transport. */
function slowBridge(delayMs: number) {
  return {
    request: (message: { op: string }, timeoutMs: number) =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearTimeout(response);
          reject(new Error("Request timeout: WORKSPACE_REQUEST"));
        }, timeoutMs);
        const response = setTimeout(() => {
          clearTimeout(deadline);
          resolve({ type: "WORKSPACE_RESPONSE", op: message.op, result: {} });
        }, delayMs);
      }),
  } as unknown as RuntimeClient;
}

afterEach(() => vi.useRealTimers());

describe("Changes Git read budgets", () => {
  it.each(reads)(
    "keeps a slow %s pending through the old 10s cutoff",
    async (_op, read) => {
      vi.useFakeTimers();
      const failed = vi.fn();
      const completed = vi.fn();
      const request = read(slowBridge(45_000)).then(completed, failed);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(failed).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(35_000);
      await request;
      expect(completed).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
    },
  );

  it.each(reads)("still bounds a stalled %s", async (_op, read) => {
    vi.useFakeTimers();
    const request = read(slowBridge(120_000)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await request).toEqual(
      new Error("Request timeout: WORKSPACE_REQUEST"),
    );
  });

  it("keeps the ordinary workspace read default at 10s", async () => {
    vi.useFakeTimers();
    const request = workspaceOp(slowBridge(45_000), "chats.list").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await request).toEqual(
      new Error("Request timeout: WORKSPACE_REQUEST"),
    );
  });
});
