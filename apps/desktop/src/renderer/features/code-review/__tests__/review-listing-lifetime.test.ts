import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodeReviewListResult,
  CodeReviewThread,
} from "@zeros/protocol/code-review";
import { listCodeReviewThreads } from "@/renderer/platform/bridge/code-review-bridge";
import { codeReviewCache, codeReviewCacheKey } from "../review-cache";
import { forgetReviewCachesForFolders } from "../review-cache-forget";
import { loadCodeReview, loadCodeReviewPage } from "../use-code-review";

vi.mock("@/renderer/platform/bridge/code-review-bridge", () => ({
  listCodeReviewThreads: vi.fn(),
  createCodeReviewThread: vi.fn(),
  replyCodeReviewThread: vi.fn(),
  setCodeReviewThreadResolved: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function thread(id: string): CodeReviewThread {
  return {
    id,
    workspaceId: "workspace",
    anchor: {
      path: id === "revoked" ? "nested/old.ts" : `outer/${id}.ts`,
      side: "file",
      startLine: 1,
      endLine: 1,
      revision: "r",
    },
    comments: [
      {
        id: `${id}-comment`,
        author: { id: "author", name: "Reviewer", kind: "human" },
        body: id,
        createdAt: 1,
      },
    ],
    resolved: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
function page(
  threads: CodeReviewThread[],
  nextCursor?: string,
): CodeReviewListResult {
  return {
    workspaceId: "workspace",
    threads,
    partial: nextCursor !== undefined,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
const key = codeReviewCacheKey("/repo/worktree", "workspace");
const cursor = "same-opaque-cursor";
const visible = Array.from({ length: 50 }, (_, index) =>
  thread(`visible-${index}`),
);

beforeEach(() => {
  forgetReviewCachesForFolders(() => true);
  codeReviewCache.clear();
  vi.resetAllMocks();
});

describe("workspace review listing pass lifetime", () => {
  it("does not share or publish an older pass continuation when a refresh reuses its cursor", async () => {
    const oldPage = deferred<CodeReviewListResult>();
    const newPage = deferred<CodeReviewListResult>();
    let continuationReads = 0;
    vi.mocked(listCodeReviewThreads).mockImplementation(async (input) => {
      if (!input.cursor) return page(visible, cursor);
      continuationReads++;
      return continuationReads === 1 ? oldPage.promise : newPage.promise;
    });
    await loadCodeReview(key);
    const old = loadCodeReviewPage(key, { cursor });
    await vi.waitFor(() => expect(continuationReads).toBe(1));
    await loadCodeReview(key, true);
    const current = loadCodeReviewPage(key, { cursor });
    const shared = loadCodeReviewPage(key, { cursor });
    try {
      oldPage.resolve(page([thread("revoked")]));
      await old;
      expect(
        codeReviewCache.peekSnapshot(key).data?.threads.map((item) => item.id),
      ).toEqual(visible.map((item) => item.id));
      expect(codeReviewCache.peekSnapshot(key).data?.partial).toBe(true);
      expect(continuationReads).toBe(2);
    } finally {
      newPage.resolve(page([]));
      await Promise.allSettled([old, current, shared]);
    }
    expect(codeReviewCache.peekSnapshot(key).data?.threads).toHaveLength(50);
    expect(codeReviewCache.peekSnapshot(key).data?.partial).toBe(false);
  });

  it("does not let an old page supersede a newer first-page read before that read settles", async () => {
    const oldPage = deferred<CodeReviewListResult>();
    const refreshed = deferred<CodeReviewListResult>();
    vi.mocked(listCodeReviewThreads)
      .mockResolvedValueOnce(page([thread("revoked")], cursor))
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(refreshed.promise);
    await loadCodeReview(key);
    const old = loadCodeReviewPage(key, { cursor });
    await vi.waitFor(() =>
      expect(listCodeReviewThreads).toHaveBeenCalledTimes(2),
    );
    const refresh = loadCodeReview(key, true);
    await vi.waitFor(() =>
      expect(listCodeReviewThreads).toHaveBeenCalledTimes(3),
    );
    oldPage.resolve(page([]));
    await old;
    refreshed.resolve(page([]));
    await refresh;
    expect(codeReviewCache.peekSnapshot(key).data?.threads).toEqual([]);
    expect(codeReviewCache.peekSnapshot(key).data?.partial).toBe(false);
  });

  it("keeps the confirmed listing loadable after a refresh fails", async () => {
    vi.mocked(listCodeReviewThreads)
      .mockResolvedValueOnce(page([thread("visible")], cursor))
      .mockRejectedValueOnce(new Error("Refresh failed"))
      .mockResolvedValueOnce(page([]));
    await loadCodeReview(key);
    await expect(loadCodeReview(key, true)).rejects.toThrow("Refresh failed");
    await loadCodeReviewPage(key, { cursor });
    expect(
      codeReviewCache.peekSnapshot(key).data?.threads.map((item) => item.id),
    ).toEqual(["visible"]);
    expect(codeReviewCache.peekSnapshot(key).data?.partial).toBe(false);
  });

  it.each([false, true])(
    "does not let a continuation clear a workspace invalidation (requestedAfter=%s)",
    async (afterInvalidation) => {
      const continuation = deferred<CodeReviewListResult>();
      let rootReads = 0;
      vi.mocked(listCodeReviewThreads).mockImplementation(async (input) => {
        if (input.cursor) return continuation.promise;
        rootReads++;
        return rootReads === 1 ? page([thread("revoked")], cursor) : page([]);
      });
      await loadCodeReview(key);
      if (afterInvalidation) codeReviewCache.invalidate(key);
      const old = loadCodeReviewPage(key, { cursor });
      if (!afterInvalidation) {
        await vi.waitFor(() =>
          expect(listCodeReviewThreads).toHaveBeenCalledTimes(2),
        );
        codeReviewCache.invalidate(key);
      }
      continuation.resolve(page([thread("revoked")]));
      await old;
      // A normal next consumer must still revalidate the first page instead
      // of treating the continuation's publication as a fresh workspace list.
      await loadCodeReview(key);
      expect(rootReads).toBe(2);
      expect(codeReviewCache.peekSnapshot(key).data?.threads).toEqual([]);
    },
  );
});
