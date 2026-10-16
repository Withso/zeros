// What the iOS Simulator tab needs before it can show a device: Xcode itself
// (Command Line Tools alone have no simulators) and an iOS runtime.

import type { ChildProcess } from "node:child_process";

import type { SimulatorSetupState } from "@zeros/protocol/simulators";

import { SYSCTL, XCODEBUILD, XCODE_SELECT, XCRUN, type ToolRunner } from "./tool-runner";

export interface IosSetupProbe {
  state: Exclude<SimulatorSetupState, "checking" | "unsupported">;
  toolLabel: string | null;
}

export function iosRuntimeAvailable(json: string): boolean {
  try {
    const root = JSON.parse(json) as { runtimes?: unknown };
    return (
      Array.isArray(root.runtimes) &&
      root.runtimes.some(
        (runtime) =>
          !!runtime &&
          typeof runtime === "object" &&
          (runtime as Record<string, unknown>).platform === "iOS" &&
          (runtime as Record<string, unknown>).isAvailable === true,
      )
    );
  } catch {
    return false;
  }
}

/** "Xcode 27.0" from `xcodebuild -version`. */
export function xcodeVersionLabel(output: string): string | null {
  const match = /^Xcode (\d+(?:\.\d+){0,2})\s*$/m.exec(output);
  return match ? `Xcode ${match[1]}` : null;
}

export async function probeIosSetup(run: ToolRunner): Promise<IosSetupProbe> {
  let developerDir: string;
  try {
    developerDir = (await run(XCODE_SELECT, ["-p"], { timeoutMs: 10_000 })).stdout.trim();
  } catch {
    return { state: "tools-missing", toolLabel: null };
  }
  if (!developerDir || developerDir.includes("/CommandLineTools")) {
    return { state: "tools-missing", toolLabel: null };
  }
  try {
    await run(XCRUN, ["--find", "simctl"], { timeoutMs: 10_000 });
  } catch {
    return { state: "tools-missing", toolLabel: null };
  }
  // A first launch that still needs the license or components can fail here
  // while simctl works, so the label is optional.
  const toolLabel = await run(XCODEBUILD, ["-version"], { timeoutMs: 15_000 }).then(
    ({ stdout }) => xcodeVersionLabel(stdout),
    () => null,
  );
  try {
    const { stdout } = await run(XCRUN, ["simctl", "list", "runtimes", "-j"], {
      timeoutMs: 20_000,
    });
    return {
      state: iosRuntimeAvailable(stdout) ? "ready" : "runtime-missing",
      toolLabel,
    };
  } catch {
    return { state: "runtime-missing", toolLabel };
  }
}

/** Bytes of memory macOS could give a new simulator, from `sysctl -n
 * kern.memorystatus_level hw.memsize`. The level is the free percentage the
 * kernel's memory pressure uses; free pages alone are always low on macOS. */
export function availableMemoryFromSysctl(output: string): number | null {
  const [level, total] = output.trim().split(/\s+/).map(Number);
  if (
    level === undefined ||
    total === undefined ||
    !Number.isInteger(level) ||
    level < 0 ||
    level > 100 ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.floor((total * level) / 100);
}

export async function readAvailableMemory(run: ToolRunner): Promise<number | null> {
  try {
    const { stdout } = await run(SYSCTL, ["-n", "kern.memorystatus_level", "hw.memsize"], {
      timeoutMs: 5_000,
    });
    return availableMemoryFromSysctl(stdout);
  } catch {
    return null;
  }
}

/** The percentage in an `xcodebuild -downloadPlatform` progress line, 0 to 1. */
export function runtimeDownloadProgress(line: string): number | null {
  const match = /(\d{1,3}(?:\.\d+)?)%/.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? percent / 100
    : null;
}

export type SpawnTool = (file: string, args: readonly string[]) => ChildProcess;

export interface RuntimeDownload {
  /** Resolves when the download and install finish; rejects on failure. */
  readonly done: Promise<void>;
  cancel(): void;
}

/** Downloads and installs the current iOS simulator runtime. */
export function downloadIosRuntime(
  spawnTool: SpawnTool,
  onProgress: (progress: number | null) => void,
): RuntimeDownload {
  const child = spawnTool(XCODEBUILD, ["-downloadPlatform", "iOS"]);
  let cancelled = false;
  let tail = "";
  const read = (chunk: Buffer | string) => {
    // Progress lines end in carriage returns as well as newlines.
    const lines = (tail + chunk.toString()).split(/[\r\n]+/);
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const progress = runtimeDownloadProgress(line);
      if (progress !== null) onProgress(progress);
    }
  };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && !cancelled) resolve();
      else reject(new Error(cancelled ? "cancelled" : `exit ${code ?? "signal"}`));
    });
  });
  return {
    done,
    cancel() {
      cancelled = true;
      child.kill("SIGTERM");
    },
  };
}
