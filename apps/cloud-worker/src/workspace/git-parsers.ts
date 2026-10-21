// Ported pure parsers from apps/desktop/src/engine/git/{diff,porcelain}.ts.
// Source snapshot: be2801b9. No Local engine runtime imports.

export interface Hunk {
  filePath: string; oldFilePath?: string; oldStart: number; oldLines: number;
  newStart: number; newLines: number; body: string;
}
export interface FileChange {
  path: string; oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
}
export interface DiffFileSummary extends FileChange { additions: number; deletions: number; binary: boolean }

const statusLetter = (letter: string): FileChange["status"] => ({ A: "added", C: "added", D: "deleted", R: "renamed", U: "conflicted" } as const)[letter as "A"] ?? "modified";

export function bucketPorcelain(raw: string) {
  const result = { staged: [] as FileChange[], unstaged: [] as FileChange[], untracked: [] as string[], conflicted: [] as FileChange[] };
  for (const entry of parsePorcelainZ(raw)) {
    const file = { path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) };
    if (isConflictEntry(entry)) result.conflicted.push({ ...file, status: "conflicted" });
    else if (entry.x === "?" && entry.y === "?") result.untracked.push(entry.path);
    else {
      if (entry.x !== " " && entry.x !== "!") result.staged.push({ ...file, status: statusLetter(entry.x) });
      if (entry.y !== " " && entry.y !== "!") result.unstaged.push({ ...file, status: statusLetter(entry.y) });
    }
  }
  return result;
}

export function parseNameStatus(raw: string): FileChange[] {
  const fields = raw.split("\0"), files: FileChange[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const code = fields[i++][0];
    if (code === "R" || code === "C") {
      const oldPath = fields[i++], path = fields[i++];
      if (path) files.push({ path, oldPath, status: statusLetter(code) });
    } else {
      const path = fields[i++]; if (path) files.push({ path, status: statusLetter(code) });
    }
  }
  return files;
}

export function parseNumstat(raw: string): Array<{ path: string; additions: number; deletions: number; binary: boolean }> {
  const fields = raw.split("\0"), files = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const record = fields[i++], first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first), removed = record.slice(first + 1, second);
    let path = record.slice(second + 1);
    if (!path) { i++; path = fields[i++]; }
    files.push({ path, additions: Number(added) || 0, deletions: Number(removed) || 0, binary: added === "-" || removed === "-" });
  }
  return files;
}

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
 *  **Why `-z`:** the human porcelain format C-quotes any
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

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff into structured hunks. Each `@@ -A,B +C,D @@`
 *  header opens a new hunk; the body up to the next header (or the
 *  next "diff --git" or EOF) is the hunk's lines. */
export function parseUnifiedDiff(raw: string): Hunk[] {
  const out: Hunk[] = [];
  const lines = raw.split("\n");
  let currentFilePath = "";
  let currentOldFilePath = "";
  let currentHunk: Hunk | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentHunk) {
      currentHunk.body = buffer.join("\n");
      out.push(currentHunk);
    }
    currentHunk = null;
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      flush();
      // Format: `diff --git a/<path> b/<path>` — capture BOTH sides (b is the
      // canonical path, a is the pre-image / rename source). If the header
      // can't be parsed (e.g. a path containing " b/", or quoting), set both to
      // "" so the hunk fails CLOSED in the remote secret filter rather than
      // inheriting a stale path. (We also run diff with core.quotePath=false so
      // non-ASCII paths parse cleanly.)
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      currentOldFilePath = m ? m[1] : "";
      currentFilePath = m ? m[2] : "";
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(HUNK_HEADER_RE);
      if (m) {
        currentHunk = {
          filePath: currentFilePath,
          oldFilePath: currentOldFilePath,
          oldStart: parseInt(m[1], 10),
          oldLines: m[2] ? parseInt(m[2], 10) : 1,
          newStart: parseInt(m[3], 10),
          newLines: m[4] ? parseInt(m[4], 10) : 1,
          body: "",
        };
        buffer = [line];
      }
      continue;
    }
    if (currentHunk) buffer.push(line);
  }
  flush();
  return out;
}

