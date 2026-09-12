// ──────────────────────────────────────────────────────────
// Design directory target — what switching to Design would do to a checkout
// ──────────────────────────────────────────────────────────
//
// Entering Design mode resolves ONE folder for the checkout (engine
// design/directory.ts): the configured pointer, an adopted committed document,
// or — on a repository's first design use — a fresh "<repo> - Design" folder
// the engine creates. The mode toggle and the Create page need that answer
// BEFORE the switch so they can say "Create design directory" instead of
// silently writing a folder into the user's checkout.
//
// The engine previews it on `design.listDirectories` (`target`). This module
// mounts that read as keyed server state: one entry per workspace id or repo
// root, shared by every surface asking about the same checkout, patched to
// `exists: true` the moment a switch to Design is confirmed (the switch is
// what created the folder), and invalidated with the other Git-derived caches
// on external ref changes and engine reconnects (state/read-caches.ts).
//
// A `null` value is a real answer — the engine could not preview (an
// unrecognized configured pointer). Consumers then offer the plain switch and
// let mode entry surface the engine's error.
// ──────────────────────────────────────────────────────────

import { getActiveBridge } from "../platform/bridge/active-bridge";
import {
  bridgeDesignListDirectories,
  type DesignDirectoryListingWire,
} from "../platform/bridge/design-bridge";
import {
  DESIGN_DIRECTORY_TARGET_MAX_AGE_MS,
  designDirectoryTargetCache,
} from "./read-caches";
import { useCachedRead, type CachedRead } from "./use-cached-read";

export interface DesignDirectoryTarget {
  /** Repo-relative folder Design mode would open or create. */
  directory: string;
  /** True when the Design document marker already exists — switching opens
   *  it. False means switching CREATES it; an engine-reserved empty vnode does
   *  not count as an initialized document. */
  exists: boolean;
}

/** Cache key for a managed workspace's checkout. */
export function designDirectoryTargetKeyForWorkspace(
  workspaceId: string,
): string {
  return `ws:${workspaceId}`;
}

/** Cache key for a repository's main checkout (the Create page previews the
 *  repo before any worktree exists). */
export function designDirectoryTargetKeyForRepo(repoRoot: string): string {
  return `repo:${repoRoot}`;
}

/** The `design.listDirectories` argument a key resolves to: the engine accepts
 *  a workspace id or a known repo root in the same slot. */
export function designDirectoryTargetRequest(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(separator + 1);
}

/** Pure projection of the wire listing onto the target shape. Total: an
 *  older engine omits `target`, which reads as "unknown" (null). */
export function designDirectoryTargetFromListing(
  listing: Pick<DesignDirectoryListingWire, "target">,
): DesignDirectoryTarget | null {
  const target = listing.target;
  if (
    !target ||
    typeof target.directory !== "string" ||
    !target.directory ||
    typeof target.exists !== "boolean"
  ) {
    return null;
  }
  return { directory: target.directory, exists: target.exists };
}

export async function fetchDesignDirectoryTarget(
  key: string,
): Promise<DesignDirectoryTarget | null> {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error("Not connected to the Zeros engine yet.");
  }
  const listing = await bridgeDesignListDirectories(
    bridge,
    designDirectoryTargetRequest(key),
  );
  return designDirectoryTargetFromListing(listing);
}

/** Mount the target for `key` (null = inert). Consumers read `data`:
 *  undefined while unknown, null when the engine could not preview, else the
 *  folder and whether it exists. */
export function useDesignDirectoryTarget(
  key: string | null,
  options: { enabled?: boolean } = {},
): CachedRead<DesignDirectoryTarget | null> {
  return useCachedRead(
    designDirectoryTargetCache,
    key,
    fetchDesignDirectoryTarget,
    {
      maxAgeMs: DESIGN_DIRECTORY_TARGET_MAX_AGE_MS,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    },
  );
}

/** A confirmed switch to Design is the exact moment the folder came to exist
 *  (mode entry initializes it). Patch the key so the toggle returns to a plain
 *  switch immediately instead of offering to create a folder that is there. */
export function markDesignDirectoryTargetExists(key: string): void {
  const current = designDirectoryTargetCache.peekSnapshot(key).data;
  if (current && !current.exists) {
    designDirectoryTargetCache.setData(key, { ...current, exists: true });
    return;
  }
  // No confirmed preview to patch: mark stale so the next mounted read
  // revalidates against the engine rather than trusting a guess.
  designDirectoryTargetCache.invalidate(key);
}
