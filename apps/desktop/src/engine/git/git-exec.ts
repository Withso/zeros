// Shared execFile wrapper for `git` calls. Centralised so every write
// path uses the same error shape, the same buffer cap, and the same
// "args array, never a concatenated string" guarantee against shell
// injection.

import { execFile, type ExecFileException } from "node:child_process";
import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactSensitive } from "@zeros/protocol/scrub";
import { GitError, type GitErrorCode } from "./errors";
import {
  prepareGitCredentialInvocation,
  refreshGitCredentialAfterAuthenticationFailure,
  type GitCredentialRequest,
} from "./credential-broker";
// Pure leaf module (node:path only) — no cycle back into git/.
import { pruneLauncherScriptEnv } from "../env/launcher-env";

const execFileAsync = promisify(execFile);

export interface RunFileOptions {
  cwd?: string;
  maxBufferBytes?: number;
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string | undefined>;
  /** Abort the process and its request when the owning capability is revoked. */
  signal?: AbortSignal;
  /** Run the final child as the qualified cloud worker. The engine remains
   * root, but filesystem mutations produced on the worker's behalf must keep
   * the tenant checkout worker-owned. */
  identity?: { uid: number; gid: number };
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
  kill(signal?: number | NodeJS.Signals): void;
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
      uid?: number;
      gid?: number;
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
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
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
        ...(opts.identity
          ? { uid: opts.identity.uid, gid: opts.identity.gid }
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
    const abort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", abort, { once: true });
    // Drain both pipes concurrently with exit waiting. Reading after `exited`
    // can deadlock a chatty child on a full pipe.
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readBunOutput(child.stdout),
        readBunOutput(child.stderr),
      ]);
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
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
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.identity
      ? { uid: opts.identity.uid, gid: opts.identity.gid }
      : {}),
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
  /** Qualified uid/gid for a trusted engine operation performed on behalf of
   * a cloud agent. Local desktop callers omit it and retain same-user parity. */
  identity?: { uid: number; gid: number };
  /** Revoke an in-flight integration operation with its boundary. */
  signal?: AbortSignal;
}

const SAFE_CALLER_GIT_ENV = new Set([
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_INDEX_FILE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
]);

const EXECUTION_ENV = new Set([
  "BASH_ENV",
  "CDPATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "EDITOR",
  "ENV",
  "GPG_AGENT_INFO",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PAGER",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
  "SHELL",
  "SHELLOPTS",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSH_AUTH_SOCK",
  "VISUAL",
  "ZDOTDIR",
]);

const LOCKED_CALLER_ENV = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "XDG_CONFIG_HOME",
]);

function mayControlGitExecution(key: string): boolean {
  return (
    (key.startsWith("GIT_") && !SAFE_CALLER_GIT_ENV.has(key)) ||
    key.startsWith("GIT_CONFIG_KEY_") ||
    key.startsWith("GIT_CONFIG_VALUE_") ||
    EXECUTION_ENV.has(key)
  );
}

/** Build a deterministic environment for a privileged engine Git command.
 *
 * Repository programs are disabled by command/config policy below, and this
 * removes every environment escape hatch that can independently select an
 * editor, pager, diff, SSH/proxy command, config injection, remote helper, or
 * dynamic loader. The narrow author/committer/index and TLS path variables are
 * the only `GIT_*` values accepted from an internal caller. */
function gitChildEnv(
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  pruneLauncherScriptEnv(env, process.env);
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || EXECUTION_ENV.has(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (LOCKED_CALLER_ENV.has(key) || mayControlGitExecution(key)) continue;
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const key of SAFE_CALLER_GIT_ENV) {
    const value = extra?.[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_EDITOR: "true",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
  };
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

/** Classify the transport failures emitted by Git/curl/ssh across push, fetch,
 * pull, and clone. Keeping this in one place prevents each call site from
 * recognizing a different subset of Git's platform-dependent wording. */
export function classifyGitTransportError(
  stderr: string,
): GitErrorCode | undefined {
  if (
    // "told us to quit" is the broker's own fail-closed signal: Zeros owns this
    // host but the selected method has no usable credential yet. That IS an
    // authentication outcome — it must reach the reconnect UI and the one-shot
    // rotation retry below, not fall through as a generic command failure.
    //
    // `Repository not found` belongs here too: GitHub deliberately answers a
    // revoked token, or a repo outside the GitHub App's installation, with a
    // 404-shaped "not found" rather than a 403, so this is the MOST common way
    // an auth failure actually presents. Without it the reconnect affordance and
    // the rotation retry were both lost to a bare GIT_COMMAND_FAILED.
    //
    // The status-code and permission alternatives are anchored to the phrasing
    // git/curl actually emit. A bare `permission denied` matched local
    // filesystem errors ("unable to unlink old 'x': Permission denied"), and a
    // bare `\b403\b` matched any object path or byte count containing 403 —
    // both then told the user to reconnect GitHub and, worse, triggered a
    // GitHub App refresh-token rotation for a non-auth failure.
    /not authenticated|authentication failed|invalid username or password|could not read (?:username|password)|terminal prompts disabled|told us to quit|http basic: access denied|permission denied \((?:publickey|password)|remote: (?:permission|write access) (?:denied|to repository not granted)|remote: repository not found|repository '[^']*' not found|(?:requested url returned error|the requested url returned error): (?:401|403)\b/i.test(
      stderr,
    )
  ) {
    return "NOT_AUTHENTICATED";
  }
  if (
    // TLS/proxy/transport breakage is a network outcome, not a mystery command
    // failure: "you may be offline" is the honest thing to tell the user.
    /could not resolve host|network is unreachable|failed to connect|connection (?:refused|reset)|operation timed out|connection timed out|couldn't connect to server|server certificate verification failed|ssl (?:certificate problem|connect error)|gnutls_handshake|early eof|rpc failed|(?:requested url returned error): (?:50\d|429)\b|proxy connect aborted|unexpected disconnect while reading sideband/i.test(
      stderr,
    )
  ) {
    return "NETWORK_ERROR";
  }
  return undefined;
}

/** The user-facing next step for a transport failure.
 *
 *  `runGit` attaches this to the GitError it throws, because the message it
 *  carries is the command line (`git push -u origin zeros/foo failed`) and the
 *  renderer's shared description mapping prefers `remediation` when there is
 *  one — without this, "Couldn't push" was explained with a git invocation.
 *
 *  The auth sentence deliberately does NOT say "sign in": GitHub answers a
 *  repository outside the selected connection's reach with the same
 *  "Repository not found" it uses for a revoked token, so the copy has to hold
 *  for both. (Callers that can tell the two apart — the Create PR control, via
 *  getWorkspaceRepoAccess — say something more specific.) */
export function gitTransportRemediation(
  code: GitErrorCode,
): string | undefined {
  if (code === "NOT_AUTHENTICATED") {
    return "GitHub refused this operation. Check Settings → Integrations, and that the connected account can access this repository.";
  }
  if (code === "NETWORK_ERROR") {
    return "Couldn't reach the remote. Check your connection, then try again.";
  }
  return undefined;
}

const NETWORK_GIT_COMMANDS = new Set([
  "clone",
  "fetch",
  "ls-remote",
  "pull",
  "push",
]);

/** Options whose value is the next argv entry. Git accepts a large option
 * surface for network commands; treating every non-flag as the remote mistakes
 * values such as the `1` in `fetch --depth 1 origin` for a repository. Keep the
 * parsing deliberately command-scoped and let `--option=value` remain one
 * self-contained flag. */
const NETWORK_OPTIONS_WITH_VALUE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  clone: new Set([
    "-b",
    "--branch",
    "-c",
    "--config",
    "--depth",
    "--filter",
    "-j",
    "--jobs",
    "-o",
    "--origin",
    "--reference",
    "--reference-if-able",
    "--revision",
    "--separate-git-dir",
    "--server-option",
    "--shallow-exclude",
    "--shallow-since",
    "--template",
    "-u",
    "--upload-pack",
  ]),
  fetch: new Set([
    "--deepen",
    "--depth",
    "--filter",
    "-j",
    "--jobs",
    "--negotiation-tip",
    "--refmap",
    "--recurse-submodules",
    "--server-option",
    "--shallow-exclude",
    "--shallow-since",
    "--upload-pack",
  ]),
  "ls-remote": new Set(["--server-option", "--sort", "--upload-pack"]),
  pull: new Set([
    "--deepen",
    "--depth",
    "--filter",
    "-j",
    "--jobs",
    "--negotiation-tip",
    "--refmap",
    "--recurse-submodules",
    "-s",
    "--server-option",
    "--shallow-exclude",
    "--shallow-since",
    "--strategy",
    "--strategy-option",
    "--upload-pack",
    "-X",
  ]),
  push: new Set(["--exec", "-o", "--push-option", "--receive-pack", "--repo"]),
};

/** Git's own global options that consume the following argv entry. Needed to
 * find the SUBCOMMAND position, which is the only place a network command can
 * appear. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);

/** Index of the git SUBCOMMAND, or -1 when argv has none. Matching anywhere in
 * argv would mistake an argument that merely happens to read like a command —
 * `stash push`'s subcommand, or a `-m` message — for a network operation, which
 * then resolves that value as a remote. */
function subcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value) continue;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(value)) {
      i += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return i;
  }
  return -1;
}

const ENGINE_GIT_BUILTINS = new Set([
  "add",
  "apply",
  "branch",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-ref-format",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "commit-tree",
  "config",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "fetch",
  "for-each-ref",
  "hash-object",
  "init",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge",
  "merge-base",
  "merge-tree",
  "mv",
  "pull",
  "push",
  "read-tree",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "revert",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "sparse-checkout",
  "stash",
  "status",
  "switch",
  "symbolic-ref",
  "tag",
  "update-index",
  "update-ref",
  "var",
  "worktree",
  "write-tree",
]);

const SAFE_CALLER_CONFIG_KEYS = new Set([
  "core.quotepath",
  "user.email",
  "user.name",
]);

export interface ParsedEngineGitCommand {
  globalArgs: string[];
  command: string;
  commandArgs: string[];
}

function unsafeGitInvocation(message: string): GitError {
  return new GitError({
    code: "VALIDATION_FAILED",
    message,
    remediation:
      "Run repository-defined Git extensions in an agent or a Terminal tab instead.",
  });
}

function assertSafeCallerConfig(value: string): void {
  const separator = value.indexOf("=");
  if (separator < 1 || value.includes("\0") || value.length > 4_096) {
    throw unsafeGitInvocation("Engine Git received an invalid -c setting.");
  }
  const key = value.slice(0, separator).toLowerCase();
  const configValue = value.slice(separator + 1);
  if (key === "core.editor") {
    if (configValue === "true") return;
  } else if (key === "sequence.editor") {
    if (configValue === "true") return;
  } else if (SAFE_CALLER_CONFIG_KEYS.has(key)) {
    return;
  }
  throw unsafeGitInvocation(
    `Engine Git refuses the authority-changing config key “${key}”.`,
  );
}

export function parseEngineGitCommand(
  args: string[],
): ParsedEngineGitCommand {
  const commandIndex = subcommandIndex(args);
  if (commandIndex < 0) {
    throw unsafeGitInvocation(
      "Engine Git requires an explicit built-in command.",
    );
  }
  for (let index = 0; index < commandIndex; index += 1) {
    const value = args[index];
    if (value === "-c") {
      const setting = args[index + 1];
      if (!setting) {
        throw unsafeGitInvocation("Engine Git received -c without a value.");
      }
      assertSafeCallerConfig(setting);
      index += 1;
      continue;
    }
    if (value === "--no-pager" || value === "-P") continue;
    throw unsafeGitInvocation(
      `Engine Git refuses the global option “${value ?? ""}”.`,
    );
  }
  const command = args[commandIndex]!;
  if (!ENGINE_GIT_BUILTINS.has(command)) {
    throw unsafeGitInvocation(
      `Engine Git refuses the external or aliased command “${command}”.`,
    );
  }
  return {
    globalArgs: args.slice(0, commandIndex),
    command,
    commandArgs: args.slice(commandIndex + 1),
  };
}

const OPTIONS_WITH_VALUES = new Set([
  "--author",
  "--branch",
  "--date",
  "--deepen",
  "--depth",
  "--file",
  "--filter",
  "--fixup",
  "--format",
  "--grep",
  "--jobs",
  "--max-count",
  "--message",
  "--negotiation-tip",
  "--origin",
  "--pathspec-from-file",
  "--pretty",
  "--push-option",
  "--reference",
  "--reference-if-able",
  "--refmap",
  "--repo",
  "--revision",
  "--separate-git-dir",
  "--server-option",
  "--shallow-exclude",
  "--shallow-since",
  "--since",
  "--sort",
  "--squash",
  "--strategy-option",
  "--trailer",
  "--until",
  "-b",
  "-F",
  "-j",
  "-m",
  "-o",
  "-X",
]);

function optionName(value: string): string {
  const equals = value.indexOf("=");
  return equals < 0 ? value : value.slice(0, equals);
}

function assertNoExecutableCommandOptions(
  command: string,
  commandArgs: readonly string[],
): void {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const value = commandArgs[index]!;
    if (value === "--") break;
    if (!value.startsWith("-")) continue;
    const name = optionName(value);
    const signing =
      (command === "commit" || command === "tag") &&
      (name === "-S" || name === "-s" || name === "--gpg-sign");
    const trailerCommand = command === "commit" && name === "--trailer";
    const editor = command === "config" && (name === "-e" || name === "--edit");
    const customStrategy =
      (command === "merge" || command === "pull" || command === "rebase") &&
      (name === "-s" || name === "--strategy");
    const remoteProgram =
      (command === "clone" ||
        command === "fetch" ||
        command === "pull" ||
        command === "push") &&
      (name === "--exec" ||
        name === "--receive-pack" ||
        name === "--upload-pack");
    const cloneProgram =
      command === "clone" &&
      (name === "-c" ||
        name === "--config" ||
        name === "--template" ||
        name === "-u");
    const recursiveProgram =
      (command === "checkout" ||
        command === "clone" ||
        command === "fetch" ||
        command === "pull") &&
      (name === "--recurse-submodules" ||
        name === "--remote-submodules" ||
        name === "--shallow-submodules");
    const rebaseExec =
      command === "rebase" && (name === "-x" || name === "--exec");
    if (
      signing ||
      trailerCommand ||
      editor ||
      customStrategy ||
      remoteProgram ||
      cloneProgram ||
      recursiveProgram ||
      rebaseExec ||
      name === "--ext-diff" ||
      name === "--textconv"
    ) {
      throw unsafeGitInvocation(
        `Engine Git refuses the executable option “${name}” for ${command}.`,
      );
    }
    if (!value.includes("=") && OPTIONS_WITH_VALUES.has(name)) index += 1;
  }
}

let emptyEngineGitDirectory: string | null = null;
let emptyEngineGitConsumerGid: number | null = null;

function engineGitEmptyDirectory(identity?: {
  uid: number;
  gid: number;
}): string {
  if (!emptyEngineGitDirectory) {
    emptyEngineGitDirectory = mkdtempSync(
      path.join(tmpdir(), "zeros-engine-git-empty-"),
    );
    chmodSync(emptyEngineGitDirectory, 0o700);
  }
  if (identity && emptyEngineGitConsumerGid !== identity.gid) {
    if (emptyEngineGitConsumerGid !== null) {
      throw unsafeGitInvocation(
        "Engine Git already serves a different cloud worker group.",
      );
    }
    const ownerUid = process.geteuid?.();
    if (ownerUid !== 0) {
      if (
        ownerUid !== identity.uid ||
        (process.getegid?.() !== identity.gid &&
          !(process.getgroups?.() ?? []).includes(identity.gid))
      ) {
        throw unsafeGitInvocation(
          "Engine Git cannot grant its policy directory to this worker.",
        );
      }
    } else {
      chownSync(emptyEngineGitDirectory, 0, identity.gid);
    }
    chmodSync(emptyEngineGitDirectory, 0o750);
    emptyEngineGitConsumerGid = identity.gid;
  }
  return emptyEngineGitDirectory;
}

interface GitConfigEntry {
  origin: string;
  key: string;
  value: string;
}

function parseOriginConfigList(stdout: string): GitConfigEntry[] {
  const fields = stdout.split("\0");
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const origin = fields[index] ?? "";
    const record = fields[index + 1] ?? "";
    if (!origin || !record) continue;
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? "" : record.slice(newline + 1);
    if (
      key.length === 0 ||
      key.length > 4_096 ||
      /[\0\r\n=]/.test(key) ||
      origin.length > 16_384 ||
      /[\0\r\n]/.test(origin) ||
      value.length > 1024 * 1024
    ) {
      throw unsafeGitInvocation("Engine Git produced an unsafe config entry.");
    }
    entries.push({
      origin,
      key,
      value,
    });
  }
  return entries;
}

function pathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function findWorktreeTerritory(cwd: string): {
  root: string;
  metadata: string[];
} | null {
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = path.join(current, ".git");
    try {
      let descriptor: number;
      try {
        descriptor = openSync(
          dotGit,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (error) {
        // Windows does not consistently allow opening a directory as a file
        // descriptor. This fallback never reads a checked path; it only
        // preserves recognition of a physical .git directory there.
        const value = lstatSync(dotGit);
        if (value.isDirectory() && !value.isSymbolicLink()) {
          return { root: current, metadata: [realpathSync(dotGit)] };
        }
        throw error;
      }
      try {
        const value = fstatSync(descriptor);
        const currentEntry = lstatSync(dotGit);
        if (
          currentEntry.isSymbolicLink() ||
          currentEntry.dev !== value.dev ||
          currentEntry.ino !== value.ino
        ) {
          throw new Error("unstable .git entry");
        }
        if (value.isDirectory()) {
          return { root: current, metadata: [realpathSync(dotGit)] };
        }
        if (!value.isFile() || value.nlink !== 1) {
          throw new Error("unsupported .git entry");
        }
        const source = readFileSync(descriptor, "utf8").slice(0, 16_384);
        const match = /^gitdir:\s*(.+?)\s*$/im.exec(source);
        if (match?.[1]) {
          const gitDir = realpathSync(path.resolve(current, match[1]));
          const metadata = [gitDir];
          try {
            const common = readFileSync(
              path.join(gitDir, "commondir"),
              "utf8",
            ).trim();
            if (common)
              metadata.push(realpathSync(path.resolve(gitDir, common)));
          } catch {
            /* a standalone .git file has no commondir */
          }
          return { root: current, metadata };
        }
      } finally {
        closeSync(descriptor);
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolve a path to its physical spelling even when its leaf does not exist.
 *
 * Git can report a config/include path through a host alias (`/var` on macOS,
 * a worktree symlink, etc.). Comparing that lexical spelling with the physical
 * repository root would otherwise let code-owned configuration escape the
 * territory check. Walking to the nearest existing ancestor also keeps a
 * currently-missing include inside code territory classified correctly if it
 * appears before a later invocation. */
function physicalPath(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function pathSpellings(candidate: string): string[] {
  const lexical = path.resolve(candidate);
  const physical = physicalPath(lexical);
  return lexical === physical ? [lexical] : [lexical, physical];
}

function configOriginPaths(
  origin: string,
  cwd: string,
  territory: ReturnType<typeof findWorktreeTerritory>,
): string[] {
  if (!origin.startsWith("file:")) return [];
  const value = origin.slice("file:".length);
  if (!value) return [];
  // Git renders repository-local origins as `file:.git/config` even when the
  // command cwd is a nested directory. Anchor relative origins at the detected
  // worktree root; resolving them from the nested cwd invents a code-owned
  // `.git` path and makes every safe engine Git command fail closed.
  return pathSpellings(path.resolve(territory?.root ?? cwd, value));
}

function resolveIncludePaths(
  value: string,
  origin: string,
  cwd: string,
  territory: ReturnType<typeof findWorktreeTerritory>,
): string[] {
  let candidates: string[];
  if (value.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) return [];
    candidates = [path.join(home, value.slice(2))];
  } else if (value.includes("%(prefix)")) {
    return [];
  } else if (path.isAbsolute(value)) {
    candidates = [value];
  } else {
    candidates = configOriginPaths(origin, cwd, territory).map(
      (originPath) => path.resolve(path.dirname(originPath), value),
    );
  }
  return [...new Set(candidates.flatMap(pathSpellings))];
}

function assertNoCodeWritableConfig(
  territory: ReturnType<typeof findWorktreeTerritory>,
  entries: readonly GitConfigEntry[],
  cwd: string,
): void {
  if (!territory) return;
  const isMetadata = (candidate: string): boolean =>
    territory.metadata.some((metadata) => pathInside(candidate, metadata));
  for (const entry of entries) {
    const unsafeOrigin = configOriginPaths(entry.origin, cwd, territory).find(
      (origin) => pathInside(origin, territory.root) && !isMetadata(origin),
    );
    if (unsafeOrigin) {
      throw unsafeGitInvocation(
        `Engine Git refuses configuration loaded from code territory: ${unsafeOrigin}`,
      );
    }
    const lower = entry.key.toLowerCase();
    if (
      lower === "include.path" ||
      (lower.startsWith("includeif.") && lower.endsWith(".path"))
    ) {
      const unsafeInclude = resolveIncludePaths(
        entry.value,
        entry.origin,
        cwd,
        territory,
      ).find(
        (includePath) =>
          pathInside(includePath, territory.root) && !isMetadata(includePath),
      );
      if (unsafeInclude) {
        throw unsafeGitInvocation(
          `Engine Git refuses a config include from code territory: ${unsafeInclude}`,
        );
      }
    }
  }
}

function neutralConfigValue(key: string): string | null {
  const lower = key.toLowerCase();
  if (lower.startsWith("alias.")) return "";
  if (/^filter\..+\.(?:clean|smudge|process)$/.test(lower)) return "";
  if (/^filter\..+\.required$/.test(lower)) return "false";
  if (/^diff\..+\.(?:command|textconv)$/.test(lower)) return "";
  if (/^merge\..+\.driver$/.test(lower)) return "false";
  if (/^credential(?:\..+)?\.helper$/.test(lower)) return "";
  if (/^(?:browser|difftool|guitool|mergetool|man)\..+\.cmd$/.test(lower)) {
    return "false";
  }
  if (/^trailer\..+\.(?:cmd|command)$/.test(lower)) return "false";
  if (/^tar\..+\.command$/.test(lower)) return "false";
  if (/^pager\./.test(lower)) return "cat";
  if (/^gpg(?:\..+)?\.program$/.test(lower)) return "false";
  if (lower === "gpg.ssh.defaultkeycommand") return "false";
  if (/^submodule\..+\.update$/.test(lower)) return "checkout";
  if (/^remote\..+\.vcs$/.test(lower)) return "";
  if (/^remote\..+\.uploadpack$/.test(lower)) return "git-upload-pack";
  if (/^remote\..+\.receivepack$/.test(lower)) return "git-receive-pack";
  if (/^remote\..+\.proxy$/.test(lower)) return "none";
  return null;
}

function configArgs(entries: readonly (readonly [string, string])[]): string[] {
  return entries.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

interface EngineGitPolicyCacheEntry {
  dynamic: Array<readonly [string, string]>;
  fingerprints: ReadonlyMap<string, string>;
  refreshAfter: number;
}

const engineExecutableCache = new Map<string, string>();

function engineExecutable(name: string): string {
  const enginePath = process.env.PATH ?? "";
  const cacheKey = `${name}\0${enginePath}`;
  const cached = engineExecutableCache.get(cacheKey);
  if (cached) return cached;
  for (const directory of enginePath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isFile()) {
        engineExecutableCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch {
      /* keep searching the engine-authored PATH */
    }
  }
  throw unsafeGitInvocation(`Engine ${name} executable is unavailable.`);
}

export function engineGitBinary(): string {
  return engineExecutable("git");
}

function engineSshBinary(): string {
  const testCommand = process.env.ZEROS_TEST_GIT_SSH_COMMAND;
  if (process.env.NODE_ENV === "test" && testCommand) {
    if (
      !path.isAbsolute(testCommand) ||
      testCommand.includes("\0") ||
      !statSync(testCommand).isFile()
    ) {
      throw unsafeGitInvocation("Engine SSH test executable is invalid.");
    }
    return realpathSync(testCommand);
  }
  return engineExecutable("ssh");
}

const ENGINE_GIT_POLICY_CACHE_MS = 5_000;
const MAX_ENGINE_GIT_POLICY_CACHE_ENTRIES = 512;
const engineGitPolicyCache = new Map<string, EngineGitPolicyCacheEntry>();
const engineGitPolicyFlights = new Map<
  string,
  Promise<Array<readonly [string, string]>>
>();

function configContext(
  cwd: string,
  territory: ReturnType<typeof findWorktreeTerritory>,
): string {
  if (territory) {
    return `${territory.root}\0${territory.metadata.join("\0")}`;
  }
  try {
    return `nonrepo\0${realpathSync(cwd)}`;
  } catch {
    return `nonrepo\0${path.resolve(cwd)}`;
  }
}

function configFileFingerprint(candidate: string): string {
  try {
    const link = lstatSync(candidate, { bigint: true });
    let target = candidate;
    try {
      target = realpathSync(candidate);
    } catch {
      /* The lstat identity is sufficient for a dangling symlink. */
    }
    const value = statSync(target, { bigint: true });
    return [
      link.dev,
      link.ino,
      link.size,
      link.mtimeNs,
      link.ctimeNs,
      target,
      value.dev,
      value.ino,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ].join(":");
  } catch {
    return "missing";
  }
}

function configSourcePaths(
  territory: ReturnType<typeof findWorktreeTerritory>,
  entries: readonly GitConfigEntry[],
  cwd: string,
): string[] {
  const candidates = new Set<string>();
  for (const entry of entries) {
    for (const origin of configOriginPaths(entry.origin, cwd, territory)) {
      candidates.add(origin);
    }
    const lower = entry.key.toLowerCase();
    if (
      lower === "include.path" ||
      (lower.startsWith("includeif.") && lower.endsWith(".path"))
    ) {
      for (const includePath of resolveIncludePaths(
        entry.value,
        entry.origin,
        cwd,
        territory,
      )) {
        candidates.add(includePath);
      }
    }
  }
  const home = process.env.HOME;
  if (home) {
    candidates.add(path.join(home, ".gitconfig"));
    candidates.add(
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        "git",
        "config",
      ),
    );
  }
  candidates.add("/etc/gitconfig");
  for (const metadata of territory?.metadata ?? []) {
    candidates.add(path.join(metadata, "config"));
    candidates.add(path.join(metadata, "config.worktree"));
  }
  return [...candidates];
}

function configFingerprints(paths: readonly string[]): Map<string, string> {
  return new Map(
    paths.map((candidate) => [candidate, configFileFingerprint(candidate)]),
  );
}

function policyCacheIsCurrent(entry: EngineGitPolicyCacheEntry): boolean {
  if (Date.now() >= entry.refreshAfter) return false;
  for (const [candidate, fingerprint] of entry.fingerprints) {
    if (configFileFingerprint(candidate) !== fingerprint) return false;
  }
  return true;
}

async function dynamicEngineGitPolicy(
  cwd: string,
  callerGlobalArgs: readonly string[],
  env: Record<string, string | undefined>,
): Promise<Array<readonly [string, string]>> {
  const territory = findWorktreeTerritory(cwd);
  const cacheKey = configContext(cwd, territory);
  const cached = engineGitPolicyCache.get(cacheKey);
  if (cached && policyCacheIsCurrent(cached)) return cached.dynamic;
  const existing = engineGitPolicyFlights.get(cacheKey);
  if (existing) return existing;

  const flight = (async (): Promise<Array<readonly [string, string]>> => {
    const { stdout } = await runFile(
      "git",
      [
        ...callerGlobalArgs,
        "config",
        "--show-origin",
        "--null",
        "--list",
        "--includes",
      ],
      { cwd, env, timeoutMs: 5_000, maxBufferBytes: 4 * 1024 * 1024 },
    );
    const entries = parseOriginConfigList(stdout);
    if (entries.length > 8_192) {
      throw unsafeGitInvocation(
        "Engine Git configuration exceeds the safety limit.",
      );
    }
    assertNoCodeWritableConfig(territory, entries, cwd);
    const dynamic = new Map<string, readonly [string, string]>();
    for (const entry of entries) {
      const value = neutralConfigValue(entry.key);
      if (value !== null) {
        dynamic.set(entry.key.toLowerCase(), [entry.key, value]);
      }
    }
    const result = [...dynamic.values()];
    if (
      result.length > 1_024 ||
      result.reduce(
        (bytes, [key, value]) => bytes + key.length + value.length,
        0,
      ) >
        64 * 1024
    ) {
      throw unsafeGitInvocation(
        "Engine Git executable configuration exceeds the safety limit.",
      );
    }
    const sources = configSourcePaths(territory, entries, cwd);
    engineGitPolicyCache.delete(cacheKey);
    engineGitPolicyCache.set(cacheKey, {
      dynamic: result,
      fingerprints: configFingerprints(sources),
      refreshAfter: Date.now() + ENGINE_GIT_POLICY_CACHE_MS,
    });
    while (engineGitPolicyCache.size > MAX_ENGINE_GIT_POLICY_CACHE_ENTRIES) {
      const oldest = engineGitPolicyCache.keys().next().value;
      if (typeof oldest !== "string") break;
      engineGitPolicyCache.delete(oldest);
    }
    return result;
  })();
  engineGitPolicyFlights.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    if (engineGitPolicyFlights.get(cacheKey) === flight) {
      engineGitPolicyFlights.delete(cacheKey);
    }
  }
}

async function engineGitPolicyArgs(
  cwd: string,
  callerGlobalArgs: readonly string[],
  env: Record<string, string | undefined>,
  command: string,
  allowSsh: boolean,
  identity?: { uid: number; gid: number },
): Promise<string[]> {
  const dynamic = await dynamicEngineGitPolicy(cwd, callerGlobalArgs, env);
  const empty = engineGitEmptyDirectory(identity);
  return configArgs([
    ...dynamic,
    ["commit.gpgSign", "false"],
    ["core.alternateRefsCommand", ""],
    ["core.askPass", ""],
    ["core.editor", "true"],
    ["core.fsmonitor", "false"],
    ["core.gitProxy", "none"],
    ["core.hooksPath", empty],
    ["core.pager", "cat"],
    ["core.sshCommand", allowSsh ? engineSshBinary() : "false"],
    ["core.useReplaceRefs", "false"],
    ["credential.helper", ""],
    ["diff.external", ""],
    ["fetch.recurseSubmodules", "false"],
    ["gc.recentObjectsHook", ""],
    ["gpg.program", "false"],
    ["gpg.ssh.defaultKeyCommand", "false"],
    ["gpg.ssh.program", "false"],
    ["gpg.x509.program", "false"],
    ["init.templateDir", empty],
    ["interactive.diffFilter", ""],
    ["merge.default", "text"],
    [`pager.${command}`, "cat"],
    ["protocol.allow", "never"],
    ["protocol.bundle.allow", "always"],
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", "always"],
    ["protocol.git.allow", "always"],
    ["protocol.http.allow", "always"],
    ["protocol.https.allow", "always"],
    ["protocol.ssh.allow", allowSsh ? "always" : "never"],
    ["sequence.editor", "true"],
    ["submodule.recurse", "false"],
    ["tag.gpgSign", "false"],
    ["uploadpack.packObjectsHook", ""],
  ]);
}

function safeDiffArgs(command: string, args: readonly string[]): string[] {
  if (
    command === "diff" ||
    command === "diff-files" ||
    command === "diff-index" ||
    command === "diff-tree" ||
    command === "log" ||
    command === "show"
  ) {
    return ["--no-ext-diff", "--no-textconv", ...args];
  }
  return [...args];
}

function firstNetworkRemote(
  args: string[],
  commandIndex: number,
  command: string,
): string | null {
  const optionsWithValue = NETWORK_OPTIONS_WITH_VALUE[command] ?? new Set();
  for (let i = commandIndex + 1; i < args.length; i += 1) {
    const value = args[i];
    if (!value) continue;
    if (value === "--") {
      return args[i + 1] ?? null;
    }
    // `git push --repo <repository>` carries the target in an option rather
    // than a positional. Its long `--repo=<repository>` spelling does too.
    if (command === "push" && value.startsWith("--repo=")) {
      return value.slice("--repo=".length) || null;
    }
    if (optionsWithValue.has(value)) {
      const optionValue = args[i + 1];
      if (command === "push" && value === "--repo") {
        return optionValue ?? null;
      }
      i += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value;
  }
  return null;
}

/** Resolve the remote Git itself will use for a no-argument pull. Pull's
 * positional repository is optional when the current branch has an upstream;
 * transport hardening still needs that remote before the child starts so SSH
 * and credential capabilities are scoped correctly. */
async function configuredPullRemote(cwd: string): Promise<string | null> {
  try {
    const branch = await runFile(
      "git",
      ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { timeoutMs: 5_000, env: gitChildEnv() },
    );
    const branchName = branch.stdout.trim();
    if (!branchName) return null;
    const configured = await runFile(
      "git",
      ["-C", cwd, "config", "--get", `branch.${branchName}.remote`],
      { timeoutMs: 5_000, env: gitChildEnv() },
    );
    return configured.stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseHttpRemote(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseSshRemote(value: string): URL | "scp" | null {
  if (/^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "ssh:" && parsed.hostname ? parsed : null;
    } catch {
      return null;
    }
  }
  if (
    value.length === 0 ||
    value.length > 16_384 ||
    value.startsWith("-") ||
    /[\0-\x20\x7f\\]/.test(value) ||
    value.includes("://")
  ) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const authority = value.slice(0, separator);
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : authority.slice(at + 1);
  if (
    authority.includes("/") ||
    !host ||
    (host.startsWith("[")
      ? !/^\[[0-9A-Fa-f:.]+\]$/.test(host)
      : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(host)) ||
    (at >= 0 && !/^[A-Za-z0-9._-]{1,255}$/.test(authority.slice(0, at)))
  ) {
    return null;
  }
  return "scp";
}

function isNetworkRemote(value: string): boolean {
  return Boolean(parseHttpRemote(value) || parseSshRemote(value));
}

function decodedUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function networkCredentialRequest(
  cwd: string,
  args: string[],
): Promise<{
  network: boolean;
  transport: "http" | "ssh" | null;
  request: GitCredentialRequest | null;
  hasEmbeddedCredential: boolean;
}> {
  const candidateIndex = subcommandIndex(args);
  const commandIndex =
    candidateIndex >= 0 && NETWORK_GIT_COMMANDS.has(args[candidateIndex]!)
      ? candidateIndex
      : -1;
  if (commandIndex < 0) {
    return {
      network: false,
      transport: null,
      request: null,
      hasEmbeddedCredential: false,
    };
  }
  const command = args[commandIndex];
  let target = firstNetworkRemote(args, commandIndex, command);
  if (!target && command === "pull") {
    target = await configuredPullRemote(cwd);
  }
  if (!target) {
    return {
      network: true,
      transport: null,
      request: null,
      hasEmbeddedCredential: false,
    };
  }

  // clone takes a URL directly. Other network commands generally take a
  // configured remote name; resolve it without crossing the broker seam.
  if (command !== "clone" && !isNetworkRemote(target)) {
    try {
      const resolved = await runFile(
        "git",
        ["-C", cwd, "remote", "get-url", target],
        { timeoutMs: 5_000, env: gitChildEnv() },
      );
      target = resolved.stdout.trim();
    } catch {
      return {
        network: true,
        transport: null,
        request: null,
        hasEmbeddedCredential: false,
      };
    }
  }

  const parsed = parseHttpRemote(target);
  if (!parsed) {
    const ssh = parseSshRemote(target);
    return {
      network: true,
      transport: ssh ? "ssh" : null,
      request: null,
      hasEmbeddedCredential:
        ssh instanceof URL
          ? Boolean(ssh.password || ssh.search || ssh.hash)
          : false,
    };
  }
  const protocol = parsed.protocol.slice(0, -1) as "http" | "https";
  return {
    network: true,
    transport: "http",
    // A password, query, or fragment can bypass the selected method or carry a
    // bearer into argv/config. A bare
    // `https://alice@github.com/o/r.git` — the common legacy form git itself
    // handles fine — carries no secret: git asks for the password, and the
    // broker answers with the selected credential. Rejecting it made push,
    // fetch, ls-remote, and Create PR all fail on those repositories.
    hasEmbeddedCredential: Boolean(
      parsed.password || parsed.search || parsed.hash,
    ),
    request: {
      contextId: `cwd:${cwd}`,
      protocol,
      host: parsed.hostname.toLowerCase(),
      authority: parsed.host.toLowerCase(),
      ...(parsed.username
        ? { username: decodedUrlComponent(parsed.username) }
        : {}),
      ...(parsed.pathname && parsed.pathname !== "/"
        ? { path: decodedUrlComponent(parsed.pathname.replace(/^\/+/, "")) }
        : {}),
    },
  };
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
  // Never run Git with an empty cwd: execFile would silently
  // fall back to process.cwd() (the engine's own root / main repo), so a
  // git op meant for a workspace could mutate the wrong repository.
  if (!cwd) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `git ${args.join(" ")}: refusing to run with an empty cwd`,
    });
  }
  const parsedCommand = parseEngineGitCommand(args);
  assertNoExecutableCommandOptions(
    parsedCommand.command,
    parsedCommand.commandArgs,
  );
  const networkTarget = await networkCredentialRequest(cwd, args);
  if (networkTarget.hasEmbeddedCredential) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "This remote contains an embedded password, query, or fragment that would bypass the credential broker.",
      remediation:
        "Remove credential material from the remote URL and connect the host through a supported credential method.",
    });
  }
  const credentialInvocation = networkTarget.request
    ? await prepareGitCredentialInvocation(networkTarget.request, {
        ...(process.env.HOME && path.isAbsolute(process.env.HOME)
          ? {
              ambient: {
                gitBinary: engineGitBinary(),
                home: process.env.HOME,
                ...(process.env.XDG_CONFIG_HOME &&
                path.isAbsolute(process.env.XDG_CONFIG_HOME)
                  ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
                  : {}),
              },
            }
          : {}),
        ...(opts.identity ? { consumerIdentity: opts.identity } : {}),
      })
    : null;
  const baseChildEnv = gitChildEnv(opts.env);
  const policyArgs = await engineGitPolicyArgs(
    cwd,
    parsedCommand.globalArgs,
    baseChildEnv,
    parsedCommand.command,
    networkTarget.transport === "ssh",
    opts.identity,
  );
  const childArgs = [
    ...parsedCommand.globalArgs,
    "--no-pager",
    ...policyArgs,
    ...(credentialInvocation?.gitConfigArgs ?? []),
    parsedCommand.command,
    ...safeDiffArgs(parsedCommand.command, parsedCommand.commandArgs),
  ];
  const controlledEnv: Record<string, string | undefined> = {
    ...(networkTarget.network ? { GIT_TERMINAL_PROMPT: "0" } : {}),
    ...(networkTarget.transport === "ssh" &&
    process.env.SSH_AUTH_SOCK &&
    path.isAbsolute(process.env.SSH_AUTH_SOCK) &&
    !process.env.SSH_AUTH_SOCK.includes("\0")
      ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
      : {}),
    ...credentialInvocation?.env,
  };
  let lockAttempt = 0;
  let retriedAuthentication = false;
  try {
    for (;;) {
      try {
        const result = await runFile("git", childArgs, {
          cwd,
          maxBufferBytes: opts.maxBufferBytes,
          timeoutMs: opts.timeoutMs,
          // The caller is filtered first; the engine-owned broker coordinates
          // are applied afterward so settings/env can never redirect askpass or
          // the credential socket.
          env: { ...baseChildEnv, ...controlledEnv },
          input: opts.input,
          signal: opts.signal,
          identity: opts.identity,
        });
        // Some remote helpers have returned exit 0 after their child transport
        // printed a fatal authentication error. Never turn that into a successful
        // push/fetch merely because the wrapper process lost the exit status.
        if (
          networkTarget.network &&
          (/^fatal:/im.test(result.stderr) ||
            /^error: failed to (?:push|fetch) /im.test(result.stderr))
        ) {
          throw Object.assign(new Error("git transport failed"), {
            code: 1,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }
        return result;
      } catch (err) {
        const e = err as ExecFileException & {
          stdout?: string;
          stderr?: string;
        };
        const stderr = String(e.stderr ?? "");
        const stdout = String(e.stdout ?? "");
        // Transient lock contention from a concurrent git process in the same
        // checkout → wait and retry (bounded). git didn't mutate anything (it
        // couldn't take the lock), so re-running is safe. Checked BEFORE the
        // expected-error / mapErrorCode handling so a lock blip never surfaces.
        if (
          isGitLockContention(stderr) &&
          lockAttempt < GIT_LOCK_RETRY_BACKOFF_MS.length
        ) {
          await sleep(GIT_LOCK_RETRY_BACKOFF_MS[lockAttempt]);
          lockAttempt += 1;
          continue;
        }
        // A rejected HTTPS credential means the remote did not authorize the
        // operation, so retrying once after a token rotation cannot duplicate a
        // successful mutation. The broker fetches the replacement lazily; no
        // token is placed in this process's arguments or environment.
        if (
          credentialInvocation &&
          !retriedAuthentication &&
          classifyGitTransportError(stderr) === "NOT_AUTHENTICATED"
        ) {
          retriedAuthentication = true;
          if (
            await refreshGitCredentialAfterAuthenticationFailure(
              credentialInvocation,
            )
          ) {
            lockAttempt = 0;
            continue;
          }
        }
        if (opts.treatAsExpected) {
          const category = classifyExpectedError(stderr, stdout);
          if (category && opts.treatAsExpected.includes(category)) {
            return { stdout, stderr, expectedError: category };
          }
        }
        const code = opts.mapErrorCode?.(stderr) ?? "GIT_COMMAND_FAILED";
        const remediation = gitTransportRemediation(code);
        throw new GitError({
          code,
          message: `git ${redactSensitive(args.join(" "))} failed`,
          ...(remediation ? { remediation } : {}),
          cause: err,
          // Redacted: this context is logged and shipped with feedback, and git's
          // stderr can echo an authenticated remote URL or a helper's output. The
          // scrubbers only cover `message`/`stack`, so 4 KB of raw stderr would
          // otherwise be the one unscrubbed field on the error.
          context: {
            stderr: redactSensitive(stderr.slice(0, 4000)),
            exitCode: e.code,
          },
        });
      }
    }
  } finally {
    credentialInvocation?.release?.();
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
