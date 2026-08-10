// ──────────────────────────────────────────────────────────
// Files-to-copy — seed gitignored files into a new worktree
// ──────────────────────────────────────────────────────────
//
// A fresh `git worktree add` checkout has TRACKED files only — a new worktree
// has no `.env`, no `.env.local`, none of the gitignored machine-local files
// the project needs to run, so it cannot be built or run until the user copies
// them across by hand. This module works out what to seed automatically.
//
// We return the repo-relative paths of files that are BOTH (a) not tracked in
// the main checkout (gitignored OR plain-untracked — neither arrives via
// `git worktree add`'s checkout) AND (b) match the configured include patterns.
// Tracked files are excluded — they already arrive via git checkout. The
// caller copies them into the worktree (best-effort) via setup-hooks
// `seedPaths`.
//
// Pattern source precedence (most specific wins): a repo-root `.worktreeinclude`
// file (gitignore syntax) > the `file_include_globs` setting (resolved, so
// repo-local beats user) > the default `.env*`. A list REPLACES the one below
// it; the layers are never merged.
//
// The matching is delegated to git itself — no gitignore re-implementation, no
// glob library:
//
//   • `git ls-files -o -i --exclude-from=<patterns>` answers "is it untracked"
//     and "does it match" in one call, with EXACT gitignore semantics — which
//     is what makes `!` negation work (it used to be skipped with a warning,
//     so a `.worktreeinclude` copied from another tool silently over-copied).
//     Negation is order-sensitive exactly as git defines it: a later line wins.
//   • `:(glob)` pathspecs prune the traversal. They are a PERFORMANCE filter
//     only, and every form we emit is a deliberate SUPERSET of what the
//     pattern can match, so pruning can never drop a configured file. When a
//     pattern is one we can't confidently over-approximate (a backslash
//     escape), pruning is dropped for the whole scan rather than risked.
//
// What counts as seedable depends on where the patterns came from:
//   • EXPLICIT sources (.worktreeinclude / file_include_globs): ALL untracked
//     matches — ignored or not. The user named the path; a match that
//     happened to be missing from .gitignore used to be silently skipped
//     (".worktreeinclude is not working" in the field), which is worse than
//     the copy showing up as an untracked file in the new worktree's status.
//     `previewFilesToCopy` flags those rows so the UI can say so.
//   • The implicit `.env*` DEFAULT: gitignored matches only
//     (`-o -i --exclude-standard`). Nobody asked for these by name, and
//     seeding a NOT-ignored `.env.something` would surface it in the
//     worktree's Changes tab where an agent could commit it — for secrets,
//     silently skipping is the safe default.
// ──────────────────────────────────────────────────────────

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { opSettingsResolve } from "../settings/ops";
import { runFile } from "./git-exec";

const DEFAULT_PATTERNS = [".env*"];
const WORKTREEINCLUDE_FILE = ".worktreeinclude";
/** Safety cap — copying hundreds of files at create is almost always a too-broad
 *  pattern (e.g. `*`); seed the first N and warn rather than stall the create. */
const MAX_SEED_FILES = 500;
/** Rows returned by `previewFilesToCopy`. Beyond this the UI gets a count and
 *  `truncated: true` instead of an unbounded IPC payload. */
const MAX_PREVIEW_FILES = 2_000;
/** Tick-box rows offered by the settings pane. Directory-collapsed, so a real
 *  repo produces a handful; the cap only guards a pathological `.gitignore`. */
const MAX_CANDIDATES = 300;
/** Per-pattern match attribution costs one `git ls-files` per pattern. Cheap
 *  for a hand-written list, so cap it rather than let a generated 10k-line
 *  file fan out into 10k subprocesses. */
const MAX_ATTRIBUTED_PATTERNS = 200;
/** Concurrent `git ls-files` processes during attribution. */
const ATTRIBUTION_CONCURRENCY = 8;
/** Advisory only. Past this the preview warns that every create will be slow —
 *  the real-world failure is one big directory, not many small files, and a
 *  file COUNT cap sails right past it (a 64-file / 2.3 MiB `docs/` did). */
const LARGE_SEED_BYTES = 25 * 1024 * 1024;

export type FilesToCopySource =
  | "worktreeinclude"
  | "file_include_globs"
  | "default";

/** One line of the include list, as written. */
export interface FilesToCopyPattern {
  /** The line verbatim (trailing whitespace trimmed), `!` included. */
  raw: string;
  /** `raw` with a leading `!` stripped — the glob git will match. */
  pattern: string;
  /** True for a `!` line: it REMOVES matches instead of adding them. */
  negate: boolean;
  /** 1-based line number in `.worktreeinclude`, or 1-based index in the
   *  `file_include_globs` array. */
  line: number;
}

export interface FilesToCopyResult {
  /** Repo-relative paths of gitignored files matching the patterns. */
  paths: string[];
  /** KNOWN matches beyond MAX_SEED_FILES — not dropped: the caller copies them
   *  in a background pass so a giant match set can't stall workspace creation.
   *  Empty in the normal case. */
  deferredPaths: string[];
  /** Where the patterns came from. */
  source: FilesToCopySource;
  /** Non-fatal notes (unreadable include file, oversized match set, git error). */
  warnings: string[];
  /** False when enumeration was CUT SHORT (scan timeout or git error): `paths`
   *  may be missing matches the user configured. The caller MUST re-run in the
   *  background with a far larger budget and seed the remainder, so a slow
   *  scan costs seconds rather than the seeds themselves.
   *
   *  That retry is generous but NOT unbounded (worktree.ts
   *  LATE_SEED_SCAN_TIMEOUT_MS): `whenSeedingSettled` gates the setup command
   *  and every run-on-create action, so a scan that never returns is a
   *  workspace that never starts — silently. A retry that also comes up short
   *  is therefore possible, and it is logged at error level rather than
   *  pretended away. */
  complete: boolean;
}

// ── pattern resolution ───────────────────────────────────

interface PatternSourceResult {
  source: FilesToCopySource;
  patterns: FilesToCopyPattern[];
  /** Absolute path of the `.worktreeinclude` that supplied the patterns. */
  filePath?: string;
  /** Its raw text — the UI shows it read-only instead of an editable box. */
  text?: string;
  /** The settings layer `file_include_globs` resolved from, when that's the
   *  source: `repo-local` (this project) vs `user` (all projects) is exactly
   *  the distinction the settings pane's scope control needs. */
  layer?: string;
  warnings: string[];
}

/** Split include-list text into pattern lines: `#` comments and blanks are
 *  dropped (git drops them too), `!` lines are kept and marked. */
function parsePatternLines(text: string): FilesToCopyPattern[] {
  const out: FilesToCopyPattern[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Trailing SPACES only, exactly as git's parser does (trim_trailing_spaces
    // in dir.c). Leading whitespace is part of a gitignore pattern, and so is
    // a trailing TAB — `\s+$` ate both, which then made the pathspec prune
    // narrower than the matcher and silently dropped the named file.
    const raw = lines[i].replace(/ +$/, "");
    if (!raw || raw.startsWith("#")) continue;
    const negate = raw.startsWith("!");
    out.push({
      raw,
      pattern: negate ? raw.slice(1) : raw,
      negate,
      line: i + 1,
    });
  }
  return out;
}

/** Normalize one `file_include_globs` array into pattern strings.
 *
 *  Trimmed, unlike a `.worktreeinclude` LINE. Leading whitespace is meaningful
 *  in gitignore, but a TOML array entry (or a line in the settings pane's
 *  editor) is a discrete value — `" .env"` there is a typo, and honouring it
 *  would silently match nothing with no way for the user to see the space.
 *  Shared by the saved and the DRAFT path so a preview can't disagree with
 *  what create will do for the same list. */
function normalizeGlobList(value: readonly unknown[]): string[] {
  return value.flatMap((p) =>
    typeof p === "string" && p.trim() ? [p.trim()] : [],
  );
}

/** Read `file_include_globs` from the resolved settings (array of strings),
 *  along with the layer that won. Repo-scoped COMMITTED files still can't
 *  carry this key (`.worktreeinclude` is the committed mechanism and takes
 *  precedence anyway); the personal, gitignored `.zeros/settings.local.toml`
 *  can, which is what makes the setting per-project. */
function readFileIncludeGlobs(
  repoRoot: string,
  mainRepoRoot?: string,
): { globs: string[] | null; layer?: string } {
  try {
    const resolved = opSettingsResolve(repoRoot, mainRepoRoot);
    const v = resolved.effective.file_include_globs;
    if (Array.isArray(v)) {
      return {
        globs: normalizeGlobList(v),
        layer: resolved.sources?.file_include_globs,
      };
    }
  } catch {
    /* resolve failure → key absent; default applies */
  }
  // `null` = the key is ABSENT, which is different from an empty list.
  return { globs: null };
}

/** Resolve WHICH patterns apply to `repoRoot` and where they came from.
 *  Never throws. Exported for the preview op, which needs the source and the
 *  raw `.worktreeinclude` text even when enumeration fails.
 *
 *  `draftGlobs` previews an UNSAVED list in place of the saved
 *  `file_include_globs` — the settings pane's textarea/tick-boxes before the
 *  autosave lands. It goes through the SAME branch as a saved list on purpose:
 *  a cleared box is `[]`, which is what the pane then writes, and `[]` means
 *  "copy nothing" (below). Treating it as "use the built-in default" made the
 *  preview promise files create would not copy, and re-ticked the box the user
 *  had just cleared. Ignored when a `.worktreeinclude` is present: that file
 *  wins, so previewing anything else would be a lie. */
export function resolvePatternSource(
  repoRoot: string,
  mainRepoRoot?: string,
  draftGlobs?: readonly unknown[],
): PatternSourceResult {
  const warnings: string[] = [];
  const wtiPath = path.join(repoRoot, WORKTREEINCLUDE_FILE);
  // Open ONCE and work from that descriptor: fstat the fd and read the fd,
  // never the path twice. Testing the path and then reading the path is a
  // check-then-use race — the name can be repointed between the two calls, so
  // the bytes that arrive need not come from the thing that was checked — and
  // it is what CodeQL flags here (js/file-system-race). One descriptor pins the
  // inode for both steps, which is the fix rather than a suppression.
  let text: string | undefined;
  let readFailure: string | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(wtiPath, "r");
    // A DIRECTORY named .worktreeinclude opens cleanly on Linux and reads back
    // as junk on some platforms, so the type check stays — against the fd now.
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    text = readFileSync(fd, "utf8");
  } catch (err) {
    // ENOENT is the ordinary "this repo has no .worktreeinclude" case, not a
    // failure: it falls through to the configured patterns in silence, which is
    // exactly what the previous existsSync gate did. Anything else — a
    // directory, EACCES, a mid-read I/O error — IS the unreadable case below.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      readFailure = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (readFailure !== undefined) {
    // Falling THROUGH (rather than seeding nothing) is deliberate: an
    // unreadable include file used to mean "copy nothing at all, not even
    // .env" — a workspace that silently can't boot. Loud warning + the
    // configured/default list is the recoverable failure.
    warnings.push(
      `files-to-copy: ${WORKTREEINCLUDE_FILE} exists but could not be read (${readFailure}); falling back to the configured patterns`,
    );
  }
  if (text !== undefined) {
    const patterns = parsePatternLines(text);
    if (patterns.length === 0) {
      warnings.push(
        `files-to-copy: ${WORKTREEINCLUDE_FILE} has no patterns — nothing will be seeded into new workspaces (the file REPLACES the ${DEFAULT_PATTERNS.join(", ")} default)`,
      );
    }
    return {
      source: "worktreeinclude",
      patterns,
      filePath: wtiPath,
      text,
      warnings,
    };
  }
  // The layer is still read from disk even for a draft: it only names WHERE a
  // saved list would live ("This project" vs "All projects"), which the draft
  // does not change.
  const saved = readFileIncludeGlobs(repoRoot, mainRepoRoot);
  const layer = saved.layer;
  const globs =
    draftGlobs !== undefined ? normalizeGlobList(draftGlobs) : saved.globs;
  // PRESENT-but-empty is "copy nothing", not "use the default". Collapsing the
  // two left "don't copy my .env" inexpressible: unticking the last row deleted
  // the key, the built-in `.env*` came back, and the file the user had just
  // said no to was seeded anyway. Absent (null) still means the default.
  if (globs !== null) {
    if (globs.length === 0) {
      warnings.push(
        `files-to-copy: this project's list is empty, so nothing will be copied into a new workspace. Remove the setting to go back to the ${DEFAULT_PATTERNS.join(", ")} default.`,
      );
    }
    return {
      source: "file_include_globs",
      patterns: globs.map((g, i) => ({
        raw: g,
        pattern: g.startsWith("!") ? g.slice(1) : g,
        negate: g.startsWith("!"),
        line: i + 1,
      })),
      layer,
      warnings,
    };
  }
  return {
    source: "default",
    patterns: DEFAULT_PATTERNS.map((g, i) => ({
      raw: g,
      pattern: g,
      negate: false,
      line: i + 1,
    })),
    warnings,
  };
}

// ── pattern → pathspec (a PRUNE, always a superset) ──────

// Convert one gitignore-style pattern into git `:(glob)` pathspec(s) used to
// prune the traversal. Correctness of the MATCH comes from `--exclude-from`;
// these only have to be a superset, so we err generous:
//
//   • Both the anchored form and the any-depth `**/` form are emitted for a
//     pattern without a leading `/`, even one containing a slash (which
//     gitignore anchors). Over-matching costs a little traversal; under-
//     matching would silently drop a file the user asked for.
//   • Directory patterns need the explicit contents form: a WILDCARD-FREE
//     pathspec like `certs` matches everything under `certs/` via git's
//     leading-directory rule, but that rule is OFF once the pathspec contains
//     a wildcard — `**/secrets` matches only the entry named `secrets`, never
//     `nested/secrets/key.txt`. So we also emit `<p>/**` (and `**/<p>/**`,
//     where the leading `**/` matches zero directories, covering the root).
//
// Returns null when the pattern can't be safely over-approximated — a
// backslash escape, where wildmatch and our string surgery could disagree.
// The caller then drops pruning entirely for that scan.
// (Line comments, not a block comment — the `**/` examples above would
// terminate a `/* */` block early.)
function toPathspecs(pattern: string): string[] | null {
  let p = pattern;
  if (!p.trim() || p.trimStart().startsWith("#")) return [];
  // A `..` segment makes git reject the PATHSPEC outright ("'../x' is outside
  // repository"), which fails the whole `ls-files` call — one typo'd line in
  // the box would stop EVERY file from being seeded, in every new workspace,
  // with nothing but a log line to show for it. Such a pattern can never match
  // a repo-relative path anyway, so it contributes no prune and no matches.
  // Checked FIRST, and through the same predicate the user-facing warning
  // uses, so the two can't drift apart on inputs like `  ../x`.
  if (isEscapingPattern(p)) return [];
  // LEADING whitespace is part of a gitignore pattern (only trailing space is
  // stripped, and only unescaped). Trimming it here would prune away the very
  // file the pattern names, so hand these to the unpruned path instead of
  // guessing.
  if (p !== p.trimStart()) return null;
  // Only trailing SPACE, matching git's parser (trim_trailing_spaces in
  // dir.c). JS `trimEnd()` also eats tabs/NBSP, which git keeps as part of the
  // pattern — stripping them here would prune away a file whose name really
  // does end in a tab. Anything left over goes to the unpruned path.
  p = p.replace(/ +$/, "");
  if (p !== p.trimEnd()) return null;
  if (p.includes("\\")) {
    // `\x` escapes x. An escaped GLOB character can be over-approximated with
    // `?` — any single character is a superset of the one literal character it
    // stands for — which keeps pruning on for the escaped literals the
    // settings pane writes for a filename containing `*?[]`. An escaped `/`
    // would NARROW the prune (`?` doesn't cross a slash) and a dangling
    // backslash is undefined, so anything else still drops pruning entirely.
    if (!/^(?:[^\\]|\\[*?[\]\\])*$/.test(p)) return null;
    p = p.replace(/\\[*?[\]\\]/g, "?");
  }
  p = p.replace(/\/+$/, ""); // trailing slash (dir marker) — ls-files lists its files
  const anchored = p.startsWith("/");
  if (anchored) p = p.replace(/^\/+/, "");
  if (!p) return [];
  const specs = [`:(glob)${p}`, `:(glob)${p}/**`];
  if (!anchored) specs.push(`:(glob)**/${p}`, `:(glob)**/${p}/**`);
  return specs;
}

/** True for a pattern that can never match anything git lists, because it
 *  points outside the repository. Reported to the user rather than silently
 *  matching nothing — "why is my file not copied" has to have an answer. */
export function isEscapingPattern(pattern: string): boolean {
  const p = pattern.trim().replace(/^\/+/, "");
  return p.split("/").includes("..");
}

/** Prune pathspecs for a pattern list, or null to scan unpruned. Negations are
 *  skipped: they only ever REMOVE from the positive set, so pruning by the
 *  positives alone stays a superset. A list with no positive pattern prunes to
 *  an empty array, which the caller reads as "matches nothing". */
function prunePathspecs(patterns: FilesToCopyPattern[]): string[] | null {
  const out: string[] = [];
  for (const p of patterns) {
    if (p.negate) continue;
    const specs = toPathspecs(p.pattern);
    if (specs === null) return null;
    out.push(...specs);
  }
  return out;
}

// ── enumeration ──────────────────────────────────────────

/** Default sync budget for the ignored-file enumeration. Warm-cache scans are
 *  milliseconds even at 60k ignored files (git prunes by pathspec); this only
 *  fires on pathological cold-disk walks — and when it does, the CALLER
 *  completes the seeding in a background pass (`complete: false`), it is never
 *  skipped. */
const DEFAULT_SCAN_TIMEOUT_MS = 8_000;

export interface ResolveFilesToCopyOptions {
  /** Enumeration budget in ms. `0` = unbounded (the background completion
   *  pass). Omitted → DEFAULT_SCAN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Main checkout whose repo-local settings should apply while `repoRoot` is
   * a linked worktree. Omit on create, where repoRoot already is main. */
  mainRepoRoot?: string;
  /** Read the PATTERNS from this checkout instead of `repoRoot`, while still
   *  scanning `repoRoot` for files. Archive uses it to apply the MAIN
   *  checkout's `.worktreeinclude` to the worktree: a workspace branched
   *  before a pattern was added would otherwise checkpoint none of the files
   *  that pattern seeded, and removing the worktree would lose them for good. */
  patternRoot?: string;
  /** This caller gets no second chance (archive, the background completion
   *  pass), so raise the `git ls-files` stdout ceiling. The default THROWS
   *  rather than truncating, and a retry hits the identical deterministic
   *  failure — which is how the archive of a repo with ~160k ignored paths
   *  became impossible. Stated explicitly rather than inferred from the
   *  timeout: the two knobs are unrelated. */
  noSecondChance?: boolean;
}

/** `core.ignorecase` for a repo — true on macOS/Windows by default. Git's
 *  EXCLUDE engine honors it; the PATHSPEC engine does not unless told to, so
 *  without `--icase-pathspecs` a `.ENV` pattern matching `.env` through the
 *  exclude file would be pruned away before it could match. Cached per repo:
 *  the value is a property of the filesystem, set once by `git init`. */
// Caches the PROMISE, not the value: the preview fires several `ls-files`
// concurrently, and every one of them would otherwise miss the cache and fork
// its own `git config` on first use.
const ignoreCaseByRepo = new Map<string, Promise<boolean>>();
function repoIgnoresCase(repoRoot: string): Promise<boolean> {
  const cached = ignoreCaseByRepo.get(repoRoot);
  if (cached) return cached;
  const pending = runFile(
    "git",
    ["-C", repoRoot, "config", "--get", "--type=bool", "core.ignorecase"],
    { timeoutMs: 5_000 },
  ).then(
    ({ stdout }) => stdout.trim() === "true",
    () =>
      // Unset (git exits 1) or unreadable → fall back to the platform default
      // git itself would probe for.
      process.platform === "darwin" || process.platform === "win32",
  );
  ignoreCaseByRepo.set(repoRoot, pending);
  return pending;
}

interface LsFilesResult {
  paths: string[];
  /**
   * `git ls-files` normally returns files when `--directory` is absent. A
   * trailing slash in that mode is an opaque nested repository/worktree
   * boundary: Git matched something inside it but deliberately did not walk
   * through the inner `.git` checkout. Passing that directory to the copy
   * hook would recursively clone an unrelated working tree, including its
   * dependency/build output and `.git` pointer file.
   */
  opaqueDirectories: string[];
}

/** Run one `git ls-files` and preserve its opaque-directory signal. */
async function lsFilesDetailed(
  repoRoot: string,
  args: string[],
  pathspecs: string[] | null,
  timeoutMs: number,
  maxBufferBytes = 16 * 1024 * 1024,
): Promise<LsFilesResult> {
  const icase =
    pathspecs && pathspecs.length > 0 ? await repoIgnoresCase(repoRoot) : false;
  const { stdout } = await runFile(
    "git",
    [
      "-C",
      repoRoot,
      ...(icase ? ["--icase-pathspecs"] : []),
      "ls-files",
      ...args,
      "-z",
      // No prune → no `--` separator at all. An EMPTY array reads the same
      // way, deliberately: `--` with zero pathspecs still means "match
      // everything", so treating `[]` as a filter would be the opposite of
      // what it looks like. Callers that mean "this can't match anything"
      // must short-circuit before getting here.
      ...(pathspecs && pathspecs.length > 0 ? ["--", ...pathspecs] : []),
    ],
    {
      maxBufferBytes,
      // Bounded on the create reply path: a pathological cold-disk walk once
      // blew the create RPC past the renderer's request budget ("Request
      // timeout: WORKSPACE_REQUEST"). The budget does NOT drop seeds — on
      // timeout the caller re-runs in the background with a budget orders of
      // magnitude larger, so user-configured seeding lands late rather than
      // never.
      timeoutMs,
    },
  );
  const paths: string[] = [];
  const opaqueDirectories: string[] = [];
  for (const raw of stdout.split("\0")) {
    if (!raw) continue;
    const normalized = raw.replace(/\/+$/, "");
    if (!normalized) continue;
    if (raw.endsWith("/")) {
      opaqueDirectories.push(normalized);
      continue;
    }
    paths.push(normalized);
  }
  return { paths, opaqueDirectories };
}

/** File-only convenience for secondary preview/attribution queries. */
async function lsFiles(
  repoRoot: string,
  args: string[],
  pathspecs: string[] | null,
  timeoutMs: number,
  maxBufferBytes = 16 * 1024 * 1024,
): Promise<string[]> {
  return (
    await lsFilesDetailed(repoRoot, args, pathspecs, timeoutMs, maxBufferBytes)
  ).paths;
}

/** Write the pattern list to a throwaway file git can read as an exclude
 *  source, and hand the path to `fn`.
 *
 *  For a `.worktreeinclude` we copy its TEXT VERBATIM rather than pointing git
 *  at the file itself. Byte-identical content parses identically — escapes and
 *  trailing-space rules stay exactly git's — but it pins the scan to the bytes
 *  `resolvePatternSource` actually read, so an edit mid-scan can't make the
 *  reported patterns and the enumerated files disagree. */
async function withExcludeFile<T>(
  src: PatternSourceResult,
  fn: (excludeFile: string) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const file = path.join(dir, "include");
    await writeFile(
      file,
      src.text ?? src.patterns.map((p) => p.raw).join("\n") + "\n",
    );
    return fn(file);
  });
}

/** Run `fn` against a private scratch directory and remove it afterwards.
 *  One owner for the exclude-file temp lifecycle, so cleanup, permissions and
 *  TMPDIR handling stay in a single place. `mkdtemp` already creates it 0700. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "zeros-ftc-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

interface EnumerateResult {
  paths: string[];
  complete: boolean;
  warnings: string[];
  /** The prune this scan used, so a caller running further queries against the
   *  same pattern set reuses it instead of recomputing (and re-deriving the
   *  "matches nothing" special case from it). `null` = scanned unpruned;
   *  `[]` = the patterns can't match anything, so no query was run at all. */
  prune: string[] | null;
}

/** List the untracked files in `repoRoot` matching `src`'s patterns. Never
 *  throws: a git failure returns `complete: false` so the caller can defer. */
async function enumerateMatches(
  repoRoot: string,
  src: PatternSourceResult,
  timeoutMs: number,
  noSecondChance: boolean,
): Promise<EnumerateResult> {
  const warnings: string[] = [];
  if (src.patterns.length === 0)
    return { paths: [], complete: true, warnings, prune: [] };
  for (const p of src.patterns) {
    if (isEscapingPattern(p.pattern)) {
      warnings.push(
        `files-to-copy: "${p.raw}" points outside the project and can never match — remove it. Patterns are relative to the project root.`,
      );
    }
  }
  const prune = prunePathspecs(src.patterns);
  if (prune === null) {
    // One pattern we can't over-approximate turned pruning off for the WHOLE
    // scan, which is correct but can be many times slower on a big tree — and
    // a silent slowdown is undiagnosable. A backslash is not exotic: it is the
    // gitignore escape (`my\ file.env`) and what a Windows user types for a
    // separator.
    warnings.push(
      `files-to-copy: a pattern contains a backslash or leading space, so the scan can't be narrowed and walks the whole tree. Rewrite it with "/" separators if you can.`,
    );
  }
  // Every pattern is a negation, a comment, or points outside the repo →
  // nothing to include. Guard explicitly: an exclude file of pure `!` lines
  // makes `-i` match nothing anyway, but a ZERO-length pathspec array is not a
  // filter at all.
  if (prune !== null && prune.length === 0) {
    // Say so. `!` used to be rejected outright, which taught people it
    // subtracts from the built-in default — so "just `!.env.local`" is exactly
    // what someone writes expecting ".env* minus .env.local", and the honest
    // answer (a list with no positive pattern includes nothing) is the last
    // thing they would guess from a silent "nothing to seed".
    warnings.push(
      `files-to-copy: the list has no pattern that INCLUDES anything (only exclusions or comments), so nothing will be seeded. "!" removes from the lines above it — it does not subtract from the ${DEFAULT_PATTERNS.join(", ")} default.`,
    );
    return { paths: [], complete: true, warnings, prune };
  }

  const maxBufferBytes = noSecondChance ? 256 * 1024 * 1024 : 16 * 1024 * 1024;

  try {
    // The implicit `.env*` DEFAULT stays on `--exclude-standard`: gitignored
    // matches only (see the header). It carries no negation, so the pathspec IS
    // the matcher and no exclude file is needed.
    //
    // Explicit sources take ALL untracked matches, with exact gitignore
    // semantics (so `!` negation works and later lines win).
    // NOTE: deliberately NO `--directory` — it collapses fully-ignored dirs,
    // which (a) emits UNMATCHED ignored dirs like node_modules/ and (b) hides a
    // user-configured file inside a fully-ignored dir (certs/server.pem →
    // "certs/"). Both verified empirically; the flag changes matching semantics
    // and user config must never be compromised.
    const listed =
      src.source === "default"
        ? await lsFilesDetailed(
            repoRoot,
            ["-o", "-i", "--exclude-standard"],
            prune,
            timeoutMs,
            maxBufferBytes,
          )
        : await withExcludeFile(src, (excludeFile) =>
            lsFilesDetailed(
              repoRoot,
              ["-o", "-i", `--exclude-from=${excludeFile}`],
              prune,
              timeoutMs,
              maxBufferBytes,
            ),
          );
    if (listed.opaqueDirectories.length > 0) {
      const examples = listed.opaqueDirectories
        .slice(0, 3)
        .map((p) => `"${p}"`)
        .join(", ");
      warnings.push(
        `files-to-copy: skipped ${listed.opaqueDirectories.length} opaque nested Git ` +
          `worktree/repository director${listed.opaqueDirectories.length === 1 ? "y" : "ies"}` +
          (examples ? ` reported while matching files (${examples})` : ""),
      );
    }
    return { paths: listed.paths, complete: true, warnings, prune };
  } catch (err) {
    warnings.push(
      `files-to-copy: git ls-files failed (will retry in background): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { paths: [], complete: false, warnings, prune };
  }
}

/** Resolve matching untracked files in `repoRoot`. Create passes the main
 * checkout and copies the result into a new worktree; archive passes the live
 * worktree itself so workspace-only ignored matches are checkpointed too.
 * Never throws — every failure degrades to a warning + a partial/empty list
 * (with `complete: false`) so the caller can choose to defer or fail closed. */
export async function resolveFilesToCopy(
  repoRoot: string,
  opts: ResolveFilesToCopyOptions = {},
): Promise<FilesToCopyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const src = resolvePatternSource(
    opts.patternRoot ?? repoRoot,
    opts.mainRepoRoot,
  );
  const warnings = [...src.warnings];
  const { source } = src;

  const enumerated = await enumerateMatches(
    repoRoot,
    src,
    timeoutMs,
    opts.noSecondChance === true,
  );
  warnings.push(...enumerated.warnings);
  if (!enumerated.complete)
    return { paths: [], deferredPaths: [], source, warnings, complete: false };

  const all = enumerated.paths;
  let paths = all;
  let deferredPaths: string[] = [];
  if (all.length > MAX_SEED_FILES) {
    warnings.push(
      `files-to-copy: ${all.length} files matched (sync cap ${MAX_SEED_FILES}); seeding the first ${MAX_SEED_FILES} now and the rest in the background. Narrow the patterns.`,
    );
    paths = all.slice(0, MAX_SEED_FILES);
    deferredPaths = all.slice(MAX_SEED_FILES);
  }
  return { paths, deferredPaths, source, warnings, complete: true };
}

// ── preview (settings UI) ────────────────────────────────

/** One row the settings pane can offer as a tick-box: something git ignores in
 *  this checkout, whether or not the current patterns select it.
 *
 *  Enumerated with `--directory`, which collapses a fully-ignored directory to
 *  a single entry. That is the OPPOSITE of what seeding wants (see the
 *  `--directory` note in enumerateMatches) and exactly what a picker wants:
 *  `node_modules/` as one row a human can read, not 60,000. It is also what
 *  makes the scan affordable — git stops descending at the first ignored
 *  directory (measured: 10 rows / 8 ms on a tree with 60k ignored files). */
export interface FilesToCopyCandidate {
  /** Repo-relative path, with any trailing slash normalized away. */
  path: string;
  /** True when this row stands for a whole ignored directory. */
  isDir: boolean;
  /** Size in bytes; `-1` for a directory — summing one would cost the very
   *  walk `--directory` just saved. The UI renders those as a folder. */
  bytes: number;
}

export interface FilesToCopyPreviewFile {
  /** Repo-relative path, as git reports it. */
  path: string;
  /** Size on disk in bytes; -1 when the file vanished between scan and stat. */
  bytes: number;
  /** False → untracked but NOT gitignored. It will still be copied (the user
   *  named it), but it lands in the new workspace's Changes tab where an agent
   *  could commit it. The row that has to be flagged. */
  ignored: boolean;
}

export interface FilesToCopyPatternStat extends FilesToCopyPattern {
  /** How many untracked files this line matches on its own. `0` on a positive
   *  line is the typo signal. On a negation it's how many of the positive
   *  matches it removes. `null` when attribution was skipped (see
   *  MAX_ATTRIBUTED_PATTERNS) or the scan failed. */
  matchCount: number | null;
}

export interface FilesToCopyPreview {
  source: FilesToCopySource;
  /** Settings layer `file_include_globs` came from (`repo-local` / `user` / …),
   *  when that's the source. */
  sourceLayer?: string;
  /** Absolute path of the `.worktreeinclude` in play, when that's the source. */
  sourcePath?: string;
  /** Its raw text, so the UI can show it read-only rather than an empty box. */
  sourceText?: string;
  /** The folder files are copied FROM — what "N files will be copied from …"
   *  names. */
  rootPath: string;
  patterns: FilesToCopyPatternStat[];
  /** Files that WILL be copied, capped at MAX_PREVIEW_FILES. */
  files: FilesToCopyPreviewFile[];
  /** Total matched count before the display cap. */
  totalCount: number;
  /** Bytes across the files in `files`. A LOWER BOUND once `truncated` — we
   *  don't stat matches we aren't showing. */
  totalBytes: number;
  /** True when `files` was cut to MAX_PREVIEW_FILES. */
  truncated: boolean;
  /** Paths that match the patterns but are TRACKED — `git worktree add`
   *  already puts them in the workspace, so copying them is a no-op. Shown
   *  disabled rather than hidden: hiding makes the pattern look broken. */
  trackedMatches: string[];
  /** Every ignored thing in the checkout, directory-collapsed — the tick-box
   *  universe. Independent of the current patterns: without it the pane could
   *  only ever show you what you already selected, so nothing new would be
   *  discoverable. Empty when the scan failed. */
  candidates: FilesToCopyCandidate[];
  warnings: string[];
  /** False when enumeration was cut short — the UI must say "couldn't check",
   *  never "0 files". Zero and unknown are different answers. */
  complete: boolean;
}

/** Which of `paths` git actually ignores. `check-ignore` exits 1 when none do,
 *  which `runFile` raises as an error — that is a valid answer, not a failure. */
async function partitionIgnored(
  repoRoot: string,
  paths: string[],
  timeoutMs: number,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  try {
    const { stdout } = await runFile(
      "git",
      ["-C", repoRoot, "check-ignore", "-z", "--stdin"],
      {
        input: paths.join("\0"),
        maxBufferBytes: 16 * 1024 * 1024,
        timeoutMs,
      },
    );
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const stdout = (err as { stdout?: unknown }).stdout;
    // Exit 1 = "no path is ignored" (empty stdout). Anything else = unknown,
    // and an unknown ignore-status must not be reported as "not ignored" —
    // that would paint every row with a scary warning pill. Treat as ignored.
    if (code === 1)
      return new Set(
        typeof stdout === "string" ? stdout.split("\0").filter(Boolean) : [],
      );
    return new Set(paths);
  }
}

/** Per-line match counts, one `git ls-files` per pattern, run concurrently.
 *  Preview-only — the create path never pays for this. */
async function attributePatterns(
  repoRoot: string,
  src: PatternSourceResult,
  matched: Set<string>,
  /** What is LEFT of the preview's whole-call budget, re-read per subprocess —
   *  a fixed per-call timeout would let N patterns cost N × the budget. */
  timeLeft: () => number,
): Promise<FilesToCopyPatternStat[]> {
  if (src.patterns.length > MAX_ATTRIBUTED_PATTERNS)
    return src.patterns.map((p) => ({ ...p, matchCount: null }));
  const hasNegation = src.patterns.some((p) => p.negate);
  return withTempDir(async (dir) => {
    // Count with the SAME listing mode enumerateMatches used for this source.
    // The implicit `.env*` default seeds gitignored files ONLY, and its
    // pathspec is its matcher — so it counts via `--exclude-standard` and no
    // exclude file. Passing both would UNION the two exclude sources and print
    // "2 matches" beside a one-row file list, in the most common configuration
    // there is, on the row whose whole job is to explain why a file was or
    // wasn't copied.
    const countMatches = async (
      prune: string[] | null,
      writeExcludeFile: () => Promise<string>,
    ): Promise<string[]> =>
      src.source === "default"
        ? lsFiles(
            repoRoot,
            ["-o", "-i", "--exclude-standard"],
            prune,
            timeLeft(),
          )
        : lsFiles(
            repoRoot,
            ["-o", "-i", `--exclude-from=${await writeExcludeFile()}`],
            prune,
            timeLeft(),
          );

    // What the POSITIVE lines alone select, so a negation can be scored
    // against the set it actually operates on. One extra scan, and only when
    // the list has a negation at all.
    const positiveLines = src.patterns.filter((p) => !p.negate);
    const positives = new Set<string>(
      hasNegation && positiveLines.length > 0
        ? await countMatches(prunePathspecs(positiveLines), async () => {
            const file = path.join(dir, "positives");
            await writeFile(
              file,
              positiveLines.map((p) => p.raw).join("\n") + "\n",
            );
            return file;
          }).catch(() => [])
        : [],
    );
    const out: FilesToCopyPatternStat[] = new Array(src.patterns.length);
    // A fixed worker pool, NOT Promise.all over the list: 200 patterns would
    // otherwise fork 200 concurrent `git ls-files` processes at once.
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < src.patterns.length; i = next++) {
        const p = src.patterns[i];
        const prune = toPathspecs(p.pattern);
        // An empty prune means this line can't match anything (a comment, a
        // `..` escape). Answer 0 without forking git — and without handing
        // lsFiles a `[]` that would silently scan the whole tree.
        if (prune !== null && prune.length === 0) {
          out[i] = { ...p, matchCount: 0 };
          continue;
        }
        try {
          // Always the POSITIVE form of the glob; `negate` decides what the
          // resulting hit list MEANS.
          const hits = await countMatches(prune, async () => {
            const file = path.join(dir, `p${i}`);
            await writeFile(file, `${p.pattern}\n`);
            return file;
          });
          // For a negation, the honest number is how many files it actually
          // TOOK OUT: hits that some positive line had selected and that the
          // final set no longer contains. Counting every hit missing from the
          // final set instead credits it with files no positive ever selected
          // — a defensive `!*.pem` in a repo with 40 stray .pem files reported
          // "removes 40" while removing nothing.
          out[i] = {
            ...p,
            matchCount: p.negate
              ? hits.filter((h) => positives.has(h) && !matched.has(h)).length
              : hits.length,
          };
        } catch {
          out[i] = { ...p, matchCount: null };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ATTRIBUTION_CONCURRENCY, src.patterns.length) },
        worker,
      ),
    );
    return out;
  });
}

export interface PreviewFilesToCopyOptions extends ResolveFilesToCopyOptions {
  /** Patterns to preview INSTEAD of the resolved ones — the settings pane
   *  previews the draft in the textarea before the user saves it. Ignored when
   *  a `.worktreeinclude` is present: that file wins, and previewing something
   *  the create path won't use would be a lie. */
  patterns?: string[];
}

/** WHOLE-CALL budget for a preview, not a per-subprocess one. The preview
 *  fans out — enumerate, ignore-check, tracked-check, one `ls-files` per
 *  pattern — and handing each of those the same `timeoutMs` would let the sum
 *  run for minutes past the renderer's request budget while the engine keeps
 *  forking git. Every subprocess gets what is LEFT of this instead. */
const PREVIEW_BUDGET_MS = 15_000;
/** Concurrent `lstat`s when sizing preview rows. Sequential awaits over 2,000
 *  files is a visible stall on a network mount. */
const STAT_CONCURRENCY = 32;

interface CandidateScan {
  rows: FilesToCopyCandidate[];
  /** Entries git reported beyond MAX_CANDIDATES. `0` when nothing was cut. */
  dropped: number;
  /** False when git failed — distinct from "this checkout ignores nothing",
   *  which is what an empty list used to be indistinguishable from. */
  ok: boolean;
}

/** Every ignored entry in the checkout, directories collapsed to one row each.
 *  Never throws — a failed scan just means the pane offers no tick-boxes and
 *  falls back to the pattern editor, but it says so (`ok: false`) rather than
 *  letting the pane report "this project has no ignored files". */
async function listCandidates(
  repoRoot: string,
  timeoutMs: number,
): Promise<CandidateScan> {
  let raw: string;
  try {
    // Not via lsFiles(): that strips the trailing slash which is the ONLY
    // signal distinguishing a collapsed directory from a file of the same name.
    const { stdout } = await runFile(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "-o",
        "-i",
        "--exclude-standard",
        "--directory",
        // An ignored-but-empty directory is not a thing anyone wants to copy.
        "--no-empty-directory",
        "-z",
      ],
      { maxBufferBytes: 16 * 1024 * 1024, timeoutMs },
    );
    raw = stdout;
  } catch {
    return { rows: [], dropped: 0, ok: false };
  }
  const all = raw.split("\0").filter(Boolean);
  const rows = all
    .slice(0, MAX_CANDIDATES)
    .map((p) => ({ path: p.replace(/\/+$/, ""), isDir: p.endsWith("/") }));
  const sizes = await statSizes(
    repoRoot,
    rows.map((r) => r.path),
  );
  return {
    rows: rows.map((r, i) => ({ ...r, bytes: r.isDir ? -1 : sizes[i] })),
    dropped: all.length - rows.length,
    ok: true,
  };
}

/** Size `rels` (repo-relative) with bounded concurrency. `-1` for a file that
 *  vanished between the scan and the stat — the copy is best-effort anyway. */
async function statSizes(repoRoot: string, rels: string[]): Promise<number[]> {
  const sizes: number[] = new Array(rels.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < rels.length; i = next++) {
      try {
        sizes[i] = (await lstat(path.join(repoRoot, rels[i]))).size;
      } catch {
        sizes[i] = -1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, rels.length) }, worker),
  );
  return sizes;
}

/** Everything the "Files to copy" settings pane renders, in one call: where
 *  the patterns came from, what they resolve to on disk right now, which rows
 *  need a warning, and how big the whole thing is. Never throws. */
export async function previewFilesToCopy(
  repoRoot: string,
  opts: PreviewFilesToCopyOptions = {},
): Promise<FilesToCopyPreview> {
  // One budget for the WHOLE call, spent down across the fan-out below, so a
  // pathological repo can't turn one click into minutes of forked git.
  const deadline = Date.now() + (opts.timeoutMs || PREVIEW_BUDGET_MS);
  // `1` rather than `0`: a spent budget must mean "give up", and `0` means
  // "unbounded" to runFile.
  const left = (): number => Math.max(1, deadline - Date.now());
  // The draft goes through resolvePatternSource itself rather than being
  // assembled here, so the preview and the create path can only ever disagree
  // if that one function does — including on the cases that used to diverge
  // (an empty or comment-only draft, and an entry with leading whitespace).
  const src = resolvePatternSource(repoRoot, opts.mainRepoRoot, opts.patterns);

  // Provenance only — everything downstream of the scan is set explicitly at
  // each return, so a new field can't silently keep a placeholder value on the
  // path that matters.
  const head = {
    source: src.source,
    ...(src.layer ? { sourceLayer: src.layer } : {}),
    ...(src.filePath ? { sourcePath: src.filePath } : {}),
    ...(src.text !== undefined ? { sourceText: src.text } : {}),
    rootPath: repoRoot,
  };
  const warnings = [...src.warnings];

  // `noSecondChance`: the preview is the surface a user opens to DIAGNOSE a
  // repo whose seeding is misbehaving, so it must not be the one call that
  // blows a stdout ceiling and reports "couldn't check" on exactly the
  // oversized repo it was opened to explain.
  // Candidates are independent of the patterns, so they run alongside the match
  // scan rather than after it — and they still populate the tick-boxes when the
  // match scan fails, which is what keeps the "couldn't check" state useful.
  const [enumerated, candidateScan] = await Promise.all([
    enumerateMatches(repoRoot, src, left(), true),
    listCandidates(repoRoot, left()),
  ]);
  warnings.push(...enumerated.warnings);
  // A cut-short candidate scan is a different statement from "this project
  // ignores nothing", and the pane renders the latter as "Nothing needs
  // copying — new workspaces will already be complete". Say it out loud.
  if (!candidateScan.ok) {
    warnings.push(
      `files-to-copy: couldn't list this project's ignored files, so the checklist below may be incomplete.`,
    );
  }
  if (!enumerated.complete) {
    if (candidateScan.dropped > 0)
      warnings.push(candidateCap(candidateScan.dropped));
    return {
      ...head,
      patterns: src.patterns.map((p) => ({ ...p, matchCount: null })),
      files: [],
      totalCount: 0,
      totalBytes: 0,
      truncated: false,
      trackedMatches: [],
      candidates: candidateScan.rows,
      warnings,
      complete: false,
    };
  }

  const matched = enumerated.paths;
  const matchedSet = new Set(matched);
  const { prune } = enumerated;

  // Only the rows we will actually return get sized and ignore-checked. A `*`
  // pattern can match every file under node_modules; doing that work for a
  // list that is truncated anyway would turn a preview into a long stall.
  // `totalBytes` is therefore a LOWER BOUND once truncated — which `truncated`
  // says out loud, and which is enough for a "this is too big" warning.
  const shown = matched.slice(0, MAX_PREVIEW_FILES);
  const truncated = matched.length > shown.length;

  const [ignored, tracked, patterns, sizes] = await Promise.all([
    partitionIgnored(repoRoot, shown, left()),
    // Tracked files matching the same patterns: `-c -i --exclude-from` is
    // documented as "when showing files in the index, print only those matched
    // by an exclude pattern". An empty prune came back from a pattern set that
    // can't match anything, so there is nothing to ask git about.
    prune?.length === 0
      ? Promise.resolve<string[]>([])
      : withExcludeFile(src, (excludeFile) =>
          lsFiles(
            repoRoot,
            ["-c", "-i", `--exclude-from=${excludeFile}`],
            prune,
            left(),
          ),
        ).catch(() => [] as string[]),
    // Per-line counts are a nicety; the source, the file list and the warnings
    // are the answer. A full ENOSPC/EMFILE temp-dir failure must degrade to
    // `matchCount: null` — which the type already models — not reject the
    // whole preview. (`previewFilesToCopy` is documented as never throwing and
    // the service handler has no catch.)
    attributePatterns(repoRoot, src, matchedSet, left).catch(() =>
      src.patterns.map((p) => ({ ...p, matchCount: null })),
    ),
    statSizes(repoRoot, shown),
  ]);

  const files: FilesToCopyPreviewFile[] = shown.map((rel, i) => ({
    path: rel,
    bytes: sizes[i],
    ignored: ignored.has(rel),
  }));
  const totalBytes = sizes.reduce((sum, b) => sum + Math.max(0, b), 0);
  if (truncated) {
    warnings.push(
      `files-to-copy: ${matched.length} files match; showing the first ${shown.length}. Sizes below are for those only.`,
    );
  }

  const notIgnored = files.filter((f) => !f.ignored).length;
  if (notIgnored > 0) {
    warnings.push(
      `files-to-copy: ${notIgnored} matched file(s) are not gitignored — they will be copied, but they show up as untracked changes in the new workspace.`,
    );
  }
  // `truncated` counts as large on its own. Otherwise the one advisory meant
  // to catch "you selected a dependency tree" is silenced by exactly the case
  // it exists for: past the display cap, totalBytes only covers the first
  // MAX_PREVIEW_FILES rows and can sit under the threshold while the real set
  // is gigabytes.
  if (truncated || totalBytes > LARGE_SEED_BYTES) {
    warnings.push(
      `files-to-copy: ${matched.length} files / ${truncated ? "over " : ""}${Math.round(totalBytes / (1024 * 1024))} MB match — every new workspace pays this copy. Dependency trees and build output are usually better rebuilt by the setup command.`,
    );
  }

  const allCandidates = withMatchedNonIgnored(candidateScan.rows, files);
  const candidates = allCandidates.slice(0, MAX_CANDIDATES);
  // Both ways a row can fall off the list — git returned more than the cap, or
  // the merge above pushed it over — reported as one number, so the count the
  // user sees is the count that is actually missing.
  const droppedCandidates =
    candidateScan.dropped + (allCandidates.length - candidates.length);
  if (droppedCandidates > 0) warnings.push(candidateCap(droppedCandidates));

  return {
    ...head,
    patterns,
    files,
    totalCount: matched.length,
    totalBytes,
    truncated,
    trackedMatches: tracked,
    candidates,
    warnings,
    complete: true,
  };
}

/** The candidate cap used to be applied with no flag, no count and no warning,
 *  so rows simply vanished from the tick-box universe while the pane's
 *  per-group "N items" counts read as complete. */
function candidateCap(dropped: number): string {
  return `files-to-copy: showing the first ${MAX_CANDIDATES} ignored entries of ${MAX_CANDIDATES + dropped}; the rest aren't listed. Use the pattern editor to name anything missing.`;
}

/** The tick-box universe, plus any matched file git is NOT ignoring.
 *
 *  `listCandidates` runs `ls-files -o -i --exclude-standard`, so everything it
 *  returns is by definition gitignored — which left the one row the design
 *  most wants to flag with nowhere to appear. An explicit pattern naming an
 *  untracked-but-not-ignored `config.local.json` produced `files: [that]` and
 *  `candidates: []`, so the pane rendered "Nothing needs copying" directly
 *  above "1 file will be copied", and the "Git isn't ignoring this" badge was
 *  unreachable. These rows ARE copied, so they belong in the list. */
function withMatchedNonIgnored(
  candidates: FilesToCopyCandidate[],
  files: FilesToCopyPreviewFile[],
): FilesToCopyCandidate[] {
  const seen = new Set(candidates.map((c) => c.path));
  const extra = files.flatMap((f) =>
    f.ignored || seen.has(f.path)
      ? []
      : [{ path: f.path, isDir: false, bytes: f.bytes }],
  );
  if (extra.length === 0) return candidates;
  // Sorted together so the list doesn't reshuffle as rows move between ignored
  // and not. The caller applies the cap, so the two ways a row can fall off
  // are counted in one place.
  return [...candidates, ...extra].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
