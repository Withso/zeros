import { describe, expect, it } from "vitest";
import type { SimulatorDevice, SimulatorSetupStatus } from "@zeros/protocol/simulators";

import {
  simulatorDeviceStatusLabel,
  simulatorNewDeviceItem,
  simulatorSetupRow,
} from "../simulator-setup-model";

function setup(
  state: SimulatorSetupStatus["state"],
  download: SimulatorSetupStatus["download"] = null,
): SimulatorSetupStatus {
  return { platform: "ios", state, toolLabel: "Xcode 26.0", download };
}

describe("simulator setup row", () => {
  it("says what's ready, with the Xcode version beside it", () => {
    expect(simulatorSetupRow(setup("ready"), "ios", 3)).toEqual({
      tone: "ready",
      message: "Xcode and Simulator installed",
      detail: "Xcode 26.0",
      action: null,
      checkAgain: false,
    });
  });

  it("points to Xcode when it's missing", () => {
    expect(simulatorSetupRow(setup("tools-missing"), "ios", 0)).toMatchObject({
      tone: "warning",
      message: "Xcode isn't installed",
      action: { kind: "get-xcode", label: "Get Xcode" },
      checkAgain: true,
    });
  });

  it("offers the iOS runtime, its progress and a way to stop it", () => {
    expect(simulatorSetupRow(setup("runtime-missing"), "ios", 0)).toMatchObject({
      tone: "warning",
      action: { kind: "install-runtime", label: "Install iOS runtime" },
      checkAgain: true,
    });
    expect(
      simulatorSetupRow(
        setup("runtime-missing", { state: "downloading", progress: 0.426 }),
        "ios",
        0,
      ),
    ).toMatchObject({
      tone: "pending",
      message: "Downloading the iOS runtime…",
      progress: 43,
      action: { kind: "cancel-download", label: "Cancel" },
      checkAgain: false,
    });
    expect(
      simulatorSetupRow(
        setup("runtime-missing", { state: "downloading", progress: null }),
        "ios",
        0,
      ).progress,
    ).toBeNull();
    expect(
      simulatorSetupRow(setup("runtime-missing", { state: "failed", progress: 0.2 }), "ios", 0),
    ).toMatchObject({
      tone: "error",
      action: { kind: "install-runtime", label: "Try again" },
      checkAgain: true,
    });
  });

  it("asks for a simulator when Xcode has none", () => {
    expect(simulatorSetupRow(setup("ready"), "ios", 0)).toMatchObject({
      tone: "warning",
      message: "No iOS simulators yet",
      checkAgain: true,
    });
  });

  it("stays quiet while checking and says plainly when simulators can't run", () => {
    expect(simulatorSetupRow(setup("checking"), "ios", 0)).toMatchObject({
      tone: "pending",
      action: null,
      checkAgain: false,
    });
    expect(simulatorSetupRow(setup("unsupported"), "ios", 0)).toMatchObject({
      tone: "error",
      action: null,
      checkAgain: false,
    });
    expect(simulatorSetupRow(null, "android", 0)).toMatchObject({
      tone: "error",
      message: "Android Simulator isn't available in this version of Zeros.",
    });
  });
});

describe("Android setup row", () => {
  function android(
    state: SimulatorSetupStatus["state"],
    extra: Partial<SimulatorSetupStatus> = {},
  ): SimulatorSetupStatus {
    return {
      platform: "android",
      state,
      toolLabel: "Android Emulator 36.1.9",
      download: null,
      newDevice: "Pixel 10 with Android 17",
      creating: false,
      studioInstalled: true,
      ...extra,
    };
  }

  it("points to Android Studio when there's no emulator", () => {
    expect(
      simulatorSetupRow(android("tools-missing", { studioInstalled: false }), "android", 0),
    ).toMatchObject({
      tone: "warning",
      message: "Android Studio isn't installed",
      action: { kind: "get-android-studio", label: "Get Android Studio" },
      checkAgain: true,
    });
    expect(simulatorSetupRow(android("tools-missing"), "android", 0)).toMatchObject({
      tone: "warning",
      message: "The Android Emulator isn't installed",
      action: { kind: "open-android-studio", label: "Open Android Studio" },
      checkAgain: true,
    });
  });

  it("sends a missing system image to Android Studio, which downloads them", () => {
    expect(simulatorSetupRow(android("runtime-missing"), "android", 0)).toMatchObject({
      tone: "warning",
      message: "No Android system image yet",
      action: { kind: "open-android-studio", label: "Open Android Studio" },
      checkAgain: true,
    });
    expect(
      simulatorSetupRow(android("runtime-missing", { studioInstalled: false }), "android", 0)
        .action,
    ).toEqual({ kind: "get-android-studio", label: "Get Android Studio" });
  });

  it("offers to create the device it names, and shows that it's working", () => {
    expect(simulatorSetupRow(android("ready"), "android", 0)).toEqual({
      tone: "warning",
      message: "No Android simulators yet",
      detail: "Create a Pixel 10 with Android 17, or add one in Android Studio's Device Manager.",
      action: { kind: "create-android-device", label: "Create device" },
      checkAgain: true,
    });
    expect(
      simulatorSetupRow(android("ready", { studioInstalled: false }), "android", 0).detail,
    ).toBe("Create a Pixel 10 with Android 17.");
    expect(simulatorSetupRow(android("ready", { creating: true }), "android", 0)).toEqual({
      tone: "pending",
      message: "Creating Pixel 10 with Android 17…",
      action: null,
      checkAgain: false,
    });
  });

  it("falls back to Android Studio when Zeros can't make a device", () => {
    expect(simulatorSetupRow(android("ready", { newDevice: null }), "android", 0)).toMatchObject({
      tone: "warning",
      message: "No Android simulators yet",
      detail: "Add one in Android Studio's Device Manager.",
      action: { kind: "open-android-studio", label: "Open Android Studio" },
      checkAgain: true,
    });
    expect(
      simulatorSetupRow(
        android("ready", { newDevice: null, studioInstalled: false }),
        "android",
        0,
      ).action,
    ).toBeNull();
  });

  it("says what's ready once there's a device", () => {
    expect(simulatorSetupRow(android("ready", { creating: true }), "android", 1)).toEqual({
      tone: "ready",
      message: "Android Emulator installed",
      detail: "Android Emulator 36.1.9",
      action: null,
      checkAgain: false,
    });
  });

  it("lets the device picker make another device once there is one", () => {
    expect(simulatorNewDeviceItem(android("ready"), "android")).toEqual({
      label: "New Pixel 10 with Android 17",
      creating: false,
    });
    expect(simulatorNewDeviceItem(android("ready", { creating: true }), "android")).toEqual({
      label: "Creating Pixel 10 with Android 17…",
      creating: true,
    });
    expect(simulatorNewDeviceItem(android("ready", { newDevice: null }), "android")).toBeNull();
    expect(simulatorNewDeviceItem(android("runtime-missing"), "android")).toBeNull();
    expect(simulatorNewDeviceItem(android("ready"), "ios")).toBeNull();
    expect(simulatorNewDeviceItem(null, "android")).toBeNull();
  });
});

describe("device status label", () => {
  const device = (state: SimulatorDevice["state"]): SimulatorDevice => ({
    id: "iphone",
    platform: "ios",
    name: "iPhone 17",
    osLabel: "iOS 26.0",
    formFactor: "phone",
    state,
    bootedByZeros: false,
  });

  it("shows the OS, or what the device is doing", () => {
    expect(simulatorDeviceStatusLabel(device("booted"))).toBe("iOS 26.0");
    expect(simulatorDeviceStatusLabel(device("shutdown"))).toBe("iOS 26.0");
    expect(simulatorDeviceStatusLabel(device("booting"))).toBe("Starting…");
    expect(simulatorDeviceStatusLabel(device("shutting-down"))).toBe("Shutting down…");
  });
});
