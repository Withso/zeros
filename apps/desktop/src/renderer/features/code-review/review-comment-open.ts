import { openChangesAtRepositoryPath } from "@/renderer/shell/workbench/file-pill-navigation";
import { requestReviewCommentReveal } from "./review-comment-reveal";
import type { ReviewCommentReference } from "./review-comment-reference";

/** Line comments open at their line in Changes; a conversation comment has
 *  no line, so it opens in the preview instead. Returns false for that case,
 *  and when Changes holds a draft for another file, so the caller can show
 *  the preview rather than nothing. */
export function revealReviewComment(
  cwd: string | null | undefined,
  reference: ReviewCommentReference,
): boolean {
  if (!cwd || !reference.path || !reference.line) return false;
  // GitHub paths are repository-relative, not relative to the chat's folder.
  const owner = openChangesAtRepositoryPath(cwd, reference.path);
  if (!owner) return false;
  requestReviewCommentReveal({
    owner,
    path: reference.path,
    side: reference.side ?? "new",
    line: reference.line,
  });
  return true;
}
