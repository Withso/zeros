import { execFile } from "node:child_process";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { WorkspaceError } from "./scope";

export interface CommandOptions {
  input?: string;
  readOnly?: boolean;
  maxBuffer?: number;
  timeout?: number;
  allowExitCodes?: number[];
}
export interface CommandResult { stdout: string; code: number }
export type CommandRunner = (program: "git" | "gh", args: string[], options?: CommandOptions) => Promise<CommandResult>;

/** No shell interpolation and no ambient provider/worker credentials. stderr
 * can contain remote URLs and credentials, so it never crosses the bridge. */
export function commandRunner(cwd: string, wiring: NodeJS.ProcessEnv = {}): CommandRunner {
  return (program, args, options = {}) => new Promise((resolve, reject) => {
    const env = workerChildEnvironment(undefined, wiring);
    env.GIT_TERMINAL_PROMPT = "0"; env.GIT_EDITOR = "true";
    if (options.readOnly) env.GIT_OPTIONAL_LOCKS = "0";
    const child = execFile(program, args, { cwd, env, encoding: "utf8", timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024 }, (error, stdout) => {
      const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
      if (!error || options.allowExitCodes?.includes(code)) resolve({ stdout, code });
      else reject(new WorkspaceError(error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "GIT_OUTPUT_TOO_LARGE" : "GIT_COMMAND_FAILED",
        error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "This result is too large. Select a file to view its changes." : "The Git command could not be completed. Check the repository state and try again."));
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
