// Dashboard navigation preferences shared with repository-owner cleanup.

import { useSyncExternalStore } from "react";

const REPO_FILTER_KEY = "zeros:dashboard-repo-filter:v1";

let loaded = false;
let snapshot: string | null = null;
const listeners = new Set<() => void>();

function readStoredDashboardRepoFilter(): string | null {
  try {
    return localStorage.getItem(REPO_FILTER_KEY) || null;
  } catch {
    return null;
  }
}

export function readDashboardRepoFilter(): string | null {
  if (!loaded) {
    snapshot = readStoredDashboardRepoFilter();
    loaded = true;
  }
  return snapshot;
}

export function saveDashboardRepoFilter(repoSlug: string | null): void {
  if (readDashboardRepoFilter() === repoSlug) return;
  try {
    if (repoSlug) localStorage.setItem(REPO_FILTER_KEY, repoSlug);
    else localStorage.removeItem(REPO_FILTER_KEY);
  } catch {
    /* storage disabled (private mode) — non-fatal */
  }
  snapshot = repoSlug;
  loaded = true;
  for (const listener of listeners) listener();
}

/** Clear only when the deleted repository owns the current filter. */
export function clearDashboardRepoFilter(repoSlug: string): void {
  if (!repoSlug || readDashboardRepoFilter() !== repoSlug) return;
  saveDashboardRepoFilter(null);
}

function subscribeDashboardRepoFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDashboardRepoFilter(): string | null {
  return useSyncExternalStore(
    subscribeDashboardRepoFilter,
    readDashboardRepoFilter,
    readDashboardRepoFilter,
  );
}

/** Test-only singleton reset. */
export function resetDashboardPreferencesForTests(): void {
  loaded = false;
  snapshot = null;
  listeners.clear();
}
