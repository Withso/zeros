import { reviewRangeContext, type ReviewCodeSnapshot } from "./review-anchors";
import type { ReviewSelectionTarget } from "./review-annotations";
import type { CodeReviewExternalSource } from "./review-thread-model";

/** A retained draft keeps its original target even when the adapter refreshes. */
export function canPostReviewSelection(
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

export async function postCapturedReview(
  captured: ReviewSelectionTarget,
  snapshot: ReviewCodeSnapshot | undefined,
  external: CodeReviewExternalSource | undefined,
  body: string,
): Promise<void> {
  if (!canPostReviewSelection(captured, snapshot, external)) {
    throw new Error("The PR diff changed. Refresh it before posting to PR.");
  }
  // The adapter owns old-path translation. Preserve this immutable selection.
  await external!.postComment!(captured.anchor, body);
}
