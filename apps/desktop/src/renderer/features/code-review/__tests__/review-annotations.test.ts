import { describe, expect, it } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import {
  ReviewAnnotationCache,
  reviewAnnotationVersion,
} from "../review-annotations";
import {
  anchorFromSelection,
  type ReviewCodeSnapshot,
} from "../review-anchors";
import type { CodeReviewThreadItem } from "../review-thread-model";

const file: Extract<ReviewCodeSnapshot, { kind: "file" }> = {
  kind: "file",
  path: "a.ts",
  content: "one\ntwo\nthree\n",
  revision: "r",
};
function thread(id: string, line: number, version = 1): CodeReviewThreadItem {
  return {
    id,
    source: "workspace",
    anchor: anchorFromSelection(file, { start: line, end: line })!,
    comments: [],
    resolved: false,
    version,
  };
}

describe("native review annotation identities", () => {
  it("rebuilds a native layout on resume while retaining annotation payloads", () => {
    const cache = new ReviewAnnotationCache();
    const threads = [thread("a", 1)];
    const shown = cache.forFile(file, threads, undefined, true);
    const hidden = cache.forFile(file, threads, undefined, false);
    const resumed = cache.forFile(file, threads, undefined, true);
    expect(hidden).not.toBe(shown);
    expect(resumed).not.toBe(hidden);
    expect(resumed[0]).toBe(shown[0]);
    expect(cache.forFile(file, threads, undefined, true)).toBe(resumed);
  });
  it("publishes newly loaded history at the same mutation version", () => {
    const cache = new ReviewAnnotationCache();
    const firstThread = {
      ...thread("history", 2),
      commentsComplete: false,
      commentsCursor: "next",
      commentCount: 2,
      comments: [
        {
          id: "c1",
          author: { id: "u", name: "Author", kind: "human" as const },
          body: "First",
          createdAt: 1,
        },
      ],
    };
    const first = cache.forFile(file, [firstThread]);
    const page = {
      ...firstThread,
      commentsComplete: true,
      commentsCursor: undefined,
      comments: [
        ...firstThread.comments,
        { ...firstThread.comments[0]!, id: "c2", body: "Next", createdAt: 2 },
      ],
    };
    const next = cache.forFile(file, [page]);
    expect(next).not.toBe(first);
    expect(next[0]!.metadata.threads[0]!.thread.comments).toHaveLength(2);
    expect(reviewAnnotationVersion(next)).not.toBe(
      reviewAnnotationVersion(first),
    );
  });
  it("shares unchanged items/payloads and groups threads at the same line slot", () => {
    const cache = new ReviewAnnotationCache();
    const a = thread("a", 1);
    const b = thread("b", 3);
    const first = cache.forFile(file, [a, b]);
    expect(cache.forFile(file, [a, b])).toBe(first);
    const updated = cache.forFile(file, [
      a,
      { ...b, version: 2 },
      thread("c", 3),
    ]);
    expect(updated).toHaveLength(2);
    expect(updated[0]).toBe(first[0]);
    expect(updated[1]!.metadata.id).toBe(first[1]!.metadata.id);
    expect(
      updated[1]!.metadata.threads.map(({ thread: item }) => item.id),
    ).toEqual(["b", "c"]);
    expect(reviewAnnotationVersion(updated)).not.toBe(
      reviewAnnotationVersion(first),
    );
  });

  it("does not move an original composer anchor during a source refresh", () => {
    const cache = new ReviewAnnotationCache();
    const anchor = anchorFromSelection(file, { start: 2, end: 3 })!;
    const selection = { itemId: "a.ts", anchor, mode: "composer" as const };
    const first = cache.forFile(file, [], selection);
    expect(first[0]!.lineNumber).toBe(3);
    const changed = cache.forFile(
      { ...file, revision: "r2", content: "one\nother\nthree\n" },
      [],
      selection,
    );
    expect(changed[0]!.lineNumber).toBe(0);
    expect(changed[0]!.metadata.selection?.anchor).toBe(anchor);
  });

  it("retains old and new side slots independently in unified and split views", () => {
    const fileDiff = getSingularPatch(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-one\n+two\n",
    );
    const snapshot: Extract<ReviewCodeSnapshot, { kind: "diff" }> = {
      kind: "diff",
      path: "a.ts",
      revision: "d",
      fileDiff,
    };
    const old = {
      ...thread("old", 1),
      anchor: anchorFromSelection(snapshot, {
        start: 1,
        end: 1,
        side: "deletions",
      })!,
    };
    const next = {
      ...thread("new", 1),
      anchor: anchorFromSelection(snapshot, {
        start: 1,
        end: 1,
        side: "additions",
      })!,
    };
    const annotations = new ReviewAnnotationCache().forDiff(snapshot, [
      old,
      next,
    ]);
    expect(annotations.map((entry) => [entry.side, entry.lineNumber])).toEqual([
      ["additions", 1],
      ["deletions", 1],
    ]);
    expect(annotations[0]!.metadata.id).not.toBe(annotations[1]!.metadata.id);
  });
});
