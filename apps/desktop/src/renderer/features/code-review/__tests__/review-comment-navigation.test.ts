import { beforeEach, describe, expect, it, vi } from "vitest";
import { openChangesAtRepositoryPath } from "@/renderer/shell/workbench/file-pill-navigation";
import { revealReviewComment } from "../review-comment-open";
import { currentReviewCommentReveal } from "../review-comment-reveal";
import type { ReviewCommentReference } from "../review-comment-reference";

vi.mock("@/renderer/shell/workbench/file-pill-navigation", () => ({ openChangesAtRepositoryPath: vi.fn() }));

const reference: ReviewCommentReference = {
  kind: "pr-comment", key: "github:T1", prNumber: 42, title: "t", body: "b",
  author: { name: "priya", avatarUrl: null, bot: false }, createdAt: 1, url: null,
  path: "src/a.ts", side: "old", startLine: 3, line: 4,
};

beforeEach(() => vi.mocked(openChangesAtRepositoryPath).mockReset().mockReturnValue("owner-1"));

describe.each(["/personal/repo", "/organization/repo", "cloud://organization/workspace"])("opening a comment in %s", (cwd) => {
  it("opens a line comment at its line and side in Changes", () => {
    expect(revealReviewComment(cwd, reference)).toBe(true);
    expect(openChangesAtRepositoryPath).toHaveBeenCalledWith(cwd, "src/a.ts");
    expect(currentReviewCommentReveal()).toMatchObject({ owner: "owner-1", path: "src/a.ts", side: "old", line: 4 });
  });

  it("falls back to the preview when Changes keeps another file's draft", () => {
    vi.mocked(openChangesAtRepositoryPath).mockReturnValue(null);
    const before = currentReviewCommentReveal();
    expect(revealReviewComment(cwd, { ...reference, line: 9 })).toBe(false);
    expect(currentReviewCommentReveal()).toBe(before);
  });

  it("leaves a conversation comment to its preview", () => {
    expect(revealReviewComment(cwd, { ...reference, path: undefined, line: undefined })).toBe(false);
    expect(openChangesAtRepositoryPath).not.toHaveBeenCalled();
  });
});
