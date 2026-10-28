import {
  cloudTargetForValue,
  cloudWorkspaceKey,
} from "./bridge/cloud-workspace-key";
import { useCallback, useSyncExternalStore } from "react";

let version = 0,
  all = 0;
const scopes = new Map<string, number>();
const listeners = new Set<() => void>();
export function subscribeCloudGithubPrScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** A separate presentation lifetime also retires mounted state and drafts. */
export function cloudGithubPrScope(
  workspaceId: string | null | undefined,
): string {
  try {
    const target = cloudTargetForValue(workspaceId);
    if (!target) return "local";
    return `${all}:${scopes.get(target.organizationId) ?? 0}:${scopes.get(cloudWorkspaceKey(target)) ?? 0}`;
  } catch {
    return "unavailable";
  }
}
export function invalidateCloudGithubPrScope(scope?: string): void {
  if (scope) {
    scopes.set(scope, ++version);
    if (scopes.size > 256) {
      all = ++version;
      scopes.clear();
    }
  } else {
    all = ++version;
    scopes.clear();
  }
  for (const listener of listeners) listener();
}
export function useCloudGithubPrScope(
  workspaceId: string | null | undefined,
): string {
  const read = useCallback(
    () => cloudGithubPrScope(workspaceId),
    [workspaceId],
  );
  return useSyncExternalStore(subscribeCloudGithubPrScope, read, read);
}
