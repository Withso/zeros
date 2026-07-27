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
