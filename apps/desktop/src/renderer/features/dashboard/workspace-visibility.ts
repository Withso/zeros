import { useSyncExternalStore } from "react";
import type { Workspace } from "../../platform/git";

// Personal dashboard state, scoped to a workspace's current archive period.
// A restored/rearchived workspace never inherits a previous period's hiding.
const STORAGE_KEY = "zeros:dashboard-workspace-visibility:v1";
const MAX_ENTRIES = 5000;
export const AUTO_HIDE_ARCHIVE_MS = 15 * 24 * 60 * 60 * 1000;
type ArchiveOwner = Pick<Workspace, "id" | "repoSlug" | "archivedAt">;
interface VisibilityEntry {
  archivedAt: number;
  hidden: boolean;
  repoSlug: string;
}
interface VisibilitySnapshot {
  readonly entries: Readonly<Record<string, VisibilityEntry>>;
  // A cutoff retains automatic hides without one persisted entry per archive.
  readonly autoHiddenBefore: number | null;
}
let current: VisibilitySnapshot | undefined;
const listeners = new Set<() => void>();

export function readWorkspaceVisibility(): VisibilitySnapshot {
  if (current) return current;
  const entries: Record<string, VisibilityEntry> = {};
  let autoHiddenBefore: number | null = null;
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const stored = parsed as Partial<VisibilitySnapshot>;
      if (
        typeof stored.autoHiddenBefore === "number" &&
        Number.isFinite(stored.autoHiddenBefore) &&
        stored.autoHiddenBefore >= 0
      )
        autoHiddenBefore = stored.autoHiddenBefore;
      const storedEntries = stored.entries;
      for (const [id, value] of Object.entries(
        storedEntries &&
          typeof storedEntries === "object" &&
          !Array.isArray(storedEntries)
          ? storedEntries
          : {},
      ).slice(-MAX_ENTRIES)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as Partial<VisibilityEntry>;
        if (
          typeof entry.archivedAt !== "number" ||
          !Number.isFinite(entry.archivedAt) ||
          entry.archivedAt < 0 ||
          typeof entry.hidden !== "boolean" ||
          typeof entry.repoSlug !== "string"
        )
          continue;
        Object.defineProperty(entries, id, {
          value: entry,
          enumerable: true,
          configurable: true,
        });
      }
    }
  } catch {
    /* invalid or unavailable storage starts empty */
  }
  current = { entries, autoHiddenBefore };
  return current;
}

function publish(next: VisibilitySnapshot): void {
  current = {
    ...next,
    entries: Object.fromEntries(
      Object.entries(next.entries).slice(-MAX_ENTRIES),
    ),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* retain the memory snapshot */
  }
  for (const listener of listeners) listener();
}

export function workspaceIsHidden(
  workspace: ArchiveOwner,
  snapshot: VisibilitySnapshot,
  autoHide: boolean,
  now: number,
): boolean {
  if (workspace.archivedAt == null) return false;
  const { entries, autoHiddenBefore } = snapshot;
  const entry = Object.hasOwn(entries, workspace.id)
    ? entries[workspace.id]
    : undefined;
  if (entry?.archivedAt === workspace.archivedAt) return entry.hidden;
  return (
    (autoHiddenBefore != null && workspace.archivedAt <= autoHiddenBefore) ||
    (autoHide && now - workspace.archivedAt >= AUTO_HIDE_ARCHIVE_MS)
  );
}

export function setWorkspaceHidden(
  workspace: ArchiveOwner,
  hidden: boolean,
): void {
  if (workspace.archivedAt == null) return;
  const snapshot = readWorkspaceVisibility();
  const { entries } = snapshot;
  const previous = entries[workspace.id];
  if (previous && previous.archivedAt > workspace.archivedAt) return;
  if (
    previous?.archivedAt === workspace.archivedAt &&
    previous.hidden === hidden
  )
    return;
  const next = { ...entries };
  delete next[workspace.id];
  publish({
    ...snapshot,
    entries: {
      ...next,
      [workspace.id]: {
        archivedAt: workspace.archivedAt,
        hidden,
        repoSlug: workspace.repoSlug,
      },
    },
  });
}

/** Persist automatic transitions in one notification. Disabling the experiment
 * stops future automatic hides without undoing ones already applied. Explicit
 * Unhide overrides the automatic policy for this same archive period. */
export function hideExpiredWorkspaces(
  workspaces: readonly ArchiveOwner[],
  now: number,
): void {
  const snapshot = readWorkspaceVisibility();
  let cutoff = snapshot.autoHiddenBefore;
  for (const workspace of workspaces) {
    if (
      workspace.archivedAt == null ||
      now - workspace.archivedAt < AUTO_HIDE_ARCHIVE_MS
    )
      continue;
    cutoff = Math.max(cutoff ?? 0, workspace.archivedAt);
  }
  if (cutoff !== snapshot.autoHiddenBefore)
    publish({ ...snapshot, autoHiddenBefore: cutoff });
}

export function forgetWorkspaceVisibility(
  workspaceId: string,
  archivedAt?: number | null,
): void {
  const snapshot = readWorkspaceVisibility();
  const { entries } = snapshot;
  if (!Object.hasOwn(entries, workspaceId)) return;
  if (
    archivedAt !== undefined &&
    entries[workspaceId].archivedAt !== archivedAt
  )
    return;
  const next = { ...entries };
  delete next[workspaceId];
  publish({ ...snapshot, entries: next });
}

export function forgetRepositoryVisibility(repoSlug: string): void {
  const snapshot = readWorkspaceVisibility();
  const { entries } = snapshot;
  const next = Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value.repoSlug !== repoSlug),
  );
  if (Object.keys(next).length !== Object.keys(entries).length)
    publish({ ...snapshot, entries: next });
}

export function useWorkspaceVisibility(): VisibilitySnapshot {
  return useSyncExternalStore(
    subscribeWorkspaceVisibility,
    readWorkspaceVisibility,
    readWorkspaceVisibility,
  );
}
export function subscribeWorkspaceVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    current = undefined;
    for (const listener of listeners) listener();
  });

export function resetWorkspaceVisibilityForTests(): void {
  current = undefined;
  listeners.clear();
}
