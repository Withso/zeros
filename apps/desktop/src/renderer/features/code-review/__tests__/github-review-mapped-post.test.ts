import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrInlineReview } from "@zeros/protocol/github-review";
import {
  getPrInlineReview,
  getPrReviewDiff,
  postPrLineComment,
} from "@/renderer/platform/github-review";
import { githubReviewCache, githubReviewKey } from "../github-review-cache";
import { useGithubReview } from "../use-github-review";

vi.mock("@/renderer/platform/github-review", () => ({
  getPrInlineReview: vi.fn(),
  getPrReviewDiff: vi.fn(),
  postPrLineComment: vi.fn(),
  replyPrReviewThread: vi.fn(),
  setPrReviewThreadResolved: vi.fn(),
}));

const target = { workspaceId: "mapped-workspace", prNumber: 9 };
const cwd = "/repo/mapped-workspace";
const key = githubReviewKey(target.workspaceId, target.prNumber);
const head = "c".repeat(40);
const base = "d".repeat(40);
const snapshot: PrInlineReview = {
  headSha: head,
  baseSha: base,
  threads: [],
  annotations: [],
  threadsTruncated: false,
  annotationsTruncated: false,
  annotationError: null,
  viewer: { login: "arun", avatarUrl: null },
};
const patch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n keep\n+added line\n end\n";

function capture(localComparison: boolean) {
  let review!: ReturnType<typeof useGithubReview>;
  function Capture() {
    review = useGithubReview({ ...target, cwd, active: true, localComparison });
    return null;
  }
  renderToString(createElement(Capture));
  return review.source!;
}

beforeEach(() => {
  vi.resetAllMocks();
  githubReviewCache.clear();
  githubReviewCache.setData(key, snapshot);
  vi.mocked(getPrInlineReview).mockResolvedValue(snapshot);
  vi.mocked(getPrReviewDiff).mockResolvedValue({ headSha: head, baseSha: base, patch });
  vi.mocked(postPrLineComment).mockResolvedValue({ id: 1, url: "https://github.com/o/r/pull/9#discussion_r1" });
});
afterEach(() => githubReviewCache.clear());

describe("posting a Changes-tab comment to the pull request", () => {
  it("is offered only for a local comparison, as the connected GitHub account", () => {
    expect(capture(false).postMappedComment).toBeUndefined();
    const source = capture(true);
    expect(source.postMappedComment).toBeTypeOf("function");
    expect(source.postAs).toEqual({ name: "arun", avatarUrl: null });
    expect(source.mappedTarget).toBe(key);
  });

  it("matches the selected text to the PR's current head before posting", async () => {
    await capture(true).postMappedComment!(
      { path: "src/a.ts", side: "new", startLine: 2, endLine: 2, revision: "local:new", context: "added line" },
      "Why this line?",
      (line) => ["keep", "added line", "end"][line - 1] ?? null,
      () => true,
    );
    expect(getPrReviewDiff).toHaveBeenCalledWith(target);
    expect(postPrLineComment).toHaveBeenCalledWith({
      ...target,
      body: "Why this line?",
      path: "src/a.ts",
      side: "RIGHT",
      line: 2,
      startLine: 2,
      commitSha: head,
      baseSha: base,
    });
  });

  it("refuses lines the pull request does not contain, without posting", async () => {
    await expect(
      capture(true).postMappedComment!(
        { path: "src/a.ts", side: "new", startLine: 4, endLine: 4, revision: "local:new", context: "only on disk" },
        "Lost comment",
        () => null,
        () => true,
      ),
    ).rejects.toThrow("aren't part of the pull request");
    expect(postPrLineComment).not.toHaveBeenCalled();
  });

  it("keeps the draft when the comparison changes during the PR diff read", async () => {
    await expect(
      capture(true).postMappedComment!(
        { path: "src/a.ts", side: "new", startLine: 2, endLine: 2, revision: "local:new", context: "added line" },
        "Changed underneath",
        () => null,
        () => false,
      ),
    ).rejects.toThrow("comparison changed");
    expect(getPrReviewDiff).toHaveBeenCalled();
    expect(postPrLineComment).not.toHaveBeenCalled();
  });
});
