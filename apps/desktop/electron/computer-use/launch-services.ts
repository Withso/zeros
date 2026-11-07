// Launch Services hand-offs for computer use. `open -g` delivers a URL to one
// app without activating it, which is how an agent opens a page in the user's
// browser in one step instead of typing into its address bar.

import { execFile } from "node:child_process";

import { isComputerBundleId } from "@zeros/protocol/computer-use-tools";

const OPEN = "/usr/bin/open";
const OPEN_TIMEOUT_MS = 15_000;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; signal: AbortSignal },
  callback: (error: Error | null) => void,
) => unknown;

export function openUrlInApp(
  bundleId: string,
  url: string,
  signal: AbortSignal,
  run: ExecFileLike = execFile as unknown as ExecFileLike,
): Promise<void> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (
    !isComputerBundleId(bundleId) ||
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    return Promise.reject(new Error("Only http and https URLs can be opened."));
  }
  return new Promise((resolve, reject) => {
    run(
      OPEN,
      ["-g", "-b", bundleId, parsed.href],
      { timeout: OPEN_TIMEOUT_MS, signal },
      (error) => {
        if (error) reject(new Error(`macOS could not open the URL in ${bundleId}.`));
        else resolve();
      },
    );
  });
}
