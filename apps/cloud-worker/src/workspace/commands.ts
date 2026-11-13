import { execFile } from "node:child_process";
import { workerChildEnvironment, mergeGitEnvironment } from "../drivers/shared/agent-environment";
import { WorkspaceError } from "./scope";
import { operationEnvironment } from "../sharing/operation-environment";

export interface CommandOptions {
  input?: string | Uint8Array;
  readOnly?: boolean;
  maxBuffer?: number;
  timeout?: number;
  allowExitCodes?: number[];
}
export interface CommandResult { stdout: string; code: number }
export type CommandRunner = (program: "git" | "gh", args: string[], options?: CommandOptions) => Promise<CommandResult>;

/** Why a Git command failed, as a closed detail read from its stderr inside the worker; the stderr itself (remote
 * URLs, credentials) never leaves. The first matching class wins. */
export const GIT_FAILURE_DETAILS = ["credential_missing", "auth_rejected", "permission_denied", "repository_not_found", "protected_branch",
  "hook_declined", "remote_rejected", "network", "timeout", "other"] as const;
export type GitFailureDetail = typeof GIT_FAILURE_DETAILS[number];
const GIT_FAILURE_PATTERNS: Array<[RegExp, GitFailureDetail]> = [
  [/could not read (?:Username|Password)|terminal prompts disabled/i, "credential_missing"],
  [/Authentication failed|Invalid username or password|HTTP Basic: Access denied/i, "auth_rejected"],
  [/Permission to \S+ denied|Write access to repository not granted|returned error: 403/i, "permission_denied"],
  [/Repository not found|returned error: 404/i, "repository_not_found"],
  [/GH006|protected branch/i, "protected_branch"],
  [/pre-receive hook declined/i, "hook_declined"],
  [/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/i, "remote_rejected"],
  [/Could not resolve host|Failed to connect|Connection (?:timed out|refused|reset)|Operation timed out|SSL|TLS/i, "network"],
];
export function gitFailureDetail(stderr: string, error: { killed?: boolean; signal?: string | null } | null): GitFailureDetail {
  if (error?.killed) return "timeout";
  return GIT_FAILURE_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "other";
}
/** GIT_COMMAND_FAILED with its closed detail. */
export class GitCommandError extends WorkspaceError {
  constructor(readonly detail: GitFailureDetail) { super("GIT_COMMAND_FAILED", "The Git command could not be completed. Check the repository state and try again."); }
}

/** No shell interpolation and no ambient provider/worker credentials. stderr
 * can contain remote URLs and credentials, so it never crosses the bridge. */
export function commandRunner(cwd: string, wiring: NodeJS.ProcessEnv = {}): CommandRunner {
  return (program, args, options = {}) => new Promise((resolve, reject) => {
    const operation = operationEnvironment.getStore();
    const env = operation ? workerChildEnvironment(undefined, mergeGitEnvironment(wiring, operation.git), {}, operation.zeros) : workerChildEnvironment(undefined, wiring);
    env.GIT_TERMINAL_PROMPT = "0"; env.GIT_EDITOR = "true";
    if (options.readOnly) env.GIT_OPTIONAL_LOCKS = "0";
    const child = execFile(program, args, { cwd, env, encoding: "utf8", timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
      if (!error || options.allowExitCodes?.includes(code)) resolve({ stdout, code });
      else if (program === "git" && /^(?:Author|Committer) identity unknown$|^fatal: (?:empty ident name|no email was given|unable to auto-detect email address)/m.test(stderr))
        reject(new WorkspaceError("GIT_IDENTITY_REQUIRED", "Reconnect GitHub in Zeros to configure your commit identity, or set a repository-local Git identity."));
      else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "This result is too large. Select a file to view its changes."));
      else reject(program === "git" ? new GitCommandError(gitFailureDetail(stderr, error))
        : new WorkspaceError("GIT_COMMAND_FAILED", "The Git command could not be completed. Check the repository state and try again."));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });
}

export function safeRef(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new WorkspaceError("VALIDATION_FAILED", "Invalid Git reference.");
  return value;
}

export function boundedInteger(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new WorkspaceError("VALIDATION_FAILED", "Invalid result limit.");
  return value;
}
