import type { PrInlineReview } from "@zeros/protocol/github-review";
import { KeyedAsyncCache } from "@/renderer/shared/lib/keyed-async-cache";
import { registerPrWorkspaceCacheForget } from "@/renderer/shell/pr/pr-cache-forget";

export function githubReviewKey(workspaceId: string, prNumber: number): string {
  return JSON.stringify(["github.com", workspaceId, prNumber]);
}
export function githubReviewTargetFromKey(key: string): {
  workspaceId: string;
  prNumber: number;
} {
  const [, workspaceId, prNumber] = JSON.parse(key) as [string, string, number];
  return { workspaceId, prNumber };
}
function reconcileRows<T extends { id: string }>(
  previous: T[],
  next: T[],
): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  const shared = next.map((item) => {
    const existing = byId.get(item.id);
    return existing && JSON.stringify(existing) === JSON.stringify(item)
      ? existing
      : item;
  });
  return previous.length === shared.length &&
    shared.every((item, index) => item === previous[index])
    ? previous
    : shared;
}
export function reconcileGithubReview(
  previous: PrInlineReview | undefined,
  next: PrInlineReview,
): PrInlineReview {
  if (!previous) return next;
  const threads = reconcileRows(previous.threads, next.threads);
  const annotations = reconcileRows(previous.annotations, next.annotations);
  return threads === previous.threads &&
    annotations === previous.annotations &&
    previous.headSha === next.headSha &&
    previous.baseSha === next.baseSha &&
    previous.threadsTruncated === next.threadsTruncated &&
    previous.annotationsTruncated === next.annotationsTruncated &&
    previous.annotationError === next.annotationError
    ? previous
    : { ...next, threads, annotations };
}
export function createGithubReviewCache(
  maxEntries = 32,
): KeyedAsyncCache<PrInlineReview> {
  return new KeyedAsyncCache({
    maxEntries,
    maxWeight: 16 * 1024 * 1024,
    reconcile: reconcileGithubReview,
    weightOf: (snapshot) =>
      2 *
      (snapshot.threads.reduce(
        (total, thread) =>
          total +
          (thread.context?.length ?? 0) +
          thread.comments.reduce(
            (size, comment) => size + comment.body.length,
            0,
          ),
        0,
      ) +
        snapshot.annotations.reduce(
          (total, annotation) => total + annotation.message.length,
          0,
        )),
  });
}
export const githubReviewCache = createGithubReviewCache();
const refreshVersions = new Map<string, number>();
/** Several visible surfaces share the same Git invalidation without issuing a
 * second follow-up request simply because each received the broadcast. */
export function observeGithubReviewRefresh(key: string, version: number): void {
  const previous = refreshVersions.get(key);
  if (previous !== undefined && previous !== version)
    githubReviewCache.invalidate(key);
  refreshVersions.delete(key);
  refreshVersions.set(key, version);
  while (refreshVersions.size > 128)
    refreshVersions.delete(refreshVersions.keys().next().value!);
}
registerPrWorkspaceCacheForget((workspaceId) => {
  for (const key of githubReviewCache.keys()) {
    if (githubReviewTargetFromKey(key).workspaceId !== workspaceId) continue;
    githubReviewCache.forget(key);
    refreshVersions.delete(key);
  }
});
