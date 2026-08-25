// ──────────────────────────────────────────────────────────
// tree-paths — pure path helpers for the workspace file tree
// ──────────────────────────────────────────────────────────
//
// Kept out of workspace-file-tree.tsx so the node test environment can
// exercise them without importing the React / shadow-DOM component.

/** Every ancestor directory prefix of a repo-relative POSIX path, shortest
 *  first — "a/b/c.ts" → ["a", "a/b"]. Used to expand a collapsed branch
 *  top-down before selecting/scrolling to a file; prefixes the tree model
 *  doesn't know (e.g. segments it flattened away) resolve to no item at the
 *  call site and are skipped harmlessly. */
export function ancestorDirPrefixes(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** Make a flat path listing safe for @pierre/trees without changing its
 * relative order. Git can legitimately report an indexed symlink/file and
 * untracked descendants beneath its worktree replacement in the same
 * `ls-files -co` result. Descendants prove that the worktree shape is a
 * directory, so the stale file row yields; exact duplicates yield after their
 * first occurrence for the same reason. */
export function reconcileTreePathList(paths: readonly string[]): string[] {
  const directoryKeys = new Set<string>();
  for (const path of paths) {
    if (path.endsWith("/")) directoryKeys.add(path.slice(0, -1));
    for (const dir of ancestorDirPrefixes(path)) directoryKeys.add(dir);
  }

  const seen = new Set<string>();
  const reconciled: string[] = [];
  let changed = false;
  for (const path of paths) {
    if (seen.has(path)) {
      changed = true;
      continue;
    }
    seen.add(path);
    if (!path.endsWith("/") && directoryKeys.has(path)) {
      changed = true;
      continue;
    }
    reconciled.push(path);
  }
  // This identity is load-bearing for WorkspaceFileTree's first render. Its
  // model and tracked snapshot share the warm cache array; replacing a valid
  // list with an equal clone makes the layout effect reset the model and
  // collapse the initial selected file's ancestor chain.
  return changed ? reconciled : (paths as string[]);
}

export type TreeSelectionMirrorIntent =
  | { kind: "suspend" }
  | { kind: "clear" }
  | { kind: "select"; path: string };

/** The Files tab uses undefined to suspend its mirror while hidden and null to
 * explicitly clear the active home tab's selection. Keep those states distinct
 * so clearing a file cannot leave a tree row stuck selected. */
export function treeSelectionMirrorTarget(
  active: boolean,
  filePath?: string | null,
): string | null | undefined {
  return active ? (filePath ?? null) : undefined;
}

/** Normalize the tri-state mirror prop for the imperative tree effect. */
export function treeSelectionMirrorIntent(
  target: string | null | undefined,
): TreeSelectionMirrorIntent {
  if (target === undefined) return { kind: "suspend" };
  if (target === null) return { kind: "clear" };
  return { kind: "select", path: target };
}

/** The path a tree-selection publication should OPEN, or null for none.
 *  Two guards, both required:
 *   • the mirror echo — a selection the mirror itself just applied is the
 *     caller's already-open file; re-opening it would clobber entry intent;
 *   • the re-publication echo — only a row that was NOT in the previous
 *     publication is a user selection. The selection store can re-emit an
 *     unchanged row (rebuilds, focus churn), and once the owning tab has no
 *     open file (mirrorTarget null — e.g. the fixed Files home just reverted
 *     to blank) the mirror guard alone no longer filters it: without this,
 *     closing the home's file with its tree expanded instantly re-opened it. */
export function treeSelectionOpenTarget(
  prevSelected: readonly string[],
  selected: readonly string[],
  mirrorTarget: string | null | undefined,
): string | null {
  const last = selected[selected.length - 1];
  if (!last) return null;
  if (mirrorTarget != null && last === mirrorTarget) return null;
  if (prevSelected.includes(last)) return null;
  return last;
}
