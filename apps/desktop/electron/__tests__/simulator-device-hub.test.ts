import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SimulatorDeviceState,
  SimulatorHubSnapshot,
  SimulatorInput,
  SimulatorScreen,
  SimulatorTouch,
} from "@zeros/protocol/simulators";

import type { AndroidDevicesRead } from "../devices/android-devices";
import type { AndroidSetupProbe } from "../devices/android-sdk";
import {
  DEVICE_POLL_MS,
  DeviceActionError,
  DeviceHub,
  LOW_MEMORY_BYTES,
  SETTLING_POLL_MS,
  type AndroidDevicesPort,
  type DeviceHubOptions,
  type IosSimctlPort,
  type LiveViewsPort,
} from "../devices/device-hub";
import type { IosSetupProbe, RuntimeDownload } from "../devices/ios-setup";
import type { IosAppearance, IosDeviceRecord } from "../devices/ios-simctl";
import type { StartFrameFeed } from "../devices/live-view";
import { ToolFailure } from "../devices/tool-runner";

const PHONE = "11111111-1111-4111-8111-111111111111";
const PAD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SCREEN: SimulatorScreen = { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 62 };
const MINUTE = 60_000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeSimctl implements IosSimctlPort {
  readonly states = new Map<string, SimulatorDeviceState>([
    [PHONE, "shutdown"],
    [PAD, "shutdown"],
    [OTHER, "shutdown"],
  ]);
  readonly names: Record<string, string> = {
    [PHONE]: "iPhone 17",
    [PAD]: "iPad Pro 13-inch (M5)",
    [OTHER]: "iPhone 17e",
  };
  bootGate: ReturnType<typeof deferred<void>> | null = null;
  bootError: Error | null = null;
  nextList: Array<ReturnType<typeof deferred<IosDeviceRecord[]>>> = [];
  readonly shutdowns: string[] = [];
  readonly boots: string[] = [];

  snapshotRecords(): IosDeviceRecord[] {
    return [...this.states].map(([id, state]) => ({
      device: {
        id,
        platform: "ios",
        name: this.names[id]!,
        osLabel: "iOS 27.0",
        formFactor: id === PAD ? "tablet" : "phone",
        state,
      },
      deviceTypeBundlePath: `/types/${this.names[id]}.simdevicetype`,
      runtimeVersion: "27.0",
    }));
  }

  list = vi.fn(async () => {
    const pending = this.nextList.shift();
    if (pending) return pending.promise;
    return this.snapshotRecords();
  });

  boot = vi.fn(async (udid: string, signal?: AbortSignal) => {
    this.boots.push(udid);
    this.states.set(udid, "booting");
    if (this.bootGate) {
      const gate = this.bootGate;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted: stderr /Users/me")));
        gate.promise.then(resolve, reject);
      });
    }
    if (this.bootError) throw this.bootError;
    this.states.set(udid, "booted");
  });

  shutdown = vi.fn(async (udid: string) => {
    this.shutdowns.push(udid);
    this.states.set(udid, "shutdown");
  });

  appearance = vi.fn(async (): Promise<IosAppearance | null> => "light");
  setAppearance = vi.fn(async () => undefined);
}

class FakeViews implements LiveViewsPort {
  readonly open = vi.fn((viewId: string, deviceId: string) => {
    this.views.set(viewId, deviceId);
  });
  readonly close = vi.fn((viewId: string) => {
    this.views.delete(viewId);
  });
  readonly views = new Map<string, string>();
  closeDevice = vi.fn((deviceId: string) => {
    const closed = [...this.views].filter(([, id]) => id === deviceId).map(([viewId]) => viewId);
    for (const viewId of closed) this.views.delete(viewId);
    return closed;
  });
  viewCount = () => this.views.size;
  deviceOf = (viewId: string) => this.views.get(viewId) ?? null;
  closeAll = vi.fn(() => this.views.clear());
  dispose = vi.fn(() => this.views.clear());
}

class FakeClock {
  now = 5_000_000;
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

interface Harness {
  hub: DeviceHub;
  simctl: FakeSimctl;
  views: FakeViews;
  clock: FakeClock;
  snapshots: SimulatorHubSnapshot[];
  saved: string[][];
  inputs: Array<{ udid: string; input: SimulatorInput }>;
  options: DeviceHubOptions;
  latest(): SimulatorHubSnapshot;
}

function harness(overrides: Partial<DeviceHubOptions> & { owned?: string[] } = {}): Harness {
  const simctl = new FakeSimctl();
  const views = new FakeViews();
  const clock = new FakeClock();
  const snapshots: SimulatorHubSnapshot[] = [];
  const saved: string[][] = [];
  const inputs: Harness["inputs"] = [];
  const options: DeviceHubOptions = {
    platform: "darwin",
    simctl,
    probeSetup: async (): Promise<IosSetupProbe> => ({ state: "ready", toolLabel: "Xcode 27.0" }),
    readProfile: async () => ({ screen: SCREEN, chromeIdentifier: "com.apple.dt.devicekit.chrome.phone11" }),
    input: {
      available: () => true,
      perform: async (udid, input) => {
        inputs.push({ udid, input });
      },
    },
    views,
    ownership: {
      load: async () => overrides.owned ?? [],
      save: async (ids) => {
        saved.push([...ids]);
      },
    },
    availableMemory: async () => 16 * 1024 ** 3,
    downloadRuntime: () => ({ done: new Promise<void>(() => undefined), cancel: () => undefined }),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  };
  const hub = new DeviceHub(options);
  return {
    hub,
    simctl,
    views,
    clock,
    snapshots,
    saved,
    inputs,
    options,
    latest: () => snapshots.at(-1) ?? hub.snapshot(),
  };
}

const device = (snapshot: SimulatorHubSnapshot, id: string) =>
  snapshot.devices.find((entry) => entry.id === id);

describe("DeviceHub", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is unsupported off macOS and never runs device tools", async () => {
    const off = harness({ platform: "linux" });
    const snapshot = await off.hub.refresh();
    expect(snapshot.setup).toEqual([
      { platform: "ios", state: "unsupported", toolLabel: null, download: null },
    ]);
    expect(snapshot.devices).toEqual([]);
    expect(off.simctl.list).not.toHaveBeenCalled();
    await expect(off.hub.boot(PHONE)).rejects.toThrow("no longer available");
  });

  it("publishes the devices and setup, coalescing updates", async () => {
    const snapshot = await h.hub.refresh();
    await flush();
    expect(snapshot.setup[0]).toMatchObject({ state: "ready", toolLabel: "Xcode 27.0" });
    expect(snapshot.devices.map((entry) => [entry.name, entry.state, entry.bootedByZeros])).toEqual([
      ["iPhone 17", "shutdown", false],
      ["iPad Pro 13-inch (M5)", "shutdown", false],
      ["iPhone 17e", "shutdown", false],
    ]);
    expect(h.snapshots).toHaveLength(1);
  });

  it("lists nothing when Xcode is missing", async () => {
    const missing = harness({
      probeSetup: async () => ({ state: "tools-missing", toolLabel: null }),
    });
    const snapshot = await missing.hub.refresh();
    expect(snapshot.setup[0]?.state).toBe("tools-missing");
    expect(snapshot.devices).toEqual([]);
  });

  it("boots a device, owns it and shares concurrent boot requests", async () => {
    await h.hub.refresh();
    h.simctl.bootGate = deferred();
    const first = h.hub.boot(PHONE);
    const second = h.hub.boot(PHONE);
    await flush();
    expect(device(h.latest(), PHONE)?.state).toBe("booting");
    h.simctl.bootGate.resolve();
    await expect(first).resolves.toBe("booted");
    await expect(second).resolves.toBe("booted");
    expect(h.simctl.boots).toEqual([PHONE]);
    await flush();
    expect(device(h.latest(), PHONE)).toMatchObject({ state: "booted", bootedByZeros: true });
    expect(h.saved.at(-1)).toEqual([PHONE]);
  });

  it("lets a view start as soon as a boot finishes", async () => {
    await h.hub.refresh();
    await h.hub.boot(PHONE);
    await expect(h.hub.startView(PHONE)).resolves.toEqual({ viewId: "view-1", screen: SCREEN });
    expect(h.views.open).toHaveBeenCalledWith("view-1", PHONE, SCREEN);
  });

  it("keeps ownership when a device list read overlaps the boot", async () => {
    await h.hub.refresh();
    const stale = deferred<IosDeviceRecord[]>();
    const staleRecords = h.simctl.snapshotRecords();
    h.simctl.nextList.push(stale);
    const refresh = h.hub.refresh();
    await flush();
    await h.hub.boot(PHONE);
    stale.resolve(staleRecords);
    await refresh;
    await flush();
    expect(device(h.hub.snapshot(), PHONE)).toMatchObject({ state: "booted", bootedByZeros: true });
    expect(h.saved.at(-1)).toEqual([PHONE]);
  });

  it("stops a boot when asked and shuts the half-booted device down", async () => {
    await h.hub.refresh();
    h.simctl.bootGate = deferred();
    const boot = h.hub.boot(PHONE);
    await flush();
    expect(h.hub.cancelBoot(PHONE)).toBe(true);
    await expect(boot).resolves.toBe("cancelled");
    expect(h.simctl.shutdowns).toEqual([PHONE]);
    await flush();
    expect(device(h.latest(), PHONE)).toMatchObject({ state: "shutdown", bootedByZeros: false });
    expect(h.hub.cancelBoot(PHONE)).toBe(false);
  });

  it("reports boot failures in its own words", async () => {
    await h.hub.refresh();
    h.simctl.bootError = new Error("CoreSimulator error at /Users/me/Library");
    const log = vi.fn();
    const logged = harness({ simctl: h.simctl, log });
    await logged.hub.refresh();
    await expect(logged.hub.boot(PHONE)).rejects.toThrow(/^Couldn't start iPhone 17\.$/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("simulator boot failed"));
    expect(device(logged.hub.snapshot(), PHONE)?.bootedByZeros).toBe(false);
  });

  it("refuses ids that are not in its own device list", async () => {
    await h.hub.refresh();
    await expect(h.hub.boot("--erase")).rejects.toThrow("no longer available");
    await expect(h.hub.input("NOPE", { kind: "button", button: "home" })).rejects.toThrow(
      "no longer available",
    );
    expect(h.simctl.boot).not.toHaveBeenCalled();
  });

  it("waits for the first device read, so restored tabs can start views", async () => {
    h.simctl.states.set(PHONE, "booted");
    await expect(h.hub.startView(PHONE)).resolves.toMatchObject({ viewId: "view-1" });
  });

  it("shuts down idle devices it booted after a minute's warning", async () => {
    await h.hub.refresh();
    await h.hub.boot(PHONE);
    await h.clock.advance(29 * MINUTE);
    expect(h.latest().idleWarnings).toEqual([{ deviceId: PHONE, shutdownAt: h.clock.now + MINUTE }]);
    await h.clock.advance(MINUTE);
    expect(h.simctl.shutdowns).toEqual([PHONE]);
    expect(device(h.latest(), PHONE)).toMatchObject({ state: "shutdown", bootedByZeros: false });
    expect(h.latest().idleWarnings).toEqual([]);
  });

  it("counts input and Keep running as use", async () => {
    await h.hub.refresh();
    await h.hub.boot(PHONE);
    await h.clock.advance(29 * MINUTE);
    await h.hub.keepRunning(PHONE);
    await flush();
    expect(h.latest().idleWarnings).toEqual([]);
    await h.clock.advance(20 * MINUTE);
    await h.hub.input(PHONE, { kind: "tap", at: { x: 10, y: 10 } });
    await h.clock.advance(20 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([]);
    expect(h.inputs).toEqual([{ udid: PHONE, input: { kind: "tap", at: { x: 10, y: 10 } } }]);
  });

  it("never idles out a device it did not boot", async () => {
    h.simctl.states.set(PAD, "booted");
    await h.hub.refresh();
    await h.clock.advance(5 * 60 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([]);
    expect(device(h.latest(), PAD)).toMatchObject({ state: "booted", bootedByZeros: false });
  });

  it("follows the idle shutdown setting", async () => {
    await h.hub.refresh();
    await h.hub.boot(PHONE);
    h.hub.setPreferences({ agentsEnabled: true, idleShutdown: "never", showAgentTouches: true });
    await h.clock.advance(10 * 60 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([]);
    h.hub.setPreferences({ agentsEnabled: true, idleShutdown: "15m", showAgentTouches: true });
    await h.clock.advance(MINUTE);
    expect(h.simctl.shutdowns).toEqual([PHONE]);
  });

  it("keeps a held device running", async () => {
    await h.hub.refresh();
    await h.hub.boot(PHONE);
    const release = h.hub.hold(PHONE);
    await h.clock.advance(2 * 60 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([]);
    release();
    await h.clock.advance(30 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([PHONE]);
  });

  it("remembers devices it booted before a restart, and forgets ones now off", async () => {
    h = harness({ owned: [PHONE, PAD] });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    expect(device(h.hub.snapshot(), PHONE)?.bootedByZeros).toBe(true);
    expect(device(h.hub.snapshot(), PAD)?.bootedByZeros).toBe(false);
    expect(h.saved.at(-1)).toEqual([PHONE]);
    await h.clock.advance(30 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([PHONE]);
  });

  it("warns before booting a third device or with little memory", async () => {
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.bootWarnings(PAD)).resolves.toEqual([]);
    await expect(h.hub.bootWarnings(PHONE)).resolves.toEqual([]);
    h.simctl.states.set(PAD, "booted");
    await h.hub.refresh();
    await expect(h.hub.bootWarnings(OTHER)).resolves.toEqual(["many-devices"]);

    const low = harness({ availableMemory: async () => LOW_MEMORY_BYTES - 1 });
    await low.hub.refresh();
    await expect(low.hub.bootWarnings(PHONE)).resolves.toEqual(["low-memory"]);
    const unknown = harness({ availableMemory: async () => null });
    await unknown.hub.refresh();
    await expect(unknown.hub.bootWarnings(PHONE)).resolves.toEqual([]);
  });

  it("runs views and input only on running devices", async () => {
    await h.hub.refresh();
    await expect(h.hub.startView(PHONE)).rejects.toThrow("iPhone 17 isn't running.");
    await expect(h.hub.input(PHONE, { kind: "button", button: "home" })).rejects.toThrow(
      "isn't running",
    );
    expect(h.hub.stopView("../view")).toBe(false);
    expect(h.hub.stopView("view-9")).toBe(true);
  });

  it("readies input for a device as its view opens, so the first touch is quick", async () => {
    const prepare = vi.fn();
    h = harness({ input: { available: () => true, perform: async () => undefined, prepare } });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await h.hub.startView(PHONE);
    expect(prepare).toHaveBeenCalledWith(PHONE);
  });

  it("says which running devices its own input reaches", async () => {
    await h.hub.refresh();
    expect(h.hub.canDrive(PHONE)).toBe(false);
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    expect(h.hub.canDrive(PHONE)).toBe(true);
    expect(h.hub.canDrive("not-a-device")).toBe(false);
    const noTool = harness({
      input: { available: () => false, perform: async () => undefined },
    });
    noTool.simctl.states.set(PHONE, "booted");
    await noTool.hub.refresh();
    expect(noTool.hub.canDrive(PHONE)).toBe(false);
  });

  it("explains a missing profile or input tool without tool output", async () => {
    h = harness({ readProfile: async () => null });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.startView(PHONE)).rejects.toThrow("Zeros can't show iPhone 17.");
    const noTool = harness({
      input: { available: () => false, perform: async () => undefined },
    });
    noTool.simctl.states.set(PHONE, "booted");
    await noTool.hub.refresh();
    await expect(noTool.hub.startView(PHONE)).rejects.toThrow("can't show simulators");
  });

  it("maps input failures to its own message", async () => {
    h = harness({
      input: {
        available: () => true,
        perform: async () => {
          throw new Error("axe: /private/path");
        },
      },
    });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.input(PHONE, { kind: "button", button: "home" })).rejects.toThrow(
      /^That didn't reach iPhone 17\.$/,
    );
  });

  it("logs what the input tool said, and tells people only that it failed", async () => {
    const logs: string[] = [];
    h = harness({
      input: {
        available: () => true,
        perform: async () => {
          throw new ToolFailure(
            "axe",
            "Error: Start and end points\n  must be different\nUsage: axe drag …\n",
            1,
            false,
          );
        },
      },
      log: (line) => logs.push(line),
    });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(
      h.hub.input(PHONE, { kind: "drag", from: { x: 1, y: 1 }, to: { x: 1, y: 1 }, durationMs: 600 }),
    ).rejects.toThrow(/^That didn't reach iPhone 17\.$/);
    expect(logs).toContain(
      "simulator input failed: axe failed (exit 1): Error: Start and end points must be different Usage: axe drag …",
    );
  });

  it("passes on an input failure already worded for people", async () => {
    h = harness({
      input: {
        available: () => true,
        perform: async () => {
          throw new DeviceActionError("iOS simulators take only characters on a US keyboard.");
        },
      },
    });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.input(PHONE, { kind: "text", text: "é" })).rejects.toThrow(
      new DeviceActionError("iOS simulators take only characters on a US keyboard."),
    );
  });

  it("refuses Back on iOS, which has no such button", async () => {
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.input(PHONE, { kind: "button", button: "back" })).rejects.toThrow(
      new DeviceActionError("iOS simulators have no Back button."),
    );
    expect(h.inputs).toEqual([]);
  });

  it("closes views of a device that shut down outside Zeros, polling while one is open", async () => {
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await h.hub.startView(PHONE);
    h.simctl.states.set(PHONE, "shutdown");
    await h.clock.advance(DEVICE_POLL_MS);
    expect(h.views.closeDevice).toHaveBeenCalledWith(PHONE);
    expect(device(h.latest(), PHONE)?.state).toBe("shutdown");
    const reads = h.simctl.list.mock.calls.length;
    await h.clock.advance(DEVICE_POLL_MS * 3);
    expect(h.simctl.list.mock.calls.length).toBe(reads);
  });

  it("keeps reading a device caught shutting down outside Zeros until it has stopped", async () => {
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await h.hub.startView(PHONE);
    h.simctl.states.set(PHONE, "shutting-down");
    await h.clock.advance(DEVICE_POLL_MS);
    expect(h.views.closeDevice).toHaveBeenCalledWith(PHONE);
    expect(h.views.viewCount()).toBe(0);
    expect(device(h.latest(), PHONE)?.state).toBe("shutting-down");
    h.simctl.states.set(PHONE, "shutdown");
    await h.clock.advance(SETTLING_POLL_MS);
    expect(device(h.latest(), PHONE)?.state).toBe("shutdown");
    const reads = h.simctl.list.mock.calls.length;
    await h.clock.advance(DEVICE_POLL_MS * 3);
    expect(h.simctl.list.mock.calls.length).toBe(reads);
  });

  it("follows a device booting outside Zeros until it is running", async () => {
    await h.hub.refresh();
    h.simctl.states.set(PHONE, "booting");
    await h.hub.refresh();
    expect(device(h.latest(), PHONE)?.state).toBe("booting");
    h.simctl.states.set(PHONE, "booted");
    await h.clock.advance(SETTLING_POLL_MS);
    expect(device(h.latest(), PHONE)?.state).toBe("booted");
    const reads = h.simctl.list.mock.calls.length;
    await h.clock.advance(DEVICE_POLL_MS * 3);
    expect(h.simctl.list.mock.calls.length).toBe(reads);
  });

  it("shuts a device down on request and closes its views", async () => {
    h.simctl.states.set(PAD, "booted");
    await h.hub.refresh();
    await h.hub.startView(PAD);
    await h.hub.shutdown(PAD);
    expect(h.views.closeDevice).toHaveBeenCalledWith(PAD);
    expect(h.simctl.shutdowns).toEqual([PAD]);
    await flush();
    expect(device(h.latest(), PAD)?.state).toBe("shutdown");
  });

  it("lets a recording finish before the device shuts down, even if saving fails", async () => {
    const order: string[] = [];
    h = harness({
      beforeShutdown: async (deviceId) => {
        order.push(`before ${deviceId}`);
        throw new Error("saving failed");
      },
    });
    h.simctl.shutdown.mockImplementation(async (udid: string) => {
      order.push(`shutdown ${udid}`);
      h.simctl.states.set(udid, "shutdown");
    });
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await h.hub.shutdown(PHONE);
    expect(order).toEqual([`before ${PHONE}`, `shutdown ${PHONE}`]);
  });

  it("describes a running device as its snapshot does", async () => {
    h = harness({ orientation: { set: async () => undefined } });
    h.simctl.states.set(PAD, "booted");
    await h.hub.refresh();
    await h.hub.rotate(PAD, "landscape-left");
    await expect(h.hub.runningDevice(PAD)).resolves.toMatchObject({
      id: PAD,
      name: "iPad Pro 13-inch (M5)",
      osLabel: "iOS 27.0",
      orientation: "landscape-left",
    });
    await expect(h.hub.runningDevice(PHONE)).rejects.toThrow("iPhone 17 isn't running.");
    await expect(h.hub.deviceScreen(PHONE)).resolves.toEqual(SCREEN);
    const unknown = harness({ readProfile: async () => null });
    await expect(unknown.hub.deviceScreen(PHONE)).resolves.toBeNull();
  });

  it("changes appearance in its own words", async () => {
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.appearance(PHONE)).resolves.toBe("light");
    await h.hub.setAppearance(PHONE, "dark");
    expect(h.simctl.setAppearance).toHaveBeenCalledWith(PHONE, "dark");
    h.simctl.setAppearance.mockRejectedValueOnce(new Error("raw"));
    await expect(h.hub.setAppearance(PHONE, "light")).rejects.toThrow(
      "Couldn't change iPhone 17's appearance.",
    );
  });

  it("rotates a running device and publishes its orientation until it stops", async () => {
    const turns: Array<[string, string]> = [];
    const turned = harness({
      orientation: {
        set: async (udid, orientation) => {
          turns.push([udid, orientation]);
        },
      },
    });
    turned.simctl.states.set(PHONE, "booted");
    await turned.hub.refresh();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");
    await turned.hub.rotate(PHONE, "landscape-left");
    await flush();
    expect(turns).toEqual([[PHONE, "landscape-left"]]);
    expect(device(turned.latest(), PHONE)?.orientation).toBe("landscape-left");
    await turned.hub.rotate(PHONE, "portrait");
    await flush();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");

    await turned.hub.rotate(PHONE, "landscape-right");
    await turned.hub.shutdown(PHONE);
    await flush();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");

    await turned.hub.boot(PHONE);
    await turned.hub.rotate(PHONE, "landscape-right");
    turned.simctl.states.set(PHONE, "shutdown");
    await turned.hub.refresh();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");
  });

  it("publishes a turn as it starts, so the frame turns with the screen, and turns back when it fails", async () => {
    const pending: Array<ReturnType<typeof deferred<void>>> = [];
    const turned = harness({
      orientation: {
        set: () => {
          const turn = deferred();
          pending.push(turn);
          return turn.promise;
        },
      },
    });
    turned.simctl.states.set(PHONE, "booted");
    await turned.hub.refresh();

    const first = turned.hub.rotate(PHONE, "landscape-left");
    await flush();
    expect(device(turned.latest(), PHONE)?.orientation).toBe("landscape-left");
    pending[0]!.resolve();
    await first;
    await flush();
    expect(device(turned.latest(), PHONE)?.orientation).toBe("landscape-left");

    const failed = turned.hub.rotate(PHONE, "portrait");
    await flush();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");
    pending[1]!.reject(new Error("raw"));
    await expect(failed).rejects.toThrow("Couldn't rotate iPhone 17.");
    await flush();
    expect(device(turned.latest(), PHONE)?.orientation).toBe("landscape-left");

    // The newest turn shows, whichever finishes first.
    const older = turned.hub.rotate(PHONE, "portrait");
    const newer = turned.hub.rotate(PHONE, "landscape-right");
    await flush();
    expect(device(turned.latest(), PHONE)?.orientation).toBe("landscape-right");
    pending[3]!.resolve();
    await newer;
    pending[2]!.resolve();
    await older;
    await flush();
    expect(device(turned.latest(), PHONE)?.orientation).toBe("landscape-right");

    // A device that stops mid-turn starts upright next time.
    const stopped = turned.hub.rotate(PHONE, "landscape-left");
    await flush();
    await turned.hub.shutdown(PHONE);
    await flush();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");
    pending[4]!.resolve();
    await stopped;
    await turned.hub.boot(PHONE);
    await flush();
    expect(device(turned.latest(), PHONE)).not.toHaveProperty("orientation");
  });

  it("rotates only running devices, in its own words unless the failure already is", async () => {
    const failure = { error: new Error("raw /Users/me/.agent-device") as Error };
    const turned = harness({
      orientation: {
        set: async () => {
          throw failure.error;
        },
      },
    });
    await turned.hub.refresh();
    await expect(turned.hub.rotate(PHONE, "landscape-left")).rejects.toThrow(
      "iPhone 17 isn't running.",
    );
    turned.simctl.states.set(PHONE, "booted");
    await turned.hub.refresh();
    await expect(turned.hub.rotate(PHONE, "landscape-left")).rejects.toThrow(
      "Couldn't rotate iPhone 17.",
    );
    failure.error = new DeviceActionError("Another automation tool is using iPhone 17.");
    await expect(turned.hub.rotate(PHONE, "landscape-left")).rejects.toThrow(
      "Another automation tool is using iPhone 17.",
    );
    expect(device(turned.hub.snapshot(), PHONE)).not.toHaveProperty("orientation");

    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.rotate(PHONE, "landscape-left")).rejects.toThrow(
      "This build of Zeros can't rotate simulators.",
    );
  });

  it("pinches through its gesture tool, never the touch tool, in its own words", async () => {
    const pinches: Array<[string, number]> = [];
    const failure: { error: Error | null } = { error: null };
    const pinching = harness({
      pinch: {
        pinch: async (udid, scale) => {
          if (failure.error) throw failure.error;
          pinches.push([udid, scale]);
        },
      },
    });
    await pinching.hub.refresh();
    await expect(pinching.hub.input(PHONE, { kind: "pinch", scale: 2 })).rejects.toThrow(
      "iPhone 17 isn't running.",
    );
    pinching.simctl.states.set(PHONE, "booted");
    await pinching.hub.refresh();
    await pinching.hub.input(PHONE, { kind: "pinch", scale: 0.5 });
    expect(pinches).toEqual([[PHONE, 0.5]]);
    expect(pinching.inputs).toEqual([]);
    failure.error = new Error("raw /Users/me/.agent-device");
    await expect(pinching.hub.input(PHONE, { kind: "pinch", scale: 2 })).rejects.toThrow(
      /^Couldn't pinch iPhone 17\.$/,
    );
    failure.error = new DeviceActionError("Another automation tool is using iPhone 17.");
    await expect(pinching.hub.input(PHONE, { kind: "pinch", scale: 2 })).rejects.toThrow(
      "Another automation tool is using iPhone 17.",
    );

    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await expect(h.hub.input(PHONE, { kind: "pinch", scale: 2 })).rejects.toThrow(
      "This build of Zeros can't pinch simulators.",
    );
    expect(h.inputs).toEqual([]);
  });

  it("installs the iOS runtime with progress, and can cancel", async () => {
    let report: (progress: number | null) => void = () => undefined;
    const finished = deferred();
    const cancel = vi.fn();
    h = harness({
      probeSetup: async () => ({ state: "runtime-missing", toolLabel: "Xcode 27.0" }),
      downloadRuntime: (onProgress): RuntimeDownload => {
        report = onProgress;
        return { done: finished.promise, cancel };
      },
    });
    await h.hub.refresh();
    expect(h.hub.installRuntime()).toBe(true);
    expect(h.hub.installRuntime()).toBe(false);
    await flush();
    expect(h.latest().setup[0]?.download).toEqual({ state: "downloading", progress: null });
    h.clock.now += 1_000;
    report(0.4);
    await flush();
    expect(h.latest().setup[0]?.download).toEqual({ state: "downloading", progress: 0.4 });
    finished.reject(new Error("network"));
    await flush();
    expect(h.latest().setup[0]?.download).toEqual({ state: "failed", progress: null });

    const again = deferred();
    h.options.downloadRuntime = () => ({ done: again.promise, cancel });
    expect(h.hub.installRuntime()).toBe(true);
    expect(h.hub.cancelRuntimeInstall()).toBe(true);
    expect(cancel).toHaveBeenCalled();
    await flush();
    expect(h.latest().setup[0]?.download).toBeNull();
  });

  it("runs no device tools until something asks for its state", async () => {
    await flush();
    expect(h.simctl.list).not.toHaveBeenCalled();
    expect(h.hub.state().setup[0]?.state).toBe("checking");
    await flush();
    await flush();
    expect(h.simctl.list).toHaveBeenCalledTimes(1);
    expect(h.latest().setup[0]?.state).toBe("ready");
    h.hub.state();
    await flush();
    expect(h.simctl.list).toHaveBeenCalledTimes(1);
  });

  it("resumes idle shutdown for devices it booted before a crash, without a tab", async () => {
    h = harness({ owned: [PHONE] });
    h.simctl.states.set(PHONE, "booted");
    await flush();
    await flush();
    expect(h.simctl.list).toHaveBeenCalled();
    await h.clock.advance(30 * MINUTE);
    expect(h.simctl.shutdowns).toEqual([PHONE]);
  });

  it("describes a device's shape before it boots, with Xcode's frame when there is one", async () => {
    const frame = {
      width: 438,
      height: 910,
      screen: { x: 18, y: 18, width: 402, height: 874 },
      slices: {} as never,
      buttons: [],
      outset: { top: 0, left: 8, bottom: 0, right: 8 },
    };
    const readFrame = vi.fn(async () => frame);
    h = harness({ readFrame });
    await expect(h.hub.deviceShape(PHONE)).resolves.toEqual({ screen: SCREEN, frame });
    expect(readFrame).toHaveBeenCalledWith("com.apple.dt.devicekit.chrome.phone11", SCREEN);

    const failing = harness({ readFrame: async () => Promise.reject(new Error("sips")) });
    await expect(failing.hub.deviceShape(PHONE)).resolves.toEqual({ screen: SCREEN, frame: null });
    const plain = harness({ readProfile: async () => ({ screen: SCREEN, chromeIdentifier: null }), readFrame });
    await expect(plain.hub.deviceShape(PHONE)).resolves.toEqual({ screen: SCREEN, frame: null });
    const unknown = harness({ readProfile: async () => null });
    await expect(unknown.hub.deviceShape(PHONE)).resolves.toBeNull();
    await expect(h.hub.deviceShape("NOPE")).rejects.toThrow("no longer available");
  });

  it("ends every view when the window that opened them goes away", async () => {
    h.simctl.states.set(PHONE, "booted");
    await h.hub.refresh();
    await h.hub.startView(PHONE);
    h.hub.stopAllViews();
    expect(h.views.closeAll).toHaveBeenCalled();
    expect(h.views.viewCount()).toBe(0);
  });

  describe("live touches", () => {
    const step = (phase: SimulatorTouch["phase"], x: number, y: number): SimulatorTouch => ({
      phase,
      at: { x, y },
    });
    let touches: Array<{ udid: string; touch: SimulatorTouch }>;
    let live: boolean;

    beforeEach(async () => {
      touches = [];
      live = true;
      h = harness({
        input: {
          available: () => true,
          perform: async (udid, input) => {
            h.inputs.push({ udid, input });
          },
          touch: async (udid, touch) => {
            touches.push({ udid, touch });
            return live;
          },
        },
      });
      h.simctl.states.set(PHONE, "booted");
      await h.hub.refresh();
    });

    it("sends the user's finger to the device as it moves, and says what each press did", async () => {
      const { viewId } = await h.hub.startView(PHONE);
      await expect(h.hub.touch(PHONE, viewId, step("down", 100, 100))).resolves.toBeNull();
      await h.hub.touch(PHONE, viewId, step("move", 100, 200));
      await h.clock.advance(300);
      await expect(h.hub.touch(PHONE, viewId, step("up", 100, 300))).resolves.toEqual({
        kind: "drag",
        from: { x: 100, y: 100 },
        to: { x: 100, y: 300 },
        durationMs: 300,
      });
      expect(touches).toEqual([
        { udid: PHONE, touch: step("down", 100, 100) },
        { udid: PHONE, touch: step("move", 100, 200) },
        { udid: PHONE, touch: step("up", 100, 300) },
      ]);
      expect(h.inputs).toEqual([]);
    });

    it("counts a press as use", async () => {
      await h.hub.boot(OTHER);
      const { viewId } = await h.hub.startView(OTHER);
      await h.clock.advance(29 * MINUTE);
      await h.hub.touch(OTHER, viewId, step("down", 1, 1));
      await h.hub.touch(OTHER, viewId, step("up", 1, 1));
      await h.clock.advance(20 * MINUTE);
      expect(h.simctl.shutdowns).toEqual([]);
    });

    it("sends a press whole when the device can't take it live", async () => {
      live = false;
      const { viewId } = await h.hub.startView(PHONE);
      await h.hub.touch(PHONE, viewId, step("down", 10, 10));
      await h.hub.touch(PHONE, viewId, step("move", 10, 15));
      await expect(h.hub.touch(PHONE, viewId, step("up", 11, 10))).resolves.toEqual({
        kind: "tap",
        at: { x: 10, y: 10 },
      });
      expect(touches).toHaveLength(1);
      expect(h.inputs).toEqual([{ udid: PHONE, input: { kind: "tap", at: { x: 10, y: 10 } } }]);

      const pinch = { pinch: vi.fn(async () => undefined) };
      h = harness({ pinch });
      h.simctl.states.set(PHONE, "booted");
      await h.hub.refresh();
      const view = await h.hub.startView(PHONE);
      await h.hub.touch(PHONE, view.viewId, { phase: "down", at: { x: 226, y: 437 }, second: { x: 176, y: 437 } });
      await expect(
        h.hub.touch(PHONE, view.viewId, { phase: "up", at: { x: 251, y: 437 }, second: { x: 151, y: 437 } }),
      ).resolves.toEqual({ kind: "pinch", scale: 2 });
      expect(pinch.pinch).toHaveBeenCalledWith(PHONE, 2, "iPhone 17");
    });

    it("lifts a finger left down when its view closes or its window goes away", async () => {
      const first = await h.hub.startView(PHONE);
      const second = await h.hub.startView(PHONE);
      await h.hub.touch(PHONE, first.viewId, step("down", 5, 5));
      await h.hub.touch(PHONE, first.viewId, step("move", 5, 50));
      h.hub.stopView(second.viewId);
      await flush();
      expect(touches).toHaveLength(2);
      h.hub.stopView(first.viewId);
      await flush();
      expect(touches.at(-1)).toEqual({ udid: PHONE, touch: step("cancel", 5, 50) });

      const third = await h.hub.startView(PHONE);
      await h.hub.touch(PHONE, third.viewId, step("down", 7, 7));
      h.hub.stopAllViews();
      await flush();
      expect(touches.at(-1)).toEqual({ udid: PHONE, touch: step("cancel", 7, 7) });
      await expect(h.hub.touch(PHONE, third.viewId, step("up", 7, 7))).resolves.toBeNull();
      expect(touches).toHaveLength(5);

      const fourth = await h.hub.startView(PHONE);
      await h.hub.touch(PHONE, fourth.viewId, step("down", 9, 9));
      await h.hub.dispose();
      expect(touches.at(-1)).toEqual({ udid: PHONE, touch: step("cancel", 9, 9) });
      await expect(h.hub.touch(PHONE, fourth.viewId, step("down", 9, 9))).resolves.toBeNull();
      expect(touches).toHaveLength(7);
    });

    it("takes touches only on a view of the running device", async () => {
      await expect(h.hub.touch(PHONE, "view-9", step("down", 1, 1))).resolves.toBeNull();
      const { viewId } = await h.hub.startView(PHONE);
      await expect(h.hub.touch(PAD, viewId, step("down", 1, 1))).rejects.toThrow(
        "iPad Pro 13-inch (M5) isn't running.",
      );
      await expect(h.hub.touch(PAD, viewId, step("up", 1, 1))).resolves.toBeNull();
      h.simctl.states.set(PAD, "booted");
      await h.hub.refresh();
      await expect(h.hub.touch(PAD, viewId, step("down", 1, 1))).resolves.toBeNull();
      await expect(h.hub.touch("NOPE", viewId, step("down", 1, 1))).rejects.toThrow(
        "no longer available",
      );
      expect(touches).toEqual([]);

      await h.hub.touch(PHONE, viewId, step("down", 1, 1));
      await h.hub.shutdown(PHONE);
      await expect(h.hub.touch(PHONE, viewId, step("up", 1, 1))).resolves.toBeNull();
      await expect(h.hub.touch(PHONE, viewId, step("down", 1, 1))).rejects.toThrow(
        "iPhone 17 isn't running.",
      );
      expect(touches).toHaveLength(1);
    });

    it("words a failed touch for people and logs what the tool said", async () => {
      const logs: string[] = [];
      h = harness({
        input: {
          available: () => true,
          perform: async () => undefined,
          touch: async () => {
            throw new ToolFailure("zeros-simulator-hid", "no-answer\n", 1, false);
          },
        },
        log: (line) => logs.push(line),
      });
      h.simctl.states.set(PHONE, "booted");
      await h.hub.refresh();
      const { viewId } = await h.hub.startView(PHONE);
      await expect(h.hub.touch(PHONE, viewId, step("down", 1, 1))).rejects.toThrow(
        /^That didn't reach iPhone 17\.$/,
      );
      expect(logs).toEqual([
        "simulator touch failed: zeros-simulator-hid failed (exit 1): no-answer",
      ]);
    });
  });

  it("keeps the preferences it was given", async () => {
    expect(h.hub.preferences()).toEqual({
      agentsEnabled: true,
      idleShutdown: "30m",
      showAgentTouches: true,
    });
    h.hub.setPreferences({ agentsEnabled: false, idleShutdown: "1h", showAgentTouches: false });
    expect(h.hub.preferences()).toEqual({
      agentsEnabled: false,
      idleShutdown: "1h",
      showAgentTouches: false,
    });
  });

  it("shuts down only the devices it booted when Zeros quits", async () => {
    h.simctl.states.set(PAD, "booted");
    await h.hub.refresh();
    await h.hub.boot(PHONE);
    await h.hub.dispose();
    expect(h.simctl.shutdowns).toEqual([PHONE]);
    expect(h.views.dispose).toHaveBeenCalled();
    // Booted again outside Zeros, it is the user's, not Zeros' to shut down.
    expect(h.saved.at(-1)).toEqual([]);
    await expect(h.hub.boot(PHONE)).rejects.toThrow("quitting");
  });

  it("keeps devices that didn't shut down by quit listed for the next launch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await h.hub.refresh();
      await h.hub.boot(PHONE);
      await h.hub.boot(OTHER);
      await h.hub.boot(PAD);
      const stuck = deferred();
      h.simctl.shutdown.mockImplementation(async (udid: string) => {
        h.simctl.shutdowns.push(udid);
        if (udid === PHONE) await stuck.promise;
        if (udid === PAD) throw new Error("Unable to shutdown device");
        h.simctl.states.set(udid, "shutdown");
      });
      const quitting = h.hub.dispose();
      await vi.advanceTimersByTimeAsync(8_000);
      await quitting;
      expect(h.simctl.shutdowns).toEqual([PHONE, OTHER, PAD]);
      expect(h.saved.at(-1)).toEqual([PHONE, PAD]);
      stuck.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});

const PIXEL = "Pixel_10";
const TABLET = "Pixel_Tablet";
const ANDROID_SCREEN: SimulatorScreen = { widthPx: 1080, heightPx: 2424, scale: 2.625, cornerRadius: 33 };
const ANDROID_READY: AndroidSetupProbe = {
  state: "ready",
  toolLabel: "Android Emulator 37.2.12",
  newDevice: "Pixel 10 with Android 17",
  studioInstalled: true,
};
const STUDIO_FRAME = {
  width: 460,
  height: 960,
  screen: { x: 25, y: 18, width: 411, height: 923 },
  image: { url: "data:image/webp;base64,AAAA", width: 460, height: 960 },
  buttons: [],
  outset: { top: 0, left: 0, bottom: 0, right: 0 },
};

class FakeAndroid implements AndroidDevicesPort {
  readonly states = new Map<string, SimulatorDeviceState>([
    [PIXEL, "shutdown"],
    [TABLET, "shutdown"],
  ]);
  readonly names: Record<string, string> = { [PIXEL]: "Pixel 10", [TABLET]: "Pixel Tablet" };
  setup: AndroidSetupProbe = ANDROID_READY;
  bootGate: ReturnType<typeof deferred<void>> | null = null;
  bootError: Error | null = null;
  readError: Error | null = null;
  createGate: ReturnType<typeof deferred<void>> | null = null;
  nextRead: Array<ReturnType<typeof deferred<AndroidDevicesRead>>> = [];
  readonly feeds: StartFrameFeed[] = [];

  current(): AndroidDevicesRead {
    return {
      setup: { ...this.setup },
      devices: [...this.states].map(([id, state]) => ({
        id,
        platform: "android",
        name: this.names[id]!,
        osLabel: "Android 17",
        formFactor: id === TABLET ? "tablet" : "phone",
        state,
      })),
    };
  }

  read = vi.fn(async (): Promise<AndroidDevicesRead> => {
    if (this.readError) throw this.readError;
    const pending = this.nextRead.shift();
    if (pending) return pending.promise;
    return this.current();
  });

  boot = vi.fn(async (id: string, signal: AbortSignal) => {
    if (this.bootGate) {
      const gate = this.bootGate;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted /Users/me/.android")));
        gate.promise.then(resolve, reject);
      });
    }
    if (this.bootError) throw this.bootError;
    this.states.set(id, "booted");
  });

  shutdown = vi.fn(async (id: string) => {
    this.states.set(id, "shutdown");
  });

  createDevice = vi.fn(async () => {
    await this.createGate?.promise;
    this.states.set("Pixel_10_2", "shutdown");
    this.names.Pixel_10_2 = "Pixel 10 (2)";
    return "Pixel_10_2";
  });

  screen = vi.fn(async (id: string) => (this.states.has(id) ? ANDROID_SCREEN : null));
  frame = vi.fn(async () => STUDIO_FRAME);
  feed = vi.fn((): StartFrameFeed => {
    const feed: StartFrameFeed = () => ({ stop: () => undefined });
    this.feeds.push(feed);
    return feed;
  });
  drives = vi.fn((id: string) => this.states.get(id) === "booted");
  input = vi.fn(async () => undefined);
  touch = vi.fn(async () => undefined);
  rotate = vi.fn(async () => undefined);
  appearance = vi.fn(async () => "dark" as const);
  setAppearance = vi.fn(async () => undefined);
  dispose = vi.fn();
}

describe("DeviceHub with Android devices", () => {
  let android: FakeAndroid;
  let h: Harness;
  beforeEach(() => {
    android = new FakeAndroid();
    h = harness({ android });
  });

  it("lists Android devices after iOS ones, with Android's own setup", async () => {
    expect(h.hub.snapshot().setup[1]).toEqual({
      platform: "android",
      state: "checking",
      toolLabel: null,
      download: null,
      newDevice: null,
      creating: false,
      studioInstalled: false,
    });
    const snapshot = await h.hub.refresh();
    expect(snapshot.setup.map((entry) => [entry.platform, entry.state])).toEqual([
      ["ios", "ready"],
      ["android", "ready"],
    ]);
    expect(snapshot.setup[1]).toMatchObject({
      toolLabel: "Android Emulator 37.2.12",
      newDevice: "Pixel 10 with Android 17",
      creating: false,
      studioInstalled: true,
    });
    expect(snapshot.devices.map((entry) => [entry.platform, entry.name])).toEqual([
      ["ios", "iPhone 17"],
      ["ios", "iPad Pro 13-inch (M5)"],
      ["ios", "iPhone 17e"],
      ["android", "Pixel 10"],
      ["android", "Pixel Tablet"],
    ]);

    const off = harness({ platform: "linux", android: new FakeAndroid() });
    expect((await off.hub.refresh()).setup.map((entry) => entry.state)).toEqual([
      "unsupported",
      "unsupported",
    ]);
  });

  it("keeps each platform's devices when the other's fail to read", async () => {
    const log = vi.fn();
    android.readError = new Error("ENOENT /Users/me/Library/Android/sdk");
    h = harness({ android, log });
    let snapshot = await h.hub.refresh();
    expect(snapshot.setup[1]?.state).toBe("tools-missing");
    expect(snapshot.devices).toHaveLength(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("android device list failed"));

    android.readError = null;
    await h.hub.refresh();
    android.readError = new Error("again");
    h.simctl.list.mockRejectedValueOnce(new Error("simctl"));
    snapshot = await h.hub.refresh();
    expect(snapshot.devices).toHaveLength(5);
    expect(snapshot.setup[1]?.state).toBe("ready");

    android.readError = null;
    h.options.probeSetup = async () => ({ state: "tools-missing", toolLabel: null });
    snapshot = await h.hub.refresh();
    expect(snapshot.devices.map((entry) => entry.id)).toEqual([PIXEL, TABLET]);
  });

  it("starts and stops Android devices through their emulators, owning them", async () => {
    await h.hub.refresh();
    android.bootGate = deferred();
    const boot = h.hub.boot(PIXEL);
    await flush();
    expect(device(h.latest(), PIXEL)?.state).toBe("booting");
    expect(android.boot).toHaveBeenCalledWith(PIXEL, expect.any(AbortSignal));
    android.bootGate.resolve();
    await expect(boot).resolves.toBe("booted");
    await flush();
    expect(device(h.latest(), PIXEL)).toMatchObject({ state: "booted", bootedByZeros: true });
    expect(h.saved.at(-1)).toEqual([PIXEL]);
    expect(h.simctl.boot).not.toHaveBeenCalled();

    await h.hub.shutdown(PIXEL);
    expect(android.shutdown).toHaveBeenCalledWith(PIXEL);
    expect(h.simctl.shutdown).not.toHaveBeenCalled();
    await flush();
    expect(device(h.latest(), PIXEL)).toMatchObject({ state: "shutdown", bootedByZeros: false });
  });

  it("idles out an Android device it started", async () => {
    await h.hub.refresh();
    await h.hub.boot(PIXEL);
    await h.clock.advance(30 * MINUTE);
    expect(android.shutdown).toHaveBeenCalledWith(PIXEL);
    expect(device(h.latest(), PIXEL)?.state).toBe("shutdown");
  });

  it("stops an Android boot when asked, ending its emulator", async () => {
    await h.hub.refresh();
    android.bootGate = deferred();
    const boot = h.hub.boot(PIXEL);
    await flush();
    expect(h.hub.cancelBoot(PIXEL)).toBe(true);
    await expect(boot).resolves.toBe("cancelled");
    expect(android.shutdown).toHaveBeenCalledWith(PIXEL);
    expect(device(h.hub.snapshot(), PIXEL)).toMatchObject({ state: "shutdown", bootedByZeros: false });
  });

  it("passes on Android boot failures already worded for people", async () => {
    await h.hub.refresh();
    android.bootError = new DeviceActionError("Pixel 10 was started outside Zeros.");
    await expect(h.hub.boot(PIXEL)).rejects.toThrow(/^Pixel 10 was started outside Zeros\.$/);
    android.bootError = new Error("the emulator exited (1)");
    await expect(h.hub.boot(PIXEL)).rejects.toThrow(/^Couldn't start Pixel 10\.$/);
    expect(device(h.hub.snapshot(), PIXEL)?.bootedByZeros).toBe(false);
  });

  it("doesn't let an Android list read during a boot undo it", async () => {
    await h.hub.refresh();
    const stale = deferred<AndroidDevicesRead>();
    const staleRead = android.current();
    android.nextRead.push(stale);
    const refresh = h.hub.refresh();
    await flush();
    await h.hub.boot(PIXEL);
    stale.resolve(staleRead);
    await refresh;
    expect(device(h.hub.snapshot(), PIXEL)).toMatchObject({ state: "booted", bootedByZeros: true });
  });

  it("shows an Android device from its own frames, in Android Studio's frame", async () => {
    await h.hub.refresh();
    await expect(h.hub.deviceShape(PIXEL)).resolves.toEqual({
      screen: ANDROID_SCREEN,
      frame: STUDIO_FRAME,
    });
    android.frame.mockRejectedValueOnce(new Error("sharp"));
    await expect(h.hub.deviceShape(PIXEL)).resolves.toEqual({ screen: ANDROID_SCREEN, frame: null });
    await expect(h.hub.startView(PIXEL)).rejects.toThrow("Pixel 10 isn't running.");

    android.states.set(PIXEL, "booted");
    await h.hub.refresh();
    // The AXe frame tool isn't needed for Android.
    h.options.input.available = () => false;
    await expect(h.hub.startView(PIXEL)).resolves.toEqual({ viewId: "view-1", screen: ANDROID_SCREEN });
    expect(h.views.open).toHaveBeenCalledWith("view-1", PIXEL, ANDROID_SCREEN, android.feeds[0]);
    await expect(h.hub.deviceScreen(PIXEL)).resolves.toEqual(ANDROID_SCREEN);

    android.feed.mockImplementationOnce(() => {
      throw new DeviceActionError("Pixel 10 was started outside Zeros. Stop it there.");
    });
    await expect(h.hub.startView(PIXEL)).rejects.toThrow("Pixel 10 was started outside Zeros.");
    android.feed.mockImplementationOnce(() => {
      throw new Error("grpc /Users/me");
    });
    await expect(h.hub.startView(PIXEL)).rejects.toThrow(/^Zeros can't show Pixel 10\.$/);
    android.screen.mockResolvedValueOnce(null);
    await expect(h.hub.startView(PIXEL)).rejects.toThrow(/^Zeros can't show Pixel 10\.$/);
  });

  it("drives Android devices with their screen, pinches included, in its own words", async () => {
    expect(h.hub.canDrive(PIXEL)).toBe(false);
    android.states.set(PIXEL, "booted");
    await h.hub.refresh();
    expect(h.hub.canDrive(PIXEL)).toBe(true);
    // An emulator started outside Zeros.
    android.drives.mockReturnValueOnce(false);
    expect(h.hub.canDrive(PIXEL)).toBe(false);
    await h.hub.input(PIXEL, { kind: "tap", at: { x: 10, y: 20 } });
    await h.hub.input(PIXEL, { kind: "pinch", scale: 2 });
    await h.hub.input(PIXEL, { kind: "button", button: "back" });
    expect(android.input.mock.calls).toEqual([
      [PIXEL, { kind: "tap", at: { x: 10, y: 20 } }, ANDROID_SCREEN],
      [PIXEL, { kind: "pinch", scale: 2 }, ANDROID_SCREEN],
      [PIXEL, { kind: "button", button: "back" }, ANDROID_SCREEN],
    ]);
    expect(h.inputs).toEqual([]);

    android.input.mockRejectedValueOnce(new Error("UNAVAILABLE /Users/me"));
    await expect(h.hub.input(PIXEL, { kind: "tap", at: { x: 1, y: 1 } })).rejects.toThrow(
      /^That didn't reach Pixel 10\.$/,
    );
    android.input.mockRejectedValueOnce(new DeviceActionError("Pixel 10 isn't running."));
    await expect(h.hub.input(PIXEL, { kind: "tap", at: { x: 1, y: 1 } })).rejects.toThrow(
      /^Pixel 10 isn't running\.$/,
    );
  });

  it("streams the user's finger to Android devices through their emulators", async () => {
    android.states.set(PIXEL, "booted");
    await h.hub.refresh();
    const { viewId } = await h.hub.startView(PIXEL);
    const pinch = (phase: SimulatorTouch["phase"], reach: number): SimulatorTouch => ({
      phase,
      at: { x: 205 + reach, y: 461 },
      second: { x: 205 - reach, y: 461 },
    });
    await h.hub.touch(PIXEL, viewId, pinch("down", 20));
    await h.hub.touch(PIXEL, viewId, pinch("move", 30));
    await expect(h.hub.touch(PIXEL, viewId, pinch("up", 40))).resolves.toEqual({
      kind: "pinch",
      scale: 2,
    });
    expect(android.touch.mock.calls).toEqual([
      [PIXEL, pinch("down", 20)],
      [PIXEL, pinch("move", 30)],
      [PIXEL, pinch("up", 40)],
    ]);
    expect(android.input).not.toHaveBeenCalled();

    android.touch.mockRejectedValueOnce(new Error("UNAVAILABLE /Users/me"));
    await expect(
      h.hub.touch(PIXEL, viewId, { phase: "down", at: { x: 1, y: 1 } }),
    ).rejects.toThrow(/^That didn't reach Pixel 10\.$/);
  });

  it("rotates Android devices and changes their appearance", async () => {
    android.states.set(PIXEL, "booted");
    await h.hub.refresh();
    await h.hub.rotate(PIXEL, "landscape-left");
    await flush();
    expect(android.rotate).toHaveBeenCalledWith(PIXEL, "landscape-left");
    expect(device(h.latest(), PIXEL)?.orientation).toBe("landscape-left");
    android.rotate.mockRejectedValueOnce(new Error("grpc"));
    await expect(h.hub.rotate(PIXEL, "portrait")).rejects.toThrow(/^Couldn't rotate Pixel 10\.$/);

    await expect(h.hub.appearance(PIXEL)).resolves.toBe("dark");
    android.appearance.mockRejectedValueOnce(new Error("adb"));
    await expect(h.hub.appearance(PIXEL)).resolves.toBeNull();
    await h.hub.setAppearance(PIXEL, "light");
    expect(android.setAppearance).toHaveBeenCalledWith(PIXEL, "light");
    expect(h.simctl.setAppearance).not.toHaveBeenCalled();
    android.setAppearance.mockRejectedValueOnce(new Error("adb"));
    await expect(h.hub.setAppearance(PIXEL, "dark")).rejects.toThrow(
      "Couldn't change Pixel 10's appearance.",
    );
  });

  it("creates one Android device at a time and lists it before finishing", async () => {
    await h.hub.refresh();
    android.createGate = deferred();
    const first = h.hub.createAndroidDevice();
    const second = h.hub.createAndroidDevice();
    expect(second).toBe(first);
    await flush();
    expect(h.latest().setup[1]?.creating).toBe(true);
    android.createGate.resolve();
    await expect(first).resolves.toBe("Pixel_10_2");
    expect(android.createDevice).toHaveBeenCalledTimes(1);
    expect(device(h.hub.snapshot(), "Pixel_10_2")?.name).toBe("Pixel 10 (2)");
    await flush();
    expect(h.latest().setup[1]?.creating).toBe(false);

    const log = vi.fn();
    h = harness({ android, log });
    await h.hub.refresh();
    android.createDevice.mockRejectedValueOnce(new Error("avdmanager: /Users/me"));
    await expect(h.hub.createAndroidDevice()).rejects.toThrow(
      /^Couldn't create the Android device\.$/,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("android device creation failed"));
    expect(h.hub.snapshot().setup[1]?.creating).toBe(false);

    android.setup = { ...ANDROID_READY, newDevice: null };
    await h.hub.refresh();
    await expect(h.hub.createAndroidDevice()).rejects.toThrow("can't make an Android device");
    await expect(harness().hub.createAndroidDevice()).rejects.toThrow(
      "This build of Zeros can't make Android devices.",
    );
  });

  it("shuts down the Android devices it started when Zeros quits, and stops a boot", async () => {
    android.states.set(TABLET, "booted");
    await h.hub.refresh();
    await h.hub.boot(PIXEL);
    h.simctl.bootGate = deferred();
    const booting = h.hub.boot(PHONE);
    await flush();
    await h.hub.dispose();
    expect(android.shutdown.mock.calls).toEqual([[PIXEL]]);
    expect(h.simctl.shutdowns).toEqual([PHONE]);
    await expect(booting).resolves.toBe("cancelled");
    expect(android.dispose).toHaveBeenCalled();
  });
});
