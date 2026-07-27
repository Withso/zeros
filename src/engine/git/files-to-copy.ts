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
// file (gitignore syntax) > the repo `file_include_globs` setting > the default
// `.env*`.
//
// The matching is delegated to git itself via `git ls-files -o` variants:
// git answers both "is it tracked" and "does it match" (via `:(glob)`
// pathspecs). No gitignore re-implementation, no glob library.
//
// What counts as seedable depends on where the patterns came from:
//   • EXPLICIT sources (.worktreeinclude / file_include_globs): ALL untracked
//     matches — ignored or not (`-o`). The user named the path; a match that
//     happened to be missing from .gitignore used to be silently skipped
//     (".worktreeinclude is not working" in the field), which is worse than
//     the copy showing up as an untracked file in the new worktree's status.
//   • The implicit `.env*` DEFAULT: gitignored matches only
//     (`-o -i --exclude-standard`). Nobody asked for these by name, and
//     seeding a NOT-ignored `.env.something` would surface it in the
//     worktree's Changes tab where an agent could commit it — for secrets,
//     silently skipping is the safe default.
// ──────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { opSettingsResolve } from "../settings/ops";
import { runFile } from "./git-exec";

const DEFAULT_PATTERNS = [".env*"];
const WORKTREEINCLUDE_FILE = ".worktreeinclude";
/** Safety cap — copying hundreds of files at create is almost always a too-broad
 *  pattern (e.g. `*`); seed the first N and warn rather than stall the create. */
const MAX_SEED_FILES = 500;

export type FilesToCopySource =
  | "worktreeinclude"
  | "file_include_globs"
  | "default";

export interface FilesToCopyResult {
  /** Repo-relative paths of gitignored files matching the patterns. */
  paths: string[];
  /** KNOWN matches beyond MAX_SEED_FILES — not dropped: the caller copies them
   *  in a background pass so a giant match set can't stall workspace creation.
   *  Empty in the normal case. */
  deferredPaths: string[];
  /** Where the patterns came from. */
  source: FilesToCopySource;
  /** Non-fatal notes (unsupported negation line, oversized match set, git error). */
  warnings: string[];
  /** False when enumeration was CUT SHORT (scan timeout or git error): `paths`
   *  may be missing matches the user configured. The caller MUST re-run with
   *  `timeoutMs: 0` in the background and seed the remainder — user-configured
   *  seeding (.worktreeinclude / file_include_globs) is never compromised, only
   *  deferred. */
  complete: boolean;
}

/** Read `.worktreeinclude` into pattern lines: strip `#` comments + blanks.
 *  Negation (`!`) lines are not supported in v1 and are skipped with a warning
 *  (pathspecs can't express them cleanly). */
function readWorktreeInclude(file: string, warnings: string[]): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      warnings.push(
        `.worktreeinclude: negation pattern not supported, ignored: "${line}"`,
      );
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Read `file_include_globs` from the resolved settings (array of strings).
 *  Repo-scoped files stopped carrying this key in the 2026-07-17 slimming, so
 *  it only resolves from the user/team/managed layers now — the per-repo way
 *  to configure seeding is a repo-root `.worktreeinclude` file (which takes
 *  precedence anyway). */
function readFileIncludeGlobs(
  repoRoot: string,
  mainRepoRoot?: string,
): string[] {
  try {
    const v = opSettingsResolve(repoRoot, mainRepoRoot).effective
      .file_include_globs;
    if (Array.isArray(v))
      return v.filter((p): p is string => typeof p === "string" && !!p.trim());
  } catch {
    /* resolve failure → no globs; default applies */
  }
  return [];
}

// Convert one gitignore-style pattern into git `:(glob)` pathspec(s). A pattern
// WITHOUT a slash matches by basename at any depth (so it gets both a root and
// an any-depth `**` form); a pattern WITH a slash is anchored to the repo root.
//
// Directory patterns need extra care (verified empirically): a WILDCARD-FREE
// pathspec like `certs` matches everything under `certs/` via git's
// leading-directory rule, but that rule is OFF once the pathspec contains a
// wildcard — `**/secrets` matches only the entry named `secrets`, never
// `nested/secrets/key.txt`. So gitignore-style dir patterns (`secrets/`)
// silently seeded nothing at depth. We therefore also emit an explicit
// `<p>/**` contents form (`**/<p>/**` matches at any depth INCLUDING the
// root — a leading `**/` matches zero directories). For file patterns the
// extra form matches nothing and is harmless.
// (Line comments, not a block comment — the `**/` examples above would
// terminate a `/* */` block early.)
function toPathspecs(pattern: string): string[] {
  let p = pattern.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return [];
  p = p.replace(/\/+$/, ""); // trailing slash (dir marker) — ls-files lists its files
  const anchored = p.startsWith("/");
  if (anchored) p = p.replace(/^\/+/, "");
  if (!p) return [];
  if (anchored || p.includes("/")) return [`:(glob)${p}`, `:(glob)${p}/**`];
  // No slash → match the basename anywhere (root + nested), plus dir contents.
  return [`:(glob)${p}`, `:(glob)**/${p}`, `:(glob)**/${p}/**`];
}

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
  const warnings: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;

  // 1. Resolve the patterns (precedence: .worktreeinclude > setting > default).
  let patterns: string[];
  let source: FilesToCopySource;
  const wtiPath = path.join(repoRoot, WORKTREEINCLUDE_FILE);
  if (existsSync(wtiPath)) {
    patterns = readWorktreeInclude(wtiPath, warnings);
    source = "worktreeinclude";
  } else {
    const globs = readFileIncludeGlobs(repoRoot, opts.mainRepoRoot);
    if (globs.length > 0) {
      patterns = globs;
      source = "file_include_globs";
    } else {
      patterns = DEFAULT_PATTERNS;
      source = "default";
    }
  }

  const pathspecs = patterns.flatMap(toPathspecs);
  if (pathspecs.length === 0)
    return { paths: [], deferredPaths: [], source, warnings, complete: true };

  // 2. Let git enumerate the untracked files matching the patterns. Explicit
  // sources seed ALL untracked matches; the implicit default seeds gitignored
  // matches only — see the header for the split. NOTE: deliberately NO
  // `--directory` — it collapses fully-ignored dirs, which (a) emits UNMATCHED
  // ignored dirs like node_modules/ and (b) hides a user-configured file
  // inside a fully-ignored dir (certs/server.pem → "certs/"). Both verified
  // empirically; the flag changes matching semantics and user config must
  // never be compromised. Plain enumeration is fast anyway (git prunes by
  // pathspec; ~20ms warm / ~70ms cold at 60k files).
  const ignoredOnly = source === "default";
  let stdout: string;
  try {
    const r = await runFile(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "-o",
        ...(ignoredOnly ? ["-i", "--exclude-standard"] : []),
        "-z",
        "--",
        ...pathspecs,
      ],
      {
        maxBufferBytes: 16 * 1024 * 1024,
        // Bounded on the create reply path: a pathological cold-disk walk once
        // blew the create RPC past the renderer's request budget ("Request
        // timeout: WORKSPACE_REQUEST"). The budget does NOT drop seeds — on
        // timeout we return complete:false and the caller re-runs unbounded in
        // the background, so user-configured seeding always lands.
        timeoutMs,
      },
    );
    stdout = r.stdout;
  } catch (err) {
    warnings.push(
      `files-to-copy: git ls-files failed (will retry in background): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { paths: [], deferredPaths: [], source, warnings, complete: false };
  }

  const all = stdout
    .split("\0")
    .map((p) => p.replace(/\/+$/, "")) // normalize any trailing slash on dir entries
    .filter(Boolean);
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
