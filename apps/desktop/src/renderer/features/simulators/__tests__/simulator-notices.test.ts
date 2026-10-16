import { describe, expect, it, vi } from "vitest";
import type { SimulatorHubSnapshot } from "@zeros/protocol/simulators";

import {
  SimulatorIdleNoticeSync,
  simulatorBootWarningNotice,
  simulatorErrorMessage,
  simulatorIdleNotices,
  simulatorRecordingEndNotice,
} from "../simulator-notices";

const PHONE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const TABLET = "3C744E00-1A2B-4C3D-8E9F-001122334455";

function hub(warnings: Array<{ deviceId: string; shutdownAt: number }>): SimulatorHubSnapshot {
  return {
    version: 1,
    devices: [
      {
        id: PHONE,
        platform: "ios",
        name: "iPhone 17",
        osLabel: "iOS 27.0",
        formFactor: "phone",
        state: "booted",
        bootedByZeros: true,
      },
    ],
    setup: [],
    idleWarnings: warnings,
  };
}

function toasts() {
  return { show: vi.fn(), dismiss: vi.fn() };
}

describe("simulator idle toasts", () => {
  it("names the device, falling back when the list no longer has it", () => {
    const notices = simulatorIdleNotices(
      hub([
        { deviceId: PHONE, shutdownAt: 61_000 },
        { deviceId: TABLET, shutdownAt: 70_000 },
      ]),
    );
    expect(notices.map((notice) => notice.title)).toEqual([
      "iPhone 17 shuts down in a minute",
      "A simulator shuts down in a minute",
    ]);
    expect(simulatorIdleNotices(null)).toEqual([]);
  });

  it("shows one toast per warning until its deadline and replaces it when the deadline moves", () => {
    const port = toasts();
    const sync = new SimulatorIdleNoticeSync(port, () => 1_000);
    sync.sync(hub([{ deviceId: PHONE, shutdownAt: 61_000 }]));
    expect(port.show).toHaveBeenCalledTimes(1);
    expect(port.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceId: PHONE, shutdownAt: 61_000 }),
      60_000,
    );

    sync.sync(hub([{ deviceId: PHONE, shutdownAt: 61_000 }]));
    expect(port.show).toHaveBeenCalledTimes(1);

    sync.sync(hub([{ deviceId: PHONE, shutdownAt: 91_000 }]));
    expect(port.show).toHaveBeenCalledTimes(2);
    expect(port.dismiss).not.toHaveBeenCalled();
  });

  it("dismisses a toast once its warning clears, and every toast on dispose", () => {
    const port = toasts();
    const sync = new SimulatorIdleNoticeSync(port, () => 1_000);
    sync.sync(
      hub([
        { deviceId: PHONE, shutdownAt: 61_000 },
        { deviceId: TABLET, shutdownAt: 61_000 },
      ]),
    );
    sync.sync(hub([{ deviceId: TABLET, shutdownAt: 61_000 }]));
    expect(port.dismiss).toHaveBeenCalledWith(PHONE);
    expect(port.dismiss).toHaveBeenCalledTimes(1);

    sync.dispose();
    expect(port.dismiss).toHaveBeenLastCalledWith(TABLET);
    sync.sync(null);
    expect(port.dismiss).toHaveBeenCalledTimes(2);
  });

  it("keeps a past deadline visible briefly instead of passing a negative duration", () => {
    const port = toasts();
    new SimulatorIdleNoticeSync(port, () => 90_000).sync(
      hub([{ deviceId: PHONE, shutdownAt: 61_000 }]),
    );
    expect(port.show).toHaveBeenCalledWith(expect.anything(), 1_000);
  });
});

describe("simulator boot warnings", () => {
  const device = { name: "iPad mini (A17 Pro)" };

  it("says nothing without a warning", () => {
    expect(simulatorBootWarningNotice(device, [])).toBeNull();
  });

  it("puts low memory first and folds in the device count", () => {
    expect(simulatorBootWarningNotice(device, ["low-memory"])).toEqual({
      title: "Your Mac is low on memory",
      description:
        "iPad mini (A17 Pro) may run slowly. Quit apps or shut down simulators you aren't using.",
    });
    expect(simulatorBootWarningNotice(device, ["many-devices", "low-memory"])?.description).toBe(
      "iPad mini (A17 Pro) may run slowly. Each running simulator uses about 1 to 3 GB, so shut down any you aren't using.",
    );
  });

  it("warns about a third running device", () => {
    expect(simulatorBootWarningNotice(device, ["many-devices"])).toEqual({
      title: "Several simulators are running",
      description: "Each one uses about 1 to 3 GB of memory. Shut down any you aren't using.",
    });
  });

  it("keeps the host's own sentence for errors", () => {
    expect(simulatorErrorMessage(new Error(""), "Couldn't start the simulator.")).toBe(
      "Couldn't start the simulator.",
    );
    expect(simulatorErrorMessage(new Error("Couldn't start iPhone 17."), "fallback")).toBe(
      "Couldn't start iPhone 17.",
    );
    expect(simulatorErrorMessage("boom", "Couldn't start the simulator.")).toBe(
      "Couldn't start the simulator.",
    );
  });
});

describe("simulator recording ends", () => {
  const capture = {
    id: "capture-4",
    kind: "recording",
    deviceId: PHONE,
    deviceName: "iPhone 17",
    fileName: "Simulator Screen Recording - iPhone 17.mp4",
    thumbnail: null,
    durationMs: 3_600_000,
  } as const;

  it("says why a recording ended and where its video is", () => {
    expect(simulatorRecordingEndNotice({ deviceId: PHONE, reason: "limit", capture })).toEqual({
      tone: "info",
      title: "Recording of iPhone 17 stopped after an hour",
      description: "Recordings stop at an hour. The video is in Downloads.",
    });
    expect(simulatorRecordingEndNotice({ deviceId: PHONE, reason: "device", capture })).toEqual({
      tone: "info",
      title: "iPhone 17 stopped, so its recording ended",
      description: "The video is in Downloads.",
    });
    expect(simulatorRecordingEndNotice({ deviceId: PHONE, reason: "exited", capture })).toEqual({
      tone: "info",
      title: "Recording of iPhone 17 ended",
      description: "The video is in Downloads.",
    });
  });

  it("keeps main's sentence when the video couldn't be saved", () => {
    expect(
      simulatorRecordingEndNotice({
        deviceId: PHONE,
        reason: "device",
        error: "Couldn't save the recording of iPhone 17.",
      }),
    ).toEqual({ tone: "error", title: "Couldn't save the recording of iPhone 17.", description: "" });
  });

  it("says nothing as Zeros quits", () => {
    expect(simulatorRecordingEndNotice({ deviceId: PHONE, reason: "quit", capture })).toBeNull();
    expect(
      simulatorRecordingEndNotice({ deviceId: PHONE, reason: "quit", error: "Recorder failed." }),
    ).toBeNull();
  });
});
