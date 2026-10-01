// Per-repository serialization of the engine's Git worktree-registry mutations.
//
// `git worktree add`, `remove` and `move` open every registered
// `<common-dir>/worktrees/<id>` entry, and read its `commondir`, before they
// change anything. Another `git worktree add` writes its own entry in stages:
// `commondir` exists, still empty, before its contents are written, and
// `remove` deletes an entry file by file. A scan that lands in either window
// dies with `failed to read <…>/worktrees/<id>/commondir` (errno 0, printed as
// "Undefined error: 0" on macOS and "Success" on Linux, or ENOENT). Git takes no
// repository lock for these commands, so lifecycle operations on different
// workspaces of one repository (several creates at once, a create beside a
// delete) could fail each other.
//
// Every engine `git worktree` mutation therefore runs through
// `runWorktreeRegistryMutation`, which admits one at a time per repository. The
// lock is keyed by the canonical common Git directory, so the main checkout and
// its linked worktrees share it. It covers only the Git command (never fetches,
// file seeding or other lifecycle work) and is released when the command
// settles, including on failure. Different repositories never wait for each
// other.
//
// Another process, such as a terminal `git worktree add`, can still open the
// same window. A failure that matches exactly that read is retried a few times
// after a short wait: Git dies while it enumerates the registry, before it
// creates, removes or moves anything, so running the command again is safe.
//
// Registry reads (`git worktree list`) stay outside the lock. They change
// nothing, would otherwise wait behind a long checkout, and retry their own
// transient failures.

import { realpath } from "node:fs/promises";
import path from "node:path";

import { GitError } from "./errors";
import {
  runGit,
  runGitRead,
  type RunGitOptions,
  type RunGitResult,
} from "./git-exec";

/** `git worktree` subcommands that write the repository's worktree registry. */
const REGISTRY_MUTATIONS = new Set([
  "add",
  "lock",
  "move",
  "prune",
  "remove",
  "repair",
  "unlock",
]);

/** Wait (ms) before each retry of a mutation that read another process's
 *  half-written entry. That window closes in well under a millisecond, so these
 *  are generous; an entry that stays broken still fails after about 375ms. */
const TRANSIENT_REGISTRY_READ_RETRY_BACKOFF_MS = [25, 100, 250];

const TRANSIENT_REGISTRY_READ =
  /^fatal: failed to read '?[^\r\n]*?[\\/]worktrees[\\/][^\\/\r\n]+[\\/]commondir'?: (?:Undefined error: 0|Success|No error|No such file or directory)\r?$/m;

/** True when Git died reading another worktree's admin entry while it was being
 *  written or removed. Matches only that message; any other failure is real. */
export function isTransientWorktreeRegistryRead(stderr: string): boolean {
  return TRANSIENT_REGISTRY_READ.test(stderr);
}

/** `worktree add -b/-B` creates its branch before it reads the registry, so a
 *  second attempt would fail on the branch the first one made. Only the plain
 *  `worktree add <path> <commit-ish>` form, the one the engine uses, is
 *  repeated. */
function safeToRepeat(args: readonly string[]): boolean {
  return (
    args[1] !== "add" ||
    (args.length === 4 && !args.slice(2).some((arg) => arg.startsWith("-")))
  );
}

const registryTails = new Map<string, Promise<void>>();

async function withRegistryLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = registryTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  registryTails.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (registryTails.get(key) === tail) registryTails.delete(key);
  }
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** One lock per repository: its canonical common Git directory, which the main
 *  checkout and every linked worktree resolve to. */
async function registryLockKey(
  cwd: string,
  opts: RunGitOptions,
): Promise<string> {
  const { stdout } = await runGitRead(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      ...(opts.identity ? { identity: opts.identity } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  );
  const commonDir = stdout.trim();
  if (!commonDir) {
    throw new GitError({
      code: "NOT_A_REPO",
      message: "Could not resolve the repository's common Git directory.",
    });
  }
  return canonicalPath(commonDir);
}

export async function withWorktreeRegistryLock<T>(
  cwd: string,
  run: () => Promise<T>,
  opts: RunGitOptions = {},
): Promise<T> {
  const key = await registryLockKey(cwd, opts);
  return withRegistryLock(key, run);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run one `git worktree <add|move|remove|repair|prune|lock|unlock> …` for the
 *  repository containing `cwd`, while no other engine registry mutation of that
 *  repository is in flight. Errors are those of `runGit`, unchanged. */
export async function runWorktreeRegistryMutation(
  cwd: string,
  args: readonly string[],
  opts: RunGitOptions = {},
): Promise<RunGitResult> {
  if (args[0] !== "worktree" || !REGISTRY_MUTATIONS.has(args[1] ?? "")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Not a Git worktree registry mutation: git ${args.slice(0, 2).join(" ")}`,
    });
  }
  return withWorktreeRegistryLock(
    cwd,
    async () => {
      for (let attempt = 0; ; attempt++) {
        const failure = { transient: false };
        try {
          return await runGit(cwd, [...args], {
            ...opts,
            mapErrorCode: (stderr) => {
              failure.transient = isTransientWorktreeRegistryRead(stderr);
              return opts.mapErrorCode?.(stderr);
            },
          });
        } catch (error) {
          if (
            !failure.transient ||
            !safeToRepeat(args) ||
            attempt >= TRANSIENT_REGISTRY_READ_RETRY_BACKOFF_MS.length
          ) {
            throw error;
          }
          await sleep(TRANSIENT_REGISTRY_READ_RETRY_BACKOFF_MS[attempt]);
        }
      }
    },
    opts,
  );
}
