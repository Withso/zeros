// Screen recordings through the device's own `screenrecord`. It writes an
// H.264 MP4 on the device, says "Content area is …" once it is recording,
// and finishes the file when it gets SIGINT; the file is then pulled to the
// Mac and removed from the device.

import type { ChildProcess } from "node:child_process";

import type { RecorderProcess, SpawnRecorder } from "./simulator-recorder";
import type { ToolRunner } from "./tool-runner";

export interface AndroidRecordingTarget {
  adb: string;
  /** adb's name for the device, such as "emulator-5554". */
  serial: string;
  /** Before Android 14, screenrecord stops by itself after three minutes. */
  apiLevel: number;
}

const START_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4_000;
const BIT_RATE = 8_000_000;
const OLD_TIME_LIMIT_S = 180;
const UNLIMITED_API = 34;
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

let recordings = 0;

/** A recording that never starts, for a device that can't record. */
export function failedRecorder(reason: string): RecorderProcess {
  const started = Promise.reject(new Error(reason));
  void started.catch(() => undefined);
  return { started, exited: Promise.resolve(false), stop() {}, kill() {} };
}

export function recordAndroidVideo(
  spawn: SpawnRecorder,
  run: ToolRunner,
  target: AndroidRecordingTarget,
  file: string,
  log?: (message: string) => void,
): RecorderProcess {
  if (!SERIAL.test(target.serial)) return failedRecorder("not an adb device");
  const remote = `/data/local/tmp/zeros-recording-${process.pid}-${++recordings}.mp4`;
  const limit = target.apiLevel >= UNLIMITED_API ? 0 : OLD_TIME_LIMIT_S;
  const adb = (args: readonly string[], timeoutMs = 10_000) =>
    run(target.adb, ["-s", target.serial, ...args], { timeoutMs });
  let child: ChildProcess;
  try {
    // The shell's own pid is screenrecord's after `exec`, so it can be
    // signalled on the device.
    child = spawn(target.adb, [
      "-s",
      target.serial,
      "shell",
      `echo $$; exec screenrecord --verbose --bit-rate ${BIT_RATE} --time-limit ${limit} ${remote}`,
    ]);
  } catch (error) {
    log?.(`Android recording could not start: ${String(error)}`);
    return failedRecorder("adb could not start");
  }
  let output = "";
  let pid: string | null = null;
  let exitedNow = false;
  let killed = false;
  const removeRemote = () => adb(["shell", "rm", "-f", remote]).catch(() => undefined);
  const toolExited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      exitedNow = true;
      log?.(`Android recording failed: ${error.message}`);
      resolve(null);
    });
    child.once("exit", (code) => {
      exitedNow = true;
      resolve(code);
    });
  });
  const exited = toolExited.then(async (code) => {
    try {
      if (killed || (code !== 0 && !output.includes("Stopping encoder"))) {
        if (!killed) log?.(`Android recording exited with ${code}: ${output.slice(-500)}`);
        return false;
      }
      await adb(["pull", remote, file], PULL_TIMEOUT_MS);
      return true;
    } catch (error) {
      log?.(`Android recording could not be copied: ${String(error)}`);
      return false;
    } finally {
      await removeRemote();
    }
  });
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("screenrecord did not start in time"));
    }, START_TIMEOUT_MS);
    const watch = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-MAX_OUTPUT);
      pid ??= /^(\d{1,9})\r?\n/.exec(output)?.[1] ?? null;
      if (output.includes("Content area is")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    void toolExited.then(() => {
      clearTimeout(timer);
      reject(new Error("screenrecord exited before it started"));
    });
  });
  void started.catch(() => undefined);
  const signal = (name: "INT" | "KILL") => {
    if (exitedNow) return;
    // Ending adb alone would leave screenrecord running on the device.
    const args = pid
      ? ["shell", "kill", `-${name}`, pid]
      : ["shell", "pkill", `-${name}`, "-f", remote.slice(remote.lastIndexOf("/") + 1)];
    void adb(args).catch((error: unknown) => {
      log?.(`Android recording could not be signalled: ${String(error)}`);
      child.kill("SIGKILL");
    });
    if (name === "KILL") child.kill("SIGKILL");
  };
  return {
    started,
    exited,
    stop: () => signal("INT"),
    kill: () => {
      killed = true;
      signal("KILL");
    },
  };
}
