// ──────────────────────────────────────────────────────────
// Sidebar repository collapse — persisted per repository
// ──────────────────────────────────────────────────────────
//
// A repository group's collapsed state belongs to that repository (its stable
// project id, so a moved checkout keeps it). The list is bounded, validated on
// read, and pruned when the repository is removed; ids that no longer name a
// registered project are simply ignored by the sidebar.

import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../platform/settings";

const KEY = "sidebar-collapsed-repositories-v1";
const LIMIT = 256;
const MAX_ID_LENGTH = 512;
const EMPTY: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> | null = null;

function read(): ReadonlySet<string> {
  const stored = getSetting<unknown>(KEY, []);
  if (!Array.isArray(stored)) return EMPTY;
  const ids = stored.filter(
    (id): id is string =>
      typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH,
  );
  return ids.length === 0 ? EMPTY : new Set(ids.slice(-LIMIT));
}

function current(): ReadonlySet<string> {
  snapshot ??= read();
  return snapshot;
}

function write(next: string[]): void {
  const bounded = next.slice(-LIMIT);
  snapshot = bounded.length === 0 ? EMPTY : new Set(bounded);
  setSetting(KEY, bounded);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function repositoryCollapsed(projectId: string): boolean {
  return current().has(projectId);
}

export function setRepositoryCollapsed(
  projectId: string,
  collapsed: boolean,
): void {
  if (!projectId || projectId.length > MAX_ID_LENGTH) return;
  const ids = current();
  if (ids.has(projectId) === collapsed) return;
  const next = [...ids].filter((id) => id !== projectId);
  if (collapsed) next.push(projectId);
  write(next);
}

/** Owner removal: drop the repository's remembered collapse. */
export function forgetRepositoryCollapsed(projectId: string): void {
  setRepositoryCollapsed(projectId, false);
}

/** Referentially stable until a write changes the set. */
export function useCollapsedRepositories(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}

/** Test-only reset for the module snapshot. */
export function resetCollapsedRepositoriesForTests(): void {
  snapshot = null;
  listeners.clear();
}
