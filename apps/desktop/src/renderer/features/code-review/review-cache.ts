import {
  mergeCodeReviewThreads,
  type CodeReviewThread,
  type CodeReviewListResult,
} from "@zeros/protocol/code-review";
import { KeyedAsyncCache } from "@/renderer/shared/lib/keyed-async-cache";
import {
  registerReviewCacheForget,
  type ReviewCacheRequest,
} from "./review-cache-forget";

export function codeReviewCacheKey(cwd: string, workspaceId: string): string {
  return JSON.stringify([cwd.replace(/[\\/]+$/, "") || "/", workspaceId]);
}

export function codeReviewTargetFromKey(key: string): {
  cwd: string;
  workspaceId: string;
} {
  const [cwd, workspaceId] = JSON.parse(key) as [string, string];
  return { cwd, workspaceId };
}

export interface CodeReviewCollection {
  workspaceId: string;
  threads: readonly CodeReviewThread[];
  partial: boolean;
  nextCursor?: string;
  viewerActorId?: string;
  /** Renderer-only identity: opaque cursors can repeat between root reads. */
  listingId?: number;
  /** Invalidations require another root read before pages can publish. */
  listingInvalidationVersion?: number;
  /** Internal membership confirmed by the active workspace listing pass. */
  listedThreadIds?: readonly string[];
}

export function reconcileCodeReviewThreads(
  previous: readonly CodeReviewThread[] | undefined,
  next: readonly CodeReviewThread[],
  retainMissing = true,
): readonly CodeReviewThread[] {
  if (!previous) return next;
  const byId = new Map(previous.map((thread) => [thread.id, thread]));
  const membership = retainMissing
    ? null
    : new Set(next.map((thread) => thread.id));
  const retained = membership
    ? previous.filter((thread) => membership.has(thread.id))
    : previous;
  const shared = mergeCodeReviewThreads(retained, next).map((thread) => {
    const existing = byId.get(thread.id);
    if (existing === thread) return existing;
    const sameComments =
      existing &&
      existing.comments.length === thread.comments.length &&
      existing.comments.every((comment, at) => comment === thread.comments[at]);
    return existing &&
      sameComments &&
      existing.version === thread.version &&
      existing.resolved === thread.resolved &&
      existing.commentsCursor === thread.commentsCursor &&
      existing.commentsCursorAfter === thread.commentsCursorAfter &&
      (existing.commentCount ?? existing.comments.length) ===
        thread.commentCount &&
      (existing.commentsComplete ?? true) === thread.commentsComplete
      ? existing
      : { ...thread, anchor: existing?.anchor ?? thread.anchor };
  });
  return previous.length === shared.length &&
    shared.every((thread, index) => thread === previous[index])
    ? previous
    : shared;
}

export function reconcileCodeReviewCollection(
  previous: CodeReviewCollection | undefined,
  next: CodeReviewCollection,
): CodeReviewCollection {
  const partial = next.partial || next.nextCursor !== undefined;
  const listedThreadIds = partial
    ? (next.listedThreadIds ?? next.threads.map((thread) => thread.id))
    : undefined;
  if (!previous)
    return listedThreadIds === next.listedThreadIds
      ? next
      : { ...next, listedThreadIds };
  if (previous.workspaceId !== next.workspaceId)
    throw new Error("Review pages belong to different workspaces.");
  // A complete workspace read owns membership: omitted threads may no longer
  // be visible after a nested owner or source policy changes. Partial pages
  // retain loaded history; mutation/page publishers explicitly merge members.
  const threads = reconcileCodeReviewThreads(
    previous.threads,
    next.threads,
    partial,
  );
  const viewerActorId = next.viewerActorId ?? previous.viewerActorId;
  const sameListing =
    previous.listedThreadIds === listedThreadIds ||
    (previous.listedThreadIds !== undefined &&
      listedThreadIds !== undefined &&
      previous.listedThreadIds.length === listedThreadIds.length &&
      previous.listedThreadIds.every(
        (id, index) => id === listedThreadIds[index],
      ));
  return sameListing &&
    previous.listingId === next.listingId &&
    previous.listingInvalidationVersion === next.listingInvalidationVersion &&
    previous.threads === threads &&
    previous.nextCursor === next.nextCursor &&
    previous.partial === next.partial &&
    previous.viewerActorId === viewerActorId
    ? previous
    : {
        ...next,
        threads,
        viewerActorId,
        listedThreadIds: sameListing
          ? previous.listedThreadIds
          : listedThreadIds,
      };
}

export function createCodeReviewCache(
  maxEntries = 64,
): KeyedAsyncCache<CodeReviewCollection> {
  return new KeyedAsyncCache({
    maxEntries,
    maxWeight: 16 * 1024 * 1024,
    weightOf: (collection) =>
      collection.threads.reduce(
        (sum, thread) =>
          sum +
          (thread.anchor.context?.length ?? 0) +
          thread.comments.reduce(
            (size, comment) => size + comment.body.length,
            0,
          ),
        0,
      ) * 2,
    reconcile: reconcileCodeReviewCollection,
  });
}

export function publishCodeReviewThread(
  cache: KeyedAsyncCache<CodeReviewCollection>,
  key: string,
  thread: CodeReviewThread,
  request?: ReviewCacheRequest,
): void {
  if (request && !request.isCurrent()) return;
  const previous = cache.getSnapshot(key).data;
  const listedThreadIds = previous?.listedThreadIds;
  cache.setData(key, {
    ...(previous ?? { workspaceId: thread.workspaceId, partial: true }),
    threads: reconcileCodeReviewThreads(previous?.threads, [thread]),
    ...(listedThreadIds && !listedThreadIds.includes(thread.id)
      ? { listedThreadIds: [...listedThreadIds, thread.id] }
      : {}),
  });
}

/** A continuation can overlap a refresh or mutation. Merge immutable history,
 * but advance membership only within its captured listing pass and cursor. */
export function publishCodeReviewPage(
  cache: KeyedAsyncCache<CodeReviewCollection>,
  key: string,
  page: CodeReviewListResult,
  request: { cursor?: string; threadId?: string; listingId?: number },
): void {
  const previous = cache.getSnapshot(key).data;
  if (!previous) return;
  if (previous.workspaceId !== page.workspaceId)
    throw new Error("Review pages belong to different workspaces.");
  const current =
    !request.threadId &&
    previous.listingId === request.listingId &&
    previous.nextCursor !== undefined &&
    previous.nextCursor === request.cursor;
  const members = new Set(previous.threads.map((thread) => thread.id));
  // Older continuations may add history to surviving threads, but cannot
  // restore membership that a newer authoritative read removed.
  const incoming = current
    ? page.threads
    : page.threads.filter(
        (thread) =>
          members.has(thread.id) &&
          (!request.threadId || thread.id === request.threadId),
      );
  if (!current && incoming.length === 0) return;
  const threads = reconcileCodeReviewThreads(previous.threads, incoming);
  if (request.threadId) {
    // The shared merge chooses the continuation covered by the actual loaded
    // prefix, including root/latest mutation previews with a gap.
    cache.setData(key, { ...previous, threads });
  } else {
    const listedThreadIds =
      current && previous.listedThreadIds
        ? [
            ...new Set([
              ...previous.listedThreadIds,
              ...incoming.map((thread) => thread.id),
            ]),
          ]
        : previous.listedThreadIds;
    const complete = current && !page.partial && page.nextCursor === undefined;
    const confirmed =
      complete && listedThreadIds ? new Set(listedThreadIds) : null;
    cache.setData(key, {
      ...previous,
      threads: confirmed
        ? threads.filter((thread) => confirmed.has(thread.id))
        : threads,
      listedThreadIds: complete ? undefined : listedThreadIds,
      ...(current
        ? { partial: !!page.partial, nextCursor: page.nextCursor }
        : {}),
      viewerActorId: page.viewerActorId ?? previous.viewerActorId,
    });
  }
}

export const codeReviewCache = createCodeReviewCache();

registerReviewCacheForget((ownsFolder) => {
  for (const key of codeReviewCache.keys()) {
    if (ownsFolder(codeReviewTargetFromKey(key).cwd))
      codeReviewCache.forget(key);
  }
});
