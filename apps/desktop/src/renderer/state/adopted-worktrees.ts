// ──────────────────────────────────────────────────────────
// Adopted worktrees registry
// ──────────────────────────────────────────────────────────
//
// When the user "Add local project"s a foreign linked worktree (created by
// Cursor, plain `git worktree add`, or another agent tool — living OUTSIDE
// Zeros' managed ~/zeros/workspaces root), the engine registers it as a
// workspace of the parent repo's project
// (adopt-in-place). But the renderer's path→workspace/project resolvers in
// workspace-resolution.ts key off a regex that only matches the managed root,
// so an adopted external path wouldn't resolve to its project.
//
// This tiny localStorage map (worktree path → repoSlug) lets isWorktreePath()
// and findProjectForFolder() recognise adopted worktrees WITHOUT threading a
// workspace list through every resolver call site. It mirrors the persistence
// pattern in projects-store.ts.
//
// Host-local only: adoption happens through the native folder picker. Optional
// remote relay clients read registered workspaces from the engine and never
// adopt a host path directly.

import { getSetting, setSetting } from "../platform/settings";

const STORAGE_KEY = "adopted-worktrees-v1";
const MAX_ENTRIES = 2048;

/** macOS symlinks /tmp,/var,/etc under /private — normalize so a path stored
 *  one way still resolves when looked up the other (mirrors the same helper in
 *  workspace-resolution.ts so the two never disagree). */
function normalizePath(p: string): string {
  return (
    p
      .replace(/^\/private(\/(?:var|tmp|etc)(?:\/|$))/, "$1")
      .replace(/\/+$/, "") || "/"
  );
}

/** normalized worktree path → owning project's repoSlug */
type AdoptedMap = Record<string, string>;

function load(): AdoptedMap {
  const m = getSetting<AdoptedMap>(STORAGE_KEY, {});
  return m && typeof m === "object" && !Array.isArray(m)
    ? Object.fromEntries(
        Object.entries(m)
          .filter(
            ([key, value]) =>
              key.startsWith("/") &&
              key.length <= 4096 &&
              typeof value === "string" &&
              value.length > 0 &&
              value.length <= 512,
          )
          .slice(-MAX_ENTRIES),
      )
    : {};
}

/** Record that `worktreePath` is an adopted external worktree of `repoSlug`. */
export function recordAdoptedWorktree(
  worktreePath: string,
  repoSlug: string,
): void {
  if (!worktreePath || !repoSlug) return;
  const m = load();
  const key = normalizePath(worktreePath);
  if (m[key] === repoSlug) return;
  delete m[key];
  m[key] = repoSlug;
  setSetting(
    STORAGE_KEY,
    Object.fromEntries(Object.entries(m).slice(-MAX_ENTRIES)),
  );
}

/** This persisted path registry also covers managed checkouts reconnected by
 * Locate. Its legacy key names only renderer ownership, never engine adoption. */
export function forgetAdoptedWorktree(worktreePath: string): void {
  const m = load();
  delete m[normalizePath(worktreePath)];
  setSetting(STORAGE_KEY, m);
}

export function forgetAdoptedWorktreesForRepo(repoSlug: string): void {
  setSetting(
    STORAGE_KEY,
    Object.fromEntries(
      Object.entries(load()).filter(([, slug]) => slug !== repoSlug),
    ),
  );
}

/** Include the matched root so resolvers can protect nested repositories. */
export function findAdoptedWorktree(
  folder: string | null | undefined,
): { path: string; repoSlug: string } | null {
  if (!folder) return null;
  const normalized = normalizePath(folder);
  const owner = Object.entries(load())
    .filter(
      ([root]) => normalized === root || normalized.startsWith(`${root}/`),
    )
    .sort(([a], [b]) => b.length - a.length)[0];
  return owner ? { path: owner[0], repoSlug: owner[1] } : null;
}

/** The repoSlug of the project that owns this adopted worktree, or null. */
export function adoptedWorktreeSlug(
  folder: string | null | undefined,
): string | null {
  return findAdoptedWorktree(folder)?.repoSlug ?? null;
}

/** True when `folder` is a known adopted external worktree. */
export function isAdoptedWorktreePath(
  folder: string | null | undefined,
): boolean {
  return adoptedWorktreeSlug(folder) != null;
}
