import type { HunkReviewDecision } from "@zeros/protocol/git-review-actions";
import { KeyedAsyncCache } from "@/renderer/shared/lib/keyed-async-cache";
import {
  registerReviewCacheForget,
  type ReviewCacheRequest,
} from "./review-cache-forget";

export function hunkReviewCacheKey(
  clientIdentity: string,
  cwd: string,
  path: string,
): string {
  return JSON.stringify([clientIdentity, cwd, path]);
}
export function hunkReviewTargetFromKey(key: string): {
  identity: string;
  cwd: string;
  path: string;
} {
  const [identity, cwd, path] = JSON.parse(key) as [string, string, string];
  return { identity, cwd, path };
}
export function reconcileHunkReviews(
  previous: readonly HunkReviewDecision[] | undefined,
  next: readonly HunkReviewDecision[],
): readonly HunkReviewDecision[] {
  if (!previous) return next;
  const byKey = new Map(previous.map((item) => [item.key, item]));
  const shared = next.map((item) => {
    const old = byKey.get(item.key);
    return old &&
      old.decision === item.decision &&
      old.updatedAt === item.updatedAt &&
      old.path === item.path &&
      old.comparison === item.comparison
      ? old
      : item;
  });
  return previous.length === shared.length &&
    shared.every((item, index) => item === previous[index])
    ? previous
    : shared;
}
export function createHunkReviewCache(
  maxEntries = 128,
): KeyedAsyncCache<readonly HunkReviewDecision[]> {
  return new KeyedAsyncCache({
    maxEntries,
    maxWeight: 8 * 1024 * 1024,
    weightOf: (items) =>
      items.reduce((sum, item) => sum + 192 + item.path.length * 2, 0),
    reconcile: reconcileHunkReviews,
  });
}
export function publishHunkReview(
  cache: KeyedAsyncCache<readonly HunkReviewDecision[]>,
  key: string,
  decision: HunkReviewDecision,
  request?: ReviewCacheRequest,
): void {
  if (request && !request.isCurrent()) return;
  const items = cache.getSnapshot(key).data ?? [];
  cache.setData(
    key,
    [...items.filter((item) => item.key !== decision.key), decision].slice(
      -1024,
    ),
  );
}
export const hunkReviewCache = createHunkReviewCache();

registerReviewCacheForget((ownsFolder) => {
  for (const key of hunkReviewCache.keys()) {
    if (ownsFolder(hunkReviewTargetFromKey(key).cwd))
      hunkReviewCache.forget(key);
  }
});
