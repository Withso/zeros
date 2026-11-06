import { useCallback, useSyncExternalStore } from "react";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";
import type { Workspace } from "../../platform/git";
import { cloudGithubPrScope } from "../../platform/cloud-github-pr-scope";

export interface WorkspacePrDiscoverySnapshot {
  pending: boolean;
  checked: boolean;
  error: unknown | null;
}

const EMPTY: WorkspacePrDiscoverySnapshot = { pending: false, checked: false, error: null };
const entries = new Map<string, { snapshot: WorkspacePrDiscoverySnapshot; listeners: Set<() => void> }>();

export function workspacePrDiscoveryKey(
  workspace: Pick<Workspace, "id" | "repoSlug" | "branch" | "baseBranch"> | null,
  scope = cloudGithubPrScope(workspace?.id),
): string | null {
  return workspace ? `${workspace.id}#${JSON.stringify([workspace.repoSlug, workspace.branch, workspace.baseBranch, scope])}` : null;
}

function entryFor(id: string) {
  let entry = entries.get(id);
  if (!entry) {
    entry = { snapshot: EMPTY, listeners: new Set() };
    entries.set(id, entry);
  }
  return entry;
}

export function workspacePrDiscoverySnapshot(id: string | null): WorkspacePrDiscoverySnapshot {
  return id ? entries.get(id)?.snapshot ?? EMPTY : EMPTY;
}

export function publishWorkspacePrDiscovery(id: string, snapshot: WorkspacePrDiscoverySnapshot): void {
  const entry = entryFor(id);
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
  // Retain exact-key results through navigation without keeping every visited
  // workspace forever. Mounted consumers and pending reads keep their entries.
  for (const [key, candidate] of entries) {
    if (entries.size <= 128) break;
    if (key !== id && !candidate.listeners.size && !candidate.snapshot.pending) entries.delete(key);
  }
}

export function useWorkspacePrDiscoveryState(id: string | null): WorkspacePrDiscoverySnapshot {
  const subscribe = useCallback((listener: () => void) => {
    if (!id) return () => {};
    const entry = entryFor(id);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [id]);
  const snapshot = useCallback(() => workspacePrDiscoverySnapshot(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

registerPrWorkspaceCacheForget((id) => {
  for (const [key, entry] of entries) {
    if (key !== id && !key.startsWith(`${id}#`)) continue;
    entries.delete(key);
    for (const listener of entry.listeners) listener();
  }
});
