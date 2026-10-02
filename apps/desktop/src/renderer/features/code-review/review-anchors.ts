import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import {
  CODE_REVIEW_CONTEXT_LIMIT,
  type CodeReviewAnchor,
} from "@zeros/protocol/code-review";
import type { CodeReviewThreadItem } from "./review-thread-model";

export type ReviewCodeSnapshot = {
  path: string;
  revision: string;
} & (
  | { kind: "file"; content: string }
  | { kind: "diff"; fileDiff: FileDiffMetadata; confirmedRevision?: string }
);
export type ReviewAnchorState = "current" | "outdated" | "unavailable";
export interface ReviewThreadPlacement {
  /** Pierre's native file-level slot retains unmatched original anchors. */
  lineNumber: number;
  state: ReviewAnchorState;
}

/** A content identity, never a length or a line number masquerading as one. */
export function reviewContentRevision(content: string): string {
  let low = 0x811c9dc5;
  let high = 0x9e3779b9;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code ^ index, 0x85ebca6b);
  }
  return `${content.length.toString(36)}:${(high >>> 0).toString(36)}:${(low >>> 0).toString(36)}`;
}

function linesOf(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}
function withoutLineEnding(line: string): string {
  return line.replace(/\r?\n$/, "").replace(/\r$/, "");
}

/** Partial Pierre arrays are hunk-local, not indexed by source line number. */
export function reviewRangeContext(
  snapshot: ReviewCodeSnapshot,
  side: CodeReviewAnchor["side"],
  startLine: number,
  endLine: number,
): string | null {
  if (snapshot.kind === "file") {
    if (side === "old") return null;
    const lines = linesOf(snapshot.content);
    if (endLine > lines.length) return null;
    return lines
      .slice(startLine - 1, endLine)
      .map(withoutLineEnding)
      .join("\n");
  }
  const old = side === "old";
  const diff = snapshot.fileDiff;
  const lines = old ? diff.deletionLines : diff.additionLines;
  if (!diff.isPartial) {
    if (endLine > lines.length) return null;
    return lines
      .slice(startLine - 1, endLine)
      .map(withoutLineEnding)
      .join("\n");
  }
  const selected: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const hunk = diff.hunks.find((candidate) => {
      const start = old ? candidate.deletionStart : candidate.additionStart;
      const count = old ? candidate.deletionCount : candidate.additionCount;
      return line >= start && line < start + count;
    });
    if (!hunk) return null;
    const start = old ? hunk.deletionStart : hunk.additionStart;
    const index = old ? hunk.deletionLineIndex : hunk.additionLineIndex;
    const value = lines[index + line - start];
    if (value === undefined) return null;
    selected.push(withoutLineEnding(value));
  }
  return selected.join("\n");
}

export function snapshotAnchorRevision(
  snapshot: ReviewCodeSnapshot,
  side: CodeReviewAnchor["side"],
): string {
  if (snapshot.kind === "file") return snapshot.revision;
  return (
    snapshot.confirmedRevision ??
    `${snapshot.revision}:${side === "old" ? "old" : "new"}`
  );
}

export function anchorFromSelection(
  snapshot: ReviewCodeSnapshot,
  range: SelectedLineRange,
): CodeReviewAnchor | null {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end))
    return null;
  if (range.start < 1 || range.end < 1) return null;
  if (
    snapshot.kind === "diff" &&
    range.endSide &&
    range.endSide !== (range.side ?? "additions")
  )
    return null;
  const side =
    snapshot.kind === "file"
      ? "file"
      : range.side === "deletions"
        ? "old"
        : "new";
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  const context = reviewRangeContext(snapshot, side, startLine, endLine);
  if (context === null) return null;
  return {
    path:
      snapshot.kind === "diff" && side === "old"
        ? (snapshot.fileDiff.prevName ?? snapshot.path)
        : snapshot.path,
    side,
    startLine,
    endLine,
    revision: snapshotAnchorRevision(snapshot, side),
    // The protocol caps retained context; a large selection keeps its exact
    // revision rather than a truncated excerpt that could falsely match.
    ...(context.length <= CODE_REVIEW_CONTEXT_LIMIT ? { context } : {}),
  };
}

export function threadBelongsToSnapshot(
  thread: CodeReviewThreadItem,
  snapshot: ReviewCodeSnapshot,
): boolean {
  return (
    thread.anchor.path === snapshot.path ||
    (snapshot.kind === "diff" &&
      thread.anchor.side === "old" &&
      thread.anchor.path === snapshot.fileDiff.prevName)
  );
}

export function reviewThreadPlacement(
  thread: CodeReviewThreadItem,
  snapshot: ReviewCodeSnapshot,
): ReviewThreadPlacement {
  const anchor = thread.anchor;
  if (thread.outdated) return { lineNumber: 0, state: "outdated" };
  if (thread.anchorMissing) return { lineNumber: 0, state: "unavailable" };
  if (!threadBelongsToSnapshot(thread, snapshot))
    return { lineNumber: 0, state: "unavailable" };
  const context = reviewRangeContext(
    snapshot,
    anchor.side,
    anchor.startLine,
    anchor.endLine,
  );
  if (context === null) return { lineNumber: 0, state: "unavailable" };
  if (thread.source !== "workspace") {
    const matchedContext =
      anchor.context !== undefined && context === anchor.context;
    return matchedContext ||
      (snapshot.kind === "diff" &&
        snapshot.confirmedRevision === anchor.revision)
      ? { lineNumber: anchor.endLine, state: "current" }
      : {
          lineNumber: 0,
          state: anchor.context === undefined ? "unavailable" : "outdated",
        };
  }
  const matches =
    anchor.context !== undefined
      ? context === anchor.context
      : snapshotAnchorRevision(snapshot, anchor.side) === anchor.revision;
  return matches
    ? { lineNumber: anchor.endLine, state: "current" }
    : { lineNumber: 0, state: "outdated" };
}
