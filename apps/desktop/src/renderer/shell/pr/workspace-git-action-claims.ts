import { useSyncExternalStore } from "react";
import type { PrIslandActionBehavior } from "./pr-status";

export interface WorkspaceGitActionClaim {
  readonly workspaceId: string;
  readonly kind: string;
  readonly behavior: PrIslandActionBehavior | "create";
}

const claims = new Map<string, WorkspaceGitActionClaim>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Summary, Create PR and the workbench row own the same mutation lifetime,
 * including across remounts. Archive alone may replace an agent prompt it stops. */
export function claimWorkspaceGitAction(
  workspaceId: string,
  action: Pick<WorkspaceGitActionClaim, "kind" | "behavior">,
): WorkspaceGitActionClaim | null {
  const current = claims.get(workspaceId);
  if (
    current &&
    !(action.behavior === "archive" && current.behavior === "prompt")
  )
    return null;
  const owner = { workspaceId, ...action };
  claims.set(workspaceId, owner);
  emit();
  return owner;
}

export function releaseWorkspaceGitAction(
  owner: WorkspaceGitActionClaim,
): void {
  if (claims.get(owner.workspaceId) !== owner) return;
  claims.delete(owner.workspaceId);
  emit();
}

export const workspaceGitActionClaim = (workspaceId: string) =>
  claims.get(workspaceId) ?? null;
export function useWorkspaceGitActionClaim(
  workspaceId: string,
): WorkspaceGitActionClaim | null {
  return useSyncExternalStore(
    subscribe,
    () => workspaceGitActionClaim(workspaceId),
    () => null,
  );
}

export function resetWorkspaceGitActionClaimsForTesting(): void {
  claims.clear();
  emit();
}
