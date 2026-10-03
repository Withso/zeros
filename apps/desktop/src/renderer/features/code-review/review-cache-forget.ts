type OwnsReviewFolder = (folder: string) => boolean;
type ForgetReviewCaches = (ownsFolder: OwnsReviewFolder) => void;

const forgetters = new Set<ForgetReviewCaches>();
const requests = new Set<{ folder: string; current: boolean }>();

/** Cache owners register locally so lifecycle actions never import React hooks. */
export function registerReviewCacheForget(
  forget: ForgetReviewCaches,
): () => void {
  forgetters.add(forget);
  return () => forgetters.delete(forget);
}

export interface ReviewCacheRequest {
  isCurrent(): boolean;
  assertCurrent(): void;
  finish(): void;
}

/** Only pending work is retained. Removal cancels the captured lifetime even
 * when the same cache key is subsequently reopened under a new owner. */
export function beginReviewCacheRequest(folder: string): ReviewCacheRequest {
  const request = { folder, current: true };
  requests.add(request);
  return {
    isCurrent: () => request.current,
    assertCurrent: () => {
      if (!request.current)
        throw new Error(
          "The workspace was removed before the review operation finished.",
        );
    },
    finish: () => {
      request.current = false;
      requests.delete(request);
    },
  };
}

/** Use the deletion's existing normalized ownership predicate before removing
 * its project registration. Archive deliberately retains these snapshots. */
export function forgetReviewCachesForFolders(
  ownsFolder: OwnsReviewFolder,
): void {
  for (const request of requests) {
    if (!ownsFolder(request.folder)) continue;
    request.current = false;
    requests.delete(request);
  }
  for (const forget of forgetters) forget(ownsFolder);
}
