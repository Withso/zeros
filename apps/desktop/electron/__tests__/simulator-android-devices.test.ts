import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SimulatorScreen } from "@zeros/protocol/simulators";

import {
  ANDROID_BOOT_TIMEOUT_MS,
  AndroidDevices,
  defaultAndroidCornerRadius,
  emulatorGraphicsArgs,
  type AndroidDevicesOptions,
  type EmulatorControlPort,
} from "../devices/android-devices";
import type { FrameFeedOptions } from "../devices/android-emulator";
import { DeviceActionError } from "../devices/device-hub";
import {
  androidLocations,
  type AndroidSetupProbe,
  type RunningEmulator,
} from "../devices/android-sdk";
import type { ToolOutput, ToolRunner } from "../devices/tool-runner";

const PHONE = "Medium_Phone_API_37.0";
const TABLET = "Pixel_Tablet";
const ADB = "/sdk/platform-tools/adb";
const EMULATOR = "/sdk/emulator/emulator";
const READY: AndroidSetupProbe = {
  state: "ready",
  toolLabel: "Android Emulator 37.2.12",
  newDevice: "Pixel 10 with Android 17",
  studioInstalled: true,
};

let root: string;

async function avd(id: string, config: Record<string, string>): Promise<void> {
  const avdHome = path.join(root, "home", ".android", "avd");
  const dir = path.join(avdHome, `${id}.avd`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(avdHome, `${id}.ini`), `path=${dir}\ntarget=android-37.0\n`);
  await writeFile(
    path.join(dir, "config.ini"),
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
}

class FakeController implements EmulatorControlPort {
  booted = false;
  closed = false;
  readonly touches: unknown[] = [];
  readonly rotations: string[] = [];
  readonly feeds: FrameFeedOptions[] = [];
  shutdown = vi.fn(async () => undefined);
  status = vi.fn(async () => ({ booted: this.booted }));
  async touch(touches: readonly unknown[]) {
    this.touches.push(...touches);
  }
  async key() {}
  async text() {}
  async setClipboard() {}
  async rotate(orientation: string) {
    this.rotations.push(orientation);
  }
  async screenshot() {
    return Buffer.from("png-bytes");
  }
  frames(options: FrameFeedOptions) {
    this.feeds.push(options);
    return { stop: () => undefined };
  }
  close() {
    this.closed = true;
  }
}

class FakeProcess extends EventEmitter {
  constructor(readonly pid: number) {
    super();
  }
}

interface Harness {
  devices: AndroidDevices;
  running: RunningEmulator[];
  alive: Set<number>;
  signals: Array<[number, NodeJS.Signals]>;
  spawns: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv; logFile: string }>;
  processes: FakeProcess[];
  controllers: Array<{ port: number; token: string; controller: FakeController }>;
  adbCalls: string[][];
  clock: { now: number };
  /** Runs before every sleep returns, as time passes. */
  onSleep: (() => void) | null;
  /** Answers an adb call instead of the defaults, or returns null. */
  onAdb: ((args: readonly string[]) => ToolOutput | null) | null;
}

function harness(
  overrides: Partial<AndroidDevicesOptions> = {},
  probe = READY,
  sdkRoot = "/sdk",
): Harness {
  const running: RunningEmulator[] = [];
  const alive = new Set<number>();
  const signals: Harness["signals"] = [];
  const spawns: Harness["spawns"] = [];
  const processes: FakeProcess[] = [];
  const controllers: Harness["controllers"] = [];
  const adbCalls: string[][] = [];
  const clock = { now: 1_000 };
  const h = {} as Harness;
  const run: ToolRunner = async (file, args): Promise<ToolOutput> => {
    expect(file).toBe(ADB);
    adbCalls.push([...args]);
    const answer = h.onAdb?.(args);
    if (answer) return answer;
    if (args.at(-1) === "night") return { stdout: "Night mode: yes\n", stderr: "" };
    if (args.includes("uiautomator")) {
      return {
        stdout:
          '<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.Button" ' +
          'package="com.example" text="Go" bounds="[0,0][210,105]" /></hierarchy>' +
          "UI hierchary dumped to: /dev/tty",
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  const devices = new AndroidDevices({
    locations: { ...androidLocations({}, path.join(root, "home")), runningDir: "/running" },
    setup: {
      probe: async () => ({
        probe,
        sdk:
          probe.state === "tools-missing"
            ? null
            : { root: sdkRoot, emulator: EMULATOR, adb: ADB, avdmanager: null, emulatorVersion: "37.2.12" },
        studio: null,
        plan: null,
      }),
    },
    frames: {
      frame: async () => null,
      cornerRadius: async (profile) => (profile === "pixel_9" ? 33 : 0),
    },
    run,
    spawn: (file, args, env, logFile) => {
      spawns.push({ file, args, env, logFile });
      const child = new FakeProcess(9000 + processes.length);
      processes.push(child);
      alive.add(child.pid);
      return child;
    },
    logDir: "/logs",
    env: { PATH: "/usr/bin", HOME: "/Users/me", ZEROS_PRIVATE_SETTING: "kept-in-zeros" },
    controller: (port, token) => {
      const controller = new FakeController();
      controllers.push({ port, token, controller });
      return controller;
    },
    readRunning: async () => running.filter((entry) => alive.has(entry.pid)).map((entry) => ({ ...entry })),
    alive: (pid) => alive.has(pid),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    },
    sleep: async (ms) => {
      clock.now += ms;
      h.onSleep?.();
    },
    now: () => clock.now,
    ...overrides,
  });
  Object.assign(h, {
    devices,
    running,
    alive,
    signals,
    spawns,
    processes,
    controllers,
    adbCalls,
    clock,
    onSleep: null,
    onAdb: null,
  });
  return h;
}

const AGENT_KEYBOARD = "com.callstack.agentdevice.imehelper/.TestInputMethodService";
const GBOARD = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME";
const VOICE =
  "com.google.android.tts/com.google.android.apps.speech.tts.googletts.settings.asr.voiceime.VoiceInputMethodService";

/** A device's keyboards, as adb reads and picks them. A device that doesn't
 * take a keyboard keeps the one it has. */
function keyboards(
  h: Harness,
  settings: Record<string, string>,
  enabled: readonly string[],
  { takes = true } = {},
) {
  const picked: string[] = [];
  h.onAdb = (args) => {
    const command = args.slice(args.indexOf("shell") + 1);
    const line = command.join(" ");
    if (line.startsWith("settings get secure ")) {
      return { stdout: `${settings[command[3]!] ?? "null"}\n`, stderr: "" };
    }
    if (line.startsWith("settings delete secure ")) {
      delete settings[command[3]!];
      return { stdout: "Deleted 1 rows\n", stderr: "" };
    }
    if (line === "ime list -s") return { stdout: enabled.map((ime) => `${ime}\n`).join(""), stderr: "" };
    if (command[0] === "ime" && command[1] === "set") {
      picked.push(command[2]!);
      if (takes) settings.default_input_method = command[2]!;
      return { stdout: `Input method ${command[2]} selected for user #0\n`, stderr: "" };
    }
    return null;
  };
  return { settings, picked };
}

const emulator = (pid: number, token: string | null = "secret-token-1234"): RunningEmulator => ({
  pid,
  avdId: PHONE,
  serial: "emulator-5554",
  grpcPort: 8554,
  token,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-android-devices-"));
  await avd(PHONE, {
    "avd.ini.displayname": "Medium Phone API 37.0",
    "hw.device.name": "medium_phone",
    "hw.lcd.width": "1080",
    "hw.lcd.height": "2400",
    "hw.lcd.density": "420",
  });
  await avd(TABLET, {
    "avd.ini.displayname": "Pixel Tablet",
    "hw.device.name": "pixel_tablet",
    "hw.lcd.width": "2560",
    "hw.lcd.height": "1600",
    "hw.lcd.density": "320",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AndroidDevices", () => {
  it("lists phones and tablets and which are running", async () => {
    const h = harness();
    h.running.push(emulator(500));
    h.alive.add(500);
    const read = await h.devices.read();
    expect(read.setup).toEqual(READY);
    expect(read.devices).toEqual([
      {
        id: PHONE,
        platform: "android",
        name: "Medium Phone API 37.0",
        osLabel: "Android API 37.0",
        formFactor: "phone",
        state: "booted",
      },
      {
        id: TABLET,
        platform: "android",
        name: "Pixel Tablet",
        osLabel: "Android API 37.0",
        formFactor: "tablet",
        state: "shutdown",
      },
    ]);
    expect(h.devices.serial(PHONE)).toBe("emulator-5554");
  });

  it("lists nothing without the emulator", async () => {
    const h = harness({}, { ...READY, state: "tools-missing", toolLabel: null, newDevice: null });
    expect((await h.devices.read()).devices).toEqual([]);
  });

  it("starts a device without a window and waits for Android to finish starting", async () => {
    const h = harness();
    await h.devices.read();
    let sleeps = 0;
    h.onSleep = () => {
      sleeps += 1;
      // The emulator writes its file a moment after it starts, then boots.
      if (sleeps === 2) h.running.push(emulator(h.processes[0]!.pid));
      if (sleeps === 4) h.controllers[0]!.controller.booted = true;
    };
    await h.devices.boot(PHONE, new AbortController().signal);
    expect(h.spawns).toEqual([
      {
        file: EMULATOR,
        args: ["-avd", PHONE, "-no-window", "-no-boot-anim", "-grpc-use-token"],
        env: {
          PATH: "/usr/bin",
          HOME: "/Users/me",
          ANDROID_HOME: "/sdk",
          ANDROID_SDK_ROOT: "/sdk",
          ANDROID_AVD_HOME: path.join(root, "home", ".android", "avd"),
        },
        logFile: path.join("/logs", `${PHONE}.log`),
      },
    ]);
    expect(h.controllers.map(({ port, token }) => [port, token])).toEqual([[8554, "secret-token-1234"]]);
    expect(h.controllers[0]!.controller.status).toHaveBeenCalledTimes(3);
    // Quick Boot may restore a turned device; it starts upright.
    expect(h.controllers[0]!.controller.rotations).toEqual(["portrait"]);
  });

  it("draws Android 15 and later on the Mac's GPU, keeping Quick Boot, unless the device has its own graphics setting", () => {
    const hardware = ["-gpu", "host", "-feature", "GuestAngle,VulkanSnapshots"];
    expect(emulatorGraphicsArgs({ apiLevel: 37, gpuMode: "auto" })).toEqual(hardware);
    expect(emulatorGraphicsArgs({ apiLevel: 35, gpuMode: null })).toEqual(hardware);
    expect(emulatorGraphicsArgs({ apiLevel: 34, gpuMode: "auto" })).toEqual([]);
    // An image Zeros couldn't read keeps the emulator's choice.
    expect(emulatorGraphicsArgs({ apiLevel: 0, gpuMode: "auto" })).toEqual([]);
    expect(emulatorGraphicsArgs({ apiLevel: 37, gpuMode: "host" })).toEqual([]);
    expect(emulatorGraphicsArgs({ apiLevel: 37, gpuMode: "swiftshader_indirect" })).toEqual([]);
  });

  it("starts an Android 15 device with Automatic graphics on the Mac's GPU", async () => {
    const sdkRoot = path.join(root, "sdk");
    const image = path.join(sdkRoot, "system-images", "android-37.0", "google_apis", "arm64-v8a");
    await mkdir(image, { recursive: true });
    await writeFile(path.join(image, "source.properties"), "AndroidVersion.ApiLevel=37.0\n");
    await avd("New_Phone", {
      "hw.lcd.width": "1080",
      "hw.lcd.height": "2400",
      "hw.lcd.density": "420",
      "hw.gpu.mode": "auto",
      "image.sysdir.1": "system-images/android-37.0/google_apis/arm64-v8a/",
    });
    const h = harness({}, READY, sdkRoot);
    await h.devices.read();
    h.onSleep = () => {
      if (h.running.length === 0) h.running.push({ ...emulator(h.processes[0]!.pid), avdId: "New_Phone" });
      else if (h.controllers[0]) h.controllers[0].controller.booted = true;
    };
    await h.devices.boot("New_Phone", new AbortController().signal);
    expect(h.spawns.map((spawn) => spawn.args)).toEqual([
      [
        "-avd",
        "New_Phone",
        "-no-window",
        "-no-boot-anim",
        "-grpc-use-token",
        "-gpu",
        "host",
        "-feature",
        "GuestAngle,VulkanSnapshots",
      ],
    ]);
  });

  it("ends the emulator it started when the boot stops, fails or takes too long", async () => {
    const h = harness();
    await h.devices.read();
    const stop = new AbortController();
    h.onSleep = () => stop.abort();
    await expect(h.devices.boot(PHONE, stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.signals).toEqual([[9000, "SIGTERM"]]);

    h.onSleep = () => h.processes[1]!.emit("exit", 1);
    await expect(h.devices.boot(PHONE, new AbortController().signal)).rejects.toThrow(
      "the emulator exited (1)",
    );

    h.onSleep = null;
    h.clock.now = 0;
    const slow = h.devices.boot(PHONE, new AbortController().signal);
    h.onSleep = () => {
      if (h.clock.now > ANDROID_BOOT_TIMEOUT_MS) h.onSleep = null;
    };
    await expect(slow).rejects.toThrow("did not start in time");
    expect(h.signals.at(-1)).toEqual([9002, "SIGTERM"]);
  });

  it("won't take over a device someone else's emulator started", async () => {
    const h = harness();
    await h.devices.read();
    h.running.push(emulator(700, null));
    h.alive.add(700);
    const boot = h.devices.boot(PHONE, new AbortController().signal);
    await expect(boot).rejects.toThrow("Medium Phone API 37.0 was started outside Zeros.");
    await expect(boot).rejects.toBeInstanceOf(DeviceActionError);
    expect(h.spawns).toEqual([]);
    expect(h.signals).toEqual([]);
  });

  it("saves state and quits, or quits someone else's emulator through adb", async () => {
    const h = harness();
    h.running.push(emulator(500));
    h.alive.add(500);
    await h.devices.read();
    await h.devices.input(PHONE, { kind: "button", button: "home" }, (await h.devices.screen(PHONE))!);
    const controller = h.controllers[0]!.controller;
    controller.shutdown.mockImplementation(async () => {
      h.onSleep = () => h.alive.delete(500);
    });
    await h.devices.shutdown(PHONE);
    expect(controller.shutdown).toHaveBeenCalled();
    expect(controller.closed).toBe(true);
    expect(h.signals).toEqual([]);
    expect(h.devices.serial(PHONE)).toBeNull();

    h.running.length = 0;
    h.running.push(emulator(600, null));
    h.alive.add(600);
    h.onSleep = () => h.alive.delete(600);
    await h.devices.read();
    await h.devices.shutdown(PHONE);
    expect(h.adbCalls.at(-1)).toEqual(["-s", "emulator-5554", "emu", "kill"]);
  });

  it("gives a device its own keyboard back before it shuts down", async () => {
    const h = harness();
    h.running.push(emulator(500));
    h.alive.add(500);
    await h.devices.read();
    h.devices.feed(PHONE);
    const controller = h.controllers[0]!.controller;
    // agent-device's headless keyboard, left selected by an agent session
    // that couldn't end cleanly, and its note of the one it replaced.
    const device = keyboards(
      h,
      { default_input_method: AGENT_KEYBOARD, agent_device_ime_helper_previous_ime: VOICE },
      [GBOARD, VOICE, AGENT_KEYBOARD],
    );
    let keyboardAtQuit: string | undefined;
    let noteAtQuit: string | undefined;
    controller.shutdown.mockImplementation(async () => {
      keyboardAtQuit = device.settings.default_input_method;
      noteAtQuit = device.settings.agent_device_ime_helper_previous_ime;
      h.onSleep = () => h.alive.delete(500);
    });
    await h.devices.shutdown(PHONE);
    // Saved with its Quick Boot state, so it starts with it anywhere.
    expect(keyboardAtQuit).toBe(VOICE);
    expect(device.picked).toEqual([VOICE]);
    // As agent-device's own restore leaves it.
    expect(noteAtQuit).toBeUndefined();
  });

  it("keeps agent-device's note when the device doesn't take its own keyboard back", async () => {
    const logs: string[] = [];
    const h = harness({ log: (line) => logs.push(line) });
    h.running.push(emulator(600, null));
    h.alive.add(600);
    h.onSleep = () => h.alive.delete(600);
    await h.devices.read();
    const device = keyboards(
      h,
      { default_input_method: AGENT_KEYBOARD, agent_device_ime_helper_previous_ime: VOICE },
      [GBOARD, VOICE, AGENT_KEYBOARD],
      { takes: false },
    );
    await h.devices.shutdown(PHONE);
    expect(device.picked).toEqual([VOICE]);
    // agent-device can still put it back.
    expect(device.settings.agent_device_ime_helper_previous_ime).toBe(VOICE);
    expect(logs).toContain(`couldn't give ${PHONE} its own keyboard back from agent-device's`);
  });

  it("picks the device's first own keyboard when agent-device's note is gone or stale", async () => {
    const notes: Record<string, string>[] = [
      {},
      { agent_device_ime_helper_previous_ime: "com.example.gone/.Keyboard" },
    ];
    for (const note of notes) {
      const h = harness();
      // Someone else's emulator, which stops through adb.
      h.running.push(emulator(600, null));
      h.alive.add(600);
      h.onSleep = () => h.alive.delete(600);
      await h.devices.read();
      const device = keyboards(h, { default_input_method: AGENT_KEYBOARD, ...note }, [AGENT_KEYBOARD, GBOARD, VOICE]);
      await h.devices.shutdown(PHONE);
      expect(device.picked).toEqual([GBOARD]);
      expect(h.adbCalls.at(-1)).toEqual(["-s", "emulator-5554", "emu", "kill"]);
    }
  });

  it("leaves a device's own keyboard alone, and shuts down when it can't check", async () => {
    const h = harness();
    h.running.push(emulator(500));
    h.alive.add(500);
    await h.devices.read();
    h.devices.feed(PHONE);
    const controller = h.controllers[0]!.controller;
    controller.shutdown.mockImplementation(async () => {
      h.onSleep = () => h.alive.delete(500);
    });
    const device = keyboards(h, { default_input_method: VOICE }, [GBOARD, VOICE, AGENT_KEYBOARD]);
    await h.devices.shutdown(PHONE);
    expect(device.picked).toEqual([]);

    h.running.length = 0;
    h.running.push(emulator(501));
    h.alive.add(501);
    await h.devices.read();
    h.devices.feed(PHONE);
    const next = h.controllers[1]!.controller;
    next.shutdown.mockImplementation(async () => {
      h.onSleep = () => h.alive.delete(501);
    });
    h.onAdb = () => {
      throw new Error("adb: device offline");
    };
    await h.devices.shutdown(PHONE);
    expect(next.shutdown).toHaveBeenCalled();
  });

  it("gives a device it starts its own keyboard back before saying it started", async () => {
    const h = harness();
    await h.devices.read();
    const device = keyboards(h, { default_input_method: AGENT_KEYBOARD }, [GBOARD, AGENT_KEYBOARD]);
    h.onSleep = () => {
      if (h.running.length === 0) h.running.push(emulator(h.processes[0]!.pid));
      else if (h.controllers[0]) h.controllers[0].controller.booted = true;
    };
    await h.devices.boot(PHONE, new AbortController().signal);
    // An agent session can open as soon as the device has started, and it
    // selects agent-device's keyboard itself; a later check would take it away.
    expect(device.picked).toEqual([GBOARD]);
    // adb may not have found an emulator that just started.
    expect(h.adbCalls[0]).toEqual([
      "-s",
      "emulator-5554",
      "wait-for-device",
      "shell",
      "settings",
      "get",
      "secure",
      "default_input_method",
    ]);
  });

  it("ends an emulator that won't quit, and says so when it can't", async () => {
    const h = harness({
      signal: (pid, signal) => {
        h.signals.push([pid, signal]);
      },
    });
    h.running.push(emulator(500));
    h.alive.add(500);
    await h.devices.read();
    await expect(h.devices.shutdown(PHONE)).rejects.toThrow("did not stop");
    expect(h.signals).toEqual([
      [500, "SIGTERM"],
      [500, "SIGKILL"],
    ]);
  });

  it("rounds a screen as its art does, or about as a Pixel does", async () => {
    const h = harness();
    await h.devices.read();
    expect(await h.devices.screen(PHONE)).toEqual({
      widthPx: 1080,
      heightPx: 2400,
      scale: 2.625,
      cornerRadius: 33,
    });
    expect((await h.devices.screen(TABLET))!.cornerRadius).toBe(24);
    expect(await h.devices.screen("Missing")).toBeNull();
    expect(
      defaultAndroidCornerRadius({ screen: { widthPx: 1080, heightPx: 2424, scale: 2.625 }, formFactor: "phone" }),
    ).toBe(33);
  });

  it("drives a running device through its control service", async () => {
    const h = harness();
    h.running.push(emulator(500));
    h.alive.add(500);
    await h.devices.read();
    expect(h.devices.drives(PHONE)).toBe(true);
    const screen = (await h.devices.screen(PHONE)) as SimulatorScreen;
    const start = h.devices.feed(PHONE);
    start({ maxSide: 1200, fps: 30, onFrame: () => undefined, onEnd: () => undefined });
    const controller = h.controllers[0]!.controller;
    expect(controller.feeds).toHaveLength(1);
    await h.devices.input(PHONE, { kind: "tap", at: { x: 100, y: 200 } }, screen);
    expect(controller.touches).toEqual([
      { x: 263, y: 525, id: 0, down: true },
      { x: 263, y: 525, id: 0, down: false },
    ]);
    controller.touches.length = 0;
    await h.devices.touch(PHONE, { phase: "down", at: { x: 100, y: 200 } });
    await h.devices.touch(PHONE, { phase: "up", at: { x: 100, y: 210 } });
    expect(controller.touches).toEqual([
      { x: 263, y: 525, id: 0, down: true },
      { x: 263, y: 551, id: 0, down: false },
    ]);
    await expect(h.devices.touch("Missing", { phase: "down", at: { x: 1, y: 1 } })).rejects.toThrow();
    await h.devices.rotate(PHONE, "landscape-left");
    expect(controller.rotations).toEqual(["landscape-left"]);
    expect(await h.devices.appearance(PHONE)).toBe("dark");
    await h.devices.setAppearance(PHONE, "light");
    expect(h.adbCalls.at(-1)).toEqual(["-s", "emulator-5554", "shell", "cmd", "uimode", "night", "no"]);
    const file = path.join(root, "shot.png");
    await h.devices.screenshot(PHONE, file);
    expect(await readFile(file, "utf8")).toBe("png-bytes");
    expect(await h.devices.describe(PHONE)).toMatchObject({
      appId: "com.example",
      elements: [{ type: "Button", label: "Go", frame: { x: 0, y: 0, width: 80, height: 40 } }],
    });
    expect(h.devices.recordingTarget(PHONE)).toEqual({
      adb: ADB,
      serial: "emulator-5554",
      apiLevel: 0,
    });
  });

  it("can't show or drive someone else's emulator, and says why", async () => {
    const h = harness();
    h.running.push(emulator(500, null));
    h.alive.add(500);
    await h.devices.read();
    expect(h.devices.drives(PHONE)).toBe(false);
    expect(h.devices.drives(TABLET)).toBe(false);
    expect(() => h.devices.feed(PHONE)).toThrow(
      "Medium Phone API 37.0 was started outside Zeros. Stop it there, then start it here to use it in Zeros.",
    );
    expect(() => h.devices.feed(TABLET)).toThrow("Pixel Tablet isn't running.");
    expect(() => h.devices.feed(TABLET)).toThrow(DeviceActionError);
  });

  it("reconnects to an emulator that restarted", async () => {
    const h = harness();
    h.running.push(emulator(500));
    h.alive.add(500);
    await h.devices.read();
    h.devices.feed(PHONE);
    const first = h.controllers[0]!.controller;
    h.alive.delete(500);
    h.running.push(emulator(501));
    h.alive.add(501);
    await h.devices.read();
    expect(first.closed).toBe(true);
    h.devices.feed(PHONE);
    expect(h.controllers).toHaveLength(2);
    h.devices.dispose();
    expect(h.controllers[1]!.controller.closed).toBe(true);
  });
});
