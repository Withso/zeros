import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { recordAndroidVideo } from "../devices/android-recorder";
import type { ToolOutput, ToolRunner } from "../devices/tool-runner";

const ADB = "/sdk/platform-tools/adb";
const TARGET = { adb: ADB, serial: "emulator-5554", apiLevel: 37 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeAdbShell extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn((_signal: NodeJS.Signals) => {
    this.emit("exit", null);
    return true;
  });

  say(text: string): void {
    this.stdout.emit("data", text);
  }
}

function runner(
  respond: (args: readonly string[]) => ToolOutput | Error = () => ({ stdout: "", stderr: "" }),
): { run: ToolRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ToolRunner = async (file, args) => {
    expect(file).toBe(ADB);
    calls.push([...args]);
    const result = respond(args);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

const RECORDING = [
  "Time limit set to 4294967295 seconds\n",
  "Display is 1080x2400 @60.00fps (orientation=ROTATION_0), layerStack=0\n",
  "Configuring recorder for 1080x2400 video/avc at 8.00Mbps\n",
  "Content area is 1080x2400 at offset x=0 y=0\n",
].join("");

describe("Android recordings", () => {
  it("records on the device, finishes on SIGINT and copies the video to the Mac", async () => {
    const shell = new FakeAdbShell();
    const spawn = vi.fn(() => shell as never);
    const { run, calls } = runner();
    const recorder = recordAndroidVideo(spawn, run, TARGET, "/work/a.mp4");
    const [file, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe(ADB);
    expect(args.slice(0, 3)).toEqual(["-s", "emulator-5554", "shell"]);
    const remote = /(\/data\/local\/tmp\/zeros-recording-\d+-\d+\.mp4)$/.exec(args[3]!)?.[1];
    expect(remote).toBeTruthy();
    expect(args[3]).toBe(
      `echo $$; exec screenrecord --verbose --bit-rate 8000000 --time-limit 0 ${remote}`,
    );

    shell.say("5508\n");
    shell.say(RECORDING.slice(0, 40));
    await flush();
    let started = false;
    void recorder.started.then(() => {
      started = true;
    });
    await flush();
    expect(started).toBe(false);
    shell.say(RECORDING.slice(40));
    await expect(recorder.started).resolves.toBeUndefined();

    recorder.stop();
    expect(calls).toEqual([["-s", "emulator-5554", "shell", "kill", "-INT", "5508"]]);
    shell.say("Encoder stopping; recorded 43 frames in 4 seconds\nStopping encoder and muxer\n");
    shell.emit("exit", 0);
    await expect(recorder.exited).resolves.toBe(true);
    expect(calls.slice(1)).toEqual([
      ["-s", "emulator-5554", "pull", remote, "/work/a.mp4"],
      ["-s", "emulator-5554", "shell", "rm", "-f", remote],
    ]);
    recorder.stop();
    expect(calls).toHaveLength(3);
  });

  it("asks older Android for its longest recording", () => {
    const spawn = vi.fn(() => new FakeAdbShell() as never);
    recordAndroidVideo(spawn, runner().run, { ...TARGET, apiLevel: 33 }, "/work/a.mp4");
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args[3]).toContain("--time-limit 180 ");
  });

  it("fails when screenrecord exits before recording", async () => {
    const shell = new FakeAdbShell();
    const { run, calls } = runner();
    const recorder = recordAndroidVideo(() => shell as never, run, TARGET, "/work/a.mp4");
    shell.say("5508\nscreenrecord: unknown option\n");
    shell.emit("exit", 2);
    await expect(recorder.started).rejects.toThrow("exited before it started");
    await expect(recorder.exited).resolves.toBe(false);
    expect(calls.map((call) => call.slice(2, 4))).toEqual([["shell", "rm"]]);
  });

  it("loses the video when copying it fails", async () => {
    const shell = new FakeAdbShell();
    const { run } = runner((args) => (args[2] === "pull" ? new Error("device offline") : { stdout: "", stderr: "" }));
    const recorder = recordAndroidVideo(() => shell as never, run, TARGET, "/work/a.mp4");
    shell.say(`5508\n${RECORDING}`);
    await recorder.started;
    shell.emit("exit", 0);
    await expect(recorder.exited).resolves.toBe(false);
  });

  it("kills screenrecord on the device and drops the video", async () => {
    const shell = new FakeAdbShell();
    const { run, calls } = runner();
    const recorder = recordAndroidVideo(() => shell as never, run, TARGET, "/work/a.mp4");
    shell.say(`5508\n${RECORDING}`);
    await recorder.started;
    recorder.kill();
    expect(calls[0]).toEqual(["-s", "emulator-5554", "shell", "kill", "-KILL", "5508"]);
    expect(shell.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(recorder.exited).resolves.toBe(false);
    expect(calls.map((call) => call.slice(2, 4))).toEqual([
      ["shell", "kill"],
      ["shell", "rm"],
    ]);
  });

  it("stops a recording by name before it said its pid", () => {
    const shell = new FakeAdbShell();
    const { run, calls } = runner();
    const recorder = recordAndroidVideo(() => shell as never, run, TARGET, "/work/a.mp4");
    recorder.stop();
    expect(calls[0]!.slice(0, 6)).toEqual(["-s", "emulator-5554", "shell", "pkill", "-INT", "-f"]);
    expect(calls[0]![6]).toMatch(/^zeros-recording-\d+-\d+\.mp4$/);
  });

  it("never passes an odd serial to adb", async () => {
    const spawn = vi.fn();
    const recorder = recordAndroidVideo(spawn, runner().run, { ...TARGET, serial: "-H evil" }, "/x.mp4");
    expect(spawn).not.toHaveBeenCalled();
    await expect(recorder.started).rejects.toThrow();
    await expect(recorder.exited).resolves.toBe(false);
  });
});
