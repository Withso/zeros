// Historical same-user macOS ACLs affected the shared checkout; remove them for compatibility, not agent isolation.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import * as path from "node:path";

import { runGit } from "../git/git-exec";
import { collectSkipWorktree, isSparseCheckout } from "../git/workspace-files";

const execFileAsync = promisify(execFile);

// Compatibility contract: older builds installed this exact per-file ACE and
// `chmod -a` removes by exact text. Never mutate it; add a separate ACE for new
// directory permissions instead.
const DENY_PERMS = "deny write,delete,append,writeattr,writeextattr";
// macOS directory ACEs use write/append to add entries and delete_child to remove or rename them.
const DIRECTORY_DENY_PERMS =
  "deny write,delete,append,delete_child,writeattr,writeextattr";

/** macOS chmod requires a principal; older builds wrote this ACE for the current user. */
function denyAce(): string {
  return `user:${userInfo().username} ${DENY_PERMS}`;
}

function denyDirectoryAce(): string {
  return `user:${userInfo().username} ${DIRECTORY_DENY_PERMS}`;
}

/** Batch chmod calls to stay under macOS argv limits without spawning per file. */
const CHMOD_BATCH = 200;

export interface DesignLockResult {
  /** Paths counted as cleaned; benign missing ACLs can count in bulk. */
  changed: number;
  /** Paths with real removal failures, so partial cleanup is not reported as complete. */
  failed: string[];
}

/** A background sweep takes the workspace mutation lane per step so Design reads can interleave. */
export type DesignLockTurn = <T>(step: () => Promise<T>) => Promise<T>;
const directTurn: DesignLockTurn = (step) => step();
/** A cancelled or superseded sweep stops without counting untouched paths as failures. */
export class DesignLockSweepStopped extends Error {}

export function designLockSupported(): boolean {
  return process.platform === "darwin";
}

/** Return an empty sentinel for invalid paths; only a whole-tree cleanup may use it, never a Design root. */
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

/** Compare complete path segments so a sibling prefix does not count as inside. */
export function isInsideDir(file: string, dir: string): boolean {
  if (!dir) return false;
  return file === dir || file.startsWith(`${dir}/`);
}

/** Enumerate existing tracked files for historical ACL cleanup; missing worktree entries are not removal failures. */
export async function lockableFiles(
  cwd: string,
  designDir: string,
): Promise<string[]> {
  const [{ stdout: tracked }, { stdout: deleted }, sparse] = await Promise.all([
    runGit(cwd, ["ls-files", "-z"]),
    runGit(cwd, ["ls-files", "-d", "-z"]),
    isSparseCheckout(cwd),
  ]);

  // Only sparse checkouts use skip-worktree here to identify absent paths; outside sparse mode it can mark a file still on disk.
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

/** macOS chmod -a exits nonzero for files without ACLs; that is normal during a cleanup sweep. */
export function isBenignRemoveError(stderr: string): boolean {
  return /No ACL present/i.test(stderr);
}

/** One non-benign chmod error requires per-file retry even when the others are missing ACLs. */
export function canSkipPerFileRetry(stderr: string): boolean {
  return (
    isBenignRemoveError(stderr) && !/chmod: (?!No ACL present)/i.test(stderr)
  );
}

/** Use macOS chmod -h to leave symlink targets untouched; retry a mixed batch to attribute each real failure. */
async function removeAclAce(
  cwd: string,
  files: readonly string[],
  ace = denyAce(),
  turn: DesignLockTurn = directTurn,
): Promise<DesignLockResult> {
  let changed = 0;
  const failed: string[] = [];
  for (let i = 0; i < files.length; i += CHMOD_BATCH) {
    const batch = files.slice(i, i + CHMOD_BATCH);
    try {
      await turn(() => execFileAsync("chmod", ["-h", "-a", ace, ...batch], { cwd }));
      changed += batch.length;
    } catch (batchErr) {
      if (batchErr instanceof DesignLockSweepStopped) throw batchErr;
      const batchStderr = String(
        (batchErr as { stderr?: unknown } | null)?.stderr ?? "",
      );
      // Verified on macOS 26.3: chmod still processes the batch when all reported errors are missing ACLs.
      if (canSkipPerFileRetry(batchStderr)) {
        changed += batch.length;
        continue;
      }
      for (const file of batch) {
        try {
          await turn(() => execFileAsync("chmod", ["-h", "-a", ace, file], { cwd }));
          changed += 1;
        } catch (err) {
          if (err instanceof DesignLockSweepStopped) throw err;
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

/** Check every segment's exact spelling: case-insensitive macOS lookups can disagree with case-sensitive Git paths. */
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
      // Do not follow symlinks when validating the Design root.
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
  path: string;
  links: number;
}

/** Enumerate ignored and untracked Design entries too, without following symlinks or accepting a partial tree on read failure. */
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

/** Path-scoped authorization cannot distinguish hard-link aliases; reject a multiply linked Design file without scanning for its aliases. */
export async function designDirAliasHazards(
  cwd: string,
  designDir: string,
): Promise<DesignDirAliasHazard[]> {
  const { files } = await designDirFenceEntries(cwd, designDir);
  const hazards: DesignDirAliasHazard[] = [];
  // Bound parallel metadata reads; any failed read rejects the audit.
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

/** Compatibility export for callers that only need files, not directories. */
export async function designDirFiles(
  cwd: string,
  designDir: string,
): Promise<string[]> {
  return (await designDirFenceEntries(cwd, designDir)).files;
}

/** Rescan the current tree so historical directory ACL cleanup works after crashes or edits. */
export async function unfenceDesignDirFiles(
  cwd: string,
  designDir: string,
  turn: DesignLockTurn = directTurn,
): Promise<DesignLockResult> {
  if (!designLockSupported()) return { changed: 0, failed: [] };
  const { directories, files } = await turn(() => designDirFenceEntries(cwd, designDir));
  // Release leaves before parents to limit partial cleanup if removal fails.
  const fileResult = await removeAclAce(cwd, files, denyAce(), turn);
  const directoryResult = await removeAclAce(
    cwd,
    [...directories].reverse(),
    denyDirectoryAce(),
    turn,
  );
  return {
    changed: directoryResult.changed + fileResult.changed,
    failed: [...directoryResult.failed, ...fileResult.failed],
  };
}

/** Rescan Git after a crash; sweep the entire tracked tree because the Design root may have moved. */
export async function unlockCodebase(cwd: string, turn: DesignLockTurn = directTurn): Promise<DesignLockResult> {
  if (!designLockSupported()) return { changed: 0, failed: [] };
  const files = await turn(() => lockableFiles(cwd, ""));
  return removeAclAce(cwd, files, denyAce(), turn);
}
