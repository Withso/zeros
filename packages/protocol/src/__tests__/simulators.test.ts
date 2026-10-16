import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIMULATOR_SETTINGS,
  SIMULATOR_FRAME_SLICES,
  SIMULATOR_ORIENTATIONS,
  isSimulatorDeviceId,
  isSimulatorOrientation,
  isSimulatorViewId,
  readSimulatorBootWarnings,
  readSimulatorDeviceFrame,
  readSimulatorDeviceShape,
  readSimulatorFrame,
  readSimulatorHubSnapshot,
  readSimulatorInput,
  readSimulatorPreferences,
  readSimulatorTouch,
  readSimulatorViewStart,
  simulatorIdleShutdownMs,
  simulatorPlatformLabel,
  simulatorPreferencesFromSettings,
  simulatorPressGesture,
  simulatorSettings,
} from "../simulators";

const DEVICE = {
  id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108",
  platform: "ios",
  name: "iPhone 17",
  osLabel: "iOS 27.0",
  formFactor: "phone",
  state: "booted",
  bootedByZeros: true,
};

const SNAPSHOT = {
  version: 1,
  devices: [DEVICE],
  setup: [
    {
      platform: "ios",
      state: "ready",
      toolLabel: "Xcode 27.0",
      download: { state: "downloading", progress: 0.25 },
    },
  ],
  idleWarnings: [{ deviceId: DEVICE.id, shutdownAt: 1_700_000_000_000 }],
};

const IMAGE = { url: "data:image/png;base64,iVBORw0KGgo=", width: 20, height: 20 };

function deviceFrame() {
  return {
    width: 433,
    height: 892,
    screen: { x: 22, y: 22, width: 389, height: 848 },
    slices: Object.fromEntries(SIMULATOR_FRAME_SLICES.map((slice) => [slice, IMAGE])),
    buttons: [{ name: "power", image: IMAGE, x: 430, y: 200, onTop: false }],
    outset: { top: 0, left: 4, bottom: 0, right: 4 },
  };
}

describe("simulator settings", () => {
  it("fills every missing or malformed key with the shipped default", () => {
    expect(simulatorSettings(undefined)).toEqual(DEFAULT_SIMULATOR_SETTINGS);
    expect(simulatorSettings([])).toEqual(DEFAULT_SIMULATOR_SETTINGS);
    expect(
      simulatorSettings({ enabled: "no", idle_shutdown: "5m", show_agent_touches: 0 }),
    ).toEqual(DEFAULT_SIMULATOR_SETTINGS);
    expect(DEFAULT_SIMULATOR_SETTINGS).toEqual({
      enabled: true,
      idle_shutdown: "30m",
      show_agent_touches: true,
    });
  });

  it("keeps valid values and maps them to the preferences main applies", () => {
    const settings = simulatorSettings({
      enabled: false,
      idle_shutdown: "never",
      show_agent_touches: false,
    });
    expect(settings).toEqual({
      enabled: false,
      idle_shutdown: "never",
      show_agent_touches: false,
    });
    expect(simulatorPreferencesFromSettings(settings)).toEqual({
      agentsEnabled: false,
      idleShutdown: "never",
      showAgentTouches: false,
    });
  });
});

describe("simulator hub reads", () => {
  it("reads a complete snapshot", () => {
    expect(readSimulatorHubSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(
      readSimulatorHubSnapshot({
        ...SNAPSHOT,
        setup: [{ platform: "ios", state: "tools-missing", toolLabel: null, download: null }],
        idleWarnings: [],
      }),
    ).toMatchObject({ setup: [{ state: "tools-missing", download: null }] });
  });

  it("reads a turned device's orientation and treats a missing one as portrait", () => {
    const turned = { ...DEVICE, orientation: "landscape-left" };
    expect(readSimulatorHubSnapshot({ ...SNAPSHOT, devices: [turned] })?.devices).toEqual([
      turned,
    ]);
    expect(readSimulatorHubSnapshot(SNAPSHOT)?.devices[0]).not.toHaveProperty("orientation");
    expect(SIMULATOR_ORIENTATIONS).toEqual([
      "portrait",
      "portrait-upside-down",
      "landscape-left",
      "landscape-right",
    ]);
    expect(SIMULATOR_ORIENTATIONS.every(isSimulatorOrientation)).toBe(true);
    for (const value of ["sideways", "Portrait", "", null, 90]) {
      expect(isSimulatorOrientation(value)).toBe(false);
    }
  });

  it("drops the whole snapshot when any part is malformed", () => {
    for (const snapshot of [
      { ...SNAPSHOT, version: 2 },
      { ...SNAPSHOT, devices: [{ ...DEVICE, id: "--udid" }] },
      { ...SNAPSHOT, devices: [{ ...DEVICE, state: "paused" }] },
      { ...SNAPSHOT, devices: [{ ...DEVICE, name: "" }] },
      { ...SNAPSHOT, devices: [{ ...DEVICE, orientation: "sideways" }] },
      { ...SNAPSHOT, devices: Array.from({ length: 201 }, () => DEVICE) },
      {
        ...SNAPSHOT,
        setup: [{ platform: "ios", state: "ready", toolLabel: null, download: { state: "downloading", progress: 2 } }],
      },
      { ...SNAPSHOT, setup: [{ platform: "ios", state: "ready", toolLabel: null }] },
      { ...SNAPSHOT, idleWarnings: [{ deviceId: DEVICE.id, shutdownAt: Number.NaN }] },
      [],
      null,
    ]) {
      expect(readSimulatorHubSnapshot(snapshot)).toBeNull();
    }
  });

  it("keeps only known boot warnings", () => {
    expect(readSimulatorBootWarnings(["many-devices", "x", "low-memory"])).toEqual([
      "low-memory",
      "many-devices",
    ]);
    expect(readSimulatorBootWarnings("low-memory")).toEqual([]);
  });

  it("reads a view start only with a hub view id and a sane screen", () => {
    const start = {
      viewId: "view-3",
      screen: { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 55 },
    };
    expect(readSimulatorViewStart(start)).toEqual(start);
    expect(isSimulatorViewId("view-3")).toBe(true);
    expect(isSimulatorViewId("view-")).toBe(false);
    expect(readSimulatorViewStart({ ...start, viewId: "../view-3" })).toBeNull();
    expect(
      readSimulatorViewStart({ ...start, screen: { ...start.screen, scale: 0 } }),
    ).toBeNull();
    expect(
      readSimulatorViewStart({ ...start, screen: { ...start.screen, widthPx: -1 } }),
    ).toBeNull();
  });

  it("reads a device frame whose images are all PNG data URLs", () => {
    expect(readSimulatorDeviceFrame(deviceFrame())).toEqual(deviceFrame());
    const remote = deviceFrame();
    remote.slices.top = { ...IMAGE, url: "https://example.com/top.png" };
    expect(readSimulatorDeviceFrame(remote)).toBeNull();
    const missing = deviceFrame() as Record<string, unknown>;
    missing.slices = { ...deviceFrame().slices, left: undefined };
    expect(readSimulatorDeviceFrame(missing)).toBeNull();
    const button = deviceFrame();
    button.buttons = [{ ...button.buttons[0]!, image: { ...IMAGE, url: "javascript:1" } }];
    expect(readSimulatorDeviceFrame(button)).toBeNull();
    expect(readSimulatorDeviceFrame(null)).toBeNull();
  });

  it("reads an Android Studio frame: one picture, with a mask over the screen", () => {
    const WEBP = { url: "data:image/webp;base64,UklGRg==", width: 456, height: 965 };
    const MASK = { url: "data:image/webp;base64,UklGRg==", width: 411, height: 923 };
    const picture = {
      width: 456,
      height: 965,
      screen: { x: 22, y: 21, width: 411, height: 923 },
      image: WEBP,
      mask: MASK,
      buttons: [],
      outset: { top: 0, left: 0, bottom: 0, right: 0 },
    };
    expect(readSimulatorDeviceFrame(picture)).toEqual(picture);
    const { mask: _mask, ...unmasked } = picture;
    expect(readSimulatorDeviceFrame(unmasked)).toEqual(unmasked);
    const { image: _image, ...maskOnly } = picture;
    expect(readSimulatorDeviceFrame(maskOnly)).toBeNull();
    expect(readSimulatorDeviceFrame({ ...picture, slices: deviceFrame().slices })).toBeNull();
    expect(
      readSimulatorDeviceFrame({ ...picture, image: { ...WEBP, url: "data:image/gif;base64,R0lG" } }),
    ).toBeNull();
    const { slices: _slices, ...neither } = deviceFrame();
    expect(readSimulatorDeviceFrame(neither)).toBeNull();
  });

  it("reads Android's setup: what Create device makes and whether Android Studio is there", () => {
    const android = {
      platform: "android",
      state: "ready",
      toolLabel: "Android Emulator 37.2.12",
      download: null,
      newDevice: "Pixel 10 with Android 17",
      creating: true,
      studioInstalled: true,
    };
    const snapshot = { ...SNAPSHOT, setup: [...SNAPSHOT.setup, android] };
    expect(readSimulatorHubSnapshot(snapshot)?.setup[1]).toEqual(android);
    const plain = { ...android, newDevice: null, creating: false, studioInstalled: false };
    expect(readSimulatorHubSnapshot({ ...SNAPSHOT, setup: [plain] })?.setup).toEqual([plain]);
    for (const bad of [
      { ...android, newDevice: "" },
      { ...android, creating: "done" },
      { ...android, studioInstalled: "yes" },
    ]) {
      expect(readSimulatorHubSnapshot({ ...SNAPSHOT, setup: [bad] })).toBeNull();
    }
  });

  it("reads a device shape with or without Xcode's frame", () => {
    const screen = { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 55 };
    expect(readSimulatorDeviceShape({ screen, frame: null })).toEqual({ screen, frame: null });
    expect(readSimulatorDeviceShape({ screen, frame: deviceFrame() })).toEqual({
      screen,
      frame: deviceFrame(),
    });
    expect(readSimulatorDeviceShape({ screen, frame: { ...deviceFrame(), slices: {} } })).toBeNull();
    expect(readSimulatorDeviceShape({ screen: { ...screen, scale: 9 }, frame: null })).toBeNull();
    expect(readSimulatorDeviceShape({ screen })).toBeNull();
    expect(readSimulatorDeviceShape(null)).toBeNull();
  });

  it("reads live frames with bytes and integer sizes", () => {
    const frame = { viewId: "view-1", seq: 4, width: 201, height: 437, jpeg: new Uint8Array([255, 216]) };
    expect(readSimulatorFrame(frame)).toEqual(frame);
    for (const bad of [
      { ...frame, jpeg: [255, 216] },
      { ...frame, jpeg: new Uint8Array() },
      { ...frame, width: 20.5 },
      { ...frame, seq: -1 },
      { ...frame, viewId: "x" },
    ]) {
      expect(readSimulatorFrame(bad)).toBeNull();
    }
  });
});

describe("simulator contract", () => {
  it("names each platform the way the UI does", () => {
    expect(simulatorPlatformLabel("ios")).toBe("iOS Simulator");
    expect(simulatorPlatformLabel("android")).toBe("Android Simulator");
  });

  it("accepts CoreSimulator UDIDs and AVD names but no paths or flags", () => {
    expect(isSimulatorDeviceId("FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108")).toBe(true);
    expect(isSimulatorDeviceId("Pixel_9_API_36")).toBe(true);
    for (const id of ["", "../x", ".hidden", "a b", "--udid", "x".repeat(129), 42]) {
      expect(isSimulatorDeviceId(id)).toBe(false);
    }
  });

  it("maps every idle choice to milliseconds", () => {
    expect(simulatorIdleShutdownMs("15m")).toBe(900_000);
    expect(simulatorIdleShutdownMs("30m")).toBe(1_800_000);
    expect(simulatorIdleShutdownMs("1h")).toBe(3_600_000);
    expect(simulatorIdleShutdownMs("2h")).toBe(7_200_000);
    expect(simulatorIdleShutdownMs("never")).toBeNull();
  });

  it("reads only complete preferences", () => {
    expect(
      readSimulatorPreferences({
        agentsEnabled: false,
        idleShutdown: "1h",
        showAgentTouches: true,
        extra: 1,
      }),
    ).toEqual({ agentsEnabled: false, idleShutdown: "1h", showAgentTouches: true });
    expect(
      readSimulatorPreferences({
        agentsEnabled: true,
        idleShutdown: 30,
        showAgentTouches: true,
      }),
    ).toBeNull();
    expect(readSimulatorPreferences(null)).toBeNull();
  });

  it("validates live-view input and clamps drag durations", () => {
    expect(readSimulatorInput({ kind: "tap", at: { x: 10.04, y: 20 } })).toEqual({
      kind: "tap",
      at: { x: 10, y: 20 },
    });
    expect(
      readSimulatorInput({
        kind: "drag",
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
        durationMs: 60_000,
      }),
    ).toEqual({
      kind: "drag",
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      durationMs: 5_000,
    });
    expect(readSimulatorInput({ kind: "key", key: "enter" })).toEqual({
      kind: "key",
      key: "enter",
    });
    expect(readSimulatorInput({ kind: "button", button: "home" })).toEqual({
      kind: "button",
      button: "home",
    });
    expect(readSimulatorInput({ kind: "button", button: "back" })).toEqual({
      kind: "button",
      button: "back",
    });
    expect(readSimulatorInput({ kind: "text", text: "héllo" })).toEqual({
      kind: "text",
      text: "héllo",
    });
    expect(readSimulatorInput({ kind: "pinch", scale: 2.345 })).toEqual({
      kind: "pinch",
      scale: 2.35,
    });
  });

  it("rejects malformed or unbounded input", () => {
    for (const input of [
      { kind: "tap", at: { x: -1, y: 0 } },
      { kind: "tap", at: { x: Number.NaN, y: 0 } },
      { kind: "tap", at: { x: 1, y: 20_000 } },
      { kind: "drag", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
      { kind: "text", text: "" },
      { kind: "text", text: "x".repeat(501) },
      { kind: "key", key: "f13" },
      { kind: "button", button: "siri" },
      { kind: "pinch", scale: 1 },
      { kind: "pinch", scale: 0.05 },
      { kind: "pinch", scale: 11 },
      { kind: "pinch", scale: Number.POSITIVE_INFINITY },
      { kind: "pinch" },
      { kind: "shell", command: "ls" },
      [],
    ]) {
      expect(readSimulatorInput(input)).toBeNull();
    }
  });

  it("validates each step of a live touch, with an optional second finger", () => {
    expect(readSimulatorTouch({ phase: "down", at: { x: 10.04, y: 20 } })).toEqual({
      phase: "down",
      at: { x: 10, y: 20 },
    });
    expect(
      readSimulatorTouch({ phase: "move", at: { x: 1, y: 2 }, second: { x: 401, y: 872 } }),
    ).toEqual({ phase: "move", at: { x: 1, y: 2 }, second: { x: 401, y: 872 } });
    for (const phase of ["up", "cancel"]) {
      expect(readSimulatorTouch({ phase, at: { x: 0, y: 0 } })).toEqual({
        phase,
        at: { x: 0, y: 0 },
      });
    }
    for (const touch of [
      { phase: "hover", at: { x: 1, y: 1 } },
      { phase: "down" },
      { phase: "down", at: { x: -1, y: 1 } },
      { phase: "move", at: { x: 1, y: 1 }, second: { x: 1 } },
      { phase: "move", at: { x: 1, y: 1 }, second: null },
      { kind: "tap", at: { x: 1, y: 1 } },
      "down",
      null,
    ]) {
      expect(readSimulatorTouch(touch)).toBeNull();
    }
  });

  it("tells a press's tap, long press, swipe and pinch apart", () => {
    const at = (x: number, y: number) => ({ x, y });
    const down = (x: number, y: number) => ({ phase: "down" as const, at: at(x, y) });
    const up = (x: number, y: number) => ({ phase: "up" as const, at: at(x, y) });
    expect(simulatorPressGesture(down(100, 100), up(103, 102), 120)).toEqual({
      kind: "tap",
      at: at(100, 100),
    });
    expect(simulatorPressGesture(down(100, 100), up(101, 100), 800)).toEqual({
      kind: "drag",
      from: at(100, 100),
      to: at(100, 100),
      durationMs: 800,
    });
    expect(simulatorPressGesture(down(100, 100), up(100, 300), 240)).toEqual({
      kind: "drag",
      from: at(100, 100),
      to: at(100, 300),
      durationMs: 240,
    });
    expect(simulatorPressGesture(down(100, 100), up(100, 300), 9_000)).toMatchObject({
      durationMs: 5_000,
    });
    expect(simulatorPressGesture(down(100, 100), up(100, 300), 10)).toMatchObject({
      durationMs: 50,
    });

    // The fingers of an Option-drag mirror each other through the center.
    const pinch = (a: number, b: number, phase: "down" | "up") => ({
      phase,
      at: at(a, 437),
      second: at(b, 437),
    });
    expect(simulatorPressGesture(pinch(151, 251, "down"), pinch(101, 301, "up"), 300)).toEqual({
      kind: "pinch",
      scale: 2,
    });
    expect(simulatorPressGesture(pinch(101, 301, "down"), pinch(151, 251, "up"), 300)).toEqual({
      kind: "pinch",
      scale: 0.5,
    });
    expect(simulatorPressGesture(pinch(101, 301, "down"), pinch(201, 201, "up"), 300)).toEqual({
      kind: "pinch",
      scale: 0.1,
    });
    expect(simulatorPressGesture(pinch(101, 301, "down"), pinch(102, 300, "up"), 300)).toBeNull();
    // Too near each other to tell a pinch from a wobble.
    expect(simulatorPressGesture(pinch(199, 203, "down"), pinch(0, 402, "up"), 300)).toBeNull();
  });
});
