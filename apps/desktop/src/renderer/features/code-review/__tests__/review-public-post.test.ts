import { describe, expect, it, vi } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import {
  anchorFromSelection,
  type ReviewCodeSnapshot,
} from "../review-anchors";
import type { ReviewSelectionTarget } from "../review-annotations";
import {
  canPostReviewSelection,
  postCapturedReview,
} from "../review-public-post";

const revision = "github:workspace-a:pr-7:base-1:head-1";
const patch =
  "diff --git a/a.ts b/b.ts\nsimilarity index 60%\nrename from a.ts\nrename to b.ts\n--- a/a.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
const snapshot: Extract<ReviewCodeSnapshot, { kind: "diff" }> = {
  kind: "diff",
  path: "b.ts",
  revision: "patch",
  fileDiff: getSingularPatch(patch),
  confirmedRevision: revision,
};
const captured: ReviewSelectionTarget = {
  itemId: "b.ts",
  anchor: anchorFromSelection(snapshot, {
    start: 1,
    end: 1,
    side: "deletions",
  })!,
  mode: "composer",
  postToPr: true,
  confirmedRevision: revision,
};

describe("public review target fence", () => {
  it.each([
    "github:workspace-a:pr-7:base-2:head-1",
    "github:workspace-a:pr-8:base-1:head-1",
    "github:workspace-b:pr-7:base-1:head-1",
  ])(
    "rejects a retained draft after its exact revision changes to %s",
    async (changed) => {
      const postComment = vi.fn(
        async (_anchor: CodeReviewAnchor, _body: string) => {},
      );
      const external = { threads: [], confirmedRevision: changed, postComment };
      const current = { ...snapshot, confirmedRevision: changed };
      expect(canPostReviewSelection(captured, current, external)).toBe(false);
      await expect(
        postCapturedReview(captured, current, external, "Retained draft"),
      ).rejects.toThrow("PR diff changed");
      expect(postComment).not.toHaveBeenCalled();
    },
  );

  it("checks the original anchor and both current confirmations at submission", async () => {
    const postComment = vi.fn(
      async (_anchor: CodeReviewAnchor, _body: string) => {},
    );
    const external = { threads: [], confirmedRevision: revision, postComment };
    expect(canPostReviewSelection(captured, snapshot, external)).toBe(true);
    expect(
      canPostReviewSelection(
        { ...captured, anchor: { ...captured.anchor, revision: "old" } },
        snapshot,
        external,
      ),
    ).toBe(false);
    expect(
      canPostReviewSelection(captured, snapshot, {
        ...external,
        confirmedRevision: undefined,
      }),
    ).toBe(false);
    expect(
      canPostReviewSelection(
        captured,
        { ...snapshot, confirmedRevision: undefined },
        external,
      ),
    ).toBe(false);
    expect(
      canPostReviewSelection(captured, snapshot, {
        ...external,
        confirmedRevision: "another-owner",
      }),
    ).toBe(false);
  });

  it("keeps the captured old rename path for the adapter's single translation", async () => {
    const postComment = vi.fn(
      async (_anchor: CodeReviewAnchor, _body: string) => {},
    );
    const external = { threads: [], confirmedRevision: revision, postComment };
    await postCapturedReview(captured, snapshot, external, "Original side");
    expect(postComment).toHaveBeenCalledWith(captured.anchor, "Original side");
    expect(postComment.mock.calls[0]![0]).toBe(captured.anchor);
    expect(captured.anchor.path).toBe("a.ts");
  });
});

describe("posting from a local comparison (the Changes tab)", () => {
  const localPatch =
    "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const local: Extract<ReviewCodeSnapshot, { kind: "diff" }> = {
    kind: "diff",
    path: "b.ts",
    revision: "working-tree",
    fileDiff: getSingularPatch(localPatch),
  };
  const selection: ReviewSelectionTarget = {
    itemId: "b.ts",
    anchor: anchorFromSelection(local, { start: 1, end: 1, side: "additions" })!,
    mode: "composer",
    postToPr: true,
    mappedTarget: "pr-7",
  };

  it("posts through the adapter's mapped path when the diff is not the published PR diff", async () => {
    const postMappedComment = vi.fn(
      async (_anchor: CodeReviewAnchor, _body: string, _line: (line: number) => string | null, _current: () => boolean) => {},
    );
    const external = { threads: [], postMappedComment, mappedTarget: "pr-7" };
    expect(canPostReviewSelection(selection, local, external)).toBe(true);
    await postCapturedReview(selection, local, external, "Ship it");
    expect(postMappedComment).toHaveBeenCalledWith(selection.anchor, "Ship it", expect.any(Function), expect.any(Function));
    const [, , localLine, stillCurrent] = postMappedComment.mock.calls[0]! as unknown as [
      unknown, unknown, (line: number) => string | null, () => boolean,
    ];
    expect(localLine(1)).toBe("new");
    expect(localLine(5)).toBeNull();
    expect(stillCurrent()).toBe(true);
  });

  it("rechecks the live comparison, not the one that admitted the post", async () => {
    const postMappedComment = vi.fn(async () => {});
    const external = { threads: [], postMappedComment, mappedTarget: "pr-7" };
    let current: ReviewCodeSnapshot | undefined = local;
    await postCapturedReview(selection, local, external, "Ship it", () => ({ snapshot: current, external }));
    const [, , , stillCurrent] = postMappedComment.mock.calls[0]! as unknown as [unknown, unknown, unknown, () => boolean];
    current = { ...local, fileDiff: getSingularPatch("diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+changed\n") };
    expect(stillCurrent()).toBe(false);
    current = undefined;
    expect(stillCurrent()).toBe(false);
  });

  it("keeps a mapped draft on the pull request it was opened for", () => {
    const postMappedComment = vi.fn(async () => {});
    expect(
      canPostReviewSelection(selection, local, { threads: [], postMappedComment, mappedTarget: "pr-8" }),
    ).toBe(false);
    expect(
      canPostReviewSelection({ ...selection, mappedTarget: undefined }, local, { threads: [], postMappedComment, mappedTarget: "pr-7" }),
    ).toBe(false);
    // The comparison no longer shows the captured text at those lines.
    expect(
      canPostReviewSelection(
        { ...selection, anchor: { ...selection.anchor, context: "older" } },
        local,
        { threads: [], postMappedComment, mappedTarget: "pr-7" },
      ),
    ).toBe(false);
  });

  it("never posts a whole-file anchor or an anchor without captured text", () => {
    const postMappedComment = vi.fn(async () => {});
    const external = { threads: [], postMappedComment, mappedTarget: "pr-7" };
    expect(
      canPostReviewSelection(
        { ...selection, anchor: { ...selection.anchor, context: undefined } },
        local,
        external,
      ),
    ).toBe(false);
    expect(
      canPostReviewSelection(
        { ...selection, anchor: { ...selection.anchor, side: "file" } },
        local,
        external,
      ),
    ).toBe(false);
    expect(canPostReviewSelection(selection, local, { threads: [] })).toBe(false);
  });
});
