import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ghPrGet, type PR, type Workspace } from "../../platform/git";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "../../shared/lib/keyed-async-cache";
import { useDocumentActive } from "../../state/use-document-active";
import {
  changeCountsForGeneration,
  statusForGeneration,
} from "../git-status-reads";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { registerPrWorkspaceCacheForget } from "../pr/pr-cache-forget";
import {
  PR_STATUS_FULL_POLL_MS,
  effectivePrPollState,
  isTerminalPrState,
} from "../pr/pr-status-refresh";
import {
  supportsSummaryGitStatus,
  type SummaryGitFacts,
} from "./summary-git-status-model";

const gitCache = new KeyedAsyncCache<SummaryGitFacts>({
  maxEntries: 64,
  reconcile: (previous, next) =>
    JSON.stringify(previous) === JSON.stringify(next) ? previous! : next,
});
const prCache = new KeyedAsyncCache<PR | null>(64);
const generations = new Map<string, number>();
const prAttempts = new Map<string, number>();

export function summaryGitKey(workspace: Workspace): string {
  return JSON.stringify([
    workspace.id,
    workspace.organizationId ?? null,
    workspace.path,
    workspace.baseBranch,
    workspace.prNumber,
    workspace.prState,
  ]);
}

function observeGeneration(key: string, generation: number): void {
  const previous = generations.get(key);
  if (previous !== generation) {
    gitCache.invalidate(key);
  }
  generations.delete(key);
  generations.set(key, generation);
  while (generations.size > 64)
    generations.delete(generations.keys().next().value!);
}

export function loadSummaryGit(
  workspace: Workspace,
  generation: number,
): Promise<SummaryGitFacts> {
  if (!supportsSummaryGitStatus(workspace))
    return Promise.reject(new Error("Git summary is local only"));
  const key = summaryGitKey(workspace);
  observeGeneration(key, generation);
  return gitCache.load(
    key,
    async () => {
      const [status, counts] = await Promise.all([
        statusForGeneration(workspace.id, generation, workspace.path),
        changeCountsForGeneration(workspace.id, generation),
      ]);
      return {
        all: counts.all,
        uncommitted: counts.uncommitted,
        conflicted: status.conflicted.length,
        operation: status.conflictState,
        ahead: status.ahead ?? null,
        behind: status.behind ?? null,
        upstream: status.upstream ?? null,
        branch: status.summary?.branch,
        base: status.summary?.base,
      };
    },
    { maxAgeMs: gitCache.getSnapshot(key).error ? -1 : 30_000 },
  );
}

export function loadSummaryPr(workspace: Workspace): Promise<PR | null> {
  if (!supportsSummaryGitStatus(workspace) || workspace.prNumber == null)
    return Promise.resolve(null);
  const key = summaryGitKey(workspace);
  const snapshot = prCache.getSnapshot(key);
  const attemptedAt = prAttempts.get(key);
  const age = attemptedAt === undefined ? Infinity : Date.now() - attemptedAt;
  // Failed reads have no successful freshness timestamp. Bound repeated
  // pointer/focus intent too, while an explicit Retry/mutation can bypass it.
  if (snapshot.error && age >= 0 && age < PR_STATUS_FULL_POLL_MS) {
    return snapshot.data === undefined
      ? Promise.reject(snapshot.error)
      : Promise.resolve(snapshot.data);
  }
  return prCache.load(
    key,
    async () => {
      prAttempts.delete(key);
      prAttempts.set(key, Date.now());
      while (prAttempts.size > 64)
        prAttempts.delete(prAttempts.keys().next().value!);
      const pr = await ghPrGet({
        workspaceId: workspace.id,
        prNumber: workspace.prNumber!,
      });
      return pr.number === workspace.prNumber ? pr : null;
    },
    { maxAgeMs: snapshot.error ? -1 : PR_STATUS_FULL_POLL_MS },
  );
}

export function invalidateSummaryGit(workspace: Workspace): void {
  const key = summaryGitKey(workspace);
  prAttempts.delete(key);
  gitCache.invalidate(key);
  prCache.invalidate(key);
}

function useSnapshot<T>(
  cache: KeyedAsyncCache<T>,
  key: string,
): AsyncCacheSnapshot<T> {
  const subscribe = useCallback(
    (notify: () => void) => cache.subscribe(key, notify),
    [cache, key],
  );
  const snapshot = useCallback(() => cache.getSnapshot(key), [cache, key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Git does not wait on GitHub. Each lane retains the last exact-owner result;
 * only the selected, expanded, foreground Summary starts reads or timers. */
export function useSummaryGitStatus(workspace: Workspace, active: boolean) {
  const observing = useDocumentActive(active, true);
  const key = summaryGitKey(workspace);
  const generation = useGitRefreshKey(workspace.path, workspace.id, observing);
  const git = useSnapshot(gitCache, key);
  const pr = useSnapshot(prCache, key);
  const currentWorkspace = useRef(workspace);
  currentWorkspace.current = workspace;
  useEffect(() => {
    if (!observing) return;
    void loadSummaryGit(workspace, generation).catch(() => {});
  }, [observing, key, generation, git.invalidationVersion, workspace]);
  useEffect(() => {
    if (!observing) return;
    // A file edit or workspace-list refresh is not a new GitHub observation.
    // Read on activation, owner change, explicit refresh and the PR timer.
    void loadSummaryPr(currentWorkspace.current).catch(() => {});
  }, [observing, key, pr.invalidationVersion]);

  const terminal = isTerminalPrState(
    effectivePrPollState(pr.data, workspace.prState),
  );
  useEffect(() => {
    if (!observing || workspace.prNumber == null || terminal) return;
    const timer = window.setTimeout(() => {
      prCache.invalidate(key);
    }, PR_STATUS_FULL_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [
    observing,
    key,
    workspace.prNumber,
    terminal,
    pr.updatedAt,
    pr.error,
    pr.invalidationVersion,
  ]);

  const refresh = useCallback(
    () => invalidateSummaryGit(workspace),
    [workspace],
  );
  return { git, pr, refresh };
}

registerPrWorkspaceCacheForget((workspaceId) => {
  // The small key registry is bounded alongside the snapshots. It carries no
  // authority; confirmed deletion retires pending reads as well as paint.
  for (const key of new Set([
    ...gitCache.keys(),
    ...prCache.keys(),
    ...generations.keys(),
    ...prAttempts.keys(),
  ])) {
    if (JSON.parse(key)[0] !== workspaceId) continue;
    generations.delete(key);
    prAttempts.delete(key);
    gitCache.forget(key);
    prCache.forget(key);
  }
});

export const summaryGitSnapshotForTesting = (workspace: Workspace) =>
  gitCache.getSnapshot(summaryGitKey(workspace));
export function resetSummaryGitForTesting(): void {
  gitCache.clear();
  prCache.clear();
  generations.clear();
  prAttempts.clear();
}
