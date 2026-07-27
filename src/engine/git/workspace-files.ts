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
    const [{ stdout }, { stdout: deletedStdout }] = await Promise.all([
      runGit(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]),
      runGit(cwd, ["ls-files", "-d", "-z"]),
    ]);
    const deleted = new Set(deletedStdout.split("\0").filter(Boolean));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of stdout.split("\0")) {
      if (!p || seen.has(p) || deleted.has(p)) continue;
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
