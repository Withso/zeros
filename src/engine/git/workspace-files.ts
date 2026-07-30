// ──────────────────────────────────────────────────────────
// Workspace file listing — backs the composer's @-mention picker
// ──────────────────────────────────────────────────────────
//
// The renderer can't touch the filesystem, so the @-mention picker
// asks the engine for the workspace's file list (once per cwd; the
// renderer caches + fuzzy-filters in-memory per keystroke).
//
// We prefer `git ls-files` because it gives .gitignore-respect for
// free — node_modules / dist / build / .git never surface — and it's
// fast even on large monorepos. `-c` lists tracked files, `-o` adds
// untracked-but-not-ignored ones (so brand-new files the user just
// created are mentionable), `--exclude-standard` honours .gitignore +
// .git/info/exclude + the global excludesfile, and `-z` is NUL-delimited
// so paths with spaces/newlines survive intact. Because `-c` describes the
// INDEX, it also includes tracked paths deleted from disk; a parallel `-d`
// query removes those. Changes still shows them as deletion diffs, while All
// Files and @-mentions stay truthful about what can actually be opened.
//
// Sparse-checkout gets the same treatment for the same reason. A folder
// deselected in Working directories keeps its index rows — they just gain the
// skip-worktree bit — so `-c` happily lists files that are NOT on disk. A
// parallel `ls-files -v` query drops those (`S` marks skip-worktree), which is
// what makes an excluded folder actually disappear from the tree instead of
// leaving rows that error on open. Note this only hides what git really
// removed: a dirty or untracked file inside an excluded folder stays on disk,
// keeps its `H`/untracked status, and correctly keeps showing up.
//
// When cwd isn't a git repo (fresh folder, no `git init` yet) we fall
// back to a bounded recursive walk that skips the usual heavy dirs.
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { runGit } from "./git-exec";

/** Hard cap on returned paths — keeps the IPC payload + the renderer's
 *  in-memory filter bounded on huge monorepos. */
const DEFAULT_LIMIT = 20_000;

/** Dirs the non-git fallback never descends into. (The git path doesn't
 *  need this — .gitignore already excludes them.) */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-engine",
  "dist-electron",
  "build",
  "out",
  ".next",
  ".cache",
  ".turbo",
  "coverage",
  "release",
  ".codex-protocol-cache",
]);

/** Repo-relative POSIX paths of every tracked + untracked-not-ignored
 *  file under `cwd`, capped at `limit`. Returns `[]` on any failure so
 *  the picker degrades gracefully to selection-only. */
export async function listWorkspaceFiles(
  cwd: string,
  limit: number = DEFAULT_LIMIT,
): Promise<string[]> {
  if (!cwd) return [];
  try {
    const [{ stdout }, { stdout: deletedStdout }, sparse] = await Promise.all([
      runGit(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]),
      runGit(cwd, ["ls-files", "-d", "-z"]),
      isSparseCheckout(cwd),
    ]);
    const deleted = new Set(deletedStdout.split("\0").filter(Boolean));
    // Only consult skip-worktree when sparse-checkout is actually on. The bit
    // has a second, unrelated user: `git update-index --skip-worktree <file>`
    // is the standard trick for pinning locally-modified tracked config, and
    // those files ARE on disk and openable. Filtering them unconditionally
    // made them vanish from the tree and the @-mention picker with nothing to
    // explain it. Gating on sparse also keeps the extra index scan off the
    // hot path for the overwhelming majority of repos, which are not sparse.
    const skipped = sparse
      ? collectSkipWorktree(
          (await runGit(cwd, ["ls-files", "-v", "-z"])).stdout,
        )
      : new Set<string>();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of stdout.split("\0")) {
      if (!p || seen.has(p) || deleted.has(p) || skipped.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    // Not a git repo (or git unavailable) — bounded recursive walk.
    return walkDir(cwd, limit);
  }
}

/** Whether sparse-checkout is enabled for this worktree. A plain config read —
 *  far cheaper than the full index scan it gates. Absent/false ⇒ not sparse.
 *
 *  Exported for the design lock, which needs the same gate: outside a sparse
 *  checkout the skip-worktree bit means "pinned locally-modified file", not
 *  "absent from disk". */
export async function isSparseCheckout(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, [
      "config",
      "--get",
      "core.sparseCheckout",
    ]);
    return stdout.trim().toLowerCase() === "true";
  } catch {
    // `git config --get` exits 1 when the key is unset — the common case.
    return false;
  }
}

/** Paths carrying the skip-worktree bit, from `git ls-files -v -z` output.
 *
 *  Each record is `<tag><space><path>`, NUL-terminated. A lowercase tag means
 *  assume-unchanged and an uppercase `S` means skip-worktree; only the latter
 *  implies the file was removed from the worktree by a sparse pattern.
 *  Parsing is positional (tag is always one char) rather than regex-based, so
 *  a path that itself starts with `S ` can't be misread. */
export function collectSkipWorktree(tagged: string): Set<string> {
  const out = new Set<string>();
  for (const record of tagged.split("\0")) {
    if (record.length < 3 || record[1] !== " ") continue;
    if (record[0] === "S") out.add(record.slice(2));
  }
  return out;
}

async function walkDir(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      // Skip dotfiles/dirs (except .github, which holds real config) and
      // the heavy build/dep dirs.
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        out.push(
          path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"),
        );
      }
    }
  };
  await walk(root);
  return out;
}
