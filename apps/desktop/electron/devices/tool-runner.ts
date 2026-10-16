// Runs the macOS developer tools DeviceHub depends on. Tools are called by
// absolute path with an argument array, never through a shell, and their
// stderr stays in logs: it can name local paths, so user-facing errors are
// written by DeviceHub instead.

import { execFile } from "node:child_process";

export interface ToolRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Written to stdin, then stdin closes. */
  input?: string;
  /** The whole environment, instead of Zeros' own. */
  env?: NodeJS.ProcessEnv;
}

export interface ToolOutput {
  stdout: string;
  stderr: string;
}

export type ToolRunner = (
  file: string,
  args: readonly string[],
  options?: ToolRunOptions,
) => Promise<ToolOutput>;

export class ToolFailure extends Error {
  constructor(
    readonly tool: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly aborted: boolean,
  ) {
    super(`${tool} failed${exitCode === null ? "" : ` (exit ${exitCode})`}`);
    this.name = "ToolFailure";
  }
}

export const XCRUN = "/usr/bin/xcrun";
export const XCODE_SELECT = "/usr/bin/xcode-select";
export const XCODEBUILD = "/usr/bin/xcodebuild";
export const PLUTIL = "/usr/bin/plutil";
export const SYSCTL = "/usr/sbin/sysctl";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const runTool: ToolRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: options.signal,
        ...(options.env ? { env: options.env } : {}),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        reject(
          new ToolFailure(
            file.split("/").pop() ?? file,
            String(stderr ?? "").slice(-4_000),
            typeof code === "number" ? code : null,
            options.signal?.aborted === true || error.name === "AbortError",
          ),
        );
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
