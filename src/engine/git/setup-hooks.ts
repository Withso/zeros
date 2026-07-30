// Post-create hooks for a new worktree. Pattern adopted from raine/workmux's
// `post_create` hook (see roadmap 03a fabric research).
//
// File provisioning runs after `git worktree add` returns but before the
// caller's promise resolves:
//
//   1. `copyPaths`        — copy untracked files/dirs from the repo root
//                           into the new worktree (e.g. .env, .env.local).
//   2. `symlinkPaths`     — symlink instead of copy (e.g. node_modules so
//                           the dev cache is shared with the root).
//
// The setup SCRIPT/COMMAND no longer runs here — it's resolved by
// `resolveSetupCommand` and run in the background by SetupManager (a
// worktree-scoped PTY surfaced in the Setup tab), so a slow `pnpm install`
// can't block — or time out — workspace creation.

import {
  copyFile,
  mkdir,
  stat,
  symlink,
  lstat,
  readdir,
  readlink,
} from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { GitError } from "./errors";
import { runFile } from "./git-exec";
// Reuse the engine's cached login-shell PATH resolver so an inline command
// like `pnpm install` finds the user's tools (the Electron-spawned engine's
// own PATH is often minimal). path-resolver has no engine imports → no cycle.
import { getLoginShellPath } from "../agents/adapters/shared/login-shell-path";

export interface SetupHookOptions {
  workspaceId: string;
  worktreePath: string;
  repoRoot: string;
  baseBranch: string;
  copyPaths?: string[];
  symlinkPaths?: string[];
  /** Files-to-copy: gitignored files auto-resolved from the
   *  repo's include patterns (.worktreeinclude / `file_include_globs` / `.env*`),
   *  seeded from the main checkout into the worktree. BEST-EFFORT — a missing or
   *  failed seed warns and is skipped (unlike `copyPaths`, which is explicitly
   *  caller-requested and fatal). */
  seedPaths?: string[];
}

/** Run post-create FILE provisioning for a freshly created worktree: copy /
 *  symlink the caller's explicitly-requested paths, then best-effort
 *  files-to-copy seeds. Copy / symlink errors throw VALIDATION_FAILED if the
 *  source doesn't exist (the caller explicitly asked for it); a missing seed
 *  warns and is skipped. The setup SCRIPT/COMMAND no longer runs here — it's
 *  spawned in the background by SetupManager (see resolveSetupCommand). */
export async function runSetupHooks(opts: SetupHookOptions): Promise<void> {
  // 1 & 2: file/dir provisioning. Run in order — symlinks after copies
  // so a caller can both copy `.env` and symlink `node_modules` without
  // race conditions.
  for (const rel of opts.copyPaths ?? []) {
    await copyFromRepo(opts.repoRoot, opts.worktreePath, rel);
  }
  // Files-to-copy seeds: BEST-EFFORT. These are auto-resolved (not explicitly
  // requested), so a missing or racey seed file must warn-and-skip, never fail
  // the whole worktree creation the way an explicit copyPaths entry does.
  for (const rel of opts.seedPaths ?? []) {
    try {
      // NEVER clobber what the checkout already produced. A path can be
      // gitignored in the main checkout and COMMITTED on the base branch (an
      // `.env` someone checked in, a `config.json` a branch added); `git
      // worktree add` materialises the branch's version, and overwriting it
      // with the main checkout's copy both loses the branch's content and
      // opens the workspace with a spurious modification an agent can commit.
      // The from-branch (worktree.ts seedWorktreeFiles) and late-seed passes
      // already skip these; this loop used to be the one that didn't.
      if (pathExists(path.join(opts.worktreePath, rel))) continue;
      await copyFromRepo(opts.repoRoot, opts.worktreePath, rel);
    } catch (err) {
      console.warn(
        `[setup-hooks] files-to-copy: skipped "${rel}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const rel of opts.symlinkPaths ?? []) {
    await symlinkFromRepo(opts.repoRoot, opts.worktreePath, rel);
  }
}

interface RunInlineScriptArgs {
  kind: "setup" | "archive";
  command: string;
  workspaceId: string;
  worktreePath: string;
  repoRoot: string;
  baseBranch: string;
}

/** Run an inline shell command (from the repo's resolved TOML scripts) in the
 *  worktree via `sh -c`, with the SAME scrubbed env as a setup script (H6: no
 *  provider keys / GitHub token) plus the user's login-shell PATH so common
 *  tools resolve. Throws GitError(SETUP_SCRIPT_FAILED) on a non-zero exit; the
 *  caller decides whether that is fatal (setup) or swallowed (archive). */
export async function runInlineScript(
  args: RunInlineScriptArgs,
): Promise<void> {
  const command = args.command.trim();
  if (!command) return;
  const env = buildSetupEnv({
    ZEROS_WORKSPACE_ID: args.workspaceId,
    ZEROS_WORKTREE_PATH: args.worktreePath,
    ZEROS_REPO_ROOT: args.repoRoot,
    ZEROS_BASE_BRANCH: args.baseBranch,
  });
  try {
    const loginPath = await getLoginShellPath();
    if (loginPath) env.PATH = loginPath;
  } catch {
    /* keep the allowlisted PATH */
  }
  // POSIX shell on macOS/Linux; cmd.exe on Windows (where `/bin/sh` is absent,
  // which would otherwise make setup fatally fail / archive silently no-op).
  const [shell, flag] =
    process.platform === "win32" ? ["cmd.exe", "/c"] : ["/bin/sh", "-c"];
  try {
    await runFile(shell, [flag, command], {
      cwd: args.worktreePath,
      env,
      // 256 MB: a chatty `pnpm install` / `cargo build` easily exceeds 16 MB of
      // combined stdout+stderr, which would otherwise reject setup and roll the
      // whole workspace back.
      maxBufferBytes: 256 * 1024 * 1024,
      // Archive hooks are optional, non-load-bearing cleanup. Letting one hold
      // a lifecycle open for five minutes makes a workspace appear stuck even
      // though its durable pre-hook checkpoint is already safe. Setup retains
      // the longer budget for backwards compatibility.
      timeoutMs: args.kind === "archive" ? 30 * 1000 : 5 * 60 * 1000,
    });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    throw new GitError({
      code: "SETUP_SCRIPT_FAILED",
      message: `${args.kind === "setup" ? "Setup" : "Archive"} script failed: ${command}`,
      cause: err,
      context: { stderr: stderr.slice(0, 4000) },
      remediation:
        "Check the script's exit code and stderr. You can re-run the command manually inside the worktree.",
    });
  }
}

/** Allowlist of environment variables a setup script may see. H6: the engine's
 *  full env carries provider API keys, the GitHub OAuth token, AWS/SSH creds,
 *  etc. A repo-resident script must not be able to read those, so we pass only
 *  these locale/shell basics plus the ZEROS_* context vars added by the caller. */
const SETUP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
];

function buildSetupEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SETUP_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  return { ...env, ...extra };
}

/** POSIX single-quote a path/string so it survives `sh -c "<cmd>"`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The env for the BACKGROUND setup PTY. Same scrubbed allowlist + ZEROS_*
 *  context as the (former) synchronous setup script — so a repo-resident setup
 *  command still can't read the engine's provider keys / GitHub token (H6) —
 *  plus a real-terminal TERM/COLORTERM so tool output is colored in the Setup
 *  tab, and the user's login-shell PATH so `pnpm`/`cargo`/etc. resolve. */
export async function buildSetupCommandEnv(ctx: {
  workspaceId: string;
  worktreePath: string;
  repoRoot: string;
  baseBranch: string;
}): Promise<Record<string, string>> {
  const env = buildSetupEnv({
    ZEROS_WORKSPACE_ID: ctx.workspaceId,
    ZEROS_WORKTREE_PATH: ctx.worktreePath,
    ZEROS_REPO_ROOT: ctx.repoRoot,
    ZEROS_BASE_BRANCH: ctx.baseBranch,
  });
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // Many tools (npm, eslint, jest, …) also honor FORCE_COLOR independently of
  // isatty — set it so the Setup tab shows the same colors a real terminal does.
  env.FORCE_COLOR = "1";
  try {
    const loginPath = await getLoginShellPath();
    if (loginPath) env.PATH = loginPath;
  } catch {
    /* keep the allowlisted PATH */
  }
  return env;
}

/** Resolve the single shell command to run as background setup for a new
 *  worktree, or null when the repo has nothing to run. Precedence mirrors the
 *  old synchronous runSetupHooks order:
 *    1. an explicit caller `setupScript` file (relative to repo root),
 *    2. the repo's inline `scripts.setup` (resolved TOML),
 *    3. a repo-resident `.zeros/setup.sh` — ONLY when the caller permits auto
 *       (local create) AND the user opted in via ZEROS_AUTORUN_SETUP_SH=1 (H6).
 *  Unlike the old path, a missing/failing command is NOT fatal — it surfaces in
 *  the Setup tab as setup_state="failed" and the user can Rerun. */
export async function resolveSetupCommand(opts: {
  repoRoot: string;
  setupScript?: string;
  inlineCommand?: string;
  allowAutoSetup?: boolean;
}): Promise<string | null> {
  if (opts.setupScript && opts.setupScript.trim()) {
    return shellQuote(path.join(opts.repoRoot, opts.setupScript));
  }
  if (opts.inlineCommand && opts.inlineCommand.trim()) {
    return opts.inlineCommand.trim();
  }
  if (opts.allowAutoSetup && process.env.ZEROS_AUTORUN_SETUP_SH === "1") {
    const auto = await defaultSetupScript(opts.repoRoot);
    if (auto) return shellQuote(path.join(opts.repoRoot, auto));
  }
  return null;
}

/** Does anything at all occupy `p`? `lstat`, NOT `existsSync`: existsSync
 *  FOLLOWS symlinks, so a DANGLING one reads as "nothing here" — and then a
 *  copy through it writes to wherever the link points, which for a link the
 *  base branch committed is an attacker-chosen absolute path outside the
 *  worktree. A symlink of any kind counts as already present.
 *
 *  This is only the cheap "already there, skip it" pre-check: `lstat` still
 *  FOLLOWS the parent components, so a symlinked ANCESTOR (`certs` → /outside)
 *  reads as absent here. `assertContainedDestination` is the real guard, and
 *  it runs inside every write. */
export function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Refuse to write anywhere the filesystem would redirect outside the
 *  worktree. `resolveContainedPaths` is LEXICAL — it constrains the path we
 *  compute, never where a symlink then sends it — so every component from
 *  `worktreePath` down to `dst` has to be a real directory/file.
 *
 *  Checking the final component alone is not enough: `mkdir(dirname(dst))`
 *  happily traverses a symlinked ancestor, and `lstat(dst)` resolves through
 *  it too, so `certs → /outside` committed on the base branch made
 *  `certs/server.pem` a write to `/outside/server.pem` with the MAIN
 *  checkout's contents — reachable from plain files-to-copy seeding, not just
 *  an explicit copyPaths entry. */
async function assertContainedDestination(
  worktreePath: string,
  dst: string,
): Promise<void> {
  const wtAbs = path.resolve(worktreePath);
  const rel = path.relative(wtAbs, path.resolve(dst));
  let cur = wtAbs;
  for (const segment of rel.split(path.sep)) {
    if (!segment) continue;
    cur = path.join(cur, segment);
    // Nothing at this component yet, so nothing below it either — the rest of
    // the path will be created by us, as real directories.
    if (!(await assertRealPathComponent(wtAbs, cur))) return;
  }
}

/** One component of the check above. Returns false when nothing is there yet
 *  (so the caller can stop walking), throws when a symlink is. Split out so
 *  copyDirRecursive can check just the entry it is about to write: `dst`'s own
 *  chain was proved by its caller, and re-walking it per entry would cost a
 *  depth-times-file-count pile of lstats on a `node_modules` copy. */
async function assertRealPathComponent(
  wtAbs: string,
  p: string,
): Promise<boolean> {
  const st = await lstat(p).catch(() => null);
  if (!st) return false;
  if (st.isSymbolicLink()) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `copyPaths: refusing to write through a symlink already at "${path.relative(wtAbs, p)}" in the worktree`,
    });
  }
  return true;
}

/** True for a caller-supplied relative path that would resolve outside its
 *  base — absolute, or climbing out with a `..` SEGMENT. A cheap pre-check for
 *  the copyPaths/symlinkPaths validator; the containment assertions in
 *  resolveContainedPaths are the lexical guard, and
 *  assertContainedDestination is the filesystem one. */
function escapesBase(p: string): boolean {
  return path.isAbsolute(p) || p.split(/[/\\]/).includes("..");
}

/** Validate a copy/symlink `rel` and return the contained absolute src/dst.
 *  Rejects absolute paths and `..` traversal so a caller-supplied entry can't
 *  read outside the repo root or write outside the worktree. */
function resolveContainedPaths(
  repoRoot: string,
  worktreePath: string,
  rel: string,
  label: string,
): { src: string; dst: string } {
  // Same predicate the symlink guard uses, so "escapes its base" has exactly
  // one definition in this module: absolute, or a `..` path SEGMENT.
  // Segment, not substring — `.env..bak` and `config..json` are ordinary
  // filenames, and rejecting them made an explicit copyPaths entry fatal,
  // rolling back the whole workspace create. The containment assertions below
  // are the real guard; this is the cheap pre-check.
  if (typeof rel !== "string" || rel.length === 0 || escapesBase(rel)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label}: "${rel}" must be a relative path within the repo (no "..", no absolute)`,
    });
  }
  const repoAbs = path.resolve(repoRoot);
  const wtAbs = path.resolve(worktreePath);
  const src = path.resolve(repoAbs, rel);
  const dst = path.resolve(wtAbs, rel);
  if (src !== repoAbs && !src.startsWith(repoAbs + path.sep)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label}: source escapes repo root`,
    });
  }
  if (dst !== wtAbs && !dst.startsWith(wtAbs + path.sep)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label}: destination escapes worktree`,
    });
  }
  return { src, dst };
}

async function defaultSetupScript(repoRoot: string): Promise<string | null> {
  const candidate = path.join(repoRoot, ".zeros", "setup.sh");
  try {
    await stat(candidate);
    return path.relative(repoRoot, candidate);
  } catch {
    return null;
  }
}

/** Copy a single file or recursively copy a directory. We don't use
 *  `fs.cp` because it's only stable from Node 20.1; better-sqlite3 makes
 *  us pin to Node 20+ anyway, but being explicit avoids surprise.
 *  Exported for the late seed pass (worktree.ts) — the background completion
 *  of a seed scan that was cut short at create time. */
export async function copyFromRepo(
  repoRoot: string,
  worktreePath: string,
  rel: string,
): Promise<void> {
  const { src, dst } = resolveContainedPaths(
    repoRoot,
    worktreePath,
    rel,
    "copyPaths",
  );
  let st;
  try {
    st = await lstat(src);
  } catch (err) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `copyPaths: source "${rel}" does not exist in repo root`,
      cause: err,
    });
  }
  // BEFORE the mkdir, not after: `copyFile` opens with O_CREAT|O_TRUNC and
  // follows a link at the destination, and `mkdir -p` follows one at any
  // parent — so a link the base branch committed (`.env.local →
  // ~/.ssh/authorized_keys`, or `certs → /outside`) would turn a seed into an
  // arbitrary-path overwrite with the main checkout's contents.
  await assertContainedDestination(worktreePath, dst);
  await mkdir(path.dirname(dst), { recursive: true });
  if (st.isDirectory()) {
    await copyDirRecursive(src, dst, worktreePath);
  } else if (st.isSymbolicLink()) {
    await recreateSymlink(src, dst, worktreePath, rel);
  } else {
    await copyFile(src, dst);
  }
}

/** Re-create a symlink at `dst` pointing at the same target — but never one
 *  that resolves outside `worktreePath`. Used for BOTH a top-level symlink and
 *  every link found while copying a directory: the guard used to live only on
 *  the top-level branch, so `copyPaths: ["bundle"]` re-created
 *  `bundle/link → /etc/…` unchecked.
 *
 *  Throwing is right for the path the caller NAMED; for a link that merely
 *  happens to sit inside a copied tree, copyDirRecursive catches and skips
 *  (see there — an absolute target like `/usr/bin/python3` is ordinary).
 *
 *  The test is where the link RESOLVES, not whether its text contains `..`.
 *  A relative target is relative to the link's own directory, so
 *  `node_modules/.bin/tsc → ../typescript/bin/tsc` is entirely inside the
 *  copied tree — a string check on `..` rejects it and, since copyPaths is
 *  fatal, would fail the whole workspace create for anyone copying a
 *  dependency directory.
 *
 *  `path.dirname(dst)` is only safe to resolve against because
 *  assertContainedDestination has already proved no component of it is a
 *  symlink; without that this check would be defeated by the same trick. */
async function recreateSymlink(
  src: string,
  dst: string,
  worktreePath: string,
  label: string,
): Promise<void> {
  const target = await readlink(src);
  const resolved = path.resolve(path.dirname(dst), target);
  const wtAbs = path.resolve(worktreePath);
  if (resolved !== wtAbs && !resolved.startsWith(wtAbs + path.sep)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `copyPaths: refusing to re-create an escaping symlink "${label}" → "${target}"`,
    });
  }
  await symlink(target, dst);
}

async function copyDirRecursive(
  src: string,
  dst: string,
  worktreePath: string,
): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  const wtAbs = path.resolve(worktreePath);
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    const label = path.relative(wtAbs, d);
    // Same destination rule as the top-level path, per entry: naming the
    // PARENT directory must not be a way around it. `dst`'s own chain was
    // checked by the caller, so only this new final component can be a link —
    // one lstat, not a re-walk.
    await assertRealPathComponent(wtAbs, d);
    if (e.isDirectory()) {
      await copyDirRecursive(s, d, worktreePath);
    } else if (e.isSymbolicLink()) {
      // An escaping link found INSIDE a copied tree is skipped, not fatal.
      // A standard virtualenv ships `.venv/bin/python → /usr/bin/python3` and
      // copyPaths failure rolls back the whole workspace create, so making
      // incidental tree contents fatal broke copying a dependency directory
      // outright. The explicitly named path still throws (copyFromRepo).
      try {
        await recreateSymlink(s, d, worktreePath, label);
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        console.warn(`[setup-hooks] ${err.message}; skipped`);
      }
    } else {
      await copyFile(s, d);
    }
  }
}

async function symlinkFromRepo(
  repoRoot: string,
  worktreePath: string,
  rel: string,
): Promise<void> {
  const { src, dst } = resolveContainedPaths(
    repoRoot,
    worktreePath,
    rel,
    "symlinkPaths",
  );
  try {
    await stat(src);
  } catch (err) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `symlinkPaths: source "${rel}" does not exist in repo root`,
      cause: err,
    });
  }
  // Same rule as copyFromRepo: `mkdir -p` follows a symlinked ancestor, so a
  // link the base branch committed would have us create directories (and the
  // link itself) outside the worktree.
  await assertContainedDestination(worktreePath, dst);
  await mkdir(path.dirname(dst), { recursive: true });
  // Absolute symlink so the worktree can be moved without breaking refs.
  await symlink(src, dst);
}
