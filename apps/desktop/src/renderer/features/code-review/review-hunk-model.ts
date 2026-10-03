import {
  reviewContentRevision,
  reviewHunkKey,
  splitReviewHunks,
  untrackedReviewPatch,
  type ReviewComparison,
} from "@zeros/protocol/git-review-actions";
import type { ReadFileResult } from "@/renderer/platform/files";
import type { GitReviewActionsClient } from "@/renderer/platform/git-review-actions";
import type { ReviewCodeSnapshot } from "./review-anchors";

export interface ReviewLiveHunkSource {
  cwd: string;
  path: string;
  patch: string;
  comparison: ReviewComparison;
  expectedContent: string | null;
  contentRevision: string;
  client?: GitReviewActionsClient;
}
export interface ReviewHunkTarget extends ReviewLiveHunkSource {
  key: string;
}

export function reviewComparisonForScope(
  scope: string | undefined,
): ReviewComparison | null {
  return scope === "uncommitted"
    ? "worktree-vs-head"
    : scope === "unstaged"
      ? "worktree-vs-index"
      : null;
}

/** Only confirmed live bytes and explicitly writable comparisons get actions. */
export function liveReviewHunkSource({
  cwd,
  path,
  patch,
  scope,
  read,
  deleted = false,
  untracked = false,
  readOnly = false,
  conflicted = false,
}: {
  cwd: string;
  path: string;
  patch: string;
  scope?: string;
  read: ReadFileResult | null | undefined;
  deleted?: boolean;
  untracked?: boolean;
  readOnly?: boolean;
  conflicted?: boolean;
}): ReviewLiveHunkSource | undefined {
  const comparison = reviewComparisonForScope(scope);
  if (
    !comparison ||
    !cwd ||
    !read ||
    read.path !== path ||
    read.designPath ||
    readOnly ||
    conflicted
  )
    return;
  const expectedContent =
    read.kind === "text" && read.content !== undefined
      ? read.content
      : deleted &&
          read.kind === "error" &&
          read.error === "file no longer exists on disk"
        ? null
        : undefined;
  if (expectedContent === undefined) return;
  const renderedPatch =
    patch ||
    (untracked && expectedContent !== null
      ? untrackedReviewPatch(path, expectedContent)
      : "");
  if (!splitReviewHunks(renderedPatch).length) return;
  return {
    cwd,
    path,
    patch: renderedPatch,
    comparison,
    expectedContent,
    contentRevision: reviewContentRevision(expectedContent),
  };
}

const targets = new WeakMap<
  ReviewLiveHunkSource,
  readonly {
    target: ReviewHunkTarget;
    lineNumber: number;
    side: "old" | "new";
  }[]
>();
export function reviewHunkPlacements(
  snapshot: Extract<ReviewCodeSnapshot, { kind: "diff" }>,
  source: ReviewLiveHunkSource,
) {
  if (source.path !== snapshot.path || snapshot.confirmedRevision) return [];
  let existing = targets.get(source);
  if (!existing) {
    existing = splitReviewHunks(source.patch).map((hunk) => ({
      target: {
        ...source,
        patch: hunk.patch,
        key: reviewHunkKey(
          source.path,
          source.comparison,
          hunk.patch,
          source.contentRevision,
        ),
      },
      lineNumber:
        hunk.newLines > 0
          ? hunk.newStart + hunk.newLines - 1
          : hunk.oldStart + hunk.oldLines - 1,
      side: hunk.newLines > 0 ? ("new" as const) : ("old" as const),
    }));
    targets.set(source, existing);
  }
  return existing;
}
