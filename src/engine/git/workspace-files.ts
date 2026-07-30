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
import { isInside } from "../files/read-file";

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

// ──────────────────────────────────────────────────────────
// Ignored entries — what the listing above deliberately omits
// ──────────────────────────────────────────────────────────
//
// `--exclude-standard` above hides every .gitignore'd path, which is right for
// the @-mention picker (nobody wants to @-mention node_modules/.pnpm/…) but
// wrong for the Files tab: `node_modules`, `dist/`, `.env` are REAL files the
// user's setup script and agents just created, and a file browser that can't
// show them is lying about the worktree.
//
// The catch is volume — 60,888 ignored files in this repo alone. So this is
// LAZY and two-phase:
//
//   • roots (no `dir`): `--directory` collapses a fully-ignored directory to a
//     single trailing-slash entry, so the whole set is ~8 rows in ~6ms instead
//     of 60k. A directory holding BOTH tracked and ignored files isn't
//     collapsed — git lists its ignored children individually, which is what
//     the tree wants there anyway.
//   • children (`dir` set): a plain readdir one level down. Everything inside
//     an ignored directory is ignored by inheritance, so git has nothing to
//     add and would only re-walk the subtree.
//
// Directories carry a trailing "/" — the marker @pierre/trees uses to
// materialise a directory node with no children yet, which is exactly how an
// unexpanded `node_modules/` row exists before we've listed it.
//
// `.git` is absent by design: it is not "ignored" (git excludes it
// structurally), showing it invites accidental corruption of the object store,
// and every mainstream editor hides it too. The roots query gets that from git;
// `readIgnoredDir` has to drop it explicitly, because a nested checkout inside
// an ignored directory (a git-URL dependency under `vendor/`, a sibling
// worktree under `.conductor/`) puts a real `.git` one readdir away.
// ──────────────────────────────────────────────────────────

/** Cap per directory level. A pnpm `node_modules/.pnpm` can hold tens of
 *  thousands of sibling entries; past this the tree row count stops being
 *  navigable anyway, and the payload crosses a bridge. */
const IGNORED_DIR_LIMIT = 5_000;

/** Byte-order comparator — deliberately NOT `localeCompare`.
 *
 *  Two reasons, both about the per-level cap being a STABLE prefix of a stable
 *  order. `localeCompare` returns 0 for strings that are merely equivalent under
 *  the collator ("café" spelled NFC vs NFD; a name with a zero-width space vs one
 *  without; a soft hyphen), so the sort is not a total order and V8 falls back to
 *  readdir order for those pairs — which is not reproducible between calls on a
 *  Linux filesystem, where both normalizations can sit in one directory. And it
 *  keys off the ambient locale, so
 *  `LANG=en_US` and `LANG=sv_SE` slice a DIFFERENT 5,000 entries out of the same
 *  directory. Byte order is total, locale-free, and matches how `git ls-files`
 *  orders the roots listing, so both halves of the feature agree. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `p` sits underneath one of the collapsed directory entries in
 *  `dirs` (each of which ends in "/"). `git ls-files` emits a directory before
 *  its own descendants in byte order, so callers can grow `dirs` as they walk. */
function isUnderCollapsedDir(p: string, dirs: Set<string>): boolean {
  if (dirs.size === 0) return false;
  let slash = p.indexOf("/");
  while (slash !== -1) {
    if (dirs.has(p.slice(0, slash + 1))) return true;
    slash = p.indexOf("/", slash + 1);
  }
  return false;
}

/** Ignored paths at the top level of `cwd` (repo-relative), or — with `dir` —
 *  the entries directly inside that already-ignored directory. Directories end
 *  with "/". Returns [] on any failure: a file tree must degrade to "shows
 *  less", never to an error. */
export async function listIgnoredEntries(
  cwd: string,
  dir?: string,
  limit: number = IGNORED_DIR_LIMIT,
): Promise<string[]> {
  if (!cwd) return [];
  return dir ? readIgnoredDir(cwd, dir, limit) : listIgnoredRoots(cwd, limit);
}

/** `git ls-files -o -i --exclude-standard --directory`, NUL-split. `-z` means
 *  paths arrive verbatim (no `core.quotePath` escaping), so a name with a space,
 *  a backslash or a newline survives intact. */
async function ignoredLsFiles(
  cwd: string,
  noEmptyDirectory: boolean,
): Promise<string[]> {
  const { stdout } = await runGit(cwd, [
    "ls-files",
    "-o",
    "-i",
    "--exclude-standard",
    "--directory",
    ...(noEmptyDirectory ? ["--no-empty-directory"] : []),
    "-z",
  ]);
  return stdout.split("\0").filter(Boolean);
}

async function listIgnoredRoots(
  cwd: string,
  limit: number,
): Promise<string[]> {
  try {
    // TWO queries, because `--no-empty-directory` does more than its name says.
    //
    // We want `--directory`'s collapsing (a wholly-ignored dir → one row) AND we
    // want empty ignored dirs suppressed (an unexpandable dead row). The obvious
    // move — pass both flags — silently DROPS ignored files out of any directory
    // that has no tracked content but does have untracked, non-ignored content:
    //
    //   out/report.md  (untracked, not ignored)   out/run.log  (ignored)
    //   --directory                     → out/run.log
    //   --directory --no-empty-directory → (nothing)
    //
    // That is exactly the case the feature exists for — an agent or a run action
    // writes a report next to a log into a brand-new folder — and it stays
    // broken until someone commits the sibling, which is why the original test
    // (which committed it) passed. So: take the COLLAPSED DIRECTORIES from the
    // --no-empty-directory run (that flag's one real job), and take the FILES
    // from the plain run (which never loses them). Both are ~7ms and run
    // concurrently.
    const [all, nonEmpty] = await Promise.all([
      ignoredLsFiles(cwd, false),
      ignoredLsFiles(cwd, true).catch(() => null),
    ]);
    // Null → the second query failed on its own; fall back to keeping every
    // directory rather than losing the whole listing over a dead row.
    const keepDirs =
      nonEmpty === null
        ? null
        : new Set(nonEmpty.filter((p) => p.endsWith("/")));
    const out: string[] = [];
    const collapsed = new Set<string>();
    // `all` is byte-sorted by git, so a collapsed directory always precedes its
    // own descendants — one forward pass can therefore suppress them as it goes
    // (git shouldn't emit both, but a duplicated row throws in the tree store,
    // so this stays defensive).
    for (const p of all) {
      if (p.endsWith("/")) {
        if (keepDirs && !keepDirs.has(p)) continue; // empty ignored dir
        collapsed.add(p);
      } else if (isUnderCollapsedDir(p, collapsed)) {
        continue;
      }
      out.push(p);
      if (out.length >= limit) break;
    }
    return await markSymlinkedDirs(cwd, out);
  } catch {
    return []; // not a git repo → the non-git walk above already shows files
  }
}

/** Give a symlink-to-directory the trailing "/" the tree needs to treat it as
 *  expandable. `git ls-files --directory` classifies a symlink as a FILE, so an
 *  ignored `packages/legacy -> ../shared/legacy` inside a mixed directory came
 *  back as `packages/legacy` — a leaf row that opens `file.read` on a directory.
 *  `readIgnoredDir` already stats symlinks for the same reason; this keeps the
 *  two halves of the listing agreeing. Bounded by the roots set (~8 entries),
 *  and only entries that aren't already marked are touched. */
async function markSymlinkedDirs(
  cwd: string,
  entries: string[],
): Promise<string[]> {
  const root = path.resolve(cwd);
  return Promise.all(
    entries.map(async (p) => {
      if (p.endsWith("/")) return p;
      try {
        const st = await fsp.lstat(path.join(root, p));
        if (!st.isSymbolicLink()) return p;
        return (await fsp.stat(path.join(root, p))).isDirectory() ? `${p}/` : p;
      } catch {
        return p; // vanished or broken link — leave it as a plain entry
      }
    }),
  );
}

async function readIgnoredDir(
  cwd: string,
  dir: string,
  limit: number,
): Promise<string[]> {
  const rel = dir.replace(/\/+$/, "");
  // Containment: `dir` arrives from the renderer, so resolve it against cwd and
  // require it to stay inside — lexically first, then again after realpath so a
  // symlinked ignored directory can't be used to enumerate outside the
  // worktree. Fail closed on an unreadable path.
  if (!rel || path.isAbsolute(rel)) return [];
  const root = path.resolve(cwd);
  const target = path.resolve(root, rel);
  if (!isInside(target, root)) return [];
  // No git object store, at any depth — checked on the RESOLVED path so
  // `node_modules/../.git` can't spell its way past it. This function never
  // emits a `.git` entry, so a well-behaved renderer never asks; `dir` crosses a
  // bridge, so the guard doesn't depend on that.
  if (path.relative(root, target).split(path.sep).includes(".git")) return [];
  let entries: import("node:fs").Dirent[];
  try {
    const realRoot = await fsp.realpath(root);
    const realTarget = await fsp.realpath(target);
    if (!isInside(realTarget, realRoot)) return [];
    entries = await fsp.readdir(realTarget, { withFileTypes: true });
  } catch {
    return [];
  }
  // Prefix from the RESOLVED relative path, not the caller's spelling: a `dir`
  // of "node_modules/./react" would otherwise echo back
  // "node_modules/./react/index.js", a path no tree node has — rows would nest
  // under a phantom "." and the directory would never leave the pending set.
  const prefix = path
    .relative(root, target)
    .split(path.sep)
    .join("/")
    .replace(/\/+$/, "");
  if (!prefix) return [];
  // Sort and CAP first, then stat only the survivors. Both halves matter:
  //
  //   • sorting before capping is what makes the cap a stable prefix — slicing
  //     readdir order would hand back an arbitrary subset that reshuffles
  //     between calls, so the renderer's "did this directory change?" check
  //     would fire on every refresh forever; and
  //   • capping before the stat loop is the difference between ~200ms and ~1s
  //     for a 30,000-symlink directory, since the loop below is one sequential
  //     stat per symlinked entry and pnpm's node_modules is almost all
  //     symlinks. This runs again for every open directory on every refresh.
  //
  // `.git` is dropped here, not filtered downstream: a nested checkout inside an
  // ignored directory (a git-URL dependency, a sibling worktree under the
  // gitignored `.conductor/`) would otherwise let the Files tab browse — and the
  // sibling `file.write` op edit — a real object store.
  const names = entries
    .map((e) => e.name)
    .filter((name) => name !== ".git")
    .sort(byBytes);
  const kept = names.length > limit ? names.slice(0, limit) : names;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const out: string[] = [];
  for (const name of kept) {
    const e = byName.get(name);
    // A symlinked directory (pnpm's node_modules is built from them) reports
    // isDirectory() === false on the Dirent — stat so it still expands.
    let isDir = e?.isDirectory() === true;
    if (!isDir && e?.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(path.join(target, name))).isDirectory();
      } catch {
        isDir = false; // broken symlink — list it as a plain entry
      }
    }
    out.push(`${prefix}/${name}${isDir ? "/" : ""}`);
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
