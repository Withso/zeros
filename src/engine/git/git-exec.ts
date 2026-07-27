// Shared execFile wrapper for `git` calls. Centralised so every write
// path uses the same error shape, the same buffer cap, and the same
// "args array, never a concatenated string" guarantee against shell
// injection.

import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { GitError, type GitErrorCode } from "./errors";

const execFileAsync = promisify(execFile);

export interface RunFileOptions {
  cwd?: string;
  maxBufferBytes?: number;
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string | undefined>;
}

export interface RunFileResult {
  stdout: string;
  stderr: string;
}

interface BunSubprocess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  signalCode: string | null;
  killed: boolean;
}

interface BunSubprocessRuntime {
  spawn(
    command: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin: "ignore" | Uint8Array;
      stdout: "pipe";
      stderr: "pipe";
      maxBuffer: number;
      timeout?: number;
      killSignal: "SIGKILL";
    },
  ): BunSubprocess;
}

function bunSubprocessRuntime(): BunSubprocessRuntime | null {
  const candidate = (
    globalThis as typeof globalThis & {
      Bun?: Partial<BunSubprocessRuntime>;
    }
  ).Bun;
  return typeof candidate?.spawn === "function"
    ? (candidate as BunSubprocessRuntime)
    : null;
}

async function readBunOutput(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  return stream ? new Response(stream).text() : "";
}

function subprocessFailure(args: {
  command: string;
  commandArgs: string[];
  exitCode: number | string | null;
  signal: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}): Error {
  const suffix = args.signal
    ? ` (signal ${args.signal})`
    : ` (exit ${String(args.exitCode)})`;
  return Object.assign(
    new Error(`${args.command} ${args.commandArgs.join(" ")} failed${suffix}`),
    {
      code: args.exitCode,
      signal: args.signal,
      killed: args.killed,
      stdout: args.stdout,
      stderr: args.stderr,
    },
  );
}

/** Run one non-shell command without crossing Bun's Node child-process
 * compatibility layer.
 *
 * The engine itself runs under Bun. Long-lived engines have intermittently
 * wedged inside `node:child_process.execFile` after an agent teardown followed
 * by `git worktree remove`: the child never reports completion, timers stop,
 * and every workspace RPC becomes unreachable. Native `Bun.spawn` uses
 * posix_spawn, provides its own hard timeout, and keeps stdout/stderr bounded.
 * Node (Vitest and source-mode tools) retains the established execFile path. */
export async function runFile(
  command: string,
  args: string[],
  opts: RunFileOptions = {},
): Promise<RunFileResult> {
  const bun = bunSubprocessRuntime();
  if (bun) {
    let child: BunSubprocess;
    try {
      child = bun.spawn([command, ...args], {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        stdin:
          opts.input === undefined
            ? "ignore"
            : new TextEncoder().encode(opts.input),
        stdout: "pipe",
        stderr: "pipe",
        maxBuffer: opts.maxBufferBytes ?? 16 * 1024 * 1024,
        ...(opts.timeoutMs && opts.timeoutMs > 0
          ? { timeout: opts.timeoutMs }
          : {}),
        // A timeout is a hard request-path boundary. Git and cleanup hooks do
        // not get to ignore SIGTERM and strand the single engine process.
        killSignal: "SIGKILL",
      });
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { stdout: "", stderr: "" },
      );
    }
    // Drain both pipes concurrently with exit waiting. Reading after `exited`
    // can deadlock a chatty child on a full pipe.
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBunOutput(child.stdout),
      readBunOutput(child.stderr),
    ]);
    if (exitCode !== 0) {
      throw subprocessFailure({
        command,
        commandArgs: args,
        exitCode,
        signal: child.signalCode,
        killed: child.killed,
        stdout,
        stderr,
      });
    }
    return { stdout, stderr };
  }

  const child = execFileAsync(command, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    maxBuffer: opts.maxBufferBytes ?? 16 * 1024 * 1024,
    ...(opts.timeoutMs && opts.timeoutMs > 0
      ? { timeout: opts.timeoutMs }
      : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (opts.input !== undefined && child.child.stdin) {
    child.child.stdin.write(opts.input);
    child.child.stdin.end();
  }
  const { stdout, stderr } = await child;
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

export interface RunGitOptions {
  /** Treat the named git error categories as "expected" — they're
   *  returned to the caller via `expectedError` instead of thrown.
   *  Used by pull/rebase to surface conflicts without raising. */
  treatAsExpected?: ExpectedCategory[];
  /** Map a non-zero exit / known stderr pattern to a specific
   *  GitErrorCode. Highest-precedence match wins; otherwise we fall
   *  back to GIT_COMMAND_FAILED. */
  mapErrorCode?: (stderr: string) => GitErrorCode | undefined;
  /** Override the default 16 MiB output buffer. */
  maxBufferBytes?: number;
  /** Kill the git invocation after this many ms. Use to bound a network op
   *  (e.g. `fetch`) that sits on a request reply path so a hung remote can't
   *  outlast the RPC budget. Omit = no timeout (Node default). */
  timeoutMs?: number;
  /** Write this string to the child's stdin then close it. Used by
   *  patch-on-stdin operations like `git apply --cached` (hunk staging,
   *  D.6). */
  input?: string;
  /** Extra environment variables for this invocation, merged over the engine's
   *  process.env. Used by the per-turn snapshot path to point GIT_INDEX_FILE at a
   *  scratch index (so a whole-tree snapshot never disturbs the user's real
   *  staging area) and to stamp a fixed author/committer for commit-tree. */
  env?: Record<string, string | undefined>;
}

export type ExpectedCategory =
  | "conflict"
  | "behind"
  | "ahead"
  | "nothing-to-do";

/** Reject a git ref / branch / commit-ish that could be misread as a
 *  command-line flag (argument injection) or that hides a NUL. execFile
 *  already blocks shell interpretation, but a value like "--hard" or
 *  "--abort" reaching a bare positional (`git reset --hard`, `git merge
 *  --abort`) would still let an untrusted ref change git's behavior — and
 *  refs/SHAs are positionals that can't all be protected by a `--`
 *  separator (`git checkout -- <x>` means a *pathspec*). A leading "-" is
 *  also invalid per git's own check-ref-format, so this never rejects a
 *  real ref. Mirrors the path guard in stage.ts / restore.ts so refs and
 *  paths share one validation posture. Returns the value for inline use. */
export function assertSafeGitRef(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label}: must be a non-empty string`,
    });
  }
  if (value.startsWith("-")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label}: "${value}" starts with "-" (looks like a flag)`,
    });
  }
  if (value.includes("\0")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label}: contains a NUL byte`,
    });
  }
  return value;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  /** Present when an "expected" outcome was matched. Allows pull/rebase
   *  callers to special-case conflicts without try/catch. */
  expectedError?: ExpectedCategory;
}

/** Backoff (ms) before each retry when a git op fails purely because a
 *  concurrent git process holds a lock. Now that "Local main" is an editable
 *  workspace like any worktree, multiple agents can run in the SAME checkout
 *  and briefly contend for `.git/index.lock` (or a ref `*.lock`). git exits
 *  non-zero WITHOUT mutating anything when it can't acquire the lock, so
 *  re-running after a short wait is safe. Bounded (~1.3s total) — a genuinely
 *  stale lock (a crashed git) still surfaces git's own "remove the file" error
 *  after the retries instead of hanging. */
const GIT_LOCK_RETRY_BACKOFF_MS = [60, 150, 350, 700];

/** True when git's stderr indicates transient lock contention (another git
 *  process holds the index/ref lock) rather than a real failure — the only
 *  class of failure that's safe to retry, because git did not mutate anything
 *  when it couldn't take the lock. */
export function isGitLockContention(stderr: string): boolean {
  return (
    /Unable to create '[^']*\.lock': File exists/i.test(stderr) ||
    /Another git process seems to be running/i.test(stderr) ||
    /cannot lock ref\b/i.test(stderr) ||
    /unable to lock\b/i.test(stderr) ||
    /could not lock config file/i.test(stderr)
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run `git <args>` in `cwd`. Throws GitError on unexpected failures;
 *  returns `{ expectedError }` if the failure matches one of the
 *  caller-allowed categories. Transient `.git` lock contention is retried
 *  with backoff (see `GIT_LOCK_RETRY_BACKOFF_MS`). */
export async function runGit(
  cwd: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<RunGitResult> {
  // C9 guard: never run git with an empty cwd — execFile would silently
  // fall back to process.cwd() (the engine's own root / main repo), so a
  // git op meant for a workspace could mutate the wrong repository.
  if (!cwd) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `git ${args.join(" ")}: refusing to run with an empty cwd`,
    });
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await runFile("git", args, {
        cwd,
        maxBufferBytes: opts.maxBufferBytes,
        timeoutMs: opts.timeoutMs,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        input: opts.input,
      });
    } catch (err) {
      const e = err as ExecFileException & { stdout?: string; stderr?: string };
      const stderr = String(e.stderr ?? "");
      const stdout = String(e.stdout ?? "");
      // Transient lock contention from a concurrent git process in the same
      // checkout → wait and retry (bounded). git didn't mutate anything (it
      // couldn't take the lock), so re-running is safe. Checked BEFORE the
      // expected-error / mapErrorCode handling so a lock blip never surfaces.
      if (
        isGitLockContention(stderr) &&
        attempt < GIT_LOCK_RETRY_BACKOFF_MS.length
      ) {
        await sleep(GIT_LOCK_RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      if (opts.treatAsExpected) {
        const category = classifyExpectedError(stderr, stdout);
        if (category && opts.treatAsExpected.includes(category)) {
          return { stdout, stderr, expectedError: category };
        }
      }
      const code = opts.mapErrorCode?.(stderr) ?? "GIT_COMMAND_FAILED";
      throw new GitError({
        code,
        message: `git ${args.join(" ")} failed`,
        cause: err,
        context: { stderr: stderr.slice(0, 4000), exitCode: e.code },
      });
    }
  }
}

/** Best-effort classification of git's stderr into structured outcomes.
 *  Used by pull/rebase to surface conflicts as data, not exceptions. */
function classifyExpectedError(
  stderr: string,
  stdout: string,
): ExpectedCategory | null {
  const blob = `${stderr}\n${stdout}`;
  // Merge conflicts (pull, merge, cherry-pick).
  if (
    /CONFLICT \(/i.test(blob) ||
    /Merge conflict in/i.test(blob) ||
    /needs merge/i.test(blob) ||
    /fix conflicts and then commit/i.test(blob)
  ) {
    return "conflict";
  }
  // Rebase conflicts.
  if (
    /could not apply/i.test(blob) ||
    /resolve all conflicts manually/i.test(blob) ||
    /Failed to merge in the changes/i.test(blob)
  ) {
    return "conflict";
  }
  // "Nothing to commit / nothing to do" outcomes. The "nothing added to
  // commit but untracked files present" wording appears when the worktree
  // has untracked files (like our own .zeros/ seed) but no staged tree —
  // it means the same thing for our purposes.
  if (
    /nothing to commit/i.test(blob) ||
    /nothing added to commit/i.test(blob) ||
    /Already up to date/i.test(blob) ||
    /Current branch .* is up to date/i.test(blob)
  ) {
    return "nothing-to-do";
  }
  if (/Your branch is behind/i.test(blob)) return "behind";
  if (/Your branch is ahead/i.test(blob)) return "ahead";
  return null;
}
