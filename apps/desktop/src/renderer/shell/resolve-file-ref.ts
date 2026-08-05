// ──────────────────────────────────────────────────────────
// resolve-file-ref — match an agent's loose file reference to a real path
// ──────────────────────────────────────────────────────────
//
// Agents reference files by their full relative path ("src/styles/x.css") but
// also by a bare basename ("AskAIChat.tsx") or a trailing sub-path. pickFileMatch
// resolves such a reference against the workspace file list (listWorkspaceFiles)
// so the workbench viewer opens the REAL file instead of failing on a path that
// doesn't exist verbatim. Pure (no IPC) so it stays unit-testable.
// ──────────────────────────────────────────────────────────

/** Pick the workspace file `ref` points at, or null. `ref` is a workspace-
 *  relative path that may be exact ("a/b/c.ts"), a bare basename ("c.ts"), or a
 *  trailing sub-path ("b/c.ts"). An exact path wins; otherwise the file whose
 *  path ends with `/<ref>`. On ties the shortest path wins (then lexicographic)
 *  so the result is deterministic. The leading-`/` anchor means "AskAIChat.tsx"
 *  matches `src/x/AskAIChat.tsx` but NOT `src/MyAskAIChat.tsx`. */
export function pickFileMatch(files: string[], ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  if (files.includes(r)) return r;
  const suffix = `/${r}`;
  const matches = files.filter((f) => f.endsWith(suffix));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches
    .slice()
    .sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    )[0];
}
