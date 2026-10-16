import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulatorCapture } from "@zeros/protocol/simulator-captures";

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (payload: unknown) => void) => Promise<() => void>>(),
  unlisten: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: native.invoke,
  nativeListen: native.listen,
}));

import {
  CAPTURE_THUMBNAIL_LINGER_MS,
  CAPTURE_THUMBNAIL_MS,
  CaptureThumbnails,
  MAX_CAPTURE_THUMBNAILS,
  acceptSimulatorRecordings,
  flashSimulatorScreen,
  followSimulatorCaptures,
  listenToSimulatorFlashes,
  resetSimulatorCapturesForTests,
  simulatorRecordingStartedAt,
  type CaptureThumbnailTimers,
} from "../simulator-capture-store";

const PHONE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const TABLET = "3C744E00-1A2B-4C3D-8E9F-001122334455";

function capture(id: number, kind: SimulatorCapture["kind"] = "screenshot"): SimulatorCapture {
  return {
    id: `capture-${id}`,
    kind,
    deviceId: PHONE,
    deviceName: "iPhone 17 Pro",
    fileName: `Simulator Screenshot ${id}.png`,
    thumbnail: null,
    ...(kind === "recording" ? { durationMs: 12_000 } : {}),
  };
}

/** Timers that run only when the test moves the clock. */
function manualTimers() {
  let now = 0;
  let serial = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: CaptureThumbnailTimers = {
    now: () => now,
    set: (run, ms) => {
      serial += 1;
      pending.set(serial, { at: now + ms, run });
      return serial;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending]
          .filter(([, timer]) => timer.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
    pending: () => pending.size,
  };
}

const ids = (thumbnails: CaptureThumbnails) => thumbnails.current().map((entry) => entry.id);

beforeEach(() => {
  resetSimulatorCapturesForTests();
  native.invoke.mockReset();
  native.listen.mockReset();
  native.unlisten.mockReset();
  native.handlers.clear();
  native.listen.mockImplementation(async (event, handler) => {
    native.handlers.set(event, handler);
    return native.unlisten;
  });
});

describe("capture thumbnails", () => {
  it("shows the newest first and lets each go after a few seconds", () => {
    const clock = manualTimers();
    const thumbnails = new CaptureThumbnails(clock.timers);
    const changed = vi.fn();
    thumbnails.subscribe(changed);

    thumbnails.show(capture(1));
    clock.advance(2_000);
    thumbnails.show(capture(2));
    expect(ids(thumbnails)).toEqual(["capture-2", "capture-1"]);

    clock.advance(CAPTURE_THUMBNAIL_MS - 2_000);
    expect(ids(thumbnails)).toEqual(["capture-2"]);
    clock.advance(2_000);
    expect(ids(thumbnails)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(4);
    expect(clock.pending()).toBe(0);
  });

  it("keeps the newest few, and brings one shown again to the front with a fresh countdown", () => {
    const clock = manualTimers();
    const thumbnails = new CaptureThumbnails(clock.timers);
    for (let id = 1; id <= MAX_CAPTURE_THUMBNAILS + 1; id += 1) thumbnails.show(capture(id));
    expect(ids(thumbnails)).toEqual(["capture-4", "capture-3", "capture-2"]);
    expect(clock.pending()).toBe(MAX_CAPTURE_THUMBNAILS);

    clock.advance(4_000);
    thumbnails.show(capture(2));
    expect(ids(thumbnails)).toEqual(["capture-2", "capture-4", "capture-3"]);
    clock.advance(1_000);
    expect(ids(thumbnails)).toEqual(["capture-2"]);
    clock.advance(CAPTURE_THUMBNAIL_MS);
    expect(ids(thumbnails)).toEqual([]);
  });

  it("closes one at a time and ignores captures it isn't showing", () => {
    const clock = manualTimers();
    const thumbnails = new CaptureThumbnails(clock.timers);
    const changed = vi.fn();
    thumbnails.subscribe(changed);
    thumbnails.show(capture(1));
    thumbnails.show(capture(2));
    thumbnails.dismiss("capture-1");
    thumbnails.dismiss("capture-9");
    expect(ids(thumbnails)).toEqual(["capture-2"]);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(1);
  });

  it("waits while held, then lingers at least a moment after the last hold lets go", () => {
    const clock = manualTimers();
    const thumbnails = new CaptureThumbnails(clock.timers);
    thumbnails.show(capture(1));
    clock.advance(1_000);
    thumbnails.show(capture(2));
    clock.advance(3_500);

    const pointer = thumbnails.hold();
    const focus = thumbnails.hold();
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    expect(ids(thumbnails)).toEqual(["capture-2", "capture-1"]);

    // One shown while held waits its whole time once released.
    thumbnails.show(capture(3));
    pointer();
    pointer();
    clock.advance(60_000);
    expect(ids(thumbnails)).toHaveLength(3);

    focus();
    // capture-1 had 500ms left and capture-2 1.5s; both linger 1.5s.
    clock.advance(CAPTURE_THUMBNAIL_LINGER_MS - 1);
    expect(ids(thumbnails)).toEqual(["capture-3", "capture-2", "capture-1"]);
    clock.advance(1);
    expect(ids(thumbnails)).toEqual(["capture-3"]);
    clock.advance(CAPTURE_THUMBNAIL_MS - CAPTURE_THUMBNAIL_LINGER_MS);
    expect(ids(thumbnails)).toEqual([]);
  });

  it("clears every thumbnail and hold at once", () => {
    const clock = manualTimers();
    const thumbnails = new CaptureThumbnails(clock.timers);
    thumbnails.show(capture(1));
    const release = thumbnails.hold();
    thumbnails.clear();
    expect(ids(thumbnails)).toEqual([]);
    expect(clock.pending()).toBe(0);
    release();

    thumbnails.show(capture(2));
    clock.advance(CAPTURE_THUMBNAIL_MS);
    expect(ids(thumbnails)).toEqual([]);
  });
});

describe("simulator recordings", () => {
  it("mirrors main's snapshot and ignores a malformed one", () => {
    expect(acceptSimulatorRecordings({ version: 1, recordings: [{ deviceId: PHONE, startedAt: 5 }] }))
      .toBe(true);
    expect(simulatorRecordingStartedAt(PHONE)).toBe(5);
    expect(simulatorRecordingStartedAt(TABLET)).toBeNull();

    expect(acceptSimulatorRecordings({ version: 1, recordings: [{ deviceId: "--all" }] })).toBe(
      false,
    );
    expect(acceptSimulatorRecordings({ version: 2, recordings: [] })).toBe(false);
    expect(simulatorRecordingStartedAt(PHONE)).toBe(5);
  });

  it("follows main's recordings and hands on the ends the tab didn't stop", async () => {
    native.invoke.mockResolvedValue({
      version: 1,
      recordings: [{ deviceId: PHONE, startedAt: 1_000 }],
    });
    const onEnd = vi.fn();
    const stop = followSimulatorCaptures(onEnd);
    await vi.waitFor(() => expect(simulatorRecordingStartedAt(PHONE)).toBe(1_000));
    expect(native.invoke).toHaveBeenCalledWith("simulator_recordings");

    native.handlers.get("simulator-recordings")!({ version: 1, recordings: [] });
    expect(simulatorRecordingStartedAt(PHONE)).toBeNull();

    const end = { deviceId: PHONE, reason: "limit", capture: capture(3, "recording") };
    native.handlers.get("simulator-recording-end")!(end);
    native.handlers.get("simulator-recording-end")!({ deviceId: PHONE, reason: "stop" });
    native.handlers.get("simulator-recording-end")!({
      deviceId: TABLET,
      reason: "device",
      capture: capture(4, "recording"),
    });
    expect(onEnd.mock.calls).toEqual([[end]]);

    stop();
    expect(native.unlisten).toHaveBeenCalledTimes(2);
    native.handlers.get("simulator-recording-end")!(end);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps a live snapshot that beat the first read's reply", async () => {
    let reply: (value: unknown) => void = () => {};
    native.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    followSimulatorCaptures(vi.fn());
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());

    native.handlers.get("simulator-recordings")!({
      version: 1,
      recordings: [{ deviceId: PHONE, startedAt: 2_000 }],
    });
    reply({ version: 1, recordings: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(simulatorRecordingStartedAt(PHONE)).toBe(2_000);
  });

  it("lets go of listeners that arrive after it stopped, and reads nothing", async () => {
    const arrivals: Array<() => void> = [];
    native.listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          arrivals.push(() => resolve(native.unlisten));
        }),
    );
    const stop = followSimulatorCaptures(vi.fn());
    stop();
    for (const arrive of arrivals) arrive();
    await vi.waitFor(() => expect(native.unlisten).toHaveBeenCalledTimes(2));
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe("screenshot flashes", () => {
  it("flashes only the screens showing that device", () => {
    const phone = vi.fn();
    const otherPhone = vi.fn();
    const tablet = vi.fn();
    const stopPhone = listenToSimulatorFlashes(PHONE, phone);
    listenToSimulatorFlashes(PHONE, otherPhone);
    listenToSimulatorFlashes(TABLET, tablet);

    flashSimulatorScreen(PHONE);
    expect(phone).toHaveBeenCalledTimes(1);
    expect(otherPhone).toHaveBeenCalledTimes(1);
    expect(tablet).not.toHaveBeenCalled();

    stopPhone();
    flashSimulatorScreen(PHONE);
    expect(phone).toHaveBeenCalledTimes(1);
    expect(otherPhone).toHaveBeenCalledTimes(2);
  });
});
