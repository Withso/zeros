import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrInlineReview } from "@zeros/protocol/github-review";
import { requestCloudGithubPr } from "@/renderer/platform/cloud-github-pr";
import { githubReviewCache, githubReviewKey } from "../github-review-cache";
import { useGithubReview } from "../use-github-review";

// The real platform transport: a cloud workspace id must route both the PR
// diff read and the line comment through the cloud GitHub grant.
vi.mock("@/renderer/platform/cloud-github-pr", () => ({ requestCloudGithubPr: vi.fn() }));
vi.mock("@/renderer/platform/cloud-github-pr-capability", () => ({ hasCloudGithubPrCapability: () => true }));
vi.mock("../../../platform/cloud-github-pr-scope", () => ({ useCloudGithubPrScope: () => null }));

const workspaceId = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const key = githubReviewKey(workspaceId, 5);
const head = "e".repeat(40);
const base = "f".repeat(40);
const snapshot: PrInlineReview = {
  headSha: head, baseSha: base, threads: [], annotations: [],
  threadsTruncated: false, annotationsTruncated: false, annotationError: null,
};

afterEach(() => githubReviewCache.clear());

describe("posting a cloud Changes-tab comment to the pull request", () => {
  it("reads the PR diff and posts the mapped line through the cloud grant", async () => {
    githubReviewCache.setData(key, snapshot);
    vi.mocked(requestCloudGithubPr).mockImplementation(async (_target, op) => {
      if (op === "gh.prReviewDiff")
        return { headSha: head, baseSha: base, patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" };
      if (op === "gh.prInlineReview") return snapshot;
      return { id: 1, url: "https://github.com/o/r/pull/5#discussion_r1" };
    });
    let review!: ReturnType<typeof useGithubReview>;
    function Capture() {
      review = useGithubReview({ workspaceId, prNumber: 5, cwd: workspaceId, active: true, localComparison: true });
      return null;
    }
    renderToString(createElement(Capture));
    expect(review.source?.postMappedComment).toBeTypeOf("function");
    await review.source!.postMappedComment!(
      { path: "a.ts", side: "new", startLine: 1, endLine: 1, revision: "local:new", context: "new" },
      "Cloud comment",
      () => "new",
      () => true,
    );
    const calls = vi.mocked(requestCloudGithubPr).mock.calls.map(([, op, params]) => [op, params]);
    expect(calls[0]).toEqual(["gh.prReviewDiff", { workspaceId, prNumber: 5 }]);
    expect(calls[1]).toEqual([
      "gh.prComment",
      expect.objectContaining({ kind: "line", path: "a.ts", side: "RIGHT", line: 1, commitSha: head, baseSha: base, body: "Cloud comment" }),
    ]);
  });
});
