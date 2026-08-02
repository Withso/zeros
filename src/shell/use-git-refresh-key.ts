// ──────────────────────────────────────────────────────────
// useGitRefreshKey — a counter that bumps when the workspace's git/file state
// may have changed, so a view can re-fetch without a manual Refresh.
// ──────────────────────────────────────────────────────────
//
// Every column-3 surface (File viewers, the Changes/Files/Review tabs, the
// strip's change-count badge) subscribes to this ONE refresh bus. It bumps on:
//   1. DB_CHANGED { kinds: ["workspaces"] } — a bridge git write (stage /
//      unstage / discard / commit / …) or a cross-device write reached the
//      engine. The engine broadcasts this immediately after the op, so it's the
//      live signal for a Discard or any in-app git mutation.
//   2. Any chat's agent finishing a turn — the agent edits files / runs git via
//      its OWN shell (bypassing the bridge), so the streaming→idle transition
//      is the renderer-visible "its work just landed" signal. A single
//      coordinator watches every chat, including workspaces currently hidden.
//
//   3. triggerGitRefresh() — a renderer/native write that bypassed the bridge
//      (the row-1 editor save, or a completed row-1 Discard flow).
//
// Every publisher invalidates the affected exact cwd (or all cwd keys when the
// engine can only provide a coarse signal) before counters bump. All Files and
// Changes therefore advance as one coherent generation instead of the file
// tree serving a deleted path for the cache's remaining TTL.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { subscribeContextGraphChanged } from "../native/context-graph";
import { useBridge } from "../zeros/bridge/use-bridge";
import { onActiveBridgeConnected } from "../zeros/bridge/active-bridge";
import type { RuntimeClient } from "../zeros/bridge/ws-client";
import { useSessionsStore } from "../zeros/agent/sessions-store";
import { useWorkspaceStore } from "../zeros/store/store";
import {
  invalidateAllWorkspaceFiles,
  invalidateWorkspaceFiles,
} from "./workspace-files-cache";
import {
  invalidateAllWorkspaceFileData,
  invalidateWorkspaceFileData,
} from "./workspace-file-data-cache";
import {
  invalidateAllEngineReadCaches,
  invalidateExternalGitRefCaches,
} from "../zeros/store/read-caches";
import { invalidateAgentsCache } from "../zeros/agent/agents-cache";
import {
  notifyWorkspacesChanged,
  notifyWorkspacesChangedForIds,
} from "../zeros/store/use-projects";

// Renderer-side refresh generations — for writes that DON'T go through the
// engine bridge (so no DB_CHANGED broadcast), e.g. the Files-tab editor saving
// via the electron `write_file` IPC. A subscriber owns both its local cwd and,
// when available, the engine's opaque workspace id. Either exact identity can
// advance it; coarse engine broadcasts remain the explicit all-workspace
// fallback.
const MAX_REFRESH_SCOPE_VERSIONS = 256;
const MAX_KNOWN_WORKSPACES = 128;
const MAX_CWDS_PER_WORKSPACE = 8;
const refreshListeners = new Map<string | null, Set<() => void>>();
const refreshVersionsByScope = new Map<string, number>();
const knownCwdsByWorkspaceId = new Map<string, Set<string>>();
let refreshVersion = 0;
let coarseRefreshVersion = 0;
const bridgeRefreshSubscriptions = new WeakMap<
  RuntimeClient,
  { users: number; unsubscribe: () => void }
>();

/** Treat trailing-separator variants as one refresh/cache identity. */
function normalizeRefreshCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  if (cwd === "/" || /^[A-Za-z]:[\\/]$/.test(cwd)) return cwd;
  return cwd.replace(/[\\/]+$/, "") || null;
}

function normalizeWorkspaceId(
  workspaceId: string | null | undefined,
): string | null {
  return workspaceId?.trim() || null;
}

interface RefreshScope {
  cwd: string | null;
  workspaceId: string | null;
}

function cwdScopeKey(cwd: string): string {
  return `cwd:${cwd}`;
}

function workspaceScopeKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

function scopeKeys(scope: RefreshScope): string[] {
  const keys: string[] = [];
  if (scope.cwd) keys.push(cwdScopeKey(scope.cwd));
  if (scope.workspaceId) keys.push(workspaceScopeKey(scope.workspaceId));
  return keys;
}

function makeRefreshScope(
  cwd: string | null | undefined,
  workspaceId?: string | null,
): RefreshScope {
  return {
    cwd: normalizeRefreshCwd(cwd),
    workspaceId: normalizeWorkspaceId(workspaceId),
  };
}

/** Retain the latest renderer path for an opaque id so a watcher event can
 * invalidate an inactive workspace's bounded path-keyed caches without ever
 * putting that host path on the wire. */
function rememberWorkspaceCwd(scope: RefreshScope): void {
  if (!scope.workspaceId || !scope.cwd) return;
  const knownCwds = knownCwdsByWorkspaceId.get(scope.workspaceId) ?? new Set();
  const alreadyKnown = knownCwds.has(scope.cwd);
  knownCwds.delete(scope.cwd);
  knownCwds.add(scope.cwd);
  while (knownCwds.size > MAX_CWDS_PER_WORKSPACE) {
    const oldest = knownCwds.values().next().value as string | undefined;
    if (!oldest) break;
    knownCwds.delete(oldest);
  }
  knownCwdsByWorkspaceId.delete(scope.workspaceId);
  knownCwdsByWorkspaceId.set(scope.workspaceId, knownCwds);
  while (knownCwdsByWorkspaceId.size > MAX_KNOWN_WORKSPACES) {
    const oldest = knownCwdsByWorkspaceId.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    knownCwdsByWorkspaceId.delete(oldest);
  }
  // The id may have changed before this path was first observed (for example
  // intent-prefetch followed by a background agent edit). Mark its cache stale
  // as soon as the mapping becomes available.
  if (
    !alreadyKnown &&
    refreshVersionsByScope.has(workspaceScopeKey(scope.workspaceId))
  ) {
    invalidateWorkspaceFiles(scope.cwd);
    invalidateWorkspaceFileData(scope.cwd, scope.workspaceId);
  }
}

/** Bound inactive generations while retaining every currently owned scope. */
function pruneRefreshVersions(): void {
  if (refreshVersionsByScope.size <= MAX_REFRESH_SCOPE_VERSIONS) return;
  for (const key of refreshVersionsByScope.keys()) {
    if ((refreshListeners.get(key)?.size ?? 0) > 0) continue;
    refreshVersionsByScope.delete(key);
    if (refreshVersionsByScope.size <= MAX_REFRESH_SCOPE_VERSIONS) break;
  }
}

/** Read the newest exact or coarse generation visible to one subscriber. */
function refreshSnapshot(scope: RefreshScope): number {
  const keys = scopeKeys(scope);
  if (keys.length === 0) return refreshVersion;
  return Math.max(
    coarseRefreshVersion,
    ...keys.map((key) => refreshVersionsByScope.get(key) ?? 0),
  );
}

/** Register one exact subscriber under both identities. No identity
 * intentionally observes every publish. */
function subscribeRefresh(
  scope: RefreshScope,
  listener: () => void,
): () => void {
  rememberWorkspaceCwd(scope);
  const keys: Array<string | null> = scopeKeys(scope);
  if (keys.length === 0) keys.push(null);
  for (const key of keys) {
    const listeners = refreshListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    refreshListeners.set(key, listeners);
  }
  return () => {
    for (const key of keys) {
      const listeners = refreshListeners.get(key);
      listeners?.delete(listener);
      if (listeners?.size === 0) refreshListeners.delete(key);
    }
    pruneRefreshVersions();
  };
}

/** Advance generations first, then wake only subscribers whose snapshot moved. */
function publishRefreshVersion(
  changedScopes: ReadonlySet<string>,
  coarse: boolean,
): void {
  const version = ++refreshVersion;
  if (coarse) {
    coarseRefreshVersion = version;
  } else {
    for (const key of changedScopes) {
      // Map order is the inactive-scope LRU queue.
      refreshVersionsByScope.delete(key);
      refreshVersionsByScope.set(key, version);
    }
  }
  pruneRefreshVersions();

  const listeners = new Set(refreshListeners.get(null) ?? []);
  if (coarse) {
    for (const scoped of refreshListeners.values()) {
      for (const listener of scoped) listeners.add(listener);
    }
  } else {
    for (const key of changedScopes) {
      for (const listener of refreshListeners.get(key) ?? []) {
        listeners.add(listener);
      }
    }
  }
  for (const listener of listeners) listener();
}

/** Invalidate every exact workspace first, then notify once. Multiple agents
 * can finish in the same store update; batching prevents a burst of redundant
 * React renders while preserving exact-key cache correctness. An unknown cwd
 * deliberately falls back to a coarse invalidation rather than risking stale
 * content in a chat that was removed while its turn completed. */
function publishRefreshForCwds(
  changedCwds: readonly (string | null | undefined)[],
  coarse = false,
): void {
  const normalizedCwds = changedCwds.map(normalizeRefreshCwd);
  const hasUnknownCwd = normalizedCwds.some((cwd) => cwd === null);
  const exactCwds = new Set(
    normalizedCwds.filter((cwd): cwd is string => cwd !== null),
  );
  if (coarse || hasUnknownCwd) {
    invalidateAllWorkspaceFiles();
    invalidateAllWorkspaceFileData();
  } else {
    for (const cwd of exactCwds) {
      invalidateWorkspaceFiles(cwd);
      const workspaceIds = Array.from(knownCwdsByWorkspaceId.entries())
        .filter(([, knownCwds]) => knownCwds.has(cwd))
        .map(([workspaceId]) => workspaceId);
      if (workspaceIds.length === 0) {
        // A rowless primary checkout uses its cwd as the git target. For a
        // not-yet-observed managed worktree this harmlessly matches no diff
        // key; the engine watcher supplies its opaque-id invalidation.
        invalidateWorkspaceFileData(cwd, cwd);
      } else {
        workspaceIds.forEach((workspaceId, index) =>
          invalidateWorkspaceFileData(
            index === 0 ? cwd : undefined,
            workspaceId,
          ),
        );
      }
    }
  }
  publishRefreshVersion(
    new Set(Array.from(exactCwds, cwdScopeKey)),
    coarse || hasUnknownCwd,
  );
}

function publishRefresh(changedCwd?: string, coarse = false): void {
  publishRefreshForCwds([changedCwd], coarse);
}

function publishRefreshForWorkspaceIds(
  changedWorkspaceIds: readonly unknown[],
): void {
  const workspaceIds = new Set(
    changedWorkspaceIds
      .filter((id): id is string => typeof id === "string")
      .map(normalizeWorkspaceId)
      .filter((id): id is string => id !== null),
  );
  if (workspaceIds.size === 0) {
    publishRefresh(undefined, true);
    return;
  }
  for (const workspaceId of workspaceIds) {
    const cwds = Array.from(knownCwdsByWorkspaceId.get(workspaceId) ?? []);
    for (const cwd of cwds) invalidateWorkspaceFiles(cwd);
    if (cwds.length === 0) {
      invalidateWorkspaceFileData(undefined, workspaceId);
    } else {
      for (const cwd of cwds) invalidateWorkspaceFileData(cwd, workspaceId);
    }
  }
  publishRefreshVersion(
    new Set(Array.from(workspaceIds, workspaceScopeKey)),
    false,
  );
}

function handleWorkspaceDbChanged(msg: unknown): void {
  const kinds = (msg as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds) || !kinds.includes("workspaces")) return;

  const workspaceIds = (msg as { workspaceIds?: unknown }).workspaceIds;
  const changedIds = Array.isArray(workspaceIds)
    ? workspaceIds.filter((id): id is string => typeof id === "string")
    : [];

  // Refresh the workspace lists. When the broadcast names ids, map each to its
  // repo slug and invalidate ONLY those repos (notifyWorkspacesChangedForIds
  // still refreshes the archived History collection and falls back to a coarse
  // '*' for an unknown/remote id) — keeping the common per-change case off the
  // global invalidate storm that made the Dashboard lag the top bar. With no
  // ids, the coarse workspace-list invalidation is the only safe choice.
  if (changedIds.length > 0) notifyWorkspacesChangedForIds(changedIds);
  else notifyWorkspacesChanged("*");

  const gitRefsChanged =
    (msg as { gitRefsChanged?: unknown }).gitRefsChanged === true;
  if (Array.isArray(workspaceIds) && workspaceIds.length > 0) {
    if (gitRefsChanged) {
      invalidateExternalGitRefCaches(
        workspaceIds.filter((id): id is string => typeof id === "string"),
      );
    }
    publishRefreshForWorkspaceIds(workspaceIds);
  } else {
    if (gitRefsChanged) invalidateExternalGitRefCaches();
    publishRefresh(undefined, true);
  }
}

function retainBridgeRefreshSubscription(bridge: RuntimeClient): () => void {
  const existing = bridgeRefreshSubscriptions.get(bridge);
  if (existing) {
    existing.users += 1;
    return () => releaseBridgeRefreshSubscription(bridge);
  }
  const unsubscribe = bridge.on("DB_CHANGED", handleWorkspaceDbChanged);
  bridgeRefreshSubscriptions.set(bridge, { users: 1, unsubscribe });
  return () => releaseBridgeRefreshSubscription(bridge);
}

function releaseBridgeRefreshSubscription(bridge: RuntimeClient): void {
  const subscription = bridgeRefreshSubscriptions.get(bridge);
  if (!subscription) return;
  subscription.users -= 1;
  if (subscription.users > 0) return;
  subscription.unsubscribe();
  bridgeRefreshSubscriptions.delete(bridge);
}

/** Publish a renderer/native write to the matching cwd subscribers. An omitted
 * cwd is the deliberate coarse fallback for a mutation with unknown scope. */
export function triggerGitRefresh(changedCwd?: string): void {
  publishRefresh(changedCwd);
}

// Composer attachment staging writes into `.context-graph/` over a plain IPC —
// no bridge op, no DB_CHANGED, and no turn end until the prompt is sent (if it
// ever is). The graph's own change signal is the renderer-side substitute:
// bridge it onto this refresh bus so the Files tab's tracked AND ignored
// listings pick the new folder up the moment the write lands, exactly like a
// row-1 editor save. Coalesced on a short trailing timer per workspace — a
// multi-file drop stages one write per file, and each already notifies
// individually — so one gesture costs one refresh.
const GRAPH_REFRESH_COALESCE_MS = 150;
const graphRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
subscribeContextGraphChanged((cwd) => {
  const key = normalizeRefreshCwd(cwd);
  if (!key) return;
  const pending = graphRefreshTimers.get(key);
  if (pending) clearTimeout(pending);
  graphRefreshTimers.set(
    key,
    setTimeout(() => {
      graphRefreshTimers.delete(key);
      triggerGitRefresh(key);
    }, GRAPH_REFRESH_COALESCE_MS),
  );
});

/** Return the chats that were streaming in the previous snapshot and are no
 * longer streaming now. Kept pure so the inactive-workspace edge case remains
 * regression-testable without mounting React. */
export function finishedStreamingChatIds(
  previous: readonly string[],
  current: readonly string[],
): string[] {
  if (previous.length === 0) return [];
  const currentIds = new Set(current);
  return previous.filter((chatId) => !currentIds.has(chatId));
}

/** Mount exactly once near the persistent workspace shell. The shallow array
 * selector allocates during a token update but remains referentially stable to
 * React while the set of streaming ids is unchanged, so token chunks do not
 * rerender this coordinator. */
export function useGitRefreshCoordinator(): void {
  const bridge = useBridge();
  const streamingChatIds = useSessionsStore(
    useShallow((state) =>
      Object.entries(state.sessions)
        .filter(([, session]) => session.status === "streaming")
        .map(([chatId]) => chatId)
        .sort(),
    ),
  );
  const previousStreamingRef = useRef<readonly string[] | null>(null);
  const streamingCwdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    // Keep the DB change listener alive even when Home is the only mounted
    // surface and no exact Git-key consumer exists yet. This is also the
    // workspace-list invalidation path for Dashboard and the top bar.
    if (!bridge) return;
    return retainBridgeRefreshSubscription(bridge);
  }, [bridge]);

  useEffect(() => {
    const sessions = useSessionsStore.getState().sessions;
    const workspace = useWorkspaceStore.getState();
    const resolveCwd = (chatId: string): string | null => {
      const sessionCwd = sessions[chatId]?.cwd;
      if (sessionCwd) return sessionCwd;
      const chatCwd = workspace.chats.find(
        (chat) => chat.id === chatId,
      )?.folder;
      return chatCwd || streamingCwdsRef.current.get(chatId) || null;
    };

    // Capture the cwd when streaming begins. It remains available if the chat
    // is closed/removed at exactly the same time as its final status update.
    for (const chatId of streamingChatIds) {
      const cwd = resolveCwd(chatId);
      if (cwd) streamingCwdsRef.current.set(chatId, cwd);
    }

    const previous = previousStreamingRef.current;
    previousStreamingRef.current = streamingChatIds;
    if (!previous) return;

    const finished = finishedStreamingChatIds(previous, streamingChatIds);
    if (finished.length === 0) return;
    publishRefreshForCwds(finished.map(resolveCwd));
    for (const chatId of finished) streamingCwdsRef.current.delete(chatId);
  }, [streamingChatIds]);

  useEffect(() => {
    // A cold connection or a reconnect is an authoritative freshness boundary:
    // files may have changed while the renderer could not hear watcher events.
    // The subscribe-time fire in an already healthy app is only a mount and must
    // not turn every shell remount into a global Git refresh.
    return onActiveBridgeConnected((_client, { initial }) => {
      refreshAfterBridgeConnection(initial);
    });
  }, []);
}

export function useGitRefreshKey(
  cwd?: string | null,
  workspaceId?: string | null,
): number {
  const normalizedCwd = normalizeRefreshCwd(cwd);
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeRefresh(
        { cwd: normalizedCwd, workspaceId: normalizedWorkspaceId },
        listener,
      ),
    [normalizedCwd, normalizedWorkspaceId],
  );
  const getSnapshot = useCallback(
    () =>
      refreshSnapshot({
        cwd: normalizedCwd,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedCwd, normalizedWorkspaceId],
  );
  const key = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const bridge = useBridge();
  useEffect(() => {
    if (!bridge) return;
    return retainBridgeRefreshSubscription(bridge);
  }, [bridge]);

  return key;
}

/** Test-only snapshot access for exact-scope publication assertions. */
export function getGitRefreshKeyForTests(
  cwd?: string | null,
  workspaceId?: string | null,
): number {
  return refreshSnapshot(makeRefreshScope(cwd, workspaceId));
}

/** Test-only listener binding for fan-out assertions without mounting React. */
export function subscribeGitRefreshForTests(
  cwd: string | null | undefined,
  listener: () => void,
  workspaceId?: string | null,
): () => void {
  return subscribeRefresh(makeRefreshScope(cwd, workspaceId), listener);
}

/** Test-only exact opaque-id publication, mirroring scoped DB_CHANGED. */
export function triggerGitRefreshForWorkspaceIdsForTests(
  workspaceIds: readonly string[],
): void {
  handleWorkspaceDbChanged({ kinds: ["workspaces"], workspaceIds });
}

function refreshAfterBridgeConnection(initial: boolean): void {
  // The subscribe-time fire in an already-healthy app is only a mount (see the
  // coordinator's comment) — an initial connection invalidates nothing.
  if (initial) return;
  // A NON-initial reconnection means the engine went away (restart, crash,
  // network drop) and anything derived from it may be stale — not just the
  // file/git caches the coarse publish below covers, but every bridge read
  // cache (branches, open PRs, picker workspaces, gh auth/owners) and the
  // agent registry snapshot. Mark them all stale here so a restarted engine's
  // state can't be shadowed by pre-restart snapshots for their full freshness
  // windows; mounted consumers revalidate silently, closed ones pay nothing.
  invalidateAllEngineReadCaches();
  invalidateAgentsCache();
  publishRefresh(undefined, true);
}

/** Test-only bridge boundary publication without mounting the coordinator. */
export function triggerGitBridgeConnectionForTests(initial: boolean): void {
  refreshAfterBridgeConnection(initial);
}

/** Test-only reset. Mounted subscribers are intentionally left registered. */
export function resetGitRefreshKeysForTests(): void {
  refreshVersionsByScope.clear();
  knownCwdsByWorkspaceId.clear();
  refreshVersion = 0;
  coarseRefreshVersion = 0;
}
