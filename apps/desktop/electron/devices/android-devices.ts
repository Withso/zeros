// Android virtual devices for DeviceHub: which exist and which run, and
// starting, stopping and driving them. Zeros starts each emulator without
// a window, so a device it starts shows only in Zeros, and with a control
// token, so only Zeros and the user's own tools can drive it.
//
// An emulator someone else started has no token Zeros can read, so it shows
// as running but Zeros can't show or drive it; it still stops through adb.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  SimulatorAppearance,
  SimulatorDevice,
  SimulatorDeviceFrame,
  SimulatorInput,
  SimulatorOrientation,
  SimulatorScreen,
  SimulatorTouch,
} from "@zeros/protocol/simulators";

import type { AndroidDeviceFrames } from "./android-device-frame";
import { DeviceActionError } from "./device-hub";
import {
  EmulatorController,
  emulatorTouches,
  performEmulatorInput,
  type EmulatorInputPort,
  type EmulatorStatus,
  type FrameFeed,
  type FrameFeedOptions,
} from "./android-emulator";
import type { GrpcCallOptions } from "./android-grpc";
import type { AndroidRecordingTarget } from "./android-recorder";
import {
  createAndroidDevice,
  processAlive,
  readAvds,
  readRunningEmulators,
  type AndroidAvd,
  type AndroidLocations,
  type AndroidSdk,
  type AndroidSetup,
  type AndroidSetupProbe,
  type AndroidStudio,
  type NewDevicePlan,
  type RunningEmulator,
} from "./android-sdk";
import { readAndroidScreenElements } from "./android-ui-elements";
import type { StartFrameFeed } from "./live-view";
import type { ToolRunner } from "./tool-runner";
import type { ScreenElements } from "./ui-elements";

/** What DeviceHub reads each time it looks at devices. */
export interface AndroidDevicesRead {
  setup: AndroidSetupProbe;
  devices: Array<Omit<SimulatorDevice, "bootedByZeros">>;
}

/** The emulator's control service, as AndroidDevices uses it. */
export interface EmulatorControlPort extends EmulatorInputPort {
  status(options?: GrpcCallOptions): Promise<EmulatorStatus>;
  rotate(orientation: SimulatorOrientation): Promise<void>;
  screenshot(): Promise<Buffer>;
  shutdown(): Promise<void>;
  frames(options: FrameFeedOptions): FrameFeed;
  close(): void;
}

export interface EmulatorProcess {
  readonly pid?: number;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** Starts the emulator on its own, outliving Zeros, with its output in
 * `logFile`. */
export type SpawnEmulator = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
) => EmulatorProcess;

export interface AndroidDevicesOptions {
  locations: AndroidLocations;
  setup: Pick<AndroidSetup, "probe">;
  frames: Pick<AndroidDeviceFrames, "frame" | "cornerRadius">;
  run: ToolRunner;
  spawn: SpawnEmulator;
  /** Where the emulators Zeros starts write their output. */
  logDir: string;
  env: NodeJS.ProcessEnv;
  controller?(port: number, token: string): EmulatorControlPort;
  readRunning?(runningDir: string): Promise<RunningEmulator[]>;
  alive?(pid: number): boolean;
  signal?(pid: number, signal: NodeJS.Signals): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  log?(message: string): void;
}

/** A cold boot of a new device takes a minute or two; Quick Boot, seconds. */
export const ANDROID_BOOT_TIMEOUT_MS = 5 * 60_000;
/** Saving Quick Boot state on the way out takes about ten seconds. */
export const ANDROID_SHUTDOWN_MS = 30_000;
const POLL_MS = 250;
const STATUS_CALL_MS = 2_000;
const ADB_MS = 10_000;
const DUMP_MS = 15_000;
/** agent-device's headless keyboard, which its Android sessions type through. */
const AGENT_DEVICE_KEYBOARD = /^com\.callstack\.agentdevice\./;
/** Where agent-device notes the keyboard it replaced. */
const REPLACED_KEYBOARD = "agent_device_ime_helper_previous_ime";
const KEYBOARD_MS = 3_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EMULATOR_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "ANDROID_USER_HOME",
  "ANDROID_EMULATOR_HOME",
  "ANDROID_SDK_HOME",
]);

/** An emulator outlives Zeros, so it gets only the variables it reads, never
 * Zeros' own. */
export function emulatorEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of EMULATOR_ENV) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  return env;
}

/** The first Android that needs OpenGL ES 3.1, which the Mac's OpenGL lacks. */
const GLES_31_API = 35;

/** With Automatic graphics, the emulator draws Android 15 and later in
 * software on a Mac, at about 16 frames a second. ANGLE over the Mac's GPU,
 * through Vulkan, has OpenGL ES 3.1 and draws at 60. The emulator saves no
 * Quick Boot state while drawing through Vulkan, and deletes what it had,
 * unless its VulkanSnapshots feature is on; it is off by default. A device set
 * to Hardware or Software keeps its setting. Quick Boot state saved with one
 * renderer doesn't load with the other, so moving an Automatic device between
 * Android Studio and Zeros cold-boots it. */
export function emulatorGraphicsArgs(avd: Pick<AndroidAvd, "apiLevel" | "gpuMode">): string[] {
  if (avd.apiLevel < GLES_31_API) return [];
  if (avd.gpuMode !== null && avd.gpuMode !== "auto") return [];
  return ["-gpu", "host", "-feature", "GuestAngle,VulkanSnapshots"];
}

/** Zeros' own frame rounds an Android screen about as much as a Pixel's. */
export function defaultAndroidCornerRadius(avd: Pick<AndroidAvd, "screen" | "formFactor">): number {
  if (!avd.screen) return 0;
  const shorter = Math.min(avd.screen.widthPx, avd.screen.heightPx) / avd.screen.scale;
  return Math.round(shorter * (avd.formFactor === "tablet" ? 0.03 : 0.08));
}

function aborted(): Error {
  const error = new Error("The boot was stopped.");
  error.name = "AbortError";
  return error;
}

export class AndroidDevices {
  private sdk: AndroidSdk | null = null;
  private studio: AndroidStudio | null = null;
  private plan: NewDevicePlan | null = null;
  private avds = new Map<string, AndroidAvd>();
  private running = new Map<string, RunningEmulator>();
  private readonly connections = new Map<string, { key: string; controller: EmulatorControlPort }>();
  private readonly alive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: AndroidDevicesOptions) {
    this.alive = options.alive ?? processAlive;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async read(): Promise<AndroidDevicesRead> {
    const { probe, sdk, studio, plan } = await this.options.setup.probe();
    this.sdk = sdk;
    this.studio = studio;
    this.plan = plan;
    if (!sdk || probe.state === "tools-missing") {
      this.avds = new Map();
      this.track([]);
      return { setup: probe, devices: [] };
    }
    const [avds, running] = await Promise.all([
      readAvds(sdk.root, this.options.locations.avdHome),
      this.readRunning(),
    ]);
    this.avds = new Map(avds.map((avd) => [avd.id, avd]));
    this.track(running);
    return {
      setup: probe,
      devices: avds.map((avd) => ({
        id: avd.id,
        platform: "android",
        name: avd.name,
        osLabel: avd.osLabel,
        formFactor: avd.formFactor,
        state: this.running.has(avd.id) ? "booted" : "shutdown",
      })),
    };
  }

  /** Android Studio, for setup's "Open Android Studio". */
  studioApp(): string | null {
    return this.studio?.app ?? null;
  }

  // ── Starting and stopping ────────────────────────────────

  /** Starts the device without a window and waits for Android to finish
   * starting. A stopped boot ends the emulator it started. */
  async boot(deviceId: string, signal: AbortSignal): Promise<void> {
    const emulator = this.sdk?.emulator;
    const avd = this.avds.get(deviceId);
    if (!emulator || !this.sdk || !avd) {
      throw new DeviceActionError("The Android emulator isn't installed.");
    }
    const find = async () =>
      (await this.readRunning()).find((entry) => entry.avdId === deviceId) ?? null;
    let running = await find();
    let ended: string | null = null;
    let started: EmulatorProcess | null = null;
    if (!running) {
      try {
        started = this.options.spawn(
          emulator,
          [
            "-avd",
            deviceId,
            "-no-window",
            "-no-boot-anim",
            "-grpc-use-token",
            ...emulatorGraphicsArgs(avd),
          ],
          {
            ...emulatorEnvironment(this.options.env),
            ANDROID_HOME: this.sdk.root,
            ANDROID_SDK_ROOT: this.sdk.root,
            ANDROID_AVD_HOME: this.options.locations.avdHome,
          },
          path.join(this.options.logDir, `${deviceId}.log`),
        );
      } catch (error) {
        throw new Error(`the emulator could not start: ${message(error)}`);
      }
      started.once("exit", (code) => {
        ended = `the emulator exited (${code ?? "signal"})`;
      });
      started.once("error", (error) => {
        ended = `the emulator could not start: ${error.message}`;
      });
    }
    const deadline = this.now() + ANDROID_BOOT_TIMEOUT_MS;
    try {
      for (;;) {
        if (signal.aborted) throw aborted();
        if (ended) throw new Error(ended);
        if (this.now() > deadline) throw new Error("the emulator did not start in time");
        if (running?.grpcPort && running.token) {
          // Device reads replace what is known about running emulators, so
          // each try starts from the emulator's own file.
          this.running.set(deviceId, running);
          const connection = this.connection(deviceId);
          const status = await connection
            ?.status({ timeoutMs: STATUS_CALL_MS })
            .catch(() => null);
          if (connection && status?.booted) {
            // Quick Boot brings a device back turned as it was saved; Zeros
            // starts every device upright. An agent session can open as soon
            // as this returns and select agent-device's keyboard itself, so
            // the keyboard check finishes first.
            await Promise.all([
              connection.rotate("portrait").catch((error: unknown) => {
                this.options.log?.(`emulator rotation reset failed: ${message(error)}`);
              }),
              this.restoreKeyboard(deviceId, true),
            ]);
            return;
          }
        } else if (running && !started) {
          throw new DeviceActionError(`${avd.name} was started outside Zeros.`);
        }
        await this.sleep(POLL_MS);
        running = await find();
      }
    } catch (error) {
      if (started) {
        const pid = running?.pid ?? started.pid;
        if (pid) await this.stopProcess(pid, 0);
        this.forget(deviceId);
      }
      throw error;
    }
  }

  /** Saves the device's Quick Boot state and quits its emulator. */
  async shutdown(deviceId: string): Promise<void> {
    const running = (await this.readRunning()).find((entry) => entry.avdId === deviceId);
    if (!running) {
      this.forget(deviceId);
      return;
    }
    this.running.set(deviceId, running);
    await this.restoreKeyboard(deviceId);
    const controller = this.connection(deviceId);
    if (controller) {
      await controller.shutdown();
    } else if (this.sdk?.adb && running.serial) {
      await this.options
        .run(this.sdk.adb, ["-s", running.serial, "emu", "kill"], { timeoutMs: ADB_MS })
        .catch((error: unknown) => {
          this.options.log?.(`adb emu kill failed: ${message(error)}`);
        });
    }
    const stopped = await this.stopProcess(running.pid, ANDROID_SHUTDOWN_MS);
    this.forget(deviceId);
    if (!stopped) throw new Error("the emulator did not stop");
  }

  /** Waits up to `graceMs` for the emulator to quit, then ends it. */
  private async stopProcess(pid: number, graceMs: number): Promise<boolean> {
    const send = this.options.signal ?? ((target, name) => process.kill(target, name));
    const waitFor = async (ms: number) => {
      const until = this.now() + ms;
      for (;;) {
        if (!this.alive(pid)) return true;
        if (this.now() >= until) return false;
        await this.sleep(POLL_MS);
      }
    };
    if (await waitFor(graceMs)) return true;
    for (const [name, ms] of [
      ["SIGTERM", 5_000],
      ["SIGKILL", 2_000],
    ] as const) {
      try {
        send(pid, name);
      } catch {
        return !this.alive(pid);
      }
      if (await waitFor(ms)) return true;
    }
    return false;
  }

  /** Makes the device setup offers and returns its id. */
  async createDevice(): Promise<string> {
    if (!this.plan) throw new Error("Zeros can't make an Android device on this Mac.");
    return createAndroidDevice(this.options.run, this.plan);
  }

  // ── Showing and driving ──────────────────────────────────

  /** Its screen in its natural orientation, rounded as its frame is. */
  async screen(deviceId: string): Promise<SimulatorScreen | null> {
    const avd = this.avds.get(deviceId);
    if (!avd?.screen) return null;
    const fromArt = avd.profile
      ? await this.options.frames.cornerRadius(avd.profile, avd.screen).catch(() => null)
      : null;
    return {
      ...avd.screen,
      cornerRadius: fromArt && fromArt > 0 ? fromArt : defaultAndroidCornerRadius(avd),
    };
  }

  /** Android Studio's frame for it, or null to draw Zeros' own. */
  async frame(deviceId: string, screen: SimulatorScreen): Promise<SimulatorDeviceFrame | null> {
    const profile = this.avds.get(deviceId)?.profile;
    return profile ? this.options.frames.frame(profile, screen) : null;
  }

  /** Frames for a live view. Throws, in words for people, when Zeros can't
   * show the device. */
  feed(deviceId: string): StartFrameFeed {
    this.controller(deviceId);
    return (options) => this.controller(deviceId).frames(options);
  }

  drives(deviceId: string): boolean {
    const running = this.running.get(deviceId);
    return Boolean(running?.grpcPort && running.token);
  }

  async input(deviceId: string, input: SimulatorInput, screen: SimulatorScreen): Promise<void> {
    await performEmulatorInput(this.controller(deviceId), input, screen);
  }

  async touch(deviceId: string, touch: SimulatorTouch): Promise<void> {
    const screen = this.avds.get(deviceId)?.screen;
    if (!screen) throw new Error("the device has no screen size");
    await this.controller(deviceId).touch(emulatorTouches(touch, screen));
  }

  async rotate(deviceId: string, orientation: SimulatorOrientation): Promise<void> {
    await this.controller(deviceId).rotate(orientation);
  }

  async appearance(deviceId: string): Promise<SimulatorAppearance | null> {
    const { stdout } = await this.adb(deviceId, ["shell", "cmd", "uimode", "night"]);
    const mode = /Night mode:\s*(\w+)/.exec(stdout)?.[1];
    return mode === "yes" ? "dark" : mode === "no" ? "light" : null;
  }

  async setAppearance(deviceId: string, appearance: SimulatorAppearance): Promise<void> {
    await this.adb(deviceId, ["shell", "cmd", "uimode", "night", appearance === "dark" ? "yes" : "no"]);
  }

  // ── Captures and agents ──────────────────────────────────

  /** A PNG of the screen as the device is held. */
  async screenshot(deviceId: string, file: string): Promise<void> {
    await writeFile(file, await this.controller(deviceId).screenshot());
  }

  recordingTarget(deviceId: string): AndroidRecordingTarget {
    const adb = this.sdk?.adb;
    const serial = this.running.get(deviceId)?.serial;
    const avd = this.avds.get(deviceId);
    if (!adb || !serial || !avd) throw new Error("That device isn't running.");
    return { adb, serial, apiLevel: avd.apiLevel };
  }

  async describe(deviceId: string): Promise<ScreenElements | null> {
    const screen = this.avds.get(deviceId)?.screen;
    if (!screen) return null;
    const { stdout } = await this.adb(
      deviceId,
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      DUMP_MS,
    );
    return readAndroidScreenElements(stdout, screen);
  }

  /** adb's name for a running device, such as "emulator-5554". */
  serial(deviceId: string): string | null {
    return this.running.get(deviceId)?.serial ?? null;
  }

  sdkRoot(): string | null {
    return this.sdk?.root ?? null;
  }

  dispose(): void {
    for (const { controller } of this.connections.values()) controller.close();
    this.connections.clear();
  }

  // ── Internals ────────────────────────────────────────────

  private readRunning(): Promise<RunningEmulator[]> {
    return (this.options.readRunning ?? readRunningEmulators)(this.options.locations.runningDir);
  }

  /** The running emulators; a connection to one that stopped or restarted
   * closes. */
  private track(running: readonly RunningEmulator[]): void {
    this.running = new Map(running.map((entry) => [entry.avdId, entry]));
    for (const id of [...this.connections.keys()]) {
      const entry = this.running.get(id);
      if (!entry || this.connections.get(id)?.key !== this.keyOf(entry)) this.forgetConnection(id);
    }
  }

  private keyOf(running: RunningEmulator): string {
    return `${running.pid}:${running.grpcPort}`;
  }

  private connection(deviceId: string): EmulatorControlPort | null {
    const running = this.running.get(deviceId);
    if (!running?.grpcPort || !running.token) return null;
    const key = this.keyOf(running);
    const existing = this.connections.get(deviceId);
    if (existing?.key === key) return existing.controller;
    existing?.controller.close();
    const controller = (
      this.options.controller ?? ((port, token) => new EmulatorController(port, token))
    )(running.grpcPort, running.token);
    this.connections.set(deviceId, { key, controller });
    return controller;
  }

  private controller(deviceId: string): EmulatorControlPort {
    const controller = this.connection(deviceId);
    if (controller) return controller;
    const name = this.avds.get(deviceId)?.name ?? "This device";
    throw new DeviceActionError(
      this.running.has(deviceId)
        ? `${name} was started outside Zeros. Stop it there, then start it here to use it in Zeros.`
        : `${name} isn't running.`,
    );
  }

  private forgetConnection(deviceId: string): void {
    this.connections.get(deviceId)?.controller.close();
    this.connections.delete(deviceId);
  }

  private forget(deviceId: string): void {
    this.forgetConnection(deviceId);
    this.running.delete(deviceId);
  }

  /** Gives the device back its own keyboard while agent-device's headless one
   * is selected with no session to end it: an agent session that couldn't
   * end cleanly leaves it, and the device then shows no on-screen keyboard,
   * in Android Studio too. Never throws. */
  private async restoreKeyboard(deviceId: string, justStarted = false): Promise<void> {
    const setting = async (name: string, waitForDevice = false) => {
      const { stdout } = await this.adb(
        deviceId,
        // adb may not have found an emulator that just started.
        [...(waitForDevice ? ["wait-for-device"] : []), "shell", "settings", "get", "secure", name],
        KEYBOARD_MS,
      );
      const value = stdout.trim();
      return value && value !== "null" ? value : null;
    };
    try {
      const current = await setting("default_input_method", justStarted);
      if (!current || !AGENT_DEVICE_KEYBOARD.test(current)) return;
      const { stdout } = await this.adb(deviceId, ["shell", "ime", "list", "-s"], KEYBOARD_MS);
      const own = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((ime) => ime && !AGENT_DEVICE_KEYBOARD.test(ime));
      const replaced = await setting(REPLACED_KEYBOARD);
      const keyboard = replaced && own.includes(replaced) ? replaced : own[0];
      if (!keyboard) return;
      await this.adb(deviceId, ["shell", "ime", "set", keyboard], KEYBOARD_MS);
      if ((await setting("default_input_method")) !== keyboard) {
        this.options.log?.(`couldn't give ${deviceId} its own keyboard back from agent-device's`);
        return;
      }
      this.options.log?.(`gave ${deviceId} its own keyboard back from agent-device's`);
      // agent-device clears its note once its keyboard is gone, and notes the
      // keyboard afresh when it next selects its own.
      if (replaced) {
        await this.adb(deviceId, ["shell", "settings", "delete", "secure", REPLACED_KEYBOARD], KEYBOARD_MS);
      }
    } catch (error) {
      this.options.log?.(`android keyboard check failed: ${message(error)}`);
    }
  }

  private adb(deviceId: string, args: readonly string[], timeoutMs = ADB_MS) {
    const adb = this.sdk?.adb;
    const serial = this.running.get(deviceId)?.serial;
    if (!adb || !serial) throw new Error("That device isn't running.");
    return this.options.run(adb, ["-s", serial, ...args], { timeoutMs });
  }
}
