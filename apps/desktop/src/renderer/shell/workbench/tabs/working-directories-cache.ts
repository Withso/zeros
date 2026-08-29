// ──────────────────────────────────────────────────────────
// Working-directories read cache
// ──────────────────────────────────────────────────────────
//
// The panel is intentionally unmounted when Tree or Search owns the unified
// sidebar. Its Git snapshot therefore lives outside React: reopening paints the
// last exact-worktree value synchronously, shares concurrent reads, and keeps
// confirmed rows visible while an invalidation refreshes in the background.
// ──────────────────────────────────────────────────────────

import {
  listWorkingDirectories,
  type WorkingDirectoriesWire,
} from "@/renderer/platform/git";
import {
  stableWorkingDirectoriesSnapshot,
  WORKING_DIRECTORIES_MAX_AGE_MS,
  workingDirectoriesCache,
  workingDirectoriesCacheKey,
  workingDirectoriesRequest,
  type WorkingDirectoriesRequest,
} from "@/renderer/state/read-caches";

export {
  WORKING_DIRECTORIES_MAX_AGE_MS,
  workingDirectoriesCache,
  workingDirectoriesCacheKey,
  workingDirectoriesRequest,
};

export type WorkingDirectoriesFetcher = (
  request: WorkingDirectoriesRequest,
) => Promise<WorkingDirectoriesWire>;

const fetchFromEngine: WorkingDirectoriesFetcher = ({ cwd, workspaceId }) =>
  listWorkingDirectories(cwd, workspaceId);

/** Perform one exact request and structurally share an unchanged result. This
 * is the fetcher passed to useCachedRead; it does not call cache.load itself. */
export async function fetchWorkingDirectoriesSnapshot(
  key: string,
  fetcher: WorkingDirectoriesFetcher = fetchFromEngine,
): Promise<WorkingDirectoriesWire> {
  const next = await fetcher(workingDirectoriesRequest(key));
  return stableWorkingDirectoriesSnapshot(key, next);
}

/** Load through the shared cache. Used by intent warming and pure cache tests. */
export function loadWorkingDirectoriesSnapshot(
  key: string,
  fetcher: WorkingDirectoriesFetcher = fetchFromEngine,
): Promise<WorkingDirectoriesWire> {
  return workingDirectoriesCache.load(
    key,
    () => fetchWorkingDirectoriesSnapshot(key, fetcher),
    { maxAgeMs: WORKING_DIRECTORIES_MAX_AGE_MS },
  );
}

/** Pointer/focus intent starts the cold Git read before the urgent click. */
export function prefetchWorkingDirectories(
  cwd: string,
  workspaceId?: string | null,
): void {
  const key = workingDirectoriesCacheKey(cwd, workspaceId);
  void loadWorkingDirectoriesSnapshot(key).catch(() => {
    // The mounted panel will expose/retry the same cached error boundary.
  });
}

/** Publish an authoritative mutation reply and supersede any older read. */
export function publishWorkingDirectoriesSnapshot(
  key: string,
  result: WorkingDirectoriesWire,
): WorkingDirectoriesWire {
  const snapshot = stableWorkingDirectoriesSnapshot(key, result);
  workingDirectoriesCache.setData(key, snapshot);
  return snapshot;
}
