// Screen recordings through `simctl io recordVideo`. It writes an H.264
// MP4, says "Recording started" once the first frame is in, and finishes
// the file when it gets SIGINT.

import type { ChildProcess } from "node:child_process";

import { XCRUN } from "./tool-runner";

export interface RecorderProcess {
  /** Resolves once the first frame is written; rejects if it never is. */
  readonly started: Promise<void>;
  /** Resolves when the tool exits, however it ends: true once it has
   * finished the file. */
  readonly exited: Promise<boolean>;
  /** Finishes the file, then exits. */
  stop(): void;
  /** Ends it at once; the file is lost. */
  kill(): void;
}

export type SpawnRecorder = (file: string, args: readonly string[]) => ChildProcess;

const START_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 4_000;

export function recordSimulatorVideo(
  spawn: SpawnRecorder,
  udid: string,
  file: string,
  log?: (message: string) => void,
): RecorderProcess {
  let output = "";
  let child: ChildProcess;
  try {
    child = spawn(XCRUN, ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file]);
  } catch (error) {
    log?.(`simulator recording could not start: ${String(error)}`);
    const failed = Promise.reject(new Error("recordVideo could not start"));
    void failed.catch(() => undefined);
    return { started: failed, exited: Promise.resolve(false), stop() {}, kill() {} };
  }
  let exitedNow = false;
  const exited = new Promise<boolean>((resolve) => {
    child.once("error", (error) => {
      exitedNow = true;
      log?.(`simulator recording failed: ${error.message}`);
      resolve(false);
    });
    child.once("exit", (code) => {
      exitedNow = true;
      if (code !== 0) log?.(`simulator recording exited with ${code}: ${output.slice(-500)}`);
      resolve(code === 0 || output.includes("Wrote video to"));
    });
  });
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("recordVideo did not start in time"));
    }, START_TIMEOUT_MS);
    const watch = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-MAX_OUTPUT);
      if (output.includes("Recording started")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error("recordVideo exited before it started"));
    });
  });
  void started.catch(() => undefined);
  const signal = (name: NodeJS.Signals) => {
    if (exitedNow) return;
    try {
      child.kill(name);
    } catch {
      // It already exited.
    }
  };
  return {
    started,
    exited,
    stop: () => signal("SIGINT"),
    kill: () => signal("SIGKILL"),
  };
}
