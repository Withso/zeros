import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SimulatorRecordingEnd,
  SimulatorRecordingsSnapshot,
} from "@zeros/protocol/simulator-captures";
import type {
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorOrientation,
} from "@zeros/protocol/simulators";

import { captureDragIcon, captureThumbnail, type CaptureImages } from "../devices/capture-images";
import { captureFileName, freeFileName } from "../devices/capture-names";
import { RecordingLog, TYPING_MERGE_MS, describeAction } from "../devices/recording-timeline";
import { RecordingTimelines, recordingFingerprint } from "../devices/recording-timelines";
import {
  RECORDING_FINISH_MS,
  SCREEN_SETTLE_MS,
  SimulatorCaptures,
  placeElements,
  pngSize,
  type SimulatorCapturesOptions,
} from "../devices/simulator-captures";
import { recordSimulatorVideo, type RecorderProcess } from "../devices/simulator-recorder";
import { XCRUN } from "../devices/tool-runner";
import { readScreenElements } from "../devices/ui-elements";

const PHONE = "11111111-1111-4111-8111-111111111111";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function tree(
  space: { width: number; height: number },
  children: Array<Record<string, unknown>>,
): string {
  return JSON.stringify([
    {
      type: "Application",
      AXLabel: "Settings",
      pid: 4242,
      frame: { x: 0, y: 0, ...space },
      children,
    },
  ]);
}

const SIGN_IN = {
  type: "Button",
  AXLabel: "Sign in",
  AXValue: null,
  AXUniqueId: "login.submit",
  frame: { x: 40, y: 420, width: 120, height: 44 },
};

describe("capture names", () => {
  const at = new Date(2025, 9, 12, 14, 3, 22);

  it("names captures the way Simulator does", () => {
    expect(captureFileName("screenshot", "iPhone 17", at)).toBe(
      "Simulator Screenshot - iPhone 17 - 2025-10-12 at 14.03.22.png",
    );
    expect(captureFileName("recording", "iPad Pro 13-inch (M5)", at)).toBe(
      "Simulator Screen Recording - iPad Pro 13-inch (M5) - 2025-10-12 at 14.03.22.mp4",
    );
  });

  it("keeps device names from making paths", () => {
    expect(captureFileName("screenshot", "../My/Phone:\u0007 1", at)).toBe(
      "Simulator Screenshot - -My-Phone- 1 - 2025-10-12 at 14.03.22.png",
    );
    expect(captureFileName("screenshot", "  ", at)).toContain("Simulator Screenshot - Simulator - ");
  });

  it("numbers copies when a name is taken", () => {
    const taken = new Set(["a.png", "a (2).png"]);
    expect(freeFileName("b.png", (name) => taken.has(name))).toBe("b.png");
    expect(freeFileName("a.png", (name) => taken.has(name))).toBe("a (3).png");
    expect(freeFileName("a", () => true)).toBeNull();
  });
});

describe("capture images", () => {
  interface FakeImage {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(size: { width?: number; height?: number }): FakeImage;
    toDataURL(): string;
  }

  function image(width: number, height: number): FakeImage {
    return {
      isEmpty: () => width === 0,
      getSize: () => ({ width, height }),
      resize: ({ width: w, height: h }) =>
        image(w ?? Math.round((width * h!) / height), h ?? Math.round((height * w!) / width)),
      toDataURL: () => `data:image/png;base64,${width}x${height}`,
    };
  }

  function images(files: Record<string, FakeImage>) {
    return {
      createFromPath: vi.fn((file: string) => files[file] ?? image(0, 0)),
      createFromDataURL: vi.fn(() => image(166, 360)),
      createFromBitmap: vi.fn((_bytes: Buffer, size: { width: number; height: number }) =>
        image(size.width, size.height),
      ),
    };
  }

  const saved = (kind: "screenshot" | "recording", thumbnail: string | null) => ({
    capture: {
      id: "capture-1",
      kind,
      deviceId: PHONE,
      deviceName: "iPhone 17",
      fileName: "a.png",
      thumbnail,
    },
    path: "/Downloads/a.png",
  });

  it("shrinks a screenshot to a thumbnail, keeping its shape", () => {
    const fake = images({ "/work/shot.png": image(1206, 2622), "/work/wide.png": image(2622, 1206) });
    const port = fake as unknown as CaptureImages;
    expect(captureThumbnail(port, "/work/shot.png")).toBe("data:image/png;base64,166x360");
    expect(captureThumbnail(port, "/work/wide.png")).toBe("data:image/png;base64,360x166");
    expect(captureThumbnail(port, "/work/missing.png")).toBeNull();
  });

  it("always has an icon to drag", () => {
    const fake = images({ "/Downloads/a.png": image(1206, 2622) });
    const port = fake as unknown as CaptureImages;
    expect(captureDragIcon(port, saved("recording", "data:image/png;base64,AAAA")).getSize()).toEqual({
      width: 44,
      height: 96,
    });
    expect(captureDragIcon(port, saved("screenshot", null)).getSize()).toEqual({ width: 44, height: 96 });
    expect(fake.createFromPath).toHaveBeenCalledWith("/Downloads/a.png");
    expect(captureDragIcon(port, saved("recording", null)).getSize()).toEqual({ width: 32, height: 32 });
  });
});

describe("screen elements", () => {
  it("reads the front app and the elements people see", () => {
    const screen = readScreenElements(
      tree({ width: 402, height: 874 }, [
        {
          type: "Group",
          AXLabel: null,
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            SIGN_IN,
            { ...SIGN_IN },
            { type: "Group", AXLabel: null, frame: { x: 0, y: 0, width: 10, height: 10 } },
            {
              type: "TextField",
              AXLabel: "Address",
              AXValue: "\u200eexample.com",
              frame: { x: 149, y: 806, width: 104, height: 20.333333 },
            },
            { type: "StaticText", AXLabel: "Hidden", frame: { x: 0, y: 0, width: 0, height: 0 } },
            { type: "Button", AXLabel: null, AXUniqueId: "BackButton", frame: { x: 34, y: 792, width: 48, height: 48 } },
          ],
        },
      ]),
    );
    expect(screen.appName).toBe("Settings");
    expect(screen.pid).toBe(4242);
    expect(screen.space).toEqual({ width: 402, height: 874 });
    expect(screen.elements).toEqual([
      {
        type: "Button",
        label: "Sign in",
        value: null,
        identifier: "login.submit",
        frame: { x: 40, y: 420, width: 120, height: 44 },
      },
      {
        type: "TextField",
        label: "Address",
        value: "example.com",
        identifier: null,
        frame: { x: 149, y: 806, width: 104, height: 20.3 },
      },
      {
        type: "Button",
        label: null,
        value: null,
        identifier: "BackButton",
        frame: { x: 34, y: 792, width: 48, height: 48 },
      },
    ]);
  });

  it("never keeps what a password field holds", () => {
    const screen = readScreenElements(
      tree({ width: 402, height: 874 }, [
        {
          type: "TextField",
          subrole: "AXSecureTextField",
          AXLabel: "Password",
          AXValue: "hunter2",
          frame: { x: 20, y: 300, width: 360, height: 44 },
        },
        {
          type: "Other",
          role_description: "secure text field",
          AXLabel: null,
          AXValue: "••••",
          frame: { x: 20, y: 360, width: 360, height: 44 },
        },
      ]),
    );
    expect(screen.elements).toEqual([
      {
        type: "SecureTextField",
        label: "Password",
        value: null,
        identifier: null,
        frame: { x: 20, y: 300, width: 360, height: 44 },
      },
      {
        type: "SecureTextField",
        label: null,
        value: null,
        identifier: null,
        frame: { x: 20, y: 360, width: 360, height: 44 },
      },
    ]);
  });

  it("reads nothing from output it can't parse", () => {
    expect(readScreenElements("not json")).toEqual({
      appName: null,
      appId: null,
      pid: null,
      space: null,
      elements: [],
    });
    expect(readScreenElements("[]").elements).toEqual([]);
  });

  it("puts a portrait app's elements onto a turned screenshot", () => {
    const portrait = readScreenElements(tree({ width: 402, height: 874 }, [SIGN_IN]));
    const [placed] = placeElements(portrait, { width: 874, height: 402 }, "landscape-left");
    // The button's portrait corners (40, 420) and (160, 464) turn with the device.
    expect(placed!.frame).toEqual({ x: 420, y: 242, width: 44, height: 120 });
    const turned = readScreenElements(tree({ width: 874, height: 402 }, [SIGN_IN]));
    expect(placeElements(turned, { width: 874, height: 402 }, "landscape-left")[0]!.frame).toEqual(
      SIGN_IN.frame,
    );
  });

  it("reads a PNG's size from its header", () => {
    expect(pngSize(png(1206, 2622))).toEqual({ width: 1206, height: 2622 });
    expect(pngSize(Buffer.from("not a png at all, really"))).toBeNull();
  });
});

describe("recording timelines", () => {
  const portrait = { orientation: "portrait" as SimulatorOrientation, screen: null };
  const signIn = readScreenElements(tree({ width: 402, height: 874 }, [SIGN_IN]));

  it("words what happened", () => {
    const screen = { space: signIn.space, elements: signIn.elements };
    expect(describeAction({ kind: "tap", at: { x: 60, y: 440 } }, { ...portrait, screen })).toBe(
      'tap Button "Sign in"',
    );
    expect(describeAction({ kind: "tap", at: { x: 300.4, y: 20.6 } }, portrait)).toBe("tap at 300, 21");
    expect(describeAction({ kind: "tap", at: null, target: "@e5" }, portrait)).toBe("tap @e5");
    expect(describeAction({ kind: "long-press", at: { x: 1, y: 2 } }, portrait)).toBe(
      "long-press at 1, 2",
    );
    expect(
      describeAction({ kind: "swipe", from: { x: 200, y: 700 }, to: { x: 210, y: 200 } }, portrait),
    ).toBe("swipe up from 200, 700");
    expect(
      describeAction({ kind: "swipe", from: { x: 60, y: 440 }, to: { x: 62, y: 441 } }, { ...portrait, screen }),
    ).toBe('drag Button "Sign in"');
    expect(describeAction({ kind: "text", text: "hello\nworld" }, portrait)).toBe('type "hello world"');
    expect(describeAction({ kind: "key", key: "enter" }, portrait)).toBe("press Return");
    expect(describeAction({ kind: "button", button: "home" }, portrait)).toBe("press Home");
    expect(describeAction({ kind: "button", button: "lock" }, portrait)).toBe("press Lock");
    expect(describeAction({ kind: "button", button: "back" }, portrait)).toBe("press Back");
    expect(describeAction({ kind: "pinch", scale: 2 }, portrait)).toBe("zoom in");
    expect(describeAction({ kind: "rotate", orientation: "landscape-left" }, portrait)).toBe(
      "rotate to landscape left",
    );
    expect(describeAction({ kind: "appearance", appearance: "dark" }, portrait)).toBe(
      "switch to dark appearance",
    );
    expect(describeAction({ kind: "open", target: "com.example.app" }, portrait)).toBe(
      "open com.example.app",
    );
  });

  it("finds what the user touched on a turned screen", () => {
    const turned = readScreenElements(
      tree({ width: 874, height: 402 }, [
        { ...SIGN_IN, frame: { x: 90, y: 20, width: 40, height: 20 } },
      ]),
    );
    const context = {
      orientation: "landscape-left" as const,
      screen: { space: turned.space, elements: turned.elements },
    };
    // The portrait point (372, 100) is upright (100, 30) on a landscape-left device.
    expect(describeAction({ kind: "tap", at: { x: 372, y: 100 }, portrait: true }, context)).toBe(
      'tap Button "Sign in"',
    );
    expect(describeAction({ kind: "tap", at: { x: 200, y: 600 }, portrait: true }, context)).toBe(
      "tap at 600, 202",
    );
  });

  it("logs actions from the first frame and joins typing", () => {
    const log = new RecordingLog(1_000);
    log.note(4_200, null, { kind: "tap", at: { x: 1, y: 2 } }, portrait);
    log.note(5_000, null, { kind: "text", text: "he" }, portrait);
    log.note(5_500, null, { kind: "text", text: "llo" }, portrait);
    log.note(5_600, "Codex", { kind: "text", text: "!" }, portrait);
    log.note(5_600 + TYPING_MERGE_MS + 1, "Codex", { kind: "text", text: "?" }, portrait);
    log.note(500, null, { kind: "key", key: "enter" }, portrait);
    expect(log.actions()).toEqual([
      { atMs: 3_200, agent: null, text: "tap at 1, 2" },
      { atMs: 4_000, agent: null, text: 'type "hello"' },
      { atMs: 4_600, agent: "Codex", text: 'type "!"' },
      { atMs: 4_600 + TYPING_MERGE_MS + 1, agent: "Codex", text: 'type "?"' },
      { atMs: 0, agent: null, text: "press Return" },
    ]);
  });

  it("counts typing that may be a password instead of quoting it", () => {
    const masked = { ...portrait, maskTyping: true };
    expect(describeAction({ kind: "text", text: "hunter2" }, masked)).toBe("type 7 characters");
    expect(describeAction({ kind: "text", text: "é" }, masked)).toBe("type 1 character");
    const log = new RecordingLog(0);
    log.note(100, null, { kind: "text", text: "hun" }, masked);
    // Once part of it was masked, all of it stays masked.
    log.note(200, null, { kind: "text", text: "ter2" }, portrait);
    expect(log.actions()).toEqual([{ atMs: 100, agent: null, text: "type 7 characters" }]);
  });
});

describe("recording timelines on disk", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "zeros-timelines-"));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("fingerprints the size and both ends of a video", async () => {
    const file = path.join(folder, "video.mp4");
    const bytes = Buffer.alloc(200_000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    await writeFile(file, bytes);
    const expected = createHash("sha256")
      .update("zeros-recording\n200000\n")
      .update(bytes.subarray(0, 65_536))
      .update(bytes.subarray(200_000 - 65_536))
      .digest("hex");
    expect(await recordingFingerprint(file)).toBe(expected);
  });

  it("saves, finds and prunes timelines", async () => {
    const store = new RecordingTimelines(path.join(folder, "recordings"), 2);
    const timeline = { deviceName: "iPhone 17", osLabel: "iOS 27.0", actions: [] };
    const [a, b, c] = ["a", "b", "c"].map((letter) => letter.repeat(64));
    await store.save(a!, timeline);
    await utimes(path.join(folder, "recordings", `${a}.json`), 1, 1);
    await store.save(b!, { ...timeline, deviceName: "iPad" });
    await store.save(c!, timeline);
    expect(await store.load(a!)).toBeNull();
    expect(await store.load(b!)).toMatchObject({ deviceName: "iPad" });
    expect(await store.load(c!)).toEqual(timeline);
    expect(await store.load("../x")).toBeNull();
    await expect(store.save("../x", timeline)).rejects.toThrow();
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === "SIGINT") {
      this.stderr.emit("data", "Recording completed. Writing to disk.\nWrote video to: /x.mp4\n");
      this.emit("exit", 0);
    } else {
      this.emit("exit", null);
    }
    return true;
  });
}

describe("simctl recordings", () => {
  it("starts once the first frame is in and finishes on SIGINT", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as never);
    const recorder = recordSimulatorVideo(spawn, PHONE, "/work/a.mp4");
    expect(spawn).toHaveBeenCalledWith(XCRUN, [
      "simctl",
      "io",
      PHONE,
      "recordVideo",
      "--codec=h264",
      "--force",
      "/work/a.mp4",
    ]);
    child.stderr.emit("data", "Note: No display specified.\nRecording sta");
    child.stderr.emit("data", "rted\n");
    await expect(recorder.started).resolves.toBeUndefined();
    recorder.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    await expect(recorder.exited).resolves.toBe(true);
    recorder.kill();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails when the tool exits before recording", async () => {
    const child = new FakeChild();
    const recorder = recordSimulatorVideo(() => child as never, PHONE, "/work/a.mp4");
    child.emit("exit", 1);
    await expect(recorder.started).rejects.toThrow();
    await expect(recorder.exited).resolves.toBe(false);
  });
});

class FakeClock {
  now = 1_700_000_000_000;
  timers: Array<{ at: number; callback: () => void }> = [];
  setTimer = (callback: () => void, ms: number) => {
    const timer = { at: this.now + ms, callback };
    this.timers.push(timer);
    return timer;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer !== handle);
  };
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.now = next.at;
      next.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

class FakeRecorder implements RecorderProcess {
  readonly started: Promise<void>;
  readonly exited: Promise<boolean>;
  begin!: () => void;
  fail!: (error: Error) => void;
  exit!: (finished: boolean) => void;
  readonly stop = vi.fn(() => {
    void writeFile(this.file, "mp4-bytes").then(() => this.exit(true));
  });
  readonly kill = vi.fn(() => this.exit(false));

  constructor(private readonly file: string) {
    this.started = new Promise((resolve, reject) => {
      this.begin = resolve;
      this.fail = reject;
    });
    void this.started.catch(() => undefined);
    this.exited = new Promise((resolve) => {
      this.exit = resolve;
    });
  }
}

interface Harness {
  captures: SimulatorCaptures;
  clock: FakeClock;
  downloads: string;
  work: string;
  device: SimulatorDevice;
  holds: { taken: number; released: number };
  recorders: FakeRecorder[];
  describes: string[];
  snapshots: SimulatorRecordingsSnapshot[];
  ends: SimulatorRecordingEnd[];
  options: SimulatorCapturesOptions;
}

describe("SimulatorCaptures", () => {
  let root: string;
  let h: Harness;

  async function harness(overrides: Partial<SimulatorCapturesOptions> = {}): Promise<Harness> {
    const downloads = path.join(root, "Downloads");
    const work = path.join(root, "work");
    const clock = new FakeClock();
    const device: SimulatorDevice = {
      id: PHONE,
      platform: "ios",
      name: "iPhone 17",
      osLabel: "iOS 27.0",
      formFactor: "phone",
      state: "booted",
      bootedByZeros: true,
    };
    const holds = { taken: 0, released: 0 };
    const recorders: FakeRecorder[] = [];
    const describes: string[] = [tree({ width: 402, height: 874 }, [SIGN_IN])];
    const snapshots: SimulatorRecordingsSnapshot[] = [];
    const ends: SimulatorRecordingEnd[] = [];
    const options: SimulatorCapturesOptions = {
      devices: {
        running: async (deviceId) => {
          if (deviceId !== PHONE || device.state !== "booted") {
            throw new Error("iPhone 17 isn't running.");
          }
          return { ...device };
        },
        screen: async () => ({ widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 62 }),
        hold: () => {
          holds.taken += 1;
          return () => {
            holds.released += 1;
          };
        },
      },
      screenshot: async (_udid, file) => {
        await writeFile(file, png(1206, 2622));
      },
      record: (_udid, file) => {
        const recorder = new FakeRecorder(file);
        recorders.push(recorder);
        return recorder;
      },
      describe: async () => (describes[0] ? readScreenElements(describes[0]) : null),
      appId: async (_udid, pid) => (pid === 4242 ? "com.apple.Preferences" : null),
      thumbnail: async () => "data:image/png;base64,iVBORw0KGgo=",
      downloadsDir: () => downloads,
      workDir: work,
      timelines: new RecordingTimelines(path.join(root, "recordings")),
      onRecordings: (snapshot) => snapshots.push(snapshot),
      onRecordingEnd: (end) => ends.push(end),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...overrides,
    };
    return {
      captures: new SimulatorCaptures(options),
      clock,
      downloads,
      work,
      device,
      holds,
      recorders,
      describes,
      snapshots,
      ends,
      options,
    };
  }

  async function startRecording(): Promise<FakeRecorder> {
    const count = h.recorders.length;
    const started = h.captures.startRecording(PHONE);
    await vi.waitFor(() => expect(h.recorders).toHaveLength(count + 1));
    const recorder = h.recorders.at(-1)!;
    recorder.begin();
    await started;
    return recorder;
  }

  function hubSnapshot(device: Partial<SimulatorDevice>): SimulatorHubSnapshot {
    return {
      version: 1,
      devices: [{ ...h.device, ...device }],
      setup: [],
      idleWarnings: [],
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-captures-"));
    h = await harness();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a screenshot to Downloads under Simulator's name", async () => {
    const capture = await h.captures.screenshot(PHONE);
    const name = captureFileName("screenshot", "iPhone 17", new Date(h.clock.now));
    expect(capture).toEqual({
      id: "capture-1",
      kind: "screenshot",
      deviceId: PHONE,
      deviceName: "iPhone 17",
      fileName: name,
      thumbnail: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(await readdir(h.downloads)).toEqual([name]);
    expect(await readdir(h.work)).toEqual([]);
    expect(h.holds).toEqual({ taken: 1, released: 1 });
    const file = await h.captures.file(capture.id);
    expect(file.mimeType).toBe("image/png");
    expect(file.fileName).toBe(name);
    expect(pngSize(file.bytes)).toEqual({ width: 1206, height: 2622 });
  });

  it("never saves over another file", async () => {
    const first = await h.captures.screenshot(PHONE);
    const second = await h.captures.screenshot(PHONE);
    expect(second.fileName).toBe(first.fileName.replace(".png", " (2).png"));
    expect((await readdir(h.downloads)).sort()).toEqual([first.fileName, second.fileName].sort());
  });

  it("words its own failures and leaves nothing behind", async () => {
    const failing = await harness({
      screenshot: async (_udid, file) => {
        await writeFile(file, "partial");
        throw new Error("simctl: /Users/me/secret");
      },
    });
    await expect(failing.captures.screenshot(PHONE)).rejects.toThrow(
      "Couldn't take a screenshot of iPhone 17.",
    );
    expect(await readdir(failing.work)).toEqual([]);
    expect(failing.holds).toEqual({ taken: 1, released: 1 });
    h.device.state = "shutdown";
    await expect(h.captures.screenshot(PHONE)).rejects.toThrow("iPhone 17 isn't running.");
  });

  it("knows only the captures it saved, while they are still there", async () => {
    await expect(h.captures.file("capture-9")).rejects.toThrow("That capture is no longer available.");
    await expect(h.captures.file("../etc/passwd")).rejects.toThrow(
      "That capture is no longer available.",
    );
    const capture = await h.captures.screenshot(PHONE);
    const saved = await h.captures.savedFile(capture.id);
    expect(saved.path).toBe(path.join(h.downloads, capture.fileName));
    await rm(saved.path);
    await expect(h.captures.file(capture.id)).rejects.toThrow(
      "That screenshot isn't in Downloads anymore.",
    );
  });

  it("drops a thumbnail it can't show", async () => {
    const pictures: string[] = [];
    const big = await harness({
      thumbnail: async (picture) => {
        pictures.push(await readFile(picture, "hex"));
        return "data:image/jpeg;base64,AAAA";
      },
    });
    expect((await big.captures.screenshot(PHONE)).thumbnail).toBeNull();
    expect(pictures).toEqual([png(1206, 2622).toString("hex")]);
    const broken = await harness({
      thumbnail: async () => {
        throw new Error("no image");
      },
    });
    expect((await broken.captures.screenshot(PHONE)).thumbnail).toBeNull();
  });

  it("records until Stop, then saves the video and its timeline", async () => {
    const recorder = await startRecording();
    const startedAt = h.clock.now;
    expect(h.captures.recordings().recordings).toEqual([{ deviceId: PHONE, startedAt }]);
    expect(h.snapshots.at(-1)!.recordings).toHaveLength(1);
    expect(h.holds.taken).toBe(1);
    await h.clock.advance(0);
    await h.clock.advance(3_200);
    h.captures.noteAction(PHONE, null, { kind: "tap", at: { x: 60, y: 440 }, portrait: true });
    await h.clock.advance(300);
    h.captures.noteAction(PHONE, null, { kind: "tap", at: { x: 60, y: 440 }, portrait: true });
    await h.clock.advance(SCREEN_SETTLE_MS + 100);
    h.captures.noteAction(PHONE, "Codex", { kind: "tap", at: { x: 60, y: 440 } });
    await h.clock.advance(1_000);

    const capture = await h.captures.stopRecording(PHONE);
    expect(recorder.stop).toHaveBeenCalled();
    expect(capture).toMatchObject({
      id: "capture-1",
      kind: "recording",
      fileName: captureFileName("recording", "iPhone 17", new Date(startedAt)),
      // Made from a screenshot of the first frame.
      thumbnail: "data:image/png;base64,iVBORw0KGgo=",
      durationMs: 3_200 + 300 + SCREEN_SETTLE_MS + 100 + 1_000,
    });
    expect(h.captures.recordings().recordings).toEqual([]);
    expect(h.holds).toEqual({ taken: 1, released: 1 });
    expect(await readdir(h.work)).toEqual([]);
    const saved = await h.captures.savedFile(capture.id);
    expect(await readFile(saved.path, "utf8")).toBe("mp4-bytes");

    const fingerprint = await recordingFingerprint(saved.path);
    expect(await h.captures.timeline(fingerprint)).toEqual({
      deviceName: "iPhone 17",
      osLabel: "iOS 27.0",
      actions: [
        { atMs: 3_200, agent: null, text: 'tap Button "Sign in"' },
        // The screen may have changed since the first tap, so it isn't named.
        { atMs: 3_500, agent: null, text: "tap at 60, 440" },
        { atMs: 3_500 + SCREEN_SETTLE_MS + 100, agent: "Codex", text: 'tap Button "Sign in"' },
      ],
    });
    expect(h.ends).toEqual([]);
    await expect(h.captures.stopRecording(PHONE)).rejects.toThrow("That simulator isn't recording.");
  });

  it("starts one recording per device", async () => {
    const first = h.captures.startRecording(PHONE);
    const second = h.captures.startRecording(PHONE);
    await vi.waitFor(() => expect(h.recorders).toHaveLength(1));
    h.recorders[0]!.begin();
    expect(await first).toEqual(await second);
    expect(await h.captures.startRecording(PHONE)).toEqual(await first);
  });

  it("words a recording that won't start", async () => {
    const started = h.captures.startRecording(PHONE);
    await vi.waitFor(() => expect(h.recorders).toHaveLength(1));
    h.recorders[0]!.fail(new Error("simctl: /Users/me"));
    await expect(started).rejects.toThrow("Couldn't start recording iPhone 17.");
    expect(h.recorders[0]!.kill).toHaveBeenCalled();
    expect(h.holds).toEqual({ taken: 1, released: 1 });
    expect(h.captures.recordings().recordings).toEqual([]);
  });

  it("ends a recording at its limit and shows it once", async () => {
    await startRecording();
    await h.clock.advance(60 * 60_000);
    await vi.waitFor(() => expect(h.ends).toHaveLength(1));
    expect(h.ends[0]).toMatchObject({
      deviceId: PHONE,
      reason: "limit",
      capture: { kind: "recording" },
    });
    expect(h.captures.recordings().recordings).toEqual([]);
  });

  it("saves the recording before its device shuts down", async () => {
    const recorder = await startRecording();
    const stopping = h.captures.deviceStopping(PHONE);
    h.captures.syncDevices(hubSnapshot({ state: "shutting-down" }));
    await stopping;
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.ends).toHaveLength(1);
    expect(h.ends[0]).toMatchObject({ reason: "device", capture: { kind: "recording" } });
  });

  it("reports a recording that ended on its own without a video", async () => {
    const recorder = await startRecording();
    recorder.exit(false);
    await vi.waitFor(() => expect(h.ends).toHaveLength(1));
    expect(h.ends[0]).toEqual({
      deviceId: PHONE,
      reason: "exited",
      error: "Couldn't save the recording of iPhone 17.",
    });
    expect(await readdir(h.downloads).catch(() => [])).toEqual([]);
    expect(h.holds).toEqual({ taken: 1, released: 1 });
  });

  it("gives up on a recording that never finishes", async () => {
    const recorder = await startRecording();
    recorder.stop.mockImplementation(() => undefined);
    const stopped = h.captures.stopRecording(PHONE);
    const rejected = expect(stopped).rejects.toThrow("Couldn't save the recording of iPhone 17.");
    await flush();
    await h.clock.advance(RECORDING_FINISH_MS);
    await rejected;
    expect(recorder.kill).toHaveBeenCalled();
  });

  it("reads the screen again after the device turns", async () => {
    await startRecording();
    await h.clock.advance(0);
    h.describes[0] = tree({ width: 874, height: 402 }, [SIGN_IN]);
    h.captures.syncDevices(hubSnapshot({ orientation: "landscape-left" }));
    h.captures.noteAction(PHONE, "Codex", { kind: "tap", at: { x: 60, y: 440 } });
    await h.clock.advance(SCREEN_SETTLE_MS);
    h.captures.noteAction(PHONE, "Codex", { kind: "tap", at: { x: 60, y: 440 } });
    const capture = await h.captures.stopRecording(PHONE);
    const saved = await h.captures.savedFile(capture.id);
    const timeline = await h.captures.timeline(await recordingFingerprint(saved.path));
    expect(timeline!.actions.map((action) => action.text)).toEqual([
      "tap at 60, 440",
      'tap Button "Sign in"',
    ]);
  });

  it("quotes typing only once it has seen no password field on screen", async () => {
    await startRecording();
    // The first screen read hasn't finished yet.
    h.captures.noteAction(PHONE, null, { kind: "text", text: "secret" });
    await h.clock.advance(TYPING_MERGE_MS + 1);
    h.captures.noteAction(PHONE, null, { kind: "text", text: "search" });
    await h.clock.advance(TYPING_MERGE_MS + 1);
    h.describes[0] = tree({ width: 402, height: 874 }, [
      { type: "TextField", subrole: "AXSecureTextField", AXLabel: "Password", frame: SIGN_IN.frame },
    ]);
    h.captures.noteAction(PHONE, null, { kind: "key", key: "tab" });
    await h.clock.advance(SCREEN_SETTLE_MS);
    h.captures.noteAction(PHONE, null, { kind: "text", text: "hunter2" });
    const capture = await h.captures.stopRecording(PHONE);
    const saved = await h.captures.savedFile(capture.id);
    const timeline = await h.captures.timeline(await recordingFingerprint(saved.path));
    expect(timeline!.actions.map((action) => action.text)).toEqual([
      "type 6 characters",
      'type "search"',
      "press Tab",
      "type 7 characters",
    ]);
  });

  it("saves recordings on quit", async () => {
    await startRecording();
    await h.captures.dispose();
    expect(h.ends).toHaveLength(1);
    expect(h.ends[0]).toMatchObject({ reason: "quit", capture: { kind: "recording" } });
    await expect(h.captures.screenshot(PHONE)).rejects.toThrow("Zeros is quitting.");
  });

  it("freezes the screen with what is on it", async () => {
    const snapshot = await h.captures.annotationSnapshot(PHONE);
    expect(snapshot).toMatchObject({
      widthPx: 1206,
      heightPx: 2622,
      width: 402,
      height: 874,
      orientation: "portrait",
      deviceName: "iPhone 17",
      osLabel: "iOS 27.0",
      appName: "Settings",
      appId: "com.apple.Preferences",
      elements: [{ type: "Button", label: "Sign in" }],
    });
    expect(pngSize(snapshot.png)).toEqual({ width: 1206, height: 2622 });
    expect(await readdir(h.work)).toEqual([]);
  });

  it("freezes the screen without AXe", async () => {
    const plain = await harness({ describe: async () => null });
    const snapshot = await plain.captures.annotationSnapshot(PHONE);
    expect(snapshot).toMatchObject({ appName: null, appId: null, elements: [] });
  });

  it("takes the app ID a screen names itself, as Android's does", async () => {
    const appId = vi.fn(async () => "unused");
    const android = await harness({
      describe: async () => ({
        appName: null,
        appId: "com.android.settings",
        pid: null,
        space: { width: 402, height: 874 },
        elements: [],
      }),
      appId,
    });
    const snapshot = await android.captures.annotationSnapshot(PHONE);
    expect(snapshot).toMatchObject({ appName: null, appId: "com.android.settings" });
    expect(appId).not.toHaveBeenCalled();
  });
});
