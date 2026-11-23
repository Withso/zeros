/** Where a new diff comment goes when its pull request accepts it. A comment
 *  posts to the pull request by default, as the person's own GitHub account;
 *  choosing Workspace once keeps later comments private until changed back. */
export type ReviewCommentDestination = "pr" | "workspace";

const KEY = "zeros.review.comment-destination";

export function loadReviewCommentDestination(): ReviewCommentDestination {
  try {
    return window.localStorage.getItem(KEY) === "workspace" ? "workspace" : "pr";
  } catch {
    return "pr";
  }
}

export function saveReviewCommentDestination(
  destination: ReviewCommentDestination,
): void {
  try {
    window.localStorage.setItem(KEY, destination);
  } catch {
    // Storage is a convenience; this comment still goes where it was sent.
  }
}
