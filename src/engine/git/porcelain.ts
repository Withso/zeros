// Shared `git status --porcelain=v1 -z` parser.
//
// Extracted into its own module (no other engine imports) so every
// porcelain consumer — diff.ts `status`, ops.ts `listConflictedPaths`,
// worktree.ts `detectConflictPaths` — shares one byte-exact parse
// without import cycles.

/** One parsed `git status --porcelain=v1 -z` record.
 *
 *  `x` = index status, `y` = working-tree status. `path` is the
 *  destination path (byte-exact — see parsePorcelainZ). `oldPath` is the
 *  rename/copy source, present only when X ∈ {R, C}. */
export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  oldPath?: string;
}

/** Conflict (unmerged) status codes from porcelain v1. */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** True when a porcelain entry is an unmerged/conflicted file. */
export function isConflictEntry(e: PorcelainEntry): boolean {
  return CONFLICT_CODES.has(`${e.x}${e.y}`) || e.x === "U" || e.y === "U";
}

/** Parse `git status --porcelain=v1 -z` output into structured entries.
 *
 *  **Why `-z` (the C1 fix):** the human porcelain format C-quotes any
 *  path containing a space, quote, or non-ASCII byte (`"weird\"name"`).
 *  A line-based parser surfaces that quoted+escaped literal, which then
 *  fails to match the real file when fed back to `git add`/`git diff`
 *  — so the user cannot stage or diff any file with a space. With `-z`,
 *  records are NUL-separated and **paths are byte-exact** (no quoting).
 *
 *  Record shape: `XY <SP> PATH NUL`. For rename/copy entries (X ∈ {R, C})
 *  git emits a second NUL field with the source path, in
 *  destination-then-source order, so we consume the next field as
 *  `oldPath`. The trailing NUL yields an empty final field, skipped. */
export function parsePorcelainZ(out: string): PorcelainEntry[] {
  const fields = out.split("\0");
  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const field = fields[i];
    // Minimal valid record is "XY " + ≥1 path char = 4 bytes. Empties
    // (incl. the trailing NUL's field) are skipped.
    if (!field || field.length < 4) {
      i++;
      continue;
    }
    const x = field[0];
    const y = field[1];
    const p = field.slice(3); // skip the "XY " prefix
    if (x === "R" || x === "C") {
      entries.push({ x, y, path: p, oldPath: fields[i + 1] ?? "" });
      i += 2;
    } else {
      entries.push({ x, y, path: p });
      i += 1;
    }
  }
  return entries;
}
