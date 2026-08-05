// ──────────────────────────────────────────────────────────
// Design-mode lock — make the codebase read-only, except the design folder
// ──────────────────────────────────────────────────────────
//
// Design mode is a modal state: the agent (and the user) may edit only the
// design folder, while still READING the rest of the repo for context. That
// "read but never write" shape is why sparse-checkout is the wrong tool here —
// it removes files entirely — and why this is enforced with macOS ACLs.
//
// Why the filesystem and not agent config
// ───────────────────────────────────────
// A per-agent permission would have to be re-expressed for Claude, Codex and
// Cursor separately, could never cover the terminal, and would need redoing for
// every agent added later. An ACL sits below all of them: measured on macOS
// 26.3, a `deny write,delete,append,writeattr,writeextattr` ACE blocks a shell
// redirect, `python open(w)`, `sed -i`, `mv` and `rm` alike. One mechanism,
// every agent, no cooperation required.
//
// What gets locked
// ────────────────
// TRACKED files outside the design folder — nothing else. Gitignored paths stay
// writable on purpose: `node_modules/`, `dist*/`, `.vite/` and friends are
// where installs and dev servers write, and locking them would break the
// preview that design work depends on. The rule is "lock what git tracks".
//
// Two behaviours worth knowing before wiring this to UI
// ─────────────────────────────────────────────────────
//   1. A DIRECTORY ACE IS NOT ENOUGH. Denying `add_file,delete_child` on a
//      folder stops files being created/removed inside it, but an existing
//      file stays writable in place — verified on macOS 26.3. So the ACE has
//      to go on each file, which is why this enumerates `git ls-files`.
//   2. GIT DOES NOT REPORT FAILURE. `git checkout` across a locked file prints
//      "unable to unlink old <path>: Permission denied" to stderr, then exits
//      0 and switches the branch anyway, leaving that file stale and showing
//      as a phantom modification. Design mode must therefore either block
//      branch switching or run git through `withUnlocked()`. It is NOT safe to
//      leave locks on across an arbitrary git operation.
//
// Locks are process-independent (they live on disk), so `unlock` must be
// callable cold — after a crash, on next boot — without any retained state.
// That is why removal re-derives the file list from git rather than replaying
// a remembered set.
// ──────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import * as path from "node:path";

import { runGit } from "../git/git-exec";
import { collectSkipWorktree, isSparseCheckout } from "../git/workspace-files";

const execFileAsync = promisify(execFile);

/** The permission clause of the ACE applied to every locked file. `write`
 *  covers content, `append` covers `>>`, and the two `*attr` entries stop a
 *  chmod/xattr end-run. Removal matches on the same string, so it must stay
 *  byte-identical across versions — changing it strands locks applied by an
 *  older build. */
const DENY_PERMS = "deny write,delete,append,writeattr,writeextattr";

/** Full ACE, including the principal.
 *
 *  The identity is NOT optional: `chmod +a "deny write,…"` fails outright with
 *  "Unable to translate 'deny' to a UUID" because chmod parses the first token
 *  as the principal. It is scoped to the current user rather than `everyone`
 *  so the lock cannot affect other accounts on the machine — and the agent,
 *  the terminal and the editor all run as this user, so it still covers every
 *  writer we care about. */
export function denyAce(): string {
  return `user:${userInfo().username} ${DENY_PERMS}`;
}

/** `chmod` accepts many paths per call. Batch to keep the total argv well
 *  under ARG_MAX (macOS: 1 MiB) while still cutting a 10k-file repo down to a
 *  few dozen spawns instead of 10k. */
const CHMOD_BATCH = 200;

export interface DesignLockOptions {
  /** Repo-relative design folder, e.g. `styles/Artifacts/Designs`. Everything
   *  inside it stays writable. Normalized to POSIX, no leading/trailing slash. */
  designDir: string;
}

export interface DesignLockResult {
  /** Number of files the ACE was applied to (or removed from). */
  changed: number;
  /** Paths that could not be updated — surfaced rather than swallowed, since a
   *  partially applied lock is a false sense of safety. */
  failed: string[];
}

/** True when this platform can enforce a design lock at all. */
export function designLockSupported(): boolean {
  return process.platform === "darwin";
}

/** Normalize a repo-relative directory to a POSIX prefix with no leading or
 *  trailing separator. Returns "" for a path that escapes the repo, which
 *  callers must treat as "no design dir" rather than "lock everything".
 *
 *  An ABSOLUTE path is refused, not reinterpreted. Stripping its leading slash
 *  would turn `/Users/me/repo/designs` into the repo-relative
 *  `Users/me/repo/designs`, which matches no tracked file — so `isInsideDir`
 *  exempts nothing, the design folder is locked along with everything else, and
 *  `lockCodebase` reports a clean success. git paths are repo-relative, so an
 *  absolute input is a caller bug and refusing is the only safe reading. */
export function normalizeDesignDir(dir: string): string {
  const posix = dir.replace(/\\/g, "/").trim();
  if (!posix || posix === "." || posix === "/") return "";
  if (posix.startsWith("/")) return "";
  const normalized = path.posix
    .normalize(posix)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    return "";
  }
  return normalized;
}

/** True when `file` sits inside `dir`. Compares on segment boundaries so
 *  `designs-old/x` is not treated as living under `designs`. */
export function isInsideDir(file: string, dir: string): boolean {
  if (!dir) return false;
  return file === dir || file.startsWith(`${dir}/`);
}

/** Tracked files that should be locked: everything except the design folder.
 *
 *  Reads from the index rather than walking the disk so gitignored build
 *  output is excluded for free — the "lock what git tracks" rule. Paths that
 *  git reports but that are not present in the worktree (deleted, or removed by
 *  a Working-directories exclusion) are dropped: chmod would fail on them and
 *  inflate `failed` with entries the user cannot act on. */
export async function lockableFiles(
  cwd: string,
  designDir: string,
): Promise<string[]> {
  const [{ stdout: tracked }, { stdout: deleted }, sparse] = await Promise.all([
    runGit(cwd, ["ls-files", "-z"]),
    runGit(cwd, ["ls-files", "-d", "-z"]),
    isSparseCheckout(cwd),
  ]);

  // Consult skip-worktree ONLY in a sparse checkout, and share the Files-tab
  // parser rather than re-deriving it — both encode the same non-obvious
  // `ls-files -v` tag contract, and two copies would let the tree and the lock
  // disagree about which files are really on disk. The gate matters because the
  // bit has a second, unrelated user: `git update-index --skip-worktree <file>`
  // pins a locally-modified tracked config, and that file IS on disk. Treating
  // it as absent would quietly leave it writable while design mode claims the
  // codebase is read-only.
  const absent = new Set(deleted.split("\0").filter(Boolean));
  if (sparse) {
    const { stdout: tagged } = await runGit(cwd, ["ls-files", "-v", "-z"]);
    for (const skipped of collectSkipWorktree(tagged)) absent.add(skipped);
  }

  const dir = normalizeDesignDir(designDir);
  const out: string[] = [];
  for (const file of tracked.split("\0")) {
    if (!file || absent.has(file)) continue;
    if (isInsideDir(file, dir)) continue;
    out.push(file);
  }
  return out;
}

/** `chmod -a` on a file that carries no ACL exits non-zero with "No ACL
 *  present". During an unlock that is the NORMAL case for most of the tree —
 *  only the previously locked files have the ACE — so it must not be counted
 *  as a failure. Without this, a successful unlock reports thousands of bogus
 *  failures and looks like a broken lock. */
export function isBenignRemoveError(
  flag: "+a" | "-a",
  stderr: string,
): boolean {
  return flag === "-a" && /No ACL present/i.test(stderr);
}

/** Whether a failed BATCH can be accepted wholesale instead of retried per
 *  file. True only when every error chmod reported was a benign "No ACL
 *  present" — the negative lookahead finds any `chmod:` line that says
 *  something else, and a single one of those forces the per-file fallback so a
 *  genuine failure is never miscounted as success. */
export function canSkipPerFileRetry(
  flag: "+a" | "-a",
  stderr: string,
): boolean {
  return (
    isBenignRemoveError(flag, stderr) &&
    !/chmod: (?!No ACL present)/i.test(stderr)
  );
}

/** Run `chmod -h <flag> <ace> <files…>` in batches, collecting real failures.
 *
 *  `-h` is load-bearing, not tidiness. Without it chmod FOLLOWS symlinks, and
 *  git happily tracks a symlink with an absolute target (`.env -> /etc/app/.env`,
 *  dotfile-style links). Locking would then write a deny-write ACE onto a file
 *  OUTSIDE the repo, and unlocking only clears it while that link is still
 *  tracked and present — rename the link and the external file stays
 *  permanently unwritable. `-h` confines every change to the link itself.
 *
 *  chmod keeps going after a per-file error and exits non-zero, so a batch
 *  result is ambiguous: some paths may have been updated. A failing batch is
 *  therefore retried one path at a time — that costs a spawn per file only in
 *  the rare mixed batch, and it is what lets `failed` name exactly which paths
 *  are unprotected rather than blaming all 200. */
async function chmodAce(
  cwd: string,
  flag: "+a" | "-a",
  files: readonly string[],
): Promise<DesignLockResult> {
  const ace = denyAce();
  let changed = 0;
  const failed: string[] = [];
  for (let i = 0; i < files.length; i += CHMOD_BATCH) {
    const batch = files.slice(i, i + CHMOD_BATCH);
    try {
      await execFileAsync("chmod", ["-h", flag, ace, ...batch], { cwd });
      changed += batch.length;
    } catch (batchErr) {
      const batchStderr = String(
        (batchErr as { stderr?: unknown } | null)?.stderr ?? "",
      );
      // Unlocking sweeps the whole tree, so the overwhelmingly common batch
      // failure is "No ACL present" on files that were never locked. chmod
      // still processed every path in the batch (verified on macOS 26.3), so
      // when those are the ONLY errors there is nothing to retry — skipping
      // the fallback keeps a cold unlock at a few dozen spawns instead of one
      // per tracked file.
      if (canSkipPerFileRetry(flag, batchStderr)) {
        changed += batch.length;
        continue;
      }
      for (const file of batch) {
        try {
          await execFileAsync("chmod", ["-h", flag, ace, file], { cwd });
          changed += 1;
        } catch (err) {
          const stderr = String(
            (err as { stderr?: unknown } | null)?.stderr ?? "",
          );
          if (!isBenignRemoveError(flag, stderr)) failed.push(file);
        }
      }
    }
  }
  return { changed, failed };
}

/** Resolve the design folder for a LOCK, or throw with a message the UI can
 *  show. Every rejection here has the same failure mode behind it: a design dir
 *  that matches no path under `cwd` exempts nothing, so the lock covers the
 *  design folder too and still reports a clean success — design mode with
 *  nothing writable at all.
 *
 *  Two independent checks, because normalization alone cannot see the disk:
 *
 *    1. `normalizeDesignDir` collapses "", ".", "..", an escaping path and an
 *       absolute path to the "" sentinel, which `isInsideDir` reads as "exempt
 *       nothing" — correct for the unlock sweep, catastrophic here.
 *    2. The folder must actually exist under `cwd`, spelled exactly as given.
 *       A typo or a case difference is indistinguishable from a valid dir
 *       otherwise, and macOS is case-INSENSITIVE by default: `fs.stat` happily
 *       resolves `designs` when the tracked folder is `Designs`, while
 *       `isInsideDir` compares git's case-sensitive paths and exempts nothing.
 *       Matching each segment against its parent listing catches both. */
export async function resolveDesignDirForLock(
  cwd: string,
  designDir: string,
): Promise<string> {
  const normalized = normalizeDesignDir(designDir);
  if (!normalized) {
    throw new Error(
      `Design-mode locking needs a repo-relative design folder; got "${designDir}".`,
    );
  }
  let dir = cwd;
  for (const segment of normalized.split("/")) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      throw new Error(
        `Design-mode locking needs an existing design folder; "${normalized}" is not in this workspace.`,
      );
    }
    if (!entries.includes(segment)) {
      // Name the near-miss: on a case-insensitive volume this is the only
      // signal the caller gets that the folder is real but spelled differently.
      const near = entries.find(
        (e) => e.toLowerCase() === segment.toLowerCase(),
      );
      throw new Error(
        near
          ? `Design-mode locking needs the design folder spelled exactly as on disk; got "${segment}", found "${near}".`
          : `Design-mode locking needs an existing design folder; "${normalized}" is not in this workspace.`,
      );
    }
    dir = path.join(dir, segment);
  }
  return normalized;
}

/** Make every tracked file outside `designDir` read-only.
 *
 *  Idempotent: re-locking an already-locked tree is a no-op per file, because
 *  macOS collapses a duplicate `+a` of an identical ACE. */
export async function lockCodebase(
  cwd: string,
  opts: DesignLockOptions,
): Promise<DesignLockResult> {
  if (!designLockSupported()) {
    throw new Error(
      "Design-mode locking needs macOS — no filesystem ACL support on this platform.",
    );
  }
  const designDir = await resolveDesignDirForLock(cwd, opts.designDir);
  const files = await lockableFiles(cwd, designDir);
  return chmodAce(cwd, "+a", files);
}

/** Remove the design lock.
 *
 *  Deliberately re-derives the file list from git instead of replaying a
 *  remembered set, so it works cold after a crash. It also passes `designDir:
 *  ""` — unlocking must sweep the WHOLE tree, since the design folder may have
 *  moved since the lock was applied and a file locked under the old location
 *  would otherwise stay locked forever.
 *
 *  `chmod -a` on a file with no matching ACE is an error, so failures here are
 *  expected and non-fatal; they are counted, not thrown. */
export async function unlockCodebase(cwd: string): Promise<DesignLockResult> {
  if (!designLockSupported()) return { changed: 0, failed: [] };
  const files = await lockableFiles(cwd, "");
  return chmodAce(cwd, "-a", files);
}

/** Run `fn` with the lock lifted, then restore it.
 *
 *  Every git operation that can rewrite the worktree — checkout, merge, stash
 *  pop, reset — must go through this. git does not fail loudly on a locked
 *  path (see the header note), so skipping this silently desynchronizes the
 *  worktree from HEAD. The lock is restored even if `fn` throws.
 *
 *  Re-locking is NOT done in a `finally`. It can legitimately fail — the very
 *  operations this wraps can move the design folder out from under it (a
 *  checkout of a branch where it doesn't exist), and `lockCodebase` refuses
 *  rather than lock the whole tree — and a throw from `finally` would replace
 *  `fn`'s own error with that one, hiding why the git operation failed. So a
 *  failed relock is surfaced only when `fn` succeeded; otherwise `fn`'s error
 *  wins. Either way the tree is left UNLOCKED, which is the safe direction: a
 *  visible unlocked codebase beats a stale worktree or a locked design folder. */
export async function withUnlocked<T>(
  cwd: string,
  opts: DesignLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!designLockSupported()) return fn();
  await unlockCodebase(cwd);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await lockCodebase(cwd, opts).catch(() => {});
    throw err;
  }
  await lockCodebase(cwd, opts);
  return result;
}
