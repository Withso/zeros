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
}

export function reconcileCodeReviewThreads(
  previous: readonly CodeReviewThread[] | undefined,
  next: readonly CodeReviewThread[],
): readonly CodeReviewThread[] {
  if (!previous) return next;
  const byId = new Map(previous.map((thread) => [thread.id, thread]));
  const shared = mergeCodeReviewThreads(previous, next).map((thread) => {
    const existing = byId.get(thread.id);
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
  if (!previous) return next;
  if (previous && previous.workspaceId !== next.workspaceId)
    throw new Error("Review pages belong to different workspaces.");
  const threads = reconcileCodeReviewThreads(previous?.threads, next.threads);
  const viewerActorId = next.viewerActorId ?? previous?.viewerActorId;
  return previous &&
    previous.threads === threads &&
    previous.nextCursor === next.nextCursor &&
    previous.partial === next.partial &&
    previous.viewerActorId === viewerActorId
    ? previous
    : { ...next, threads, viewerActorId };
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
  cache.setData(key, {
    ...(previous ?? { workspaceId: thread.workspaceId, partial: true }),
    threads: reconcileCodeReviewThreads(previous?.threads, [thread]),
  });
}

/** A continuation can overlap a refresh or mutation. Merge immutable history,
 * but advance pagination only while its captured cursor still owns the slot. */
export function publishCodeReviewPage(
  cache: KeyedAsyncCache<CodeReviewCollection>,
  key: string,
  page: CodeReviewListResult,
  request: { cursor?: string; threadId?: string },
): void {
  const previous = cache.getSnapshot(key).data;
  if (!previous) return;
  if (previous.workspaceId !== page.workspaceId)
    throw new Error("Review pages belong to different workspaces.");
  const threads = reconcileCodeReviewThreads(previous.threads, page.threads);
  if (request.threadId) {
    // The shared merge chooses the continuation covered by the actual loaded
    // prefix, including root/latest mutation previews with a gap.
    cache.setData(key, { ...previous, threads });
  } else {
    const current = previous.nextCursor === request.cursor;
    cache.setData(key, {
      ...previous,
      threads,
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
