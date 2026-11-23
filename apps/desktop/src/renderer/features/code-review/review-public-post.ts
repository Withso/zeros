import { reviewRangeContext, type ReviewCodeSnapshot } from "./review-anchors";
import type { ReviewSelectionTarget } from "./review-annotations";
import type { CodeReviewExternalSource } from "./review-thread-model";

/** A local comparison posts by matching its captured text against the PR diff
 *  at submission, so it needs that text and a line range, not a revision. */
function canPostMapped(
  captured: ReviewSelectionTarget,
  snapshot: ReviewCodeSnapshot | undefined,
  external: CodeReviewExternalSource | undefined,
): boolean {
  const anchor = captured.anchor;
  return (
    !!external?.postMappedComment &&
    !!captured.mappedTarget &&
    captured.mappedTarget === external.mappedTarget &&
    snapshot?.kind === "diff" &&
    !captured.confirmedRevision &&
    !snapshot.confirmedRevision &&
    anchor.side !== "file" &&
    anchor.context !== undefined &&
    // The comparison still shows the captured text where it was selected.
    reviewRangeContext(snapshot, anchor.side, anchor.startLine, anchor.endLine) ===
      anchor.context
  );
}

function canPostExact(
  captured: ReviewSelectionTarget,
  snapshot: ReviewCodeSnapshot | undefined,
  external: CodeReviewExternalSource | undefined,
): boolean {
  if (
    snapshot?.kind !== "diff" ||
    !captured.confirmedRevision ||
    !external?.postComment
  )
    return false;
  const revision = captured.confirmedRevision;
  if (
    captured.anchor.revision !== revision ||
    snapshot.confirmedRevision !== revision ||
    external.confirmedRevision !== revision
  )
    return false;
  const anchor = captured.anchor;
  if (
    anchor.side === "file" ||
    anchor.path !==
      (anchor.side === "old"
        ? (snapshot.fileDiff.prevName ?? snapshot.path)
        : snapshot.path)
  )
    return false;
  const context = reviewRangeContext(
    snapshot,
    anchor.side,
    anchor.startLine,
    anchor.endLine,
  );
  return (
    context !== null &&
    (anchor.context === undefined || anchor.context === context)
  );
}

/** A retained draft keeps its original target even when the adapter refreshes. */
export function canPostReviewSelection(
  captured: ReviewSelectionTarget,
  snapshot: ReviewCodeSnapshot | undefined,
  external: CodeReviewExternalSource | undefined,
): boolean {
  return (
    canPostExact(captured, snapshot, external) ||
    canPostMapped(captured, snapshot, external)
  );
}

export async function postCapturedReview(
  captured: ReviewSelectionTarget,
  snapshot: ReviewCodeSnapshot | undefined,
  external: CodeReviewExternalSource | undefined,
  body: string,
  /** The live comparison and adapter, read again while a post is pending. */
  live: () => {
    snapshot: ReviewCodeSnapshot | undefined;
    external: CodeReviewExternalSource | undefined;
  } = () => ({ snapshot, external }),
): Promise<void> {
  if (canPostExact(captured, snapshot, external)) {
    // The adapter owns old-path translation. Preserve this immutable selection.
    await external!.postComment!(captured.anchor, body);
    return;
  }
  if (canPostMapped(captured, snapshot, external)) {
    const side = captured.anchor.side;
    await external!.postMappedComment!(
      captured.anchor,
      body,
      (line) => {
        const current = live().snapshot;
        return current ? reviewRangeContext(current, side, line, line) : null;
      },
      () => {
        const current = live();
        return canPostMapped(captured, current.snapshot, current.external);
      },
    );
    return;
  }
  throw new Error("The PR diff changed. Refresh it before posting to PR.");
}
