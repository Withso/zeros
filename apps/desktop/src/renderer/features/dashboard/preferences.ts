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
  presentation = null;
  presentationListeners.clear();
}

export type DashboardView = "board" | "list";
export type DashboardArchive = "active" | "all" | "archived";
export type DashboardSort = "activity" | "newest" | "name" | "repository";
export interface DashboardDisplay {
  repository: boolean;
  repositoryIcon: boolean;
  lineChanges: boolean;
  cost: boolean;
  owner: boolean;
  lastActive: boolean;
}
export interface DashboardPreferences {
  view: DashboardView;
  archive: DashboardArchive;
  sort: DashboardSort;
  display: DashboardDisplay;
}

const PRESENTATION_KEY = "zeros:dashboard-presentation:v1";
const LEGACY_ARCHIVE_KEY = "zeros:dashboard-show-archived";
const DEFAULT_DISPLAY: DashboardDisplay = {
  repository: true,
  repositoryIcon: true,
  lineChanges: true,
  cost: false,
  owner: true,
  lastActive: true,
};
let presentation: DashboardPreferences | null = null;
const presentationListeners = new Set<() => void>();

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Fixed-size app presentation, independent of the selected workspace/owner.
 * Restore during render, including the released archive-toggle preference. */
export function readDashboardPreferences(): DashboardPreferences {
  if (presentation) return presentation;
  let raw: Record<string, unknown> = {};
  let legacyArchive = false;
  try {
    legacyArchive = localStorage.getItem(LEGACY_ARCHIVE_KEY) === "1";
    raw = record(JSON.parse(localStorage.getItem(PRESENTATION_KEY) ?? "null"));
  } catch {
    /* disabled storage or an older/corrupt value */
  }
  const display = { ...DEFAULT_DISPLAY };
  const storedDisplay = record(raw.display);
  for (const key of Object.keys(display) as (keyof DashboardDisplay)[])
    if (typeof storedDisplay[key] === "boolean")
      display[key] = storedDisplay[key];
  presentation = {
    view: raw.view === "list" ? "list" : "board",
    archive:
      raw.archive === "active" ||
      raw.archive === "all" ||
      raw.archive === "archived"
        ? raw.archive
        : legacyArchive
          ? "all"
          : "active",
    sort:
      raw.sort === "newest" || raw.sort === "name" || raw.sort === "repository"
        ? raw.sort
        : "activity",
    display,
  };
  return presentation;
}

export function updateDashboardPreferences(
  patch: Partial<Omit<DashboardPreferences, "display">> & {
    display?: Partial<DashboardDisplay>;
  },
): void {
  const previous = readDashboardPreferences();
  const next = {
    ...previous,
    ...patch,
    display: { ...previous.display, ...patch.display },
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  presentation = next;
  try {
    localStorage.setItem(PRESENTATION_KEY, JSON.stringify(next));
    localStorage.setItem(
      LEGACY_ARCHIVE_KEY,
      next.archive === "active" ? "0" : "1",
    );
  } catch {
    /* The in-memory preference still works when storage is unavailable. */
  }
  for (const listener of presentationListeners) listener();
}

function subscribePresentation(listener: () => void): () => void {
  presentationListeners.add(listener);
  return () => presentationListeners.delete(listener);
}

export function useDashboardPreferences(): DashboardPreferences {
  return useSyncExternalStore(
    subscribePresentation,
    readDashboardPreferences,
    readDashboardPreferences,
  );
}
