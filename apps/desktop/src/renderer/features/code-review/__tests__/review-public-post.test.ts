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
