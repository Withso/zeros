import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import {
  getPrInlineReview,
  postPrLineComment,
  replyPrReviewThread,
  setPrReviewThreadResolved,
} from "@/renderer/platform/github-review";
import { onActiveBridgeConnected } from "@/renderer/platform/bridge/active-bridge";
import { useCachedRead } from "@/renderer/state/use-cached-read";
import {
  githubReviewCache,
  githubReviewKey,
  githubReviewTargetFromKey,
  observeGithubReviewRefresh,
} from "./github-review-cache";
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

const FRESH_MS = 45_000;
const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";
const readKey = (key: string) =>
  getPrInlineReview(githubReviewTargetFromKey(key));

export function useGithubReview({
  workspaceId,
  prNumber,
  cwd,
  active,
  refreshKey,
  confirmedHeadSha,
  confirmedBaseSha,
  renamedPaths,
}: {
  workspaceId: string | null | undefined;
  prNumber: number | null | undefined;
  cwd?: string;
  active: boolean;
  refreshKey: number;
  /** Supplied only by the published PR diff, never a working-tree comparison. */
  confirmedHeadSha?: string;
  confirmedBaseSha?: string;
  renamedPaths?: ReadonlyMap<string, string>;
}) {
  const key =
    workspaceId && prNumber ? githubReviewKey(workspaceId, prNumber) : null;
  const [documentVisible, setDocumentVisible] = useState(visible);
  const snapshot = useCachedRead(githubReviewCache, key, readKey, {
    enabled: active && documentVisible,
    maxAgeMs: FRESH_MS,
  });
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
    if (key) observeGithubReviewRefresh(key, refreshKey);
  }, [key, refreshKey]);
  useEffect(() => {
    if (!key || !active) return;
    setDocumentVisible(visible());
    const read = (maxAgeMs: number) => {
      if (visible())
        void githubReviewCache
          .load(key, () => readKey(key), { maxAgeMs })
          .catch(() => {});
    };
    const resume = () => {
      setDocumentVisible(visible());
      read(2_000);
    };
    const timer = setInterval(() => read(FRESH_MS), 30_000);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    const unsubscribe = onActiveBridgeConnected(
      (_client, info) => read(info.initial ? FRESH_MS : -1),
      cwd,
    );
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
      unsubscribe();
    };
  }, [key, active, cwd]);
  useEffect(() => {
    if (
      !key ||
      !active ||
      !visible() ||
      !confirmedHeadSha ||
      !confirmedBaseSha ||
      !loadedHeadSha ||
      (loadedHeadSha === confirmedHeadSha && loadedBaseSha === confirmedBaseSha)
    )
      return;
    void githubReviewCache
      .load(key, () => readKey(key), { force: true })
      .catch(() => {});
  }, [
    key,
    active,
    confirmedHeadSha,
    confirmedBaseSha,
    loadedHeadSha,
    loadedBaseSha,
  ]);

  const refreshAfterWrite = useCallback(async () => {
    if (!key) return;
    githubReviewCache.invalidate(key);
    // Posting succeeded even if refreshing fails. Do not keep a successfully
    // sent draft around inviting a duplicate; the read error remains visible.
    await githubReviewCache
      .load(key, () => readKey(key), { force: true })
      .catch(() => {});
  }, [key]);
  const reply = useCallback(
    async (thread: CodeReviewThreadItem, body: string) => {
      if (!key || thread.source !== "github")
        throw new Error("This finding does not accept replies.");
      const current = githubReviewCache
        .getSnapshot(key)
        .data?.threads.find((item) => item.id === thread.id);
      const commentId = current?.comments[0]?.databaseId;
      if (!commentId) throw new Error("Refresh this thread before replying.");
      await replyPrReviewThread({
        ...githubReviewTargetFromKey(key),
        commentId,
        body,
      });
      await refreshAfterWrite();
    },
    [key, refreshAfterWrite],
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
      await setPrReviewThreadResolved({
        ...githubReviewTargetFromKey(key),
        threadId: thread.id,
        resolved,
      });
      await refreshAfterWrite();
    },
    [key, refreshAfterWrite],
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
      await postPrLineComment(
        githubLineCommentForAnchor(
          githubReviewTargetFromKey(key),
          { headSha: confirmed, baseSha: confirmedBaseSha },
          anchor,
          body,
          renamedPaths,
        ),
      );
      await refreshAfterWrite();
    },
    [key, confirmed, confirmedBaseSha, renamedPaths, refreshAfterWrite],
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
    refresh: snapshot.refresh,
    error,
    notice,
  };
}
