import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (payload: unknown) => void) => Promise<() => void>>(),
  unlisten: vi.fn(),
  handler: null as ((payload: unknown) => void) | null,
}));

vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: native.invoke,
  nativeListen: native.listen,
}));

import {
  bootSimulator,
  dragSimulatorCapture,
  loadSimulatorAnnotationSnapshot,
  loadSimulatorCaptureFile,
  loadSimulatorDeviceShape,
  loadSimulatorRecordingTimeline,
  loadSimulatorRecordings,
  openSimulatorView,
  rotateSimulator,
  sendSimulatorInput,
  sendSimulatorTouch,
  startSimulatorRecording,
  startSimulatorView,
  stopSimulatorAgent,
  stopSimulatorRecording,
  takeSimulatorScreenshot,
  updateSimulatorPreferences,
} from "../simulator-api";

const PHONE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const TABLET = "3C744E00-0000-4000-8000-000000000000";
const SCREEN = { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 55 };

function frame(viewId: string, seq = 1) {
  return { viewId, seq, width: 590, height: 1278, jpeg: new Uint8Array([0xff, 0xd8]) };
}

/** Main answers view starts in order, sending each view's first frame before
 * its reply, as LiveViews does for a device that is already streaming. */
function serveViews() {
  let serial = 0;
  native.invoke.mockImplementation(async (command) => {
    if (command !== "simulator_view_start") return true;
    const viewId = `view-${++serial}`;
    native.handler?.(frame(viewId, 7));
    return { viewId, screen: SCREEN };
  });
}

beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockReset();
  native.unlisten.mockReset();
  native.handler = null;
  native.listen.mockImplementation(async (_event, handler) => {
    native.handler = handler;
    return native.unlisten;
  });
});

describe("simulator api", () => {
  it("delivers a view's frames from the first, even one that beat main's reply", async () => {
    serveViews();
    const onFrame = vi.fn();
    const view = await openSimulatorView(PHONE, onFrame);
    expect(view).toMatchObject({ viewId: "view-1", screen: SCREEN });
    expect(native.listen).toHaveBeenCalledWith("simulator-frame", expect.any(Function));
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ viewId: "view-1", seq: 7 }));

    native.handler?.(frame("view-1", 8));
    native.handler?.({ ...frame("view-1", 9), jpeg: "not bytes" });
    expect(onFrame.mock.calls.map(([value]) => value.seq)).toEqual([7, 8]);

    view.close();
    view.close();
    expect(native.invoke).toHaveBeenCalledWith("simulator_view_stop", { viewId: "view-1" });
    expect(native.invoke.mock.calls.filter(([command]) => command === "simulator_view_stop")).toHaveLength(1);
    await vi.waitFor(() => expect(native.unlisten).toHaveBeenCalledTimes(1));
  });

  it("fans one native subscription out by view and drops it with the last view", async () => {
    serveViews();
    const phone = vi.fn();
    const tablet = vi.fn();
    const first = await openSimulatorView(PHONE, phone);
    const second = await openSimulatorView(TABLET, tablet);
    expect(native.listen).toHaveBeenCalledTimes(1);

    native.handler?.(frame("view-2", 20));
    expect(tablet).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 20 }));
    expect(phone).toHaveBeenCalledTimes(1);

    first.close();
    native.handler?.(frame("view-1", 30));
    expect(phone).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(native.unlisten).not.toHaveBeenCalled();
    second.close();
    await vi.waitFor(() => expect(native.unlisten).toHaveBeenCalledTimes(1));
  });

  it("lets go of the subscription when a view can't start", async () => {
    native.invoke.mockRejectedValueOnce(new Error("iPhone 17 isn't running."));
    await expect(openSimulatorView(PHONE, vi.fn())).rejects.toThrow("iPhone 17 isn't running.");
    await vi.waitFor(() => expect(native.unlisten).toHaveBeenCalledTimes(1));
  });

  it("checks every reply before the tab sees it", async () => {
    native.invoke.mockResolvedValueOnce("maybe");
    await expect(bootSimulator(PHONE)).rejects.toThrow("Zeros couldn't read the simulators.");

    native.invoke.mockResolvedValueOnce({ viewId: "view-1", screen: { widthPx: 0 } });
    await expect(startSimulatorView(PHONE)).rejects.toThrow();

    native.invoke.mockResolvedValueOnce(null);
    await expect(loadSimulatorDeviceShape(PHONE)).resolves.toBeNull();
    native.invoke.mockResolvedValueOnce({ screen: SCREEN, frame: null });
    await expect(loadSimulatorDeviceShape(PHONE)).resolves.toEqual({ screen: SCREEN, frame: null });
    native.invoke.mockResolvedValueOnce({ screen: SCREEN, frame: { width: 10 } });
    await expect(loadSimulatorDeviceShape(PHONE)).resolves.toBeNull();
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_device_shape", { deviceId: PHONE });
  });

  it("sends the commands main registers, with plain arguments", async () => {
    native.invoke.mockResolvedValue(undefined);
    await sendSimulatorInput(PHONE, { kind: "tap", at: { x: 10, y: 20 } });
    await sendSimulatorTouch(PHONE, "view-1", { phase: "down", at: { x: 10, y: 20 } });
    await updateSimulatorPreferences({
      agentsEnabled: false,
      idleShutdown: "1h",
      showAgentTouches: true,
    });
    await rotateSimulator(PHONE, "landscape-left");
    expect(native.invoke.mock.calls).toEqual([
      ["simulator_input", { deviceId: PHONE, input: { kind: "tap", at: { x: 10, y: 20 } } }],
      [
        "simulator_touch",
        { deviceId: PHONE, viewId: "view-1", touch: { phase: "down", at: { x: 10, y: 20 } } },
      ],
      [
        "simulator_preferences_update",
        { agentsEnabled: false, idleShutdown: "1h", showAgentTouches: true },
      ],
      ["simulator_rotate", { deviceId: PHONE, orientation: "landscape-left" }],
    ]);
  });

  it("stops an agent on a device, and says whether one was using it", async () => {
    native.invoke.mockResolvedValueOnce(true);
    await expect(stopSimulatorAgent(PHONE)).resolves.toBe(true);
    native.invoke.mockResolvedValueOnce(false);
    await expect(stopSimulatorAgent(PHONE)).resolves.toBe(false);
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_agent_stop", { deviceId: PHONE });
  });
});

describe("simulator capture api", () => {
  const screenshot = {
    id: "capture-1",
    kind: "screenshot",
    deviceId: PHONE,
    deviceName: "iPhone 17",
    fileName: "Simulator Screenshot - iPhone 17.png",
    thumbnail: null,
  };
  const recording = {
    ...screenshot,
    id: "capture-2",
    kind: "recording",
    fileName: "Simulator Screen Recording - iPhone 17.mp4",
    durationMs: 4_000,
  };
  const unreadable = "Zeros couldn't read the capture.";

  it("accepts only a capture of the device and kind it asked for", async () => {
    native.invoke.mockResolvedValueOnce(screenshot);
    await expect(takeSimulatorScreenshot(PHONE)).resolves.toEqual(screenshot);
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_screenshot", { deviceId: PHONE });

    native.invoke.mockResolvedValueOnce({ ...screenshot, deviceId: TABLET });
    await expect(takeSimulatorScreenshot(PHONE)).rejects.toThrow(unreadable);
    native.invoke.mockResolvedValueOnce(recording);
    await expect(takeSimulatorScreenshot(PHONE)).rejects.toThrow(unreadable);
    native.invoke.mockResolvedValueOnce({ ...screenshot, fileName: "../../etc/passwd" });
    await expect(takeSimulatorScreenshot(PHONE)).rejects.toThrow(unreadable);

    native.invoke.mockResolvedValueOnce(recording);
    await expect(stopSimulatorRecording(PHONE)).resolves.toEqual(recording);
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_recording_stop", { deviceId: PHONE });
    native.invoke.mockResolvedValueOnce(screenshot);
    await expect(stopSimulatorRecording(PHONE)).rejects.toThrow(unreadable);
  });

  it("starts a recording of that device only", async () => {
    native.invoke.mockResolvedValueOnce({ deviceId: PHONE, startedAt: 1_000 });
    await expect(startSimulatorRecording(PHONE)).resolves.toEqual({
      deviceId: PHONE,
      startedAt: 1_000,
    });
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_recording_start", {
      deviceId: PHONE,
    });
    native.invoke.mockResolvedValueOnce({ deviceId: TABLET, startedAt: 1_000 });
    await expect(startSimulatorRecording(PHONE)).rejects.toThrow(unreadable);
  });

  it("reads which devices are recording", async () => {
    native.invoke.mockResolvedValueOnce({ version: 1, recordings: [] });
    await expect(loadSimulatorRecordings()).resolves.toEqual({ version: 1, recordings: [] });
    native.invoke.mockResolvedValueOnce({ version: 1 });
    await expect(loadSimulatorRecordings()).rejects.toThrow(unreadable);
  });

  it("asks for a capture's bytes and drag by its id alone", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    native.invoke.mockResolvedValueOnce({ fileName: screenshot.fileName, mimeType: "image/png", bytes });
    await expect(loadSimulatorCaptureFile("capture-1")).resolves.toEqual({
      fileName: screenshot.fileName,
      mimeType: "image/png",
      bytes,
    });
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_capture_file", {
      captureId: "capture-1",
    });
    native.invoke.mockResolvedValueOnce({ fileName: "a.png", mimeType: "text/html", bytes });
    await expect(loadSimulatorCaptureFile("capture-1")).rejects.toThrow(unreadable);

    native.invoke.mockResolvedValueOnce(true);
    await dragSimulatorCapture("capture-1");
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_capture_drag", {
      captureId: "capture-1",
    });
  });

  it("reads a recording's timeline, which may not exist", async () => {
    const fingerprint = "a".repeat(64);
    const timeline = {
      deviceName: "iPhone 17",
      osLabel: "iOS 26.0",
      actions: [{ atMs: 1_200, agent: null, text: 'tap Button "Sign in"' }],
    };
    native.invoke.mockResolvedValueOnce(timeline);
    await expect(loadSimulatorRecordingTimeline(fingerprint)).resolves.toEqual(timeline);
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_recording_timeline", { fingerprint });
    native.invoke.mockResolvedValueOnce(null);
    await expect(loadSimulatorRecordingTimeline(fingerprint)).resolves.toBeNull();
    native.invoke.mockResolvedValueOnce({ ...timeline, actions: "none" });
    await expect(loadSimulatorRecordingTimeline(fingerprint)).resolves.toBeNull();
  });

  it("checks Annotate's snapshot before using it", async () => {
    const snapshot = {
      png: new Uint8Array([0x89]),
      widthPx: 1206,
      heightPx: 2622,
      width: 402,
      height: 874,
      orientation: "portrait",
      deviceName: "iPhone 17",
      osLabel: "iOS 26.0",
      appName: null,
      appId: null,
      elements: [],
    };
    native.invoke.mockResolvedValueOnce(snapshot);
    await expect(loadSimulatorAnnotationSnapshot(PHONE)).resolves.toEqual(snapshot);
    expect(native.invoke).toHaveBeenLastCalledWith("simulator_annotation_snapshot", {
      deviceId: PHONE,
    });
    native.invoke.mockResolvedValueOnce({ ...snapshot, png: "not bytes" });
    await expect(loadSimulatorAnnotationSnapshot(PHONE)).rejects.toThrow(unreadable);
  });
});
