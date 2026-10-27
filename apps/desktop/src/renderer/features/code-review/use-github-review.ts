import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import type { PrInlineReview } from "@zeros/protocol/github-review";
import {
  postPrLineComment,
  replyPrReviewThread,
  setPrReviewThreadResolved,
} from "@/renderer/platform/github-review";
import { codeReviewAvailable } from "@/renderer/platform/bridge/code-review-availability";
import { useDocumentActive } from "@/renderer/state/use-document-active";
import type { AsyncCacheSnapshot } from "@/renderer/shared/lib/keyed-async-cache";
import {
  githubReviewCache,
  githubReviewKey,
  githubReviewTargetFromKey,
} from "./github-review-cache";
import {
  confirmGithubReviewRevision,
  observeGithubReview,
  refreshGithubReview,
} from "./github-review-observer";
import {
  githubLineCommentForAnchor,
  githubReviewItems,
  githubReviewNotice,
  githubReviewRevision,
} from "./github-review-model";
import {
  EMPTY_REVIEW_THREADS,
  type CodeReviewThreadItem,
} from "./review-thread-model";
import {
  beginReviewCacheRequest,
  type ReviewCacheRequest,
} from "./review-cache-forget";

const IDLE: AsyncCacheSnapshot<PrInlineReview> = Object.freeze({
  data: undefined, loading: false, refreshing: false, error: null,
  updatedAt: 0, invalidationVersion: 0,
});

function beginGithubReviewMutation(cwd: string | undefined): ReviewCacheRequest {
  if (!cwd?.trim())
    throw new Error("Open a workspace before changing a GitHub review.");
  return beginReviewCacheRequest(cwd);
}

export function useGithubReview({
  workspaceId,
  prNumber,
  cwd,
  active,
  confirmedHeadSha,
  confirmedBaseSha,
  renamedPaths,
}: {
  workspaceId: string | null | undefined;
  prNumber: number | null | undefined;
  cwd?: string;
  active: boolean;
  /** Supplied only by the published PR diff, never a working-tree comparison. */
  confirmedHeadSha?: string;
  confirmedBaseSha?: string;
  renamedPaths?: ReadonlyMap<string, string>;
}) {
  const available = codeReviewAvailable({ cwd, workspaceId });
  // Cloud v2 can report a PR summary but does not serve inline review. A null
  // key also hides any stale unsupported response cached by an older renderer.
  const key = available && workspaceId && prNumber ? githubReviewKey(workspaceId, prNumber) : null;
  const foreground = useDocumentActive(!!key && active, true);
  const subscribe = useCallback((listener: () => void) =>
    key && foreground ? githubReviewCache.subscribe(key, listener) : () => {},
  [key, foreground]);
  const getSnapshot = useCallback(() => key ? githubReviewCache.getSnapshot(key) : IDLE, [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const consumer = useMemo(() => ({ current: active, key, cwd }), [key, active, cwd]);
  const loadedHeadSha = snapshot.data?.headSha;
  const loadedBaseSha = snapshot.data?.baseSha;
  const threads = useMemo(
    () =>
      snapshot.data && key
        ? githubReviewItems(snapshot.data, githubReviewTargetFromKey(key))
        : EMPTY_REVIEW_THREADS,
    [snapshot.data, key],
  );
  useEffect(() => {
    consumer.current = active;
    const stop = key && active ? observeGithubReview(key, cwd) : undefined;
    return () => {
      consumer.current = false;
      stop?.();
    };
  }, [key, active, cwd, consumer]);
  useEffect(() => {
    if (
      !key ||
      !active ||
      !confirmedHeadSha ||
      !confirmedBaseSha ||
      !loadedHeadSha ||
      (loadedHeadSha === confirmedHeadSha && loadedBaseSha === confirmedBaseSha)
    )
      return;
    confirmGithubReviewRevision(key, confirmedHeadSha, confirmedBaseSha);
  }, [
    key,
    active,
    confirmedHeadSha,
    confirmedBaseSha,
    loadedHeadSha,
    loadedBaseSha,
  ]);

  const refreshAfterWrite = useCallback(
    async (request: ReviewCacheRequest) => {
      if (!key || !request.isCurrent() || !consumer.current || !active) return;
      // Posting succeeded even if refreshing fails. Do not keep a successfully
      // sent draft around inviting a duplicate; the read error remains visible.
      await refreshGithubReview(key, cwd, () => request.isCurrent() && consumer.current);
    },
    [key, cwd, consumer, active],
  );
  const reply = useCallback(
    async (thread: CodeReviewThreadItem, body: string) => {
      if (!key || thread.source !== "github")
        throw new Error("This finding does not accept replies.");
      const current = githubReviewCache
        .getSnapshot(key)
        .data?.threads.find((item) => item.id === thread.id);
      const commentId = current?.comments[0]?.databaseId;
      if (!commentId) throw new Error("Refresh this thread before replying.");
      const request = beginGithubReviewMutation(cwd);
      try {
        await replyPrReviewThread({
          ...githubReviewTargetFromKey(key),
          commentId,
          body,
        });
        await refreshAfterWrite(request);
      } finally {
        request.finish();
      }
    },
    [key, cwd, refreshAfterWrite],
  );
  const setResolved = useCallback(
    async (thread: CodeReviewThreadItem, resolved: boolean) => {
      if (!key || thread.source !== "github")
        throw new Error("This finding cannot be resolved here.");
      const current = githubReviewCache
        .getSnapshot(key)
        .data?.threads.find((item) => item.id === thread.id);
      if (!current || !(resolved ? current.canResolve : current.canUnresolve))
        throw new Error(
          "You do not have permission to change this thread's status.",
        );
      const request = beginGithubReviewMutation(cwd);
      try {
        await setPrReviewThreadResolved({
          ...githubReviewTargetFromKey(key),
          threadId: thread.id,
          resolved,
        });
        await refreshAfterWrite(request);
      } finally {
        request.finish();
      }
    },
    [key, cwd, refreshAfterWrite],
  );
  const confirmed =
    confirmedBaseSha &&
    loadedHeadSha === confirmedHeadSha &&
    loadedBaseSha === confirmedBaseSha
      ? confirmedHeadSha
      : undefined;
  const confirmedRevision = useMemo(
    () =>
      key && confirmed && confirmedBaseSha
        ? githubReviewRevision(githubReviewTargetFromKey(key), {
            headSha: confirmed,
            baseSha: confirmedBaseSha,
          })
        : undefined,
    [key, confirmed, confirmedBaseSha],
  );
  const postComment = useCallback(
    async (anchor: CodeReviewAnchor, body: string) => {
      if (!key || !confirmed || !confirmedBaseSha)
        throw new Error(
          "Open the published pull request diff before posting a line comment to GitHub.",
        );
      const request = beginGithubReviewMutation(cwd);
      try {
        await postPrLineComment(
          githubLineCommentForAnchor(
            githubReviewTargetFromKey(key),
            { headSha: confirmed, baseSha: confirmedBaseSha },
            anchor,
            body,
            renamedPaths,
          ),
        );
        await refreshAfterWrite(request);
      } finally {
        request.finish();
      }
    },
    [key, cwd, confirmed, confirmedBaseSha, renamedPaths, refreshAfterWrite],
  );
  const error = snapshot.error?.message;
  const notice = githubReviewNotice(snapshot.data);
  const source = useMemo(
    () =>
      key
        ? {
            threads,
            reply,
            setResolved,
            ...(confirmedRevision
              ? { confirmedRevision, postComment, createLabel: "Post to PR" }
              : {}),
            ...(error ? { error } : {}),
            ...(notice ? { notice } : {}),
            loading: snapshot.loading,
          }
        : undefined,
    [
      key,
      threads,
      reply,
      setResolved,
      confirmedRevision,
      postComment,
      error,
      notice,
      snapshot.loading,
    ],
  );
  return {
    source,
    snapshot: snapshot.data,
    refresh: useCallback(
      () =>
        key && active
          ? refreshGithubReview(key, cwd, () => consumer.current)
          : Promise.resolve(),
      [key, active, cwd, consumer],
    ),
    error,
    notice,
  };
}
