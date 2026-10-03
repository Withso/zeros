import { describe, expect, it } from "vitest";
import {
  codeReviewAnchorSchema, codeReviewCreateInputSchema, codeReviewListInputSchema,
  codeReviewPathSchema, codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema,
  CODE_REVIEW_BODY_LIMIT,
  mergeCodeReviewThreads, type CodeReviewThread,
} from "../code-review";

const anchor = { path: "src/example.ts", side: "new", startLine: 2, endLine: 4, revision: "sha256:original" };
describe("workspace code review protocol", () => {
  it.each(["old", "new", "file"])("preserves the original %s anchor and context", (side) => {
    expect(codeReviewAnchorSchema.parse({ ...anchor, side, context: "first\nsecond" })).toEqual({ ...anchor, side, context: "first\nsecond" });
  });
  it.each(["", "/absolute", "../escape", "src/../escape", "src/./file", "src//file", "src/", "C:\\file", "C:/file", "src\\file", ".git/config", "src/\0file", "src/\nfile"])(
    "rejects unsafe or ambiguous path %j", (path) => expect(codeReviewPathSchema.safeParse(path).success).toBe(false),
  );
  it.each([{ startLine: 0 }, { startLine: -1 }, { startLine: 1.5 }, { endLine: 1 }, { endLine: NaN }, { endLine: Number.MAX_SAFE_INTEGER }, { revision: " " }, { side: "RIGHT" }])(
    "rejects invalid anchor %j", (invalid) => expect(codeReviewAnchorSchema.safeParse({ ...anchor, ...invalid }).success).toBe(false),
  );
  it.each(["", " \n\t", "\0", "x".repeat(CODE_REVIEW_BODY_LIMIT + 1)])("rejects invalid bodies", (body) => {
    expect(codeReviewCreateInputSchema.safeParse({ workspaceId: "A", anchor, body }).success).toBe(false);
    expect(codeReviewReplyInputSchema.safeParse({ workspaceId: "A", threadId: "thread", body }).success).toBe(false);
  });
  it("does not accept client-chosen authors, workspace aliases, or mutation versions", () => {
    const create = { workspaceId: "A", anchor, body: "Please review" };
    expect(codeReviewCreateInputSchema.safeParse({ ...create, author: { kind: "human", id: "someone" } }).success).toBe(false);
    expect(codeReviewCreateInputSchema.safeParse({ ...create, cwd: "/elsewhere" }).success).toBe(false);
    expect(codeReviewListInputSchema.safeParse({ workspaceId: "A", includeResolved: "false" }).success).toBe(false);
    for (const expectedVersion of [undefined, 0, 1.5, "1"]) {
      expect(codeReviewSetResolvedInputSchema.safeParse({ workspaceId: "A", threadId: "thread", resolved: false, expectedVersion }).success).toBe(false);
    }
  });

  it("merges overlapping pages/previews in reply order without overwriting newer state or immutable authors", () => {
    const author = { id: "human:one", name: "Reviewer", kind: "human" as const };
    const comments = [1, 2, 3, 4].map((sequence) => ({ id: `comment-${sequence}`, author, body: `Reply ${sequence}`, sequence, createdAt: 1 }));
    const first: CodeReviewThread = {
      id: "thread", workspaceId: "A", anchor: { ...anchor, side: "new" }, comments: [comments[0]!, comments[3]!],
      resolved: true, version: 5, createdAt: 1, updatedAt: 2, commentCount: 4, commentsComplete: false, commentsCursor: "cursor",
    };
    const older: CodeReviewThread = { ...first, version: 3, resolved: false, comments: [{ ...comments[0]!, author: { ...author, name: "Changed" } }, comments[1]!] };
    const partial = mergeCodeReviewThreads([first], [older]);
    expect(partial[0]).toMatchObject({ resolved: true, version: 5, commentsComplete: false, commentsCursor: "cursor" });
    expect(partial[0]!.comments[0]!.author).toEqual(author);
    const full = mergeCodeReviewThreads(partial, [{ ...older, comments: [comments[2]!] }]);
    expect(full[0]!.comments.map((comment) => comment.sequence)).toEqual([1, 2, 3, 4]);
    expect(full[0]).toMatchObject({ resolved: true, version: 5, commentsComplete: true });
    expect(full[0]!.commentsCursor).toBeUndefined();
    expect(() => mergeCodeReviewThreads(full, [{ ...first, workspaceId: "B" }])).toThrow(/workspaces/i);
  });

  it("advances a 200-comment continuation only through contiguous history and preserves preview gaps", () => {
    const author = { id: "human:one", name: "Reviewer", kind: "human" as const };
    const comments = Array.from({ length: 200 }, (_, index) => ({ id: `comment-${index + 1}`, author, body: "Reply", sequence: index + 1, createdAt: 1 }));
    const base: CodeReviewThread = {
      id: "thread", workspaceId: "A", anchor: { ...anchor, side: "new" }, comments: comments.slice(0, 64),
      resolved: false, version: 200, createdAt: 1, updatedAt: 1, commentCount: 200, commentsComplete: false, commentsCursor: "after-64",
    };
    const next = { ...base, comments: comments.slice(64, 128), commentsCursor: "after-128" };
    const firstMerge = mergeCodeReviewThreads([base], [next]);
    expect(firstMerge[0]!.comments).toHaveLength(128);
    expect(firstMerge[0]!.commentsCursor).toBe("after-128");
    const preview = { ...base, comments: [...comments.slice(0, 64), comments[199]!], commentsCursor: "after-64" };
    const withPreview = mergeCodeReviewThreads(firstMerge, [preview]);
    expect(withPreview[0]!.comments).toHaveLength(129);
    expect(withPreview[0]!.commentsCursor).toBe("after-128");
    const skipped = mergeCodeReviewThreads([base], [{ ...base, comments: comments.slice(128, 192), commentsCursor: "after-192" }]);
    expect(skipped[0]!.commentsCursor).toBe("after-64");
    const thirdMerge = mergeCodeReviewThreads(withPreview, [{ ...base, comments: comments.slice(128, 192), commentsCursor: "after-192" }]);
    expect(thirdMerge[0]!.commentsCursor).toBe("after-192");
    const full = mergeCodeReviewThreads(thirdMerge, [{ ...base, comments: comments.slice(192), commentsCursor: undefined }]);
    expect(full[0]!.comments.map((comment) => comment.sequence)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(full[0]!.commentsComplete).toBe(true);
    expect(full[0]!.commentsCursor).toBeUndefined();
  });
});
