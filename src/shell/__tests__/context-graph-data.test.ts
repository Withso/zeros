// The Context tab's data cache, under the one race that matters to it:
// attach-time staging fires its change signal while the tab's own listing can
// still be in flight (activation + scaffold + list is two bridge round trips,
// and the write IPC often lands inside that window on a fresh workspace).
//
// KeyedAsyncCache dedups a forced load into a non-stale pending request, so
// `loadContextGraph(cwd, { force: true })` alone would (a) be satisfied by the
// PRE-write listing and (b) let that listing publish as fresh — the staged
// attachment stayed invisible until the next unrelated refresh. The contract
// pinned here: a forced load invalidates first, so the stale in-flight
// response is never published and one follow-up fetch runs after it settles.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listContextGraph = vi.fn();
const scaffoldContextGraph = vi.fn();

vi.mock("@/native/context-graph", () => ({
  listContextGraph: (...args: unknown[]) => listContextGraph(...args),
  scaffoldContextGraph: (...args: unknown[]) => scaffoldContextGraph(...args),
}));

import {
  contextGraphKey,
  loadContextGraph,
  resetContextGraphCacheForTests,
} from "../column3-tabs/context-graph-data";

const EMPTY = { exists: true, items: [], truncated: false };
const ONE = {
  exists: true,
  items: [
    {
      relPath: ".context-graph/local/attachments/att-1/shot.png",
      name: "shot.png",
      scope: "local" as const,
      category: "attachment" as const,
      kind: "image" as const,
      bytes: 13,
      mtimeMs: 1,
      attachmentId: "att-1",
    },
  ],
  truncated: false,
};

beforeEach(() => {
  resetContextGraphCacheForTests();
  scaffoldContextGraph.mockReset().mockResolvedValue({ ok: true, created: false });
  listContextGraph.mockReset();
});

afterEach(() => {
  resetContextGraphCacheForTests();
});

describe("contextGraphKey", () => {
  it("normalizes trailing separators so writer and reader agree", () => {
    expect(contextGraphKey("/repo/worktree/")).toBe("/repo/worktree");
    expect(contextGraphKey("/repo/worktree")).toBe("/repo/worktree");
    expect(contextGraphKey("/")).toBe("/");
  });
});

describe("loadContextGraph with force during an in-flight listing", () => {
  it("re-fetches after the stale request settles and publishes the fresh result", async () => {
    // First listing hangs (the tab's activation read), started BEFORE the
    // attachment write landed on disk.
    let releaseFirst!: () => void;
    listContextGraph
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(EMPTY);
          }),
      )
      // Any listing after the write sees the staged attachment.
      .mockResolvedValue(ONE);

    const initial = loadContextGraph("/w");
    await vi.waitFor(() => expect(listContextGraph).toHaveBeenCalledTimes(1));

    // The write signal: force reload while the stale read is still pending.
    const forced = loadContextGraph("/w", { force: true });
    releaseFirst();
    await initial.catch(() => {});

    const fresh = await forced;
    expect(fresh).toEqual(ONE);
    expect(listContextGraph).toHaveBeenCalledTimes(2);

    // The stale EMPTY listing must not have been published over the fresh
    // one: a plain follow-up read (no force, no pending) serves the cache's
    // settled snapshot's data or refetches — either way it reports the item.
    const settled = await loadContextGraph("/w");
    expect(settled).toEqual(ONE);
  });

  it("shares one request among concurrent non-forced callers", async () => {
    listContextGraph.mockResolvedValue(EMPTY);
    await Promise.all([loadContextGraph("/w"), loadContextGraph("/w")]);
    expect(listContextGraph).toHaveBeenCalledTimes(1);
  });
});
