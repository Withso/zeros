import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  CodeReviewThread,
  CodeReviewListResult,
} from "@zeros/protocol/code-review";
import {
  createCodeReviewThread,
  listCodeReviewThreads,
  replyCodeReviewThread,
  setCodeReviewThreadResolved,
} from "@/renderer/platform/bridge/code-review-bridge";
import {
  getActiveBridge,
  onActiveBridgeChange,
  onActiveBridgeConnected,
} from "@/renderer/platform/bridge/active-bridge";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "@/renderer/shared/lib/keyed-async-cache";
import {
  codeReviewCache,
  codeReviewCacheKey,
  codeReviewTargetFromKey,
  publishCodeReviewPage,
  publishCodeReviewThread,
  type CodeReviewCollection,
} from "./review-cache";
import {
  beginReviewCacheRequest,
  registerReviewCacheForget,
} from "./review-cache-forget";
import { ReviewDraftStore } from "./review-draft-store";
import { useCodeReviewExternal } from "./review-external-context";
import {
  EMPTY_REVIEW_THREADS,
  type CodeReviewExternalSource,
  type CodeReviewOperations,
  type CodeReviewThreadItem,
} from "./review-thread-model";

const EMPTY_THREADS: readonly CodeReviewThread[] = Object.freeze([]);
const IDLE: AsyncCacheSnapshot<CodeReviewCollection> = Object.freeze({
  data: undefined,
  loading: false,
  refreshing: false,
  error: null,
  updatedAt: 0,
  invalidationVersion: 0,
});
const pages = new KeyedAsyncCache<CodeReviewListResult>({
  maxEntries: 128,
  maxWeight: 16 * 1024 * 1024,
  weightOf: (page) =>
    page.threads.reduce(
      (sum, thread) =>
        sum +
        thread.comments.reduce(
          (bytes, comment) => bytes + comment.body.length * 2,
          0,
        ),
      0,
    ),
});
const aliases = new Map<string, string>();
registerReviewCacheForget((ownsFolder) => {
  for (const key of pages.keys()) {
    const [ownerKey] = JSON.parse(key) as [
      string,
      string | null,
      string | null,
    ];
    if (ownsFolder(codeReviewTargetFromKey(ownerKey).cwd)) pages.forget(key);
  }
  for (const key of aliases.keys()) {
    if (ownsFolder(codeReviewTargetFromKey(key).cwd)) aliases.delete(key);
  }
});
const normalized = new WeakMap<CodeReviewThread, CodeReviewThreadItem>();
let eventsStarted = false;

function startReviewEvents(): void {
  if (eventsStarted) return;
  eventsStarted = true;
  let stop: (() => void) | undefined;
  const attach = (bridge: ReturnType<typeof getActiveBridge>) => {
    stop?.();
    stop = bridge?.on("DB_CHANGED", (message) => {
      if (message.type !== "DB_CHANGED") return;
      if (!message.kinds.includes("codeReview")) return;
      const ids = message.workspaceIds;
      for (const key of codeReviewCache.keys()) {
        const [, target] = JSON.parse(key) as [string, string];
        if (
          !ids?.length ||
          ids.includes(target) ||
          ids.includes(aliases.get(key) ?? "")
        )
          codeReviewCache.invalidate(key);
      }
    });
  };
  attach(getActiveBridge());
  onActiveBridgeChange((bridge) => {
    codeReviewCache.invalidateAll();
    pages.invalidateAll();
    attach(bridge);
  });
}

export async function loadCodeReview(
  key: string,
  force = false,
): Promise<CodeReviewCollection> {
  const { cwd, workspaceId } = codeReviewTargetFromKey(key);
  const request = beginReviewCacheRequest(cwd);
  try {
    const collection = await codeReviewCache.load(
      key,
      async () => {
        request.assertCurrent();
        const result = await listCodeReviewThreads({
          workspaceId,
          includeResolved: true,
        });
        request.assertCurrent();
        aliases.set(key, result.workspaceId);
        const retained = new Set(codeReviewCache.keys());
        for (const alias of aliases.keys())
          if (!retained.has(alias)) aliases.delete(alias);
        return { ...result, partial: !!result.partial };
      },
      { force, maxAgeMs: 15_000 },
    );
    request.assertCurrent();
    return collection;
  } finally {
    request.finish();
  }
}

export async function loadCodeReviewPage(
  key: string,
  request: { cursor?: string; threadId?: string },
): Promise<void> {
  const { cwd, workspaceId } = codeReviewTargetFromKey(key);
  const lifetime = beginReviewCacheRequest(cwd);
  const pageKey = JSON.stringify([
    key,
    request.threadId ?? null,
    request.cursor ?? null,
  ]);
  try {
    const page = await pages.load(
      pageKey,
      () => {
        lifetime.assertCurrent();
        return listCodeReviewThreads({
          workspaceId,
          includeResolved: true,
          ...request,
        });
      },
      { force: true },
    );
    lifetime.assertCurrent();
    publishCodeReviewPage(codeReviewCache, key, page, request);
  } finally {
    lifetime.finish();
  }
}

export interface CodeReviewController {
  ownerKey: string;
  threads: readonly CodeReviewThreadItem[];
  operations: CodeReviewOperations;
  drafts: ReviewDraftStore;
  external?: CodeReviewExternalSource;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  partial?: boolean;
  nextCursor?: string;
  viewerActorId?: string;
  loadMore?: () => Promise<void>;
}

export function useCodeReview({
  cwd,
  workspaceId,
  active,
  refreshKey = 0,
  external: suppliedExternal,
}: {
  cwd: string | undefined;
  workspaceId?: string | null;
  active: boolean;
  refreshKey?: number;
  external?: CodeReviewExternalSource;
}): CodeReviewController {
  const inheritedExternal = useCodeReviewExternal();
  const external = suppliedExternal ?? inheritedExternal;
  const target = workspaceId || cwd || "";
  const key = cwd && target ? codeReviewCacheKey(cwd, target) : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      key ? codeReviewCache.subscribe(key, listener) : () => {},
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? codeReviewCache.getSnapshot(key) : IDLE),
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const externalRef = useRef(external);
  externalRef.current = external;
  const activeRef = useRef({ key, active });
  activeRef.current = { key, active };
  const drafts = useMemo(
    () => new ReviewDraftStore(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ephemeral drafts have the exact workspace cache owner's lifetime
    [key],
  );
  useEffect(() => {
    startReviewEvents();
    if (!active || !key) return;
    void loadCodeReview(key).catch(() => {});
  }, [active, key, refreshKey, snapshot.invalidationVersion]);
  useEffect(() => {
    if (!active || !key || !cwd) return;
    return onActiveBridgeConnected((_bridge, { initial }) => {
      if (!initial) codeReviewCache.invalidate(key);
      void loadCodeReview(key).catch(() => {});
    }, cwd);
  }, [active, key, cwd]);

  const local = useMemo(
    () =>
      (snapshot.data?.threads ?? EMPTY_THREADS).map((thread) => {
        let item = normalized.get(thread);
        if (!item) {
          item = {
            ...thread,
            source: "workspace",
            canReply: true,
            canResolve: true,
          };
          normalized.set(thread, item);
        }
        return item;
      }),
    [snapshot.data?.threads],
  );
  const threads = useMemo(() => {
    const remote = external?.threads ?? EMPTY_REVIEW_THREADS;
    return remote.length ? [...local, ...remote] : local;
  }, [local, external?.threads]);
  const operations = useMemo<CodeReviewOperations>(
    () => ({
      create: async (anchor, body, requestId) => {
        if (!key || !target)
          throw new Error("Open a workspace to add a comment.");
        const request = beginReviewCacheRequest(
          codeReviewTargetFromKey(key).cwd,
        );
        try {
          const thread = await createCodeReviewThread({
            workspaceId: target,
            anchor,
            body,
            requestId,
          });
          request.assertCurrent();
          publishCodeReviewThread(codeReviewCache, key, thread, request);
          codeReviewCache.invalidate(key);
        } finally {
          request.finish();
        }
      },
      reply: async (thread, body, requestId) => {
        if (thread.source !== "workspace") {
          const adapter = externalRef.current;
          if (!thread.canReply || !adapter?.reply)
            throw new Error("This discussion is read-only.");
          await adapter.reply(thread, body);
          return;
        }
        if (!key || !target) throw new Error("Open a workspace to reply.");
        const request = beginReviewCacheRequest(
          codeReviewTargetFromKey(key).cwd,
        );
        try {
          const result = await replyCodeReviewThread({
            workspaceId: target,
            threadId: thread.id,
            body,
            requestId,
          });
          request.assertCurrent();
          publishCodeReviewThread(codeReviewCache, key, result, request);
          codeReviewCache.invalidate(key);
        } finally {
          request.finish();
        }
      },
      setResolved: async (thread, resolved) => {
        if (thread.source !== "workspace") {
          const adapter = externalRef.current;
          if (!thread.canResolve || !adapter?.setResolved)
            throw new Error("This discussion is read-only.");
          await adapter.setResolved(thread, resolved);
          return;
        }
        if (!key || !target || typeof thread.version !== "number")
          throw new Error("Open a workspace to update this discussion.");
        const request = beginReviewCacheRequest(
          codeReviewTargetFromKey(key).cwd,
        );
        try {
          const result = await setCodeReviewThreadResolved({
            workspaceId: target,
            threadId: thread.id,
            resolved,
            expectedVersion: thread.version,
            requestId: crypto.randomUUID(),
          });
          request.assertCurrent();
          publishCodeReviewThread(codeReviewCache, key, result, request);
        } finally {
          if (request.isCurrent()) codeReviewCache.invalidate(key);
          request.finish();
        }
      },
      loadMoreComments: async (thread) => {
        if (
          !key ||
          thread.source !== "workspace" ||
          !thread.commentsCursor ||
          activeRef.current.key !== key ||
          !activeRef.current.active
        )
          return;
        await loadCodeReviewPage(key, {
          threadId: thread.id,
          cursor: thread.commentsCursor,
        });
      },
    }),
    [key, target],
  );
  const refresh = useCallback(() => {
    if (key && active) {
      codeReviewCache.invalidate(key);
      void loadCodeReview(key).catch(() => {});
    }
  }, [key, active]);
  const loadMore = useCallback(async () => {
    if (!key || activeRef.current.key !== key || !activeRef.current.active)
      return;
    const current = codeReviewCache.getSnapshot(key).data;
    if (current?.nextCursor)
      await loadCodeReviewPage(key, { cursor: current.nextCursor });
    else if (current?.partial) await loadCodeReview(key, true);
  }, [key]);
  return {
    ownerKey: key ?? "",
    threads,
    operations,
    drafts,
    external,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
    partial: snapshot.data?.partial,
    nextCursor: snapshot.data?.nextCursor,
    viewerActorId: snapshot.data?.viewerActorId,
    loadMore,
  };
}
