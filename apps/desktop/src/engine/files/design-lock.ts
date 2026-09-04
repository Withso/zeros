// ──────────────────────────────────────────────────────────
// Historical macOS ACL compatibility and cleanup helpers
// ──────────────────────────────────────────────────────────
//
// Early Zeros builds experimented with persistent same-user ACLs. That scope
// was incorrect: the checkout is shared with the user's editors, Git clients,
// and other coding platforms, so an on-disk ACL affected actors outside Zeros.
// Production code no longer installs these ACLs. The exact helpers remain so
// startup can remove guards left behind by those builds.
//
// Why this is not an agent boundary
// ───────────────────────────────────────
// Same-user ACLs affect every app running as the user and can also be removed
// by that user. Native Code uses a behavioral contract plus Zeros-owned path
// guards; a future autonomous Design agent uses ZSR and the Design API. These
// constants exist solely to identify old metadata.
//
// What historical builds locked
// ────────────────
// The retired fence walked the real Design tree: its root, every existing
// subdirectory, and every tracked, ignored, or untracked entry. Legacy helpers
// farther below still enumerate tracked code files only so old whole-codebase
// locks can be swept after upgrades.
//
// Cleanup covers directories and existing files because historical builds used
// separate ACEs for directory creation/deletion and in-place content writes.
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
// Compatibility contract: older builds installed this exact per-file ACE and
// `chmod -a` removes by exact text. Never mutate it; add a separate ACE for new
// directory permissions instead.
const DENY_PERMS = "deny write,delete,append,writeattr,writeextattr";
// On a directory, `write` means add-file, `append` means add-subdirectory, and
// `delete_child` blocks removal/rename of children (Apple ACL semantics).
const DIRECTORY_DENY_PERMS =
  "deny write,delete,append,delete_child,writeattr,writeextattr";

/** Full ACE, including the principal.
 *
 *  The identity was NOT optional: `chmod +a "deny write,…"` failed with
 *  "Unable to translate 'deny' to a UUID" because chmod parses the first token
 *  as the principal. It is scoped to the current user rather than `everyone`
 *  so the historical lock did not affect other accounts on the machine. */
function denyAce(): string {
  return `user:${userInfo().username} ${DENY_PERMS}`;
}

function denyDirectoryAce(): string {
  return `user:${userInfo().username} ${DIRECTORY_DENY_PERMS}`;
}

/** `chmod` accepts many paths per call. Batch to keep the total argv well
 *  under ARG_MAX (macOS: 1 MiB) while still cutting a 10k-file repo down to a
 *  few dozen spawns instead of 10k. */
const CHMOD_BATCH = 200;

export interface DesignLockResult {
  /** Number of paths whose historical ACE was removed (or was already absent). */
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
 *  callers must treat as "no design dir" rather than "scan the repository".
 *
 *  An ABSOLUTE path is refused, not reinterpreted. Stripping its leading slash
 *  would turn `/Users/me/repo/designs` into the repo-relative
 *  `Users/me/repo/designs`, which matches no tracked file — so `isInsideDir`
 *  exempts nothing, the design folder is locked along with everything else, and
 *  no Design entry. Git paths are repo-relative, so an absolute input is a
 *  caller bug and refusing is the only safe reading. */
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
  // it as absent would have omitted it from the historical whole-tree ACL
  // cleanup.
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
export function isBenignRemoveError(stderr: string): boolean {
  return /No ACL present/i.test(stderr);
}

/** Whether a failed BATCH can be accepted wholesale instead of retried per
 *  file. True only when every error chmod reported was a benign "No ACL
 *  present" — the negative lookahead finds any `chmod:` line that says
 *  something else, and a single one of those forces the per-file fallback so a
 *  genuine failure is never miscounted as success. */
export function canSkipPerFileRetry(stderr: string): boolean {
  return (
    isBenignRemoveError(stderr) && !/chmod: (?!No ACL present)/i.test(stderr)
  );
}

/** Remove one exact historical ACE in batches, collecting real failures.
 *
 *  `-h` is load-bearing, not tidiness. Without it chmod FOLLOWS symlinks, and
 *  git happily tracks symlinks with absolute targets. `-h` confines cleanup to
 *  the link instead of changing metadata on a target outside the checkout.
 *
 *  chmod keeps going after a per-file error and exits non-zero, so a batch
 *  result is ambiguous: some paths may have been updated. A failing batch is
 *  therefore retried one path at a time — that costs a spawn per file only in
 *  the rare mixed batch, and it is what lets `failed` name exactly which paths
 *  are unprotected rather than blaming all 200. */
async function removeAclAce(
  cwd: string,
  files: readonly string[],
  ace = denyAce(),
): Promise<DesignLockResult> {
  let changed = 0;
  const failed: string[] = [];
  for (let i = 0; i < files.length; i += CHMOD_BATCH) {
    const batch = files.slice(i, i + CHMOD_BATCH);
    try {
      await execFileAsync("chmod", ["-h", "-a", ace, ...batch], { cwd });
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
      if (canSkipPerFileRetry(batchStderr)) {
        changed += batch.length;
        continue;
      }
      for (const file of batch) {
        try {
          await execFileAsync("chmod", ["-h", "-a", ace, file], { cwd });
          changed += 1;
        } catch (err) {
          const stderr = String(
            (err as { stderr?: unknown } | null)?.stderr ?? "",
          );
          if (!isBenignRemoveError(stderr)) failed.push(file);
        }
      }
    }
  }
  return { changed, failed };
}

/** Resolve a real Design folder for containment validation or ACL cleanup.
 *
 *  Two independent checks, because normalization alone cannot see the disk:
 *
 *    1. `normalizeDesignDir` collapses "", ".", "..", an escaping path and an
 *       absolute path to the "" sentinel, which `isInsideDir` reads as "exempt
 *       nothing" — correct only for the historical whole-tree cleanup sweep.
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
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      // lstat is intentional: stat would follow a symlink and turn an
      // apparently in-workspace Design pointer into authority over some other
      // subtree. Every path segment must be a real directory.
      info = await fs.lstat(dir);
    } catch {
      throw new Error(
        `Design-mode locking needs an existing design folder; "${normalized}" is not in this workspace.`,
      );
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `Design-mode locking needs a real, symlink-free directory inside this workspace; "${normalized}" is not one.`,
      );
    }
  }
  return normalized;
}

export interface DesignDirFenceEntries {
  /** Root first, then descendants in lexical/top-down order. */
  directories: string[];
  /** Every non-directory entry, including ignored files and symlinks. */
  files: string[];
}

export interface DesignDirAliasHazard {
  /** Repo-relative Design entry whose inode is reachable by another name. */
  path: string;
  links: number;
}

/** Enumerate the ACTUAL Design tree, not Git's index.
 *
 * The protection promise applies equally to tracked documents, ignored visual
 * experiments, and untracked drafts created seconds ago by the Design engine.
 * `Dirent.isDirectory()` deliberately does not follow symlinks: a symlink is a
 * file-like fence target, never a traversal edge into code or outside the repo.
 * Any read failure aborts the sweep so fence health fails closed rather than
 * recording an incomplete tree as protected. */
export async function designDirFenceEntries(
  cwd: string,
  designDir: string,
): Promise<DesignDirFenceEntries> {
  const root = await resolveDesignDirForLock(cwd, designDir);
  const directories = [root];
  const files: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.shift()!;
    const entries = await fs.readdir(path.join(cwd, ...directory.split("/")), {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(child);
        pending.push(child);
      } else {
        files.push(child);
      }
    }
  }

  directories.sort((left, right) => left.localeCompare(right));
  files.sort((left, right) => left.localeCompare(right));
  return { directories, files };
}

/** Reject pre-existing hard-link aliases before admitting a path-scoped agent.
 *
 * A sandbox policy authorizes names, while a hard link is a second name for
 * the same inode. If one Design file already has a code-side hard link, a code
 * actor could mutate the Design document through the otherwise-allowed name.
 * We intentionally do not try to discover one alias by scanning the whole
 * volume (that is incomplete and unbounded); `nlink > 1` itself is sufficient
 * to fail closed. Symlinks are safe to enumerate with `lstat` and are left for
 * the provider's canonical path enforcement. */
export async function designDirAliasHazards(
  cwd: string,
  designDir: string,
): Promise<DesignDirAliasHazard[]> {
  const { files } = await designDirFenceEntries(cwd, designDir);
  const hazards: DesignDirAliasHazard[] = [];
  // One lstat per file is the dominant cost of this sweep on large Design
  // trees and each probe is independent, so batch them like the policy
  // builder's alias audit. A failed lstat still rejects the whole sweep, and
  // hazards keep the sorted file order because batches slice it in place.
  const batchSize = 256;
  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize);
    const infos = await Promise.all(
      batch.map((file) => fs.lstat(path.join(cwd, ...file.split("/")))),
    );
    for (let index = 0; index < batch.length; index += 1) {
      const info = infos[index]!;
      if (info.isFile() && info.nlink > 1) {
        hazards.push({ path: batch[index]!, links: info.nlink });
      }
    }
  }
  return hazards;
}

export async function assertDesignDirHasNoHardlinkAliases(
  cwd: string,
  designDir: string,
): Promise<void> {
  const hazards = await designDirAliasHazards(cwd, designDir);
  if (hazards.length === 0) return;
  throw new Error(
    `The active Design directory contains ${hazards.length} hard-linked ` +
      `${hazards.length === 1 ? "file" : "files"}; path-scoped containment ` +
      `cannot safely distinguish those aliases.`,
  );
}

/** Every non-directory entry INSIDE `designDir` that exists on disk. Kept as
 * a compatibility export for callers that historically asked for files. */
export async function designDirFiles(
  cwd: string,
  designDir: string,
): Promise<string[]> {
  return (await designDirFenceEntries(cwd, designDir)).files;
}

/** Remove a historical Design-directory fence. Sweeps every existing entry
 *  (missing ACEs are benign — see isBenignRemoveError), so it works cold after
 *  a crash and after files were added/removed since the fence was applied. */
export async function unfenceDesignDirFiles(
  cwd: string,
  designDir: string,
): Promise<DesignLockResult> {
  if (!designLockSupported()) return { changed: 0, failed: [] };
  const { directories, files } = await designDirFenceEntries(cwd, designDir);
  // Release leaves before parents, mirroring the hierarchy used by historical
  // builds and minimizing the partially cleaned subtree if removal fails.
  const fileResult = await removeAclAce(cwd, files);
  const directoryResult = await removeAclAce(
    cwd,
    [...directories].reverse(),
    denyDirectoryAce(),
  );
  return {
    changed: directoryResult.changed + fileResult.changed,
    failed: [...directoryResult.failed, ...fileResult.failed],
  };
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
  return removeAclAce(cwd, files);
}
