// The Context tab's data cache, under the one race that matters to it:
// attach-time staging fires its change signal while the tab's own listing can
// still be in flight, and the write IPC can land inside that window on a fresh
// workspace. Reads must never scaffold storage or trigger migration.
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
const graphSignal = vi.hoisted(() => ({ notify: (_cwd: string) => {} }));

vi.mock("@/renderer/platform/context-graph", () => ({
  listContextGraph: (...args: unknown[]) => listContextGraph(...args),
  scaffoldContextGraph: (...args: unknown[]) => scaffoldContextGraph(...args),
  subscribeContextGraphChanged: (listener: (cwd: string) => void) => {
    graphSignal.notify = listener;
    return () => {};
  },
}));

import {
  contextGraphKey,
  loadContextGraph,
  loadContextGraphForRefresh,
  resetContextGraphCacheForTests,
} from "../workbench/tabs/context-graph-data";

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
  scaffoldContextGraph
    .mockReset()
    .mockResolvedValue({ ok: true, created: false });
  listContextGraph.mockReset();
});

afterEach(() => {
  resetContextGraphCacheForTests();
  vi.restoreAllMocks();
});

describe("contextGraphKey", () => {
  it("normalizes trailing separators so writer and reader agree", () => {
    expect(contextGraphKey("/repo/worktree/")).toBe("/repo/worktree");
    expect(contextGraphKey("/repo/worktree")).toBe("/repo/worktree");
    expect(contextGraphKey("/")).toBe("/");
  });
});

describe("loadContextGraph with force during an in-flight listing", () => {
  it("reads legacy and current context without scaffolding or migrating on open or refresh", async () => {
    listContextGraph.mockResolvedValue(ONE);
    const a = await loadContextGraph("/a");
    const b = await loadContextGraph("/b");
    expect(a).toEqual(ONE);
    expect(b).toEqual(ONE);
    expect(await loadContextGraph("/a", { force: true })).toEqual(ONE);
    expect(scaffoldContextGraph).not.toHaveBeenCalled();
  });

  it("keeps an untouched workspace empty without preparing storage", async () => {
    const absent = { exists: false, items: [], truncated: false };
    listContextGraph.mockResolvedValue(absent);
    expect(await loadContextGraph("/new")).toEqual(absent);
    expect(scaffoldContextGraph).not.toHaveBeenCalled();
  });

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

  it("shares a fresh snapshot between Summary and Context, including after reopening", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    listContextGraph.mockResolvedValue(ONE);
    await loadContextGraphForRefresh("/w", 4);
    now.mockReturnValue(2_000);
    await loadContextGraphForRefresh("/w/", 4);
    await loadContextGraph("/w");
    expect(listContextGraph).toHaveBeenCalledTimes(1);
    await loadContextGraphForRefresh("/w", 5);
    await loadContextGraphForRefresh("/w", 5);
    expect(listContextGraph).toHaveBeenCalledTimes(2);
  });

  it("keeps A and B isolated when A finishes after switching to B", async () => {
    let releaseA!: (data: typeof ONE) => void;
    listContextGraph.mockImplementation((cwd: string) =>
      cwd === "/a"
        ? new Promise((resolve) => {
            releaseA = resolve;
          })
        : Promise.resolve(EMPTY),
    );
    const a = loadContextGraphForRefresh("/a", 1);
    await loadContextGraphForRefresh("/b", 1);
    releaseA(ONE);
    await a;
    expect(await loadContextGraphForRefresh("/b", 1)).toEqual(EMPTY);
    expect(await loadContextGraphForRefresh("/a", 1)).toEqual(ONE);
    expect(listContextGraph).toHaveBeenCalledTimes(2);
  });

  it("invalidates a hidden workspace's fresh snapshot after an attachment write", async () => {
    listContextGraph.mockResolvedValue(EMPTY);
    await loadContextGraph("/w");
    listContextGraph.mockResolvedValue(ONE);
    graphSignal.notify("/w/");
    expect(listContextGraph).toHaveBeenCalledTimes(1);
    expect(await loadContextGraph("/w")).toEqual(ONE);
    expect(listContextGraph).toHaveBeenCalledTimes(2);
  });

  it("retries a failed refresh on reopen even when the retained snapshot is recent", async () => {
    listContextGraph.mockResolvedValue(EMPTY);
    await loadContextGraph("/w");
    listContextGraph.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(loadContextGraph("/w", { force: true })).rejects.toThrow(
      "Disconnected",
    );
    listContextGraph.mockResolvedValue(ONE);
    expect(await loadContextGraph("/w")).toEqual(ONE);
  });
});
