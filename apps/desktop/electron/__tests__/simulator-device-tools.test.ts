import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SimulatorFrame } from "@zeros/protocol/simulators";

import type { FrameFeedOptions } from "../devices/android-emulator";
import { AxeInput, axeBinaryPath, axeInputInvocation } from "../devices/axe";
import { BgraFramer, bgraFrameLayout, packBgraRows } from "../devices/bgra-frames";
import { IdleShutdownScheduler } from "../devices/idle-shutdown";
import { inspectIosAppBundle } from "../devices/ios-app-bundle";
import { iosProfileFromCapabilities } from "../devices/ios-device-profile";
import {
  availableMemoryFromSysctl,
  downloadIosRuntime,
  probeIosSetup,
  runtimeDownloadProgress,
  xcodeVersionLabel,
} from "../devices/ios-setup";
import { IosSimctl, parseSimctlList } from "../devices/ios-simctl";
import { LiveViews, type FrameStreamProcess } from "../devices/live-view";
import { fileOwnershipStore, readOwnershipDocument } from "../devices/ownership-store";
import {
  PLUTIL,
  ToolFailure,
  XCODEBUILD,
  XCODE_SELECT,
  XCRUN,
  type ToolOutput,
  type ToolRunOptions,
  type ToolRunner,
} from "../devices/tool-runner";

const IOS_27 = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const IOS_26 = "com.apple.CoreSimulator.SimRuntime.iOS-26-2";
const PHONE_BUNDLE = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17.simdevicetype";
const PAD_BUNDLE =
  "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPad Pro 13-inch (M5).simdevicetype";

function simctlList(): string {
  return JSON.stringify({
    runtimes: [
      { identifier: IOS_27, name: "iOS 27.0", version: "27.0", platform: "iOS", isAvailable: true },
      { identifier: IOS_26, name: "iOS 26.2", version: "26.2", platform: "iOS", isAvailable: true },
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-27-0",
        name: "tvOS 27.0",
        version: "27.0",
        platform: "tvOS",
        isAvailable: true,
      },
    ],
    devicetypes: [
      {
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        productFamily: "iPhone",
        bundlePath: PHONE_BUNDLE,
      },
      {
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB",
        productFamily: "iPad",
        bundlePath: PAD_BUNDLE,
      },
    ],
    devices: {
      [IOS_26]: [
        {
          udid: "11111111-1111-4111-8111-111111111111",
          name: "iPhone 17",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      ],
      [IOS_27]: [
        {
          udid: "22222222-2222-4222-8222-222222222222",
          name: "iPad Pro 13-inch (M5)",
          state: "Booted",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB",
        },
        {
          udid: "33333333-3333-4333-8333-333333333333",
          name: "iPhone 17",
          state: "Booting",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
        {
          udid: "44444444-4444-4444-8444-444444444444",
          name: "iPhone 17e",
          state: "Shutdown",
          isAvailable: false,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17e",
        },
        {
          udid: "--udid",
          name: "Hostile",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [
        {
          udid: "55555555-5555-4555-8555-555555555555",
          name: "Apple TV",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-TV-1080p",
        },
      ],
    },
  });
}

interface RunCall {
  file: string;
  args: readonly string[];
  options?: ToolRunOptions;
}

function scriptedRunner(
  respond: (call: RunCall) => ToolOutput | Error | Promise<ToolOutput>,
): { run: ToolRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: ToolRunner = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const result = await respond(call);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

const out = (stdout: string): ToolOutput => ({ stdout, stderr: "" });

describe("parseSimctlList", () => {
  it("lists available iOS devices, newest runtime first, iPhones before iPads", () => {
    const records = parseSimctlList(simctlList());
    expect(records.map((entry) => [entry.device.name, entry.device.osLabel])).toEqual([
      ["iPhone 17", "iOS 27.0"],
      ["iPad Pro 13-inch (M5)", "iOS 27.0"],
      ["iPhone 17", "iOS 26.2"],
    ]);
    expect(records[0]).toEqual({
      device: {
        id: "33333333-3333-4333-8333-333333333333",
        platform: "ios",
        name: "iPhone 17",
        osLabel: "iOS 27.0",
        formFactor: "phone",
        state: "booting",
      },
      deviceTypeBundlePath: PHONE_BUNDLE,
      runtimeVersion: "27.0",
    });
    expect(records[1]?.device).toMatchObject({ formFactor: "tablet", state: "booted" });
    expect(records[1]?.deviceTypeBundlePath).toBe(PAD_BUNDLE);
    expect(records[2]?.device.state).toBe("shutdown");
  });

  it("drops ids that could read as flags and survives malformed output", () => {
    expect(parseSimctlList(simctlList()).some((entry) => entry.device.id === "--udid")).toBe(false);
    expect(parseSimctlList("not json")).toEqual([]);
    expect(parseSimctlList("[]")).toEqual([]);
    expect(parseSimctlList(JSON.stringify({ devices: { [IOS_27]: "x" } }))).toEqual([]);
  });
});

describe("IosSimctl", () => {
  it("boots through bootstatus so the call returns once the device is ready", async () => {
    const { run, calls } = scriptedRunner(() => out(""));
    const controller = new AbortController();
    await new IosSimctl(run).boot("ABC", controller.signal);
    expect(calls[0]).toMatchObject({ file: XCRUN, args: ["simctl", "bootstatus", "ABC", "-b"] });
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  it("treats shutting down a device that is already off as done", async () => {
    const { run } = scriptedRunner(
      () =>
        new ToolFailure(
          "xcrun",
          "Unable to shutdown device in current state: Shutdown",
          149,
          false,
        ),
    );
    await expect(new IosSimctl(run).shutdown("ABC")).resolves.toBeUndefined();
    const failing = scriptedRunner(() => new ToolFailure("xcrun", "Invalid device", 148, false));
    await expect(new IosSimctl(failing.run).shutdown("ABC")).rejects.toThrow(ToolFailure);
  });

  it("reads and sets the appearance", async () => {
    const { run, calls } = scriptedRunner((call) =>
      out(call.args.length === 4 ? "dark\n" : ""),
    );
    const simctl = new IosSimctl(run);
    await expect(simctl.appearance("ABC")).resolves.toBe("dark");
    await simctl.setAppearance("ABC", "light");
    expect(calls[1]?.args).toEqual(["simctl", "ui", "ABC", "appearance", "light"]);
  });
});

describe("iosProfileFromCapabilities", () => {
  const capabilities = {
    capabilities: {
      ScreenDimensionsCapability: {
        "main-screen-width": 1206,
        "main-screen-height": 2622,
        "main-screen-scale": 3,
      },
      displays: [
        { deviceName: "external", cornerRadiusUL: 10 },
        {
          deviceName: "primary",
          cornerRadiusUL: 62,
          chromeIdentifier: "com.apple.dt.devicekit.chrome.phone11",
        },
      ],
    },
  };

  it("reads the screen, its corner radius and the DeviceKit frame name", () => {
    expect(iosProfileFromCapabilities(capabilities)).toEqual({
      screen: { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 62 },
      chromeIdentifier: "com.apple.dt.devicekit.chrome.phone11",
    });
  });

  it("rejects missing or implausible screens and odd frame names", () => {
    expect(iosProfileFromCapabilities({ capabilities: {} })).toBeNull();
    expect(
      iosProfileFromCapabilities({
        capabilities: {
          ScreenDimensionsCapability: {
            "main-screen-width": 1206,
            "main-screen-height": 99_999,
            "main-screen-scale": 3,
          },
        },
      }),
    ).toBeNull();
    const odd = structuredClone(capabilities);
    (odd.capabilities.displays[1] as { chromeIdentifier: string }).chromeIdentifier = "../x y";
    expect(iosProfileFromCapabilities(odd)?.chromeIdentifier).toBeNull();
  });
});

describe("BGRA frames", () => {
  it("pads rows to 16 pixels, as the simulator framebuffer does", () => {
    expect(bgraFrameLayout(2064, 2752, 0.5)).toEqual({
      width: 1032,
      height: 1376,
      stride: 1040 * 4,
      frameBytes: 1040 * 4 * 1376,
    });
    expect(bgraFrameLayout(1206, 2622, 0.5)).toMatchObject({ width: 603, height: 1311, stride: 608 * 4 });
    expect(() => bgraFrameLayout(1, 1, 0.1)).toThrow();
  });

  it("splits a byte stream into whole frames across chunk boundaries", () => {
    const layout = bgraFrameLayout(32, 2, 1);
    const frames: number[][] = [];
    const framer = new BgraFramer(layout, (frame) => frames.push([frame[0]!, frame.at(-1)!]));
    const first = Buffer.alloc(layout.frameBytes, 1);
    const second = Buffer.alloc(layout.frameBytes, 2);
    const stream = Buffer.concat([first, second]);
    framer.push(stream.subarray(0, 10));
    framer.push(stream.subarray(10, layout.frameBytes + 7));
    framer.push(stream.subarray(layout.frameBytes + 7));
    expect(frames).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("drops row padding", () => {
    const layout = bgraFrameLayout(3, 2, 1);
    expect(layout.stride).toBe(64);
    const frame = Buffer.alloc(layout.frameBytes, 0xee);
    frame.fill(0x11, 0, 12);
    frame.fill(0x22, 64, 76);
    const packed = packBgraRows(frame, layout, Buffer.alloc(24));
    expect([...packed]).toEqual([...Array(12).fill(0x11), ...Array(12).fill(0x22)]);
  });
});

class FakeStream extends EventEmitter implements FrameStreamProcess {
  readonly stdout = new PassThrough();
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  override once(event: string, listener: (...args: never[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
}

describe("LiveViews", () => {
  const screen = { widthPx: 32, heightPx: 4, scale: 2, cornerRadius: 0 };
  let streams: FakeStream[];
  let frames: SimulatorFrame[];
  let timers: Array<{ callback: () => void; ms: number }>;
  let now: number;
  let views: LiveViews;

  beforeEach(() => {
    streams = [];
    frames = [];
    timers = [];
    now = 1_000;
    views = new LiveViews({
      scale: 0.5,
      spawn: () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
      encode: (pixels) => Buffer.from([pixels[0]!]),
      onFrame: (frame) => frames.push(frame),
      setTimer: (callback, ms) => {
        const timer = { callback, ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        timers = timers.filter((timer) => timer !== handle);
      },
      now: () => now,
    });
  });

  const layout = bgraFrameLayout(32, 4, 0.5);
  const frameOf = (value: number) => Buffer.alloc(layout.frameBytes, value);

  it("shares one stream per device and skips frames that did not change", () => {
    views.open("view-1", "A", screen);
    views.open("view-2", "A", screen);
    expect(streams).toHaveLength(1);
    streams[0]!.stdout.write(frameOf(7));
    streams[0]!.stdout.write(frameOf(7));
    streams[0]!.stdout.write(frameOf(9));
    expect(frames.map((frame) => [frame.viewId, frame.seq, frame.jpeg[0]])).toEqual([
      ["view-1", 1, 7],
      ["view-2", 1, 7],
      ["view-1", 2, 9],
      ["view-2", 2, 9],
    ]);
    expect(frames[0]).toMatchObject({ width: 16, height: 2 });
  });

  it("gives a newly opened view the last frame right away", () => {
    views.open("view-1", "A", screen);
    streams[0]!.stdout.write(frameOf(5));
    views.open("view-2", "A", screen);
    expect(frames.at(-1)).toMatchObject({ viewId: "view-2", seq: 1 });
  });

  it("stops the stream with the last view, and on device shutdown", () => {
    views.open("view-1", "A", screen);
    views.open("view-2", "A", screen);
    views.close("view-1");
    expect(streams[0]!.signals).toEqual([]);
    views.close("view-2");
    expect(streams[0]!.signals).toEqual(["SIGINT"]);
    expect(views.viewCount()).toBe(0);

    views.open("view-3", "B", screen);
    expect(views.closeDevice("B")).toEqual(["view-3"]);
    expect(views.deviceOf("view-3")).toBeNull();
    expect(streams[1]!.signals).toEqual(["SIGINT"]);
  });

  it("restarts a stream that ends while someone is watching, backing off", () => {
    views.open("view-1", "A", screen);
    streams[0]!.emit("exit", 1);
    expect(timers.map((timer) => timer.ms)).toEqual([250]);
    timers.shift()!.callback();
    expect(streams).toHaveLength(2);
    streams[1]!.emit("exit", 1);
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
    timers.shift()!.callback();
    streams[2]!.stdout.write(frameOf(3));
    streams[2]!.emit("exit", 1);
    expect(timers.map((timer) => timer.ms)).toEqual([250]);
  });

  it("does not restart a stream after its views closed", () => {
    views.open("view-1", "A", screen);
    const stream = streams[0]!;
    views.close("view-1");
    stream.emit("exit", 0);
    expect(timers).toEqual([]);
  });

  it("hands out the frame its views show while the stream keeps sending", () => {
    const packed = (value: number) => Buffer.alloc(16 * 2 * 4, value);
    expect(views.current("A")).toBeNull();
    views.open("view-1", "A", screen);
    expect(views.current("A")).toBeNull();
    streams[0]!.stdout.write(frameOf(7));
    const held = views.current("A");
    expect(held).toEqual({ pixels: packed(7), width: 16, height: 2 });
    streams[0]!.stdout.write(frameOf(9));
    expect(held!.pixels).toEqual(packed(7));
    expect(views.current("A")?.pixels).toEqual(packed(9));
    // Frames that did not change still show the stream keeps up.
    now += 900;
    streams[0]!.stdout.write(frameOf(9));
    now += 900;
    expect(views.current("A")?.pixels).toEqual(packed(9));
    // AXe sends frames steadily, so a second without one is a stalled stream.
    now += 200;
    expect(views.current("A")).toBeNull();
    streams[0]!.stdout.write(frameOf(9));
    expect(views.current("A")?.pixels).toEqual(packed(9));
    views.close("view-1");
    expect(views.current("A")).toBeNull();
  });

  it("has no current frame from a restarted stream until it sends one", () => {
    views.open("view-1", "A", screen);
    streams[0]!.stdout.write(frameOf(3));
    streams[0]!.emit("exit", 1);
    expect(views.current("A")).toBeNull();
    timers.shift()!.callback();
    expect(views.current("A")).toBeNull();
    streams[1]!.stdout.write(frameOf(3));
    expect(views.current("A")?.pixels[0]).toBe(3);
  });

  it("has no current frame after one could not be encoded", () => {
    const logs: string[] = [];
    views = new LiveViews({
      scale: 0.5,
      spawn: () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
      encode: (pixels) => {
        if (pixels[0] === 0) throw new Error("bad frame");
        return Buffer.from([pixels[0]!]);
      },
      onFrame: (frame) => frames.push(frame),
      now: () => now,
      log: (message) => logs.push(message),
    });
    views.open("view-1", "A", screen);
    streams[0]!.stdout.write(frameOf(4));
    streams[0]!.stdout.write(frameOf(0));
    expect(logs).toEqual(["simulator frame could not be encoded: Error: bad frame"]);
    expect(views.current("A")).toBeNull();
  });

  it("tells how long the screen its views show has stayed the same, while it can", () => {
    expect(views.stillFor("A")).toBeNull();
    views.open("view-1", "A", screen);
    expect(views.stillFor("A")).toBeNull();
    streams[0]!.stdout.write(frameOf(7));
    expect(views.stillFor("A")).toBe(0);
    now += 300;
    streams[0]!.stdout.write(frameOf(7));
    expect(views.stillFor("A")).toBe(300);
    now += 100;
    streams[0]!.stdout.write(frameOf(9));
    expect(views.stillFor("A")).toBe(0);
    // A stalled stream can't tell.
    now += 1_100;
    expect(views.stillFor("A")).toBeNull();
    streams[0]!.stdout.write(frameOf(9));
    expect(views.stillFor("A")).toBe(1_100);
    views.close("view-1");
    expect(views.stillFor("A")).toBeNull();
  });

  describe("with a device's own frame feed", () => {
    interface Feed {
      options: FrameFeedOptions;
      stopped: boolean;
    }
    let feeds: Feed[];
    const startFeed = (options: FrameFeedOptions) => {
      const feed: Feed = { options, stopped: false };
      feeds.push(feed);
      return {
        stop: () => {
          feed.stopped = true;
        },
      };
    };
    const pixelsOf = (width: number, height: number, value: number) =>
      Buffer.alloc(width * height * 4, value);

    beforeEach(() => {
      feeds = [];
    });

    it("asks for frames as large as the view's and sends them at their own size", () => {
      views.open("view-1", "A", screen, startFeed);
      views.open("view-2", "A", screen, startFeed);
      expect(streams).toEqual([]);
      expect(feeds).toHaveLength(1);
      expect(feeds[0]!.options).toMatchObject({ maxSide: 16, fps: 30 });
      expect(views.isStreaming("A")).toBe(true);

      feeds[0]!.options.onFrame(pixelsOf(16, 2, 4), 16, 2);
      feeds[0]!.options.onFrame(pixelsOf(16, 2, 4), 16, 2);
      expect(frames.map((frame) => [frame.viewId, frame.seq, frame.width, frame.height])).toEqual([
        ["view-1", 1, 16, 2],
        ["view-2", 1, 16, 2],
      ]);
    });

    it("sends a frame whose size changed even when its bytes did not", () => {
      views.open("view-1", "A", screen, startFeed);
      const feed = feeds[0]!.options;
      feed.onFrame(pixelsOf(16, 2, 4), 16, 2);
      feed.onFrame(pixelsOf(2, 16, 4), 2, 16);
      feed.onFrame(pixelsOf(2, 16, 4), 2, 16);
      feed.onFrame(pixelsOf(8, 2, 4), 8, 2);
      expect(frames.map((frame) => [frame.seq, frame.width, frame.height])).toEqual([
        [1, 16, 2],
        [2, 2, 16],
        [3, 8, 2],
      ]);
    });

    it("hands out its latest frame however long ago it came, as it sends only changes", () => {
      views.open("view-1", "A", screen, startFeed);
      feeds[0]!.options.onFrame(pixelsOf(2, 16, 4), 2, 16);
      now += 60_000;
      expect(views.current("A")).toEqual({ pixels: pixelsOf(2, 16, 4), width: 2, height: 16 });
      expect(views.stillFor("A")).toBe(60_000);
      feeds[0]!.options.onEnd(null);
      expect(views.current("A")).toBeNull();
      expect(views.stillFor("A")).toBeNull();
    });

    it("ignores frames whose bytes do not match their size, and frames after it stops", () => {
      views.open("view-1", "A", screen, startFeed);
      const feed = feeds[0]!;
      feed.options.onFrame(Buffer.alloc(10), 16, 2);
      expect(frames).toEqual([]);
      views.close("view-1");
      expect(feed.stopped).toBe(true);
      expect(views.isStreaming("A")).toBe(false);
      feed.options.onFrame(pixelsOf(16, 2, 1), 16, 2);
      expect(frames).toEqual([]);
    });

    it("restarts a feed that fails or ends while someone is watching", () => {
      const logs: string[] = [];
      views = new LiveViews({
        spawn: () => {
          throw new Error("AXe is not for Android");
        },
        encode: (pixels) => Buffer.from([pixels[0]!]),
        onFrame: (frame) => frames.push(frame),
        setTimer: (callback, ms) => {
          const timer = { callback, ms };
          timers.push(timer);
          return timer;
        },
        clearTimer: (handle) => {
          timers = timers.filter((timer) => timer !== handle);
        },
        log: (message) => logs.push(message),
      });
      views.open("view-1", "A", screen, startFeed);
      feeds[0]!.options.onEnd(new Error("connection reset"));
      expect(logs).toEqual(["simulator view stream failed: connection reset"]);
      expect(timers.map((timer) => timer.ms)).toEqual([250]);
      // A late end from the old feed changes nothing.
      feeds[0]!.options.onEnd(null);
      expect(timers).toHaveLength(1);
      timers.shift()!.callback();
      expect(feeds).toHaveLength(2);
      feeds[1]!.options.onFrame(pixelsOf(16, 2, 2), 16, 2);
      feeds[1]!.options.onEnd(null);
      expect(timers.map((timer) => timer.ms)).toEqual([250]);
    });

    it("retries a feed that could not start", () => {
      let attempts = 0;
      views.open("view-1", "A", screen, (options) => {
        attempts += 1;
        if (attempts === 1) throw new Error("no gRPC port");
        return startFeed(options);
      });
      expect(views.isStreaming("A")).toBe(false);
      expect(timers.map((timer) => timer.ms)).toEqual([250]);
      timers.shift()!.callback();
      expect(feeds).toHaveLength(1);
      expect(views.isStreaming("A")).toBe(true);
    });
  });
});

describe("AXe input", () => {
  it("builds argument arrays, typing text through stdin", () => {
    expect(axeInputInvocation("U", { kind: "tap", at: { x: 10.04, y: 20.06 } }).args).toEqual([
      "tap",
      "-x",
      "10",
      "-y",
      "20.1",
      "--udid",
      "U",
    ]);
    expect(
      axeInputInvocation("U", {
        kind: "drag",
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
        durationMs: 250,
      }).args,
    ).toEqual([
      "drag",
      "--start-x",
      "1",
      "--start-y",
      "2",
      "--end-x",
      "3",
      "--end-y",
      "4",
      "--duration",
      "0.25",
      "--udid",
      "U",
    ]);
    expect(axeInputInvocation("U", { kind: "text", text: "--help" })).toEqual({
      args: ["type", "--stdin", "--udid", "U"],
      stdin: "--help",
    });
    // A long press holds one point; AXe refuses a drag that goes nowhere.
    expect(
      axeInputInvocation("U", {
        kind: "drag",
        from: { x: 5, y: 6 },
        to: { x: 5, y: 6 },
        durationMs: 800,
      }).args,
    ).toEqual(["touch", "-x", "5", "-y", "6", "--down", "--up", "--delay", "0.80", "--udid", "U"]);
    expect(axeInputInvocation("U", { kind: "key", key: "enter" }).args).toEqual([
      "key",
      "40",
      "--udid",
      "U",
    ]);
    expect(axeInputInvocation("U", { kind: "button", button: "home" }).args).toEqual([
      "button",
      "home",
      "--udid",
      "U",
    ]);
  });

  it("runs one device's input in order and other devices alongside", async () => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const run: ToolRunner = (_file, args) =>
      new Promise((resolve, reject) => {
        const name = `${args.at(-1)}:${args[0]}`;
        order.push(`start ${name}`);
        gates.set(name, () => {
          order.push(`end ${name}`);
          if (args[0] === "key") reject(new Error("failed"));
          else resolve(out(""));
        });
      });
    const input = new AxeInput(() => "/axe", run);
    const first = input.perform("A", { kind: "key", key: "enter" });
    const second = input.perform("A", { kind: "button", button: "home" });
    const other = input.perform("B", { kind: "button", button: "lock" });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start A:key", "start B:button"]);
    gates.get("A:key")!();
    await expect(first).rejects.toThrow("failed");
    await vi.waitFor(() => expect(order).toContain("start A:button"));
    gates.get("A:button")!();
    gates.get("B:button")!();
    await expect(second).resolves.toBeUndefined();
    await expect(other).resolves.toBeUndefined();
  });

  it("reports when the binary is missing", async () => {
    const input = new AxeInput(() => null, async () => out(""));
    expect(input.available()).toBe(false);
    await expect(input.perform("A", { kind: "button", button: "home" })).rejects.toThrow(
      "no simulator input tool",
    );
    expect(
      axeBinaryPath({ packaged: true, resourcesPath: "/R", repoRoot: "/repo", exists: () => true }),
    ).toBe("/R/axe/axe");
    expect(
      axeBinaryPath({ packaged: false, resourcesPath: "/R", repoRoot: "/repo", exists: () => false }),
    ).toBeNull();
  });
});

describe("IdleShutdownScheduler", () => {
  let now: number;
  let timers: Array<{ at: number; callback: () => void }>;
  let events: string[];
  let scheduler: IdleShutdownScheduler;

  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.callback();
    }
    now = end;
  };

  beforeEach(() => {
    now = 1_000_000;
    timers = [];
    events = [];
    scheduler = new IdleShutdownScheduler({
      now: () => now,
      setTimer: (callback, ms) => {
        const timer = { at: now + ms, callback };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        timers = timers.filter((timer) => timer !== handle);
      },
      onWarning: (warning) => events.push(`warn ${warning.deviceId} ${warning.shutdownAt - now}`),
      onWarningCleared: (deviceId) => events.push(`clear ${deviceId}`),
      onExpire: (deviceId) => events.push(`expire ${deviceId}`),
    });
    scheduler.setLimit(30 * 60_000);
  });

  it("warns a minute ahead and then shuts down", () => {
    scheduler.track("A");
    advance(29 * 60_000 - 1);
    expect(events).toEqual([]);
    advance(1);
    expect(events).toEqual(["warn A 60000"]);
    expect(scheduler.warnings()).toEqual([{ deviceId: "A", shutdownAt: now + 60_000 }]);
    advance(60_000);
    expect(events).toEqual(["warn A 60000", "expire A"]);
    expect(scheduler.isTracked("A")).toBe(false);
  });

  it("starts over on use, including Keep running", () => {
    scheduler.track("A");
    advance(29 * 60_000);
    scheduler.use("A");
    expect(events).toEqual(["warn A 60000", "clear A"]);
    advance(29 * 60_000 - 1);
    expect(events).toHaveLength(2);
  });

  it("never shuts down a held device, and counts from the release", () => {
    scheduler.track("A");
    const release = scheduler.hold("A");
    advance(3 * 60 * 60_000);
    expect(events).toEqual([]);
    release();
    release();
    advance(29 * 60_000 - 1);
    expect(events).toEqual([]);
    advance(1);
    expect(events).toEqual(["warn A 60000"]);
  });

  it("gives the full minute when the limit drops below the idle time", () => {
    scheduler.track("A");
    advance(20 * 60_000);
    scheduler.setLimit(15 * 60_000);
    expect(events).toEqual(["warn A 60000"]);
    scheduler.setLimit(null);
    expect(events).toEqual(["warn A 60000", "clear A"]);
    advance(24 * 60 * 60_000);
    expect(events).toHaveLength(2);
  });

  it("ignores devices it does not track", () => {
    scheduler.use("B");
    scheduler.hold("B")();
    scheduler.untrack("B");
    expect(events).toEqual([]);
  });
});

describe("iOS setup", () => {
  const ready = (call: RunCall): ToolOutput | Error => {
    if (call.file === XCODE_SELECT) return out("/Applications/Xcode.app/Contents/Developer\n");
    if (call.file === XCODEBUILD) return out("Xcode 27.0\nBuild version 27A5218g\n");
    if (call.args[0] === "--find") return out("/usr/bin/simctl\n");
    return out(simctlList());
  };

  it("is ready with Xcode and an iOS runtime", async () => {
    const { run } = scriptedRunner(ready);
    await expect(probeIosSetup(run)).resolves.toEqual({ state: "ready", toolLabel: "Xcode 27.0" });
  });

  it("needs Xcode when only the Command Line Tools are selected", async () => {
    const { run } = scriptedRunner((call) =>
      call.file === XCODE_SELECT ? out("/Library/Developer/CommandLineTools\n") : ready(call),
    );
    await expect(probeIosSetup(run)).resolves.toEqual({ state: "tools-missing", toolLabel: null });
    const missing = scriptedRunner(() => new Error("ENOENT"));
    await expect(probeIosSetup(missing.run)).resolves.toMatchObject({ state: "tools-missing" });
  });

  it("needs a runtime when Xcode has no iOS simulator runtime", async () => {
    const { run } = scriptedRunner((call) =>
      call.args.includes("runtimes") ? out(JSON.stringify({ runtimes: [] })) : ready(call),
    );
    await expect(probeIosSetup(run)).resolves.toEqual({
      state: "runtime-missing",
      toolLabel: "Xcode 27.0",
    });
  });

  it("reads versions, download progress and available memory", () => {
    expect(xcodeVersionLabel("Xcode 27.0.1\nBuild version X\n")).toBe("Xcode 27.0.1");
    expect(xcodeVersionLabel("garbage")).toBeNull();
    expect(runtimeDownloadProgress("Downloading iOS 27.0 Simulator: 45.5% (3.2 GB of 7 GB)")).toBe(
      0.455,
    );
    expect(runtimeDownloadProgress("Downloading")).toBeNull();
    expect(runtimeDownloadProgress("250%")).toBeNull();
    expect(availableMemoryFromSysctl("73\n38654705664\n")).toBe(
      Math.floor((38654705664 * 73) / 100),
    );
    expect(availableMemoryFromSysctl("abc")).toBeNull();
    expect(availableMemoryFromSysctl("120\n100\n")).toBeNull();
  });

  it("downloads a runtime, reporting progress until the tool exits", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const spawnTool = vi.fn(() => child as never);
    const progress: Array<number | null> = [];
    const download = downloadIosRuntime(spawnTool, (value) => progress.push(value));
    expect(spawnTool).toHaveBeenCalledWith(XCODEBUILD, ["-downloadPlatform", "iOS"]);
    child.stdout.write("Downloading: 10.0%\rDownloading: 52");
    child.stdout.write(".5%\r");
    await vi.waitFor(() => expect(progress).toEqual([0.1, 0.525]));
    child.emit("exit", 0);
    await expect(download.done).resolves.toBeUndefined();

    const cancelled = downloadIosRuntime(spawnTool, () => undefined);
    cancelled.cancel();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", null);
    await expect(cancelled.done).rejects.toThrow("cancelled");
  });
});

describe("simulator ownership store", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zeros-sim-owned-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips the devices Zeros booted", async () => {
    const file = path.join(directory, "nested", "simulators.json");
    const store = fileOwnershipStore(file);
    await expect(store.load()).resolves.toEqual([]);
    void store.save(["A", "B"]);
    await store.save(["B", "--flag", "B"]);
    await expect(store.load()).resolves.toEqual(["B"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, devices: ["B"] });
  });

  it("ignores other versions and symlinked files", async () => {
    expect(readOwnershipDocument(JSON.stringify({ version: 2, devices: ["A"] }))).toEqual([]);
    expect(readOwnershipDocument("{")).toEqual([]);
    const target = path.join(directory, "target.json");
    await writeFile(target, JSON.stringify({ version: 1, devices: ["A"] }));
    const link = path.join(directory, "link.json");
    await symlink(target, link);
    await expect(fileOwnershipStore(link).load()).resolves.toEqual([]);
    await expect(fileOwnershipStore(target).load()).resolves.toEqual(["A"]);
  });
});

describe("iOS app bundle check", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zeros-sim-app-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function appBundle(name: string, plist: "root" | "mac" | "none"): Promise<string> {
    const bundle = path.join(directory, name);
    await mkdir(path.join(bundle, "Contents"), { recursive: true });
    if (plist === "root") await writeFile(path.join(bundle, "Info.plist"), "bplist00");
    if (plist === "mac") await writeFile(path.join(bundle, "Contents", "Info.plist"), "<plist/>");
    return bundle;
  }

  const platforms = (value: unknown) => scriptedRunner(() => out(JSON.stringify(value)));

  it("passes a bundle built for the iOS Simulator", async () => {
    const bundle = await appBundle("Demo.app", "root");
    const { run, calls } = platforms(["iPhoneSimulator"]);
    await expect(inspectIosAppBundle(run, bundle)).resolves.toBeNull();
    expect(calls).toEqual([
      {
        file: PLUTIL,
        args: [
          "-extract",
          "CFBundleSupportedPlatforms",
          "json",
          "-o",
          "-",
          path.join(bundle, "Info.plist"),
        ],
        options: { timeoutMs: 10_000 },
      },
    ]);
  });

  it("says why a bundle can't go on a simulator", async () => {
    const { run, calls } = platforms(["iPhoneSimulator"]);
    await expect(inspectIosAppBundle(run, path.join(directory, "Missing.app"))).resolves.toBe(
      `There's no app bundle at ${path.join(directory, "Missing.app")}.`,
    );
    const file = path.join(directory, "Flat.app");
    await writeFile(file, "zip");
    await expect(inspectIosAppBundle(run, file)).resolves.toBe(
      "Flat.app isn't an app bundle; app bundles are folders.",
    );
    await expect(inspectIosAppBundle(run, await appBundle("Mac.app", "mac"))).resolves.toBe(
      "Mac.app is a Mac app. Install an app built for the iOS Simulator.",
    );
    await expect(inspectIosAppBundle(run, await appBundle("Bare.app", "none"))).resolves.toBe(
      "Bare.app has no Info.plist, so it isn't a complete app bundle.",
    );
    expect(calls).toEqual([]);

    const device = await appBundle("Device.app", "root");
    await expect(inspectIosAppBundle(platforms(["iPhoneOS"]).run, device)).resolves.toBe(
      "Device.app is built for iPhone and iPad hardware, not the Simulator. Build it for an iOS Simulator destination.",
    );
    await expect(
      inspectIosAppBundle(platforms(["AppleTVSimulator"]).run, device),
    ).resolves.toBe("Device.app isn't built for the iOS Simulator.");
  });

  it("leaves bundles it can't read to the installer", async () => {
    const bundle = await appBundle("Odd.app", "root");
    const missingKey = scriptedRunner(() => new ToolFailure("plutil", "No value at that key path", 1, false));
    await expect(inspectIosAppBundle(missingKey.run, bundle)).resolves.toBeNull();
    await expect(inspectIosAppBundle(platforms("iPhoneSimulator").run, bundle)).resolves.toBeNull();
    await expect(inspectIosAppBundle(platforms([]).run, bundle)).resolves.toBeNull();
    await expect(
      inspectIosAppBundle(scriptedRunner(() => out("not json")).run, bundle),
    ).resolves.toBeNull();
  });
});
