// ──────────────────────────────────────────────────────────
// pr-create-claim — remount-safe Create PR action ownership
// ──────────────────────────────────────────────────────────
//
// The PR row unmounts outside Changes/Review, but its access/status preflight
// continues. Claims therefore live at module scope and are keyed by the exact
// workspace id: returning to the row sees the same busy state and cannot queue
// a duplicate brief. Owner identity prevents an old completion from releasing
// a newer action for that workspace.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

export interface PrCreateActionClaim {
  readonly workspaceId: string;
}

const claims = new Map<string, PrCreateActionClaim>();
const listeners = new Set<() => void>();

/** Publish one primitive snapshot change to every mounted Create PR control. */
function emit(): void {
  for (const listener of listeners) listener();
}

/** Register a renderer subscriber for the shared exact-workspace map. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Acquire one exact-workspace owner synchronously. */
export function claimPrCreateAction(
  workspaceId: string,
): PrCreateActionClaim | null {
  if (claims.has(workspaceId)) return null;
  const owner = { workspaceId };
  claims.set(workspaceId, owner);
  emit();
  return owner;
}

/** Release only the owner that is still current for its workspace. */
export function releasePrCreateAction(owner: PrCreateActionClaim): void {
  if (claims.get(owner.workspaceId) !== owner) return;
  claims.delete(owner.workspaceId);
  emit();
}

/** Exact-key snapshot shared by the hook and focused tests. */
export function isPrCreateActionClaimed(workspaceId: string): boolean {
  return claims.has(workspaceId);
}

/** Remount-safe busy signal for one workspace's Create PR control. */
export function usePrCreateActionClaimed(workspaceId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isPrCreateActionClaimed(workspaceId),
    () => false,
  );
}

/** Clear module state between focused tests. */
export function resetPrCreateActionClaimsForTesting(): void {
  if (claims.size === 0) return;
  claims.clear();
  emit();
}
