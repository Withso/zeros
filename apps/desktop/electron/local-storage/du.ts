import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { LocalStorageStatus } from "../../shared/local-storage";

export interface DuResult {
  status: LocalStorageStatus;
  bytes: number | null;
  reason?: "timeout" | "cancelled" | "errors" | "failed";
}

export interface DuOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Lower bound so far, raised as du finishes each path. */
  onProgress?: (bytes: number) => void;
  /** Tests substitute a fixture; production always runs the system du. */
  command?: string;
}

const SYSTEM_DU = "/usr/bin/du";
// One invocation per category keeps hardlinks counted once across its paths;
// chunks only bound argv for a folder with thousands of top-level entries.
const MAX_PATHS_PER_RUN = 512;

/** Only main-resolved, normalized absolute paths ever reach du. */
export function assertDuPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === path.parse(value).root ||
    value.endsWith(path.sep)
  )
    throw new Error("Refusing to measure an unresolved path.");
}

/**
 * Allocated size of `paths` from one system `du` per chunk of 512 paths: `-P`
 * never follows a symlink and `-x` stays on each path's volume. du counts a
 * hardlinked file once per invocation, so links that fall in different chunks
 * are each counted. The walk runs in a child process so neither Electron's
 * main thread nor the engine walks large trees. A timeout, cancellation or
 * unreadable folder never yields an exact-looking number: completed paths
 * become a lower bound (`partial`), and nothing completed is `unmeasured`.
 */
export async function measureWithDu(paths: readonly string[], options: DuOptions): Promise<DuResult> {
  for (const p of paths) assertDuPath(p);
  if (options.signal?.aborted) return { status: "unmeasured", bytes: null, reason: "cancelled" };
  if (paths.length === 0) return { status: "measured", bytes: 0 };
  const deadline = Date.now() + options.timeoutMs;
  let total = 0;
  let completedAny = false;
  for (let start = 0; start < paths.length; start += MAX_PATHS_PER_RUN) {
    const chunk = paths.slice(start, start + MAX_PATHS_PER_RUN);
    const base = total;
    const run = await runDu(chunk, {
      command: options.command ?? SYSTEM_DU,
      timeoutMs: Math.max(0, deadline - Date.now()),
      signal: options.signal,
      onProgress: options.onProgress && ((bytes) => options.onProgress!(base + bytes)),
    });
    total += run.bytes;
    completedAny ||= run.completed > 0;
    if (run.failure) {
      return completedAny
        ? { status: "partial", bytes: total, reason: run.failure }
        : { status: "unmeasured", bytes: null, reason: run.failure };
    }
  }
  return { status: "measured", bytes: total };
}

interface Parsed {
  bytes: number;
  completed: number;
  offset: number;
  /** Index of the first path whose record has not been matched. */
  next: number;
}

interface RunOutcome {
  bytes: number;
  completed: number;
  failure?: DuResult["reason"];
}

function runDu(
  paths: string[],
  options: { command: string; timeoutMs: number; signal?: AbortSignal; onProgress?: (bytes: number) => void },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let parsed: Parsed = { bytes: 0, completed: 0, offset: 0, next: 0 };
    let ended: DuResult["reason"] | undefined;
    let settled = false;
    const child = spawn(options.command, ["-s", "-k", "-x", "-P", "--", ...paths], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // No inherited BLOCKSIZE, locale or PATH can change units or the binary.
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      windowsHide: true,
    });
    const stop = (reason: DuResult["reason"]) => {
      ended ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    if (child.pid !== undefined) {
      try {
        os.setPriority(child.pid, 10);
      } catch {
        /* best effort: a measurement must never compete with the app */
      }
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const next = parseRecords(stdout, paths, parsed);
      if (next.completed !== parsed.completed) {
        parsed = next;
        options.onProgress?.(parsed.bytes);
      }
    });
    // Drain errors (permission denied, vanished files) without retaining paths.
    child.stderr.resume();
    child.once("error", () => finish({ bytes: 0, completed: 0, failure: "failed" }));
    child.once("close", (code) => {
      parsed = parseRecords(stdout, paths, parsed);
      const complete = parsed.completed === paths.length && parsed.offset === stdout.length;
      const failure = ended ?? (code === 0 && complete ? undefined : "errors");
      finish({ bytes: parsed.bytes, completed: parsed.completed, failure });
    });
  });
}

/** du prints `<KiB>\t<path>\n` per argument, in order. Match each record
 * against the exact path we passed so a newline inside a name cannot forge or
 * hide a record; a path du skipped (it vanished) leaves the run incomplete. */
function parseRecords(output: string, paths: readonly string[], from: Parsed): Parsed {
  let { bytes, completed, offset, next } = from;
  while (next < paths.length) {
    const match = /^(\d+)\t/.exec(output.slice(offset, offset + 24));
    if (!match) break;
    let found = -1;
    for (let candidate = next; candidate < paths.length; candidate++) {
      const record = `${match[1]}\t${paths[candidate]}\n`;
      if (output.startsWith(record, offset)) {
        found = candidate;
        offset += record.length;
        break;
      }
    }
    if (found < 0) break;
    bytes += Number(match[1]) * 1024;
    completed += 1;
    next = found + 1;
  }
  return { bytes, completed, offset, next };
}
