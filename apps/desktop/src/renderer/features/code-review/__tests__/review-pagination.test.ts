import { describe, expect, it } from "vitest";
import type { CodeReviewThread } from "@zeros/protocol/code-review";
import {
  createCodeReviewCache,
  publishCodeReviewPage,
  publishCodeReviewThread,
  type CodeReviewCollection,
} from "../review-cache";

function thread(
  sequences: number[],
  count = 130,
  version = 1,
  cursor = "next-thread",
): CodeReviewThread {
  return {
    id: "t",
    workspaceId: "w",
    anchor: {
      path: "a.ts",
      side: "file",
      startLine: 1,
      endLine: 1,
      revision: "r",
    },
    comments: sequences.map((sequence) => ({
      id: `c-${sequence}`,
      sequence,
      author: { id: "viewer", name: "Author", kind: "human" },
      body: `Reply ${sequence}`,
      createdAt: sequence,
    })),
    commentCount: count,
    commentsComplete: sequences.length === count,
    commentsCursor: cursor,
    resolved: false,
    version,
    createdAt: 1,
    updatedAt: version,
  };
}
const collection = (
  threads: CodeReviewThread[],
  nextCursor = "workspace-next",
): CodeReviewCollection => ({
  workspaceId: "w",
  threads,
  partial: true,
  nextCursor,
  viewerActorId: "viewer",
});

describe("workspace review pagination", () => {
  it("covers 200 comments without skipping a mutation-preview gap or losing the outer page", () => {
    const cache = createCodeReviewCache();
    const range = (start: number, end: number) =>
      Array.from({ length: end - start + 1 }, (_, index) => start + index);
    const chunk = (start: number, end: number, version = 1) => ({
      ...thread(range(start, end), 200, version, `after-${end}`),
      commentsCursorAfter: end,
    });
    cache.setData("a", collection([chunk(1, 64)]));
    publishCodeReviewPage(
      cache,
      "a",
      {
        workspaceId: "w",
        threads: [chunk(65, 128)],
        partial: true,
        nextCursor: "after-128",
      },
      { threadId: "t", cursor: "after-64" },
    );
    expect(cache.getSnapshot("a").data?.threads[0]?.commentsCursor).toBe(
      "after-128",
    );
    publishCodeReviewThread(cache, "a", {
      ...thread([1, 200], 200, 2, "after-1"),
      commentsCursorAfter: 1,
    });
    expect(cache.getSnapshot("a").data?.threads[0]?.commentsCursor).toBe(
      "after-128",
    );
    publishCodeReviewPage(
      cache,
      "a",
      {
        workspaceId: "w",
        threads: [chunk(129, 192)],
        partial: true,
        nextCursor: "after-192",
      },
      { threadId: "t", cursor: "after-128" },
    );
    expect(cache.getSnapshot("a").data?.threads[0]?.commentsCursor).toBe(
      "after-192",
    );
    publishCodeReviewPage(
      cache,
      "a",
      { workspaceId: "w", threads: [chunk(193, 200)], partial: false },
      { threadId: "t", cursor: "after-192" },
    );
    const current = cache.getSnapshot("a").data!;
    expect(current.nextCursor).toBe("workspace-next");
    expect(current.threads[0]).toMatchObject({
      version: 2,
      commentsComplete: true,
      commentCount: 200,
    });
    expect(
      current.threads[0]?.comments.map((comment) => comment.sequence),
    ).toEqual(range(1, 200));
    expect(current.threads[0]?.commentsCursor).toBeUndefined();
  });
  it("keeps an empty authorized page's explicit continuation", () => {
    const cache = createCodeReviewCache();
    cache.setData("a", collection([]));
    expect(cache.getSnapshot("a").data).toMatchObject({
      threads: [],
      partial: true,
      nextCursor: "workspace-next",
      viewerActorId: "viewer",
    });
  });

  it("merges repeated thread chunks and advances only the matching collection cursor", () => {
    const cache = createCodeReviewCache();
    cache.setData("a", collection([thread([1, 2], 5)]));
    publishCodeReviewPage(
      cache,
      "a",
      {
        workspaceId: "w",
        threads: [thread([3, 4], 5)],
        partial: true,
        nextCursor: "workspace-last",
      },
      { cursor: "workspace-next" },
    );
    expect(
      cache
        .getSnapshot("a")
        .data?.threads[0]?.comments.map((comment) => comment.sequence),
    ).toEqual([1, 2, 3, 4]);
    expect(cache.getSnapshot("a").data?.nextCursor).toBe("workspace-last");
    publishCodeReviewPage(
      cache,
      "a",
      { workspaceId: "w", threads: [thread([5], 5)], partial: false },
      { cursor: "workspace-next" },
    );
    expect(cache.getSnapshot("a").data?.nextCursor).toBe("workspace-last");
    expect(cache.getSnapshot("a").data?.threads[0]?.commentsComplete).toBe(
      true,
    );
  });

  it("preserves loaded history after a bounded mutation preview and an older refresh", async () => {
    const cache = createCodeReviewCache();
    const loaded = thread(
      Array.from({ length: 100 }, (_, index) => index + 1),
      101,
      2,
    );
    cache.setData("a", collection([loaded]));
    publishCodeReviewThread(cache, "a", thread([1, 101], 101, 3));
    await cache.load("a", async () => collection([thread([1, 2], 101, 2)]), {
      force: true,
    });
    const current = cache.getSnapshot("a").data!.threads[0]!;
    expect(current.version).toBe(3);
    expect(current.comments).toHaveLength(101);
    expect(current.commentsComplete).toBe(true);
  });

  it("keeps per-thread pagination independent and progresses through multiple chunks", () => {
    const cache = createCodeReviewCache();
    cache.setData("a", collection([thread([1, 5], 5, 2, "thread-two")]));
    publishCodeReviewPage(
      cache,
      "a",
      {
        workspaceId: "w",
        threads: [thread([2, 3], 5, 2, "thread-four")],
        partial: true,
        nextCursor: "thread-four",
      },
      { threadId: "t", cursor: "thread-two" },
    );
    expect(cache.getSnapshot("a").data?.nextCursor).toBe("workspace-next");
    expect(cache.getSnapshot("a").data?.threads[0]?.commentsCursor).toBe(
      "thread-four",
    );
    publishCodeReviewPage(
      cache,
      "a",
      { workspaceId: "w", threads: [thread([4, 5], 5, 2)], partial: false },
      { threadId: "t", cursor: "thread-four" },
    );
    expect(cache.getSnapshot("a").data?.threads[0]).toMatchObject({
      commentsComplete: true,
      commentCount: 5,
    });
    expect(
      cache.getSnapshot("a").data?.threads[0]?.commentsCursor,
    ).toBeUndefined();
  });
});
