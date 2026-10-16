import { describe, expect, it } from "vitest";

import {
  MAX_SIMULATOR_RECORDING_ACTIONS,
  MAX_SIMULATOR_UI_ELEMENTS,
  RECORDING_FINGERPRINT_CHUNK,
  formatRecordingClock,
  isRecordingFingerprint,
  isSimulatorCaptureId,
  readSimulatorAnnotationSnapshot,
  readSimulatorCapture,
  readSimulatorCaptureFile,
  readSimulatorRecording,
  readSimulatorRecordingEnd,
  readSimulatorRecordingTimeline,
  readSimulatorRecordings,
  recordingFingerprintHeader,
  recordingFingerprintRanges,
  simulatorCaptureStem,
  simulatorElementName,
  simulatorElementsAt,
  type SimulatorUiElement,
} from "../simulator-captures";

const DEVICE_ID = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";

const SCREENSHOT = {
  id: "capture-1",
  kind: "screenshot",
  deviceId: DEVICE_ID,
  deviceName: "iPhone 17",
  fileName: "Simulator Screenshot - iPhone 17 - 2025-10-12 at 14.03.22.png",
  thumbnail: "data:image/png;base64,iVBORw0KGgo=",
};

function element(
  type: string,
  label: string | null,
  frame: SimulatorUiElement["frame"],
): SimulatorUiElement {
  return { type, label, value: null, identifier: null, frame };
}

describe("simulator captures", () => {
  it("knows capture ids", () => {
    expect(isSimulatorCaptureId("capture-1")).toBe(true);
    expect(isSimulatorCaptureId("capture-123456789")).toBe(true);
    expect(isSimulatorCaptureId("capture-")).toBe(false);
    expect(isSimulatorCaptureId("capture-1/../2")).toBe(false);
    expect(isSimulatorCaptureId("view-1")).toBe(false);
    expect(isSimulatorCaptureId(1)).toBe(false);
  });

  it("reads screenshots and recordings", () => {
    expect(readSimulatorCapture(SCREENSHOT)).toEqual(SCREENSHOT);
    expect(
      readSimulatorCapture({
        ...SCREENSHOT,
        id: "capture-2",
        kind: "recording",
        fileName: "Simulator Screen Recording - iPhone 17 - 2025-10-12 at 14.03.22.mp4",
        thumbnail: null,
        durationMs: 12_400,
      }),
    ).toMatchObject({ kind: "recording", thumbnail: null, durationMs: 12_400 });
  });

  it("refuses a capture whose file name is a path", () => {
    for (const fileName of ["../shot.png", "a/b.png", "a\\b.png", ".hidden.png", "", ".."]) {
      expect(readSimulatorCapture({ ...SCREENSHOT, fileName })).toBeNull();
    }
  });

  it("refuses malformed captures", () => {
    expect(readSimulatorCapture({ ...SCREENSHOT, kind: "video" })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, deviceId: "../device" })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, deviceName: "" })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, thumbnail: "https://example.com/a.png" })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, thumbnail: "data:image/svg+xml;base64,AA==" })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, thumbnail: undefined })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, durationMs: -1 })).toBeNull();
    expect(readSimulatorCapture({ ...SCREENSHOT, durationMs: Number.NaN })).toBeNull();
    expect(readSimulatorCapture([SCREENSHOT])).toBeNull();
  });

  it("reads a capture's bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      readSimulatorCaptureFile({ fileName: SCREENSHOT.fileName, mimeType: "image/png", bytes }),
    ).toEqual({ fileName: SCREENSHOT.fileName, mimeType: "image/png", bytes });
    expect(
      readSimulatorCaptureFile({ fileName: "a.mp4", mimeType: "video/mp4", bytes }),
    ).not.toBeNull();
    expect(
      readSimulatorCaptureFile({ fileName: "a.png", mimeType: "image/png", bytes: new Uint8Array() }),
    ).toBeNull();
    expect(
      readSimulatorCaptureFile({ fileName: "a.gif", mimeType: "image/gif", bytes }),
    ).toBeNull();
    expect(
      readSimulatorCaptureFile({ fileName: "/tmp/a.png", mimeType: "image/png", bytes }),
    ).toBeNull();
    expect(
      readSimulatorCaptureFile({ fileName: "a.png", mimeType: "image/png", bytes: [1, 2, 3] }),
    ).toBeNull();
  });

  it("names captures the way Simulator does, in local time", () => {
    const at = new Date(2025, 9, 2, 4, 3, 2);
    expect(simulatorCaptureStem("Simulator Annotation", "iPhone 17", at)).toBe(
      "Simulator Annotation - iPhone 17 - 2025-10-02 at 04.03.02",
    );
    expect(simulatorCaptureStem("Simulator Annotation", "../My/Phone:\u0007 1", at)).toBe(
      "Simulator Annotation - -My-Phone- 1 - 2025-10-02 at 04.03.02",
    );
    expect(simulatorCaptureStem("Simulator Annotation", "   ", at)).toBe(
      "Simulator Annotation - Simulator - 2025-10-02 at 04.03.02",
    );
    expect(
      simulatorCaptureStem("Simulator Annotation", "x".repeat(200), at).split(" - ")[1],
    ).toHaveLength(80);
  });
});

describe("simulator recordings", () => {
  it("reads which devices are recording", () => {
    const snapshot = {
      version: 1,
      recordings: [{ deviceId: DEVICE_ID, startedAt: 1_700_000_000_000 }],
    };
    expect(readSimulatorRecordings(snapshot)).toEqual(snapshot);
    expect(readSimulatorRecordings({ ...snapshot, version: 2 })).toBeNull();
    expect(
      readSimulatorRecordings({ version: 1, recordings: [{ deviceId: DEVICE_ID }] }),
    ).toBeNull();
    expect(readSimulatorRecordings({ version: 1 })).toBeNull();
    expect(readSimulatorRecording({ deviceId: DEVICE_ID, startedAt: 5 })).toEqual({
      deviceId: DEVICE_ID,
      startedAt: 5,
    });
    expect(readSimulatorRecording({ deviceId: DEVICE_ID, startedAt: -1 })).toBeNull();
  });

  it("reads how a recording ended", () => {
    const capture = { ...SCREENSHOT, kind: "recording", fileName: "a.mp4", durationMs: 4_000 };
    expect(
      readSimulatorRecordingEnd({ deviceId: DEVICE_ID, reason: "limit", capture }),
    ).toMatchObject({
      deviceId: DEVICE_ID,
      reason: "limit",
      capture: { kind: "recording", durationMs: 4_000 },
    });
    expect(readSimulatorRecordingEnd({ deviceId: DEVICE_ID, capture })).toBeNull();
    expect(
      readSimulatorRecordingEnd({ deviceId: DEVICE_ID, reason: "stop", capture }),
    ).toBeNull();
    expect(
      readSimulatorRecordingEnd({
        deviceId: "3C744E00-0000-4000-8000-000000000000",
        reason: "device",
        capture,
      }),
    ).toBeNull();
    expect(
      readSimulatorRecordingEnd({
        deviceId: DEVICE_ID,
        reason: "exited",
        error: "Couldn't save the recording.",
      }),
    ).toEqual({ deviceId: DEVICE_ID, reason: "exited", error: "Couldn't save the recording." });
    expect(
      readSimulatorRecordingEnd({ deviceId: DEVICE_ID, reason: "exited", error: "" }),
    ).toBeNull();
    expect(readSimulatorRecordingEnd({ deviceId: DEVICE_ID, reason: "quit" })).toBeNull();
  });

  it("reads timelines", () => {
    const timeline = {
      deviceName: "iPhone 17",
      osLabel: "iOS 27.0",
      actions: [
        { atMs: 3_200, agent: null, text: 'tap Button "Sign in"' },
        { atMs: 5_000, agent: "Codex", text: 'type "hello"' },
      ],
    };
    expect(readSimulatorRecordingTimeline(timeline)).toEqual(timeline);
    expect(
      readSimulatorRecordingTimeline({
        ...timeline,
        actions: [{ atMs: -1, agent: null, text: "tap" }],
      }),
    ).toBeNull();
    expect(
      readSimulatorRecordingTimeline({
        ...timeline,
        actions: [{ atMs: 1, agent: "", text: "tap" }],
      }),
    ).toBeNull();
    expect(
      readSimulatorRecordingTimeline({
        ...timeline,
        actions: Array.from({ length: MAX_SIMULATOR_RECORDING_ACTIONS + 1 }, () => ({
          atMs: 1,
          agent: null,
          text: "tap",
        })),
      }),
    ).toBeNull();
  });

  it("formats moments in a video", () => {
    expect(formatRecordingClock(0)).toBe("00:00.0");
    expect(formatRecordingClock(3_200)).toBe("00:03.2");
    expect(formatRecordingClock(61_250)).toBe("01:01.3");
    expect(formatRecordingClock(59_999)).toBe("01:00.0");
    expect(formatRecordingClock(3_723_400)).toBe("1:02:03.4");
    expect(formatRecordingClock(-50)).toBe("00:00.0");
  });
});

describe("recording fingerprints", () => {
  const chunk = RECORDING_FINGERPRINT_CHUNK;

  it("hashes a short video whole", () => {
    expect(recordingFingerprintRanges(0)).toEqual([[0, 0]]);
    expect(recordingFingerprintRanges(100)).toEqual([[0, 100]]);
    expect(recordingFingerprintRanges(chunk)).toEqual([[0, chunk]]);
  });

  it("hashes a long video's first and last chunks without overlap", () => {
    expect(recordingFingerprintRanges(chunk + 10)).toEqual([
      [0, chunk],
      [chunk, chunk + 10],
    ]);
    expect(recordingFingerprintRanges(10 * chunk)).toEqual([
      [0, chunk],
      [9 * chunk, 10 * chunk],
    ]);
  });

  it("starts the hash with the size", () => {
    expect(recordingFingerprintHeader(5)).toBe("zeros-recording\n5\n");
  });

  it("knows fingerprints", () => {
    expect(isRecordingFingerprint("a".repeat(64))).toBe(true);
    expect(isRecordingFingerprint("A".repeat(64))).toBe(false);
    expect(isRecordingFingerprint("a".repeat(63))).toBe(false);
    expect(isRecordingFingerprint(`../${"a".repeat(61)}`)).toBe(false);
  });
});

describe("simulator UI elements", () => {
  const window = element("Window", null, { x: 0, y: 0, width: 402, height: 874 });
  const form = element("Group", "Sign in form", { x: 20, y: 300, width: 360, height: 200 });
  const button = element("Button", "Sign in", { x: 40, y: 420, width: 120, height: 44 });
  const elements = [window, button, form];

  it("finds the most specific elements under a point first", () => {
    expect(simulatorElementsAt(elements, { x: 60, y: 440 })).toEqual([button, form, window]);
    expect(simulatorElementsAt(elements, { x: 10, y: 10 })).toEqual([window]);
    expect(simulatorElementsAt(elements, { x: 500, y: 10 })).toEqual([]);
  });

  it("names elements by label, then value, then identifier", () => {
    expect(simulatorElementName(button)).toBe('Button "Sign in"');
    expect(simulatorElementName({ ...button, label: null, value: "On" })).toBe('Button "On"');
    expect(
      simulatorElementName({ ...button, label: null, identifier: "login.submit" }),
    ).toBe('Button "login.submit"');
    expect(simulatorElementName(window)).toBe("Window");
  });

  it("keeps element names short and on one line", () => {
    const name = simulatorElementName({ ...button, label: `Sign\n  in ${"x".repeat(200)}` });
    expect(name.startsWith('Button "Sign in x')).toBe(true);
    expect(name.endsWith('…"')).toBe(true);
    expect(name.length).toBeLessThanOrEqual('Button ""'.length + 80);
  });
});

describe("annotation snapshots", () => {
  const snapshot = {
    png: new Uint8Array([137, 80, 78, 71]),
    widthPx: 1206,
    heightPx: 2622,
    width: 402,
    height: 874,
    orientation: "portrait",
    deviceName: "iPhone 17",
    osLabel: "iOS 27.0",
    appName: "Safari",
    appId: "com.apple.mobilesafari",
    elements: [
      {
        type: "Button",
        label: "Sign in",
        value: null,
        identifier: null,
        frame: { x: 40, y: 420, width: 120, height: 44 },
      },
    ],
  };

  it("reads a frozen screen and its elements", () => {
    expect(readSimulatorAnnotationSnapshot(snapshot)).toEqual(snapshot);
    expect(
      readSimulatorAnnotationSnapshot({ ...snapshot, appName: null, appId: null, elements: [] }),
    ).toMatchObject({ appName: null, appId: null, elements: [] });
  });

  it("refuses malformed snapshots", () => {
    expect(readSimulatorAnnotationSnapshot({ ...snapshot, png: new Uint8Array() })).toBeNull();
    expect(readSimulatorAnnotationSnapshot({ ...snapshot, width: 0 })).toBeNull();
    expect(readSimulatorAnnotationSnapshot({ ...snapshot, orientation: "upside" })).toBeNull();
    expect(
      readSimulatorAnnotationSnapshot({
        ...snapshot,
        elements: [{ ...snapshot.elements[0], frame: { x: 0, y: 0, width: 0, height: 10 } }],
      }),
    ).toBeNull();
    expect(
      readSimulatorAnnotationSnapshot({
        ...snapshot,
        elements: [{ ...snapshot.elements[0], label: "" }],
      }),
    ).toBeNull();
    expect(
      readSimulatorAnnotationSnapshot({
        ...snapshot,
        elements: Array.from({ length: MAX_SIMULATOR_UI_ELEMENTS + 1 }, () => snapshot.elements[0]),
      }),
    ).toBeNull();
  });
});
