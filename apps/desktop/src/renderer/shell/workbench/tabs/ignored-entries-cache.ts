// ──────────────────────────────────────────────────────────
// ignored-entries-cache — one warm ignored-roots snapshot per workspace
// ──────────────────────────────────────────────────────────
//
// Workbench surfaces are per-worktree, so switching workspaces UNMOUNTS the Files
// tab and mounts a fresh one (workbench/workbench-pane.tsx keys its bodies by scoped tab id). The
// TRACKED listing survives that: workspace-files-cache hands the new tree the
// previous array synchronously (peekWorkspaceFiles), so the files are on screen
// in the first frame. The ignored roots had no equivalent. Every switch painted
// a tracked-only tree and then — two bridge round-trips and two
// `git ls-files -o -i --exclude-standard --directory` walks later — spliced
// `.env`, `.mcp.json`, `node_modules/`, `dist/` into it. Those land in sort
// order, in the MIDDLE of the list, so every row below them jumped and the whole
// tab read as a reload: the "files re-appearing" glitch.
//
// The roots are a pure function of the workspace, identical for every tree
// showing it, and about a dozen strings — so one bounded per-cwd snapshot is all
// it takes to make the first frame complete. It is only ever a SEED: the mounted
// hook re-lists on that same mount, so a snapshot that went stale while the
// workspace was parked self-corrects within one round-trip and never needs an
// invalidation hook (which is also why a coarse DB_CHANGED can ignore it).
//
// Deliberately roots-ONLY. A remounted tree starts fully collapsed
// (`initialExpansion: "closed"`), so the expanded set and its cached children
// have nothing to contribute to that first frame — and unlike the roots they are
// per-surface state that two File tabs open on one workspace would fight over.
// ──────────────────────────────────────────────────────────

import { listIgnoredEntries } from "@/renderer/platform/git";

import { workspaceCacheKey } from "../../workspace-files-cache";

// A handful of workspaces, matching the tracked cache's bound: the two are
// seeded and evicted by the same navigation, so a workspace that is warm for one
// should be warm for the other.
const MAX_ENTRIES = 12;

const rootsByCwd = new Map<string, string[]>();
const inflightWarms = new Set<string>();

/** The roots listing last confirmed for `cwd`, or null when this workspace has
 *  not been listed in this session. */
export function peekIgnoredRoots(cwd: string | undefined): string[] | null {
  if (!cwd) return null;
  const key = workspaceCacheKey(cwd);
  const roots = rootsByCwd.get(key);
  if (roots === undefined) return null;
  // Map iteration order is the LRU queue: reading makes this workspace the
  // newest entry, so an idle prefetch cannot evict the one being switched to.
  rootsByCwd.delete(key);
  rootsByCwd.set(key, roots);
  return roots;
}

/** Publish the listing the next mount on this workspace should paint in its
 *  first frame. Callers pass only an authoritative response — never the empty
 *  starting state, which would look like "this workspace ignores nothing". */
export function rememberIgnoredRoots(cwd: string, roots: string[]): void {
  if (!cwd) return;
  const key = workspaceCacheKey(cwd);
  rootsByCwd.delete(key);
  rootsByCwd.set(key, roots);
  while (rootsByCwd.size > MAX_ENTRIES) {
    const oldest = rootsByCwd.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rootsByCwd.delete(oldest);
  }
}

/** Prime the snapshot in the background (no await) — called on navigation
 *  intent, so even a workspace's FIRST open paints its ignored rows alongside
 *  the tracked ones instead of a beat later. Skipped once a snapshot exists or
 *  is on its way: the destination tree re-lists for itself either way, so a
 *  repeated hover must not queue a repeated worktree walk. */
export function warmIgnoredRoots(cwd: string | undefined): void {
  if (!cwd) return;
  const key = workspaceCacheKey(cwd);
  if (rootsByCwd.has(key) || inflightWarms.has(key)) return;
  inflightWarms.add(key);
  void listIgnoredEntries(cwd)
    .then((roots) => rememberIgnoredRoots(cwd, roots))
    .catch(() => {
      // No bridge / not a repo. Leaving the key cold is correct: the mounted
      // tree re-lists and owns the outcome, and the next intent may retry.
    })
    .finally(() => inflightWarms.delete(key));
}

/** Test-only reset for the module singletons. */
export function resetIgnoredRootsCacheForTests(): void {
  rootsByCwd.clear();
  inflightWarms.clear();
}
