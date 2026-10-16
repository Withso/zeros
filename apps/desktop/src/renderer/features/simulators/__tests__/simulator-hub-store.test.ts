import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulatorHubSnapshot } from "@zeros/protocol/simulators";

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (payload: unknown) => void) => Promise<() => void>>(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: native.invoke,
  nativeListen: native.listen,
}));

import {
  acceptSimulatorHubSnapshot,
  followSimulatorHub,
  loadSimulatorHub,
  resetSimulatorHubForTests,
  SIMULATOR_HUB_FOLLOW_MS,
  simulatorDevice,
  simulatorHubState,
  simulatorSetup,
} from "../simulator-hub-store";

const PHONE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";

function snapshot(state: "shutdown" | "booted" = "shutdown"): SimulatorHubSnapshot {
  return {
    version: 1,
    devices: [
      {
        id: PHONE,
        platform: "ios",
        name: "iPhone 17",
        osLabel: "iOS 27.0",
        formFactor: "phone",
        state,
        bootedByZeros: state === "booted",
      },
    ],
    setup: [{ platform: "ios", state: "ready", toolLabel: "Xcode 27.0", download: null }],
    idleWarnings: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetSimulatorHubForTests();
  native.invoke.mockReset();
  native.listen.mockReset();
  native.handlers.clear();
  native.listen.mockImplementation(async (event, handler) => {
    native.handlers.set(event, handler);
    return () => native.handlers.delete(event);
  });
});

describe("simulator hub store", () => {
  it("shares one read between callers and listens once", async () => {
    const reply = deferred<unknown>();
    native.invoke.mockReturnValueOnce(reply.promise);
    const first = loadSimulatorHub();
    const second = loadSimulatorHub();
    expect(second).toBe(first);
    expect(simulatorHubState().loading).toBe(true);
    reply.resolve(snapshot());
    await first;
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("simulator_hub_state");
    expect(native.listen).toHaveBeenCalledTimes(1);
    expect(simulatorHubState()).toMatchObject({ loading: false, error: null });
    expect(simulatorDevice(simulatorHubState().snapshot, PHONE)?.name).toBe("iPhone 17");
    expect(simulatorSetup(simulatorHubState().snapshot, "ios")?.state).toBe("ready");
    expect(simulatorSetup(simulatorHubState().snapshot, "android")).toBeNull();
  });

  it("keeps a live snapshot that arrived while the read was in flight", async () => {
    const reply = deferred<unknown>();
    native.invoke.mockReturnValueOnce(reply.promise);
    const load = loadSimulatorHub();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());
    native.handlers.get("simulator-hub-state")?.(snapshot("booted"));
    reply.resolve(snapshot("shutdown"));
    await load;
    expect(simulatorDevice(simulatorHubState().snapshot, PHONE)?.state).toBe("booted");
  });

  it("ignores malformed snapshots from main", () => {
    expect(acceptSimulatorHubSnapshot(snapshot("booted"))).toBe(true);
    expect(acceptSimulatorHubSnapshot({ version: 2, devices: [], setup: [], idleWarnings: [] })).toBe(false);
    expect(
      acceptSimulatorHubSnapshot({
        ...snapshot(),
        devices: [{ ...snapshot().devices[0], id: "--help" }],
      }),
    ).toBe(false);
    expect(simulatorDevice(simulatorHubState().snapshot, PHONE)?.state).toBe("booted");
  });

  it("keeps the last snapshot and reports why a later read failed", async () => {
    acceptSimulatorHubSnapshot(snapshot("booted"));
    native.invoke.mockRejectedValueOnce(new Error("DeviceHub is busy."));
    await loadSimulatorHub();
    expect(simulatorHubState()).toMatchObject({ loading: false, error: "DeviceHub is busy." });
    expect(simulatorDevice(simulatorHubState().snapshot, PHONE)?.state).toBe("booted");
  });

  it("treats an unreadable reply as a failed read", async () => {
    native.invoke.mockResolvedValueOnce({ version: 1, devices: "all" });
    await loadSimulatorHub();
    expect(simulatorHubState()).toMatchObject({
      snapshot: null,
      error: "Zeros couldn't read the simulators.",
    });
  });
});

describe("following the hub", () => {
  const refreshes = () =>
    native.invoke.mock.calls.filter(([command]) => command === "simulator_hub_refresh").length;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    native.invoke.mockImplementation(async () => snapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-reads the hub on a timer, once however many tabs follow it, until all let go", async () => {
    const first = followSimulatorHub();
    const second = followSimulatorHub();
    // Nothing has read the hub yet: the first read is the tab's own.
    expect(refreshes()).toBe(0);
    await vi.advanceTimersByTimeAsync(SIMULATOR_HUB_FOLLOW_MS);
    expect(refreshes()).toBe(1);
    first();
    first();
    await vi.advanceTimersByTimeAsync(SIMULATOR_HUB_FOLLOW_MS);
    expect(refreshes()).toBe(2);
    second();
    await vi.advanceTimersByTimeAsync(SIMULATOR_HUB_FOLLOW_MS * 3);
    expect(refreshes()).toBe(2);
  });

  it("re-reads at once when the window comes back, such as from Xcode", async () => {
    const release = followSimulatorHub();
    window.dispatchEvent(new Event("focus"));
    expect(refreshes()).toBe(1);
    release();
    window.dispatchEvent(new Event("focus"));
    expect(refreshes()).toBe(1);
  });

  it("re-reads at once when a tab starts following a hub read earlier", async () => {
    await loadSimulatorHub();
    const release = followSimulatorHub();
    expect(refreshes()).toBe(1);
    release();
  });

  it("keeps following after a read fails", async () => {
    native.invoke.mockRejectedValue(new Error("DeviceHub is busy."));
    const release = followSimulatorHub();
    await vi.advanceTimersByTimeAsync(SIMULATOR_HUB_FOLLOW_MS * 2);
    expect(refreshes()).toBe(2);
    release();
  });
});
