import { describe, expect, it, vi } from "vitest";

import {
  SIMULATOR_COMMAND_NAMES,
  simulatorCommands,
  type SimulatorCommandCaptures,
  type SimulatorCommandDeviceUse,
  type SimulatorCommandHub,
} from "../simulators";

const PHONE = "11111111-1111-4111-8111-111111111111";
type Event = Parameters<ReturnType<typeof simulatorCommands>["simulator_boot"]>[1];
const trusted = { trusted: true } as unknown as Event;
const stranger = { trusted: false } as unknown as Event;
const HOLDERS = {
  version: 1,
  holders: [
    {
      workspaceId: "ws_1",
      conversationId: "conv_a",
      agent: "codex",
      deviceId: PHONE,
      deviceName: "iPhone 17",
      platform: "ios",
    },
  ],
};

function fakeHub(): { [K in keyof SimulatorCommandHub]: ReturnType<typeof vi.fn> } {
  return {
    state: vi.fn(() => ({ version: 1, devices: [], setup: [], idleWarnings: [] })),
    refresh: vi.fn(async () => ({ version: 1, devices: [], setup: [], idleWarnings: [] })),
    bootWarnings: vi.fn(async () => ["many-devices"]),
    boot: vi.fn(async () => "booted"),
    cancelBoot: vi.fn(() => true),
    shutdown: vi.fn(async () => undefined),
    startView: vi.fn(async () => ({ viewId: "view-1", screen: {} })),
    stopView: vi.fn(() => true),
    input: vi.fn(async () => undefined),
    touch: vi.fn(async () => null),
    appearance: vi.fn(async () => "dark"),
    setAppearance: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
    keepRunning: vi.fn(async () => undefined),
    installRuntime: vi.fn(() => true),
    cancelRuntimeInstall: vi.fn(() => false),
    createAndroidDevice: vi.fn(async () => "Pixel_10"),
    setPreferences: vi.fn(),
    deviceShape: vi.fn(async () => null),
  };
}

function fakeDeviceUse(): {
  [K in keyof SimulatorCommandDeviceUse]: ReturnType<typeof vi.fn>;
} {
  return { state: vi.fn(() => HOLDERS), stopFromUser: vi.fn(() => true) };
}

const CAPTURE = {
  id: "capture-1",
  kind: "screenshot",
  deviceId: PHONE,
  deviceName: "iPhone 17",
  fileName: "Simulator Screenshot - iPhone 17 - 2025-10-12 at 14.03.22.png",
  thumbnail: null,
};
const SAVED = { capture: CAPTURE, path: `/Users/me/Downloads/${CAPTURE.fileName}` };
const FINGERPRINT = "a".repeat(64);

function fakeCaptures(): { [K in keyof SimulatorCommandCaptures]: ReturnType<typeof vi.fn> } {
  return {
    screenshot: vi.fn(async () => CAPTURE),
    recordings: vi.fn(() => ({ version: 1, recordings: [] })),
    startRecording: vi.fn(async () => ({ deviceId: PHONE, startedAt: 5 })),
    stopRecording: vi.fn(async () => ({ ...CAPTURE, kind: "recording", durationMs: 10 })),
    noteAction: vi.fn(),
    savedFile: vi.fn(async () => SAVED),
    file: vi.fn(async () => ({ fileName: CAPTURE.fileName, mimeType: "image/png", bytes: new Uint8Array([1]) })),
    timeline: vi.fn(async () => null),
    annotationSnapshot: vi.fn(async () => ({ deviceName: "iPhone 17" })),
  };
}

function commands(options: { withDeviceUse?: boolean } = {}) {
  const hub = fakeHub();
  const deviceUse = options.withDeviceUse === false ? null : fakeDeviceUse();
  const captures = fakeCaptures();
  const startDrag = vi.fn();
  const openAndroidStudio = vi.fn(async () => true);
  const trust = vi.fn((event: Event) => {
    if (!(event as unknown as { trusted: boolean }).trusted) {
      throw new Error("Browser surface command rejected.");
    }
  });
  return {
    hub,
    deviceUse,
    captures,
    startDrag,
    openAndroidStudio,
    trust,
    run: simulatorCommands({
      hub: hub as unknown as SimulatorCommandHub,
      deviceUse: deviceUse as unknown as SimulatorCommandDeviceUse | null,
      captures: captures as unknown as SimulatorCommandCaptures,
      startDrag,
      openAndroidStudio,
      trust,
    }),
  };
}

describe("simulator commands", () => {
  it("answer only the app window's own page", async () => {
    const { run, hub } = commands();
    for (const name of SIMULATOR_COMMAND_NAMES) {
      expect(() => run[name]({ deviceId: PHONE }, stranger)).toThrow("rejected");
    }
    expect(hub.boot).not.toHaveBeenCalled();
    expect(hub.state).not.toHaveBeenCalled();
  });

  it("pass valid requests through to DeviceHub", async () => {
    const { run, hub, openAndroidStudio } = commands();
    expect(run.simulator_hub_state({}, trusted)).toMatchObject({ version: 1 });
    await expect(run.simulator_boot_warnings({ deviceId: PHONE }, trusted)).resolves.toEqual([
      "many-devices",
    ]);
    await expect(run.simulator_boot({ deviceId: PHONE }, trusted)).resolves.toBe("booted");
    expect(run.simulator_boot_cancel({ deviceId: PHONE }, trusted)).toBe(true);
    await expect(run.simulator_shutdown({ deviceId: PHONE }, trusted)).resolves.toBe(true);
    await expect(run.simulator_view_start({ deviceId: PHONE }, trusted)).resolves.toMatchObject({
      viewId: "view-1",
    });
    expect(run.simulator_view_stop({ viewId: "view-1" }, trusted)).toBe(true);
    await expect(
      run.simulator_input({ deviceId: PHONE, input: { kind: "tap", at: { x: 10.04, y: 20 } } }, trusted),
    ).resolves.toBe(true);
    expect(hub.input).toHaveBeenCalledWith(PHONE, { kind: "tap", at: { x: 10, y: 20 } });
    await expect(run.simulator_appearance({ deviceId: PHONE }, trusted)).resolves.toBe("dark");
    await expect(
      run.simulator_appearance_set({ deviceId: PHONE, appearance: "light" }, trusted),
    ).resolves.toBe(true);
    await expect(run.simulator_keep_running({ deviceId: PHONE }, trusted)).resolves.toBe(true);
    expect(run.simulator_runtime_install({}, trusted)).toBe(true);
    expect(run.simulator_runtime_install_cancel({}, trusted)).toBe(false);
    await expect(run.simulator_android_device_create({}, trusted)).resolves.toBe("Pixel_10");
    await expect(
      run.simulator_android_studio_open({ path: "/Applications/Calculator.app" }, trusted),
    ).resolves.toBe(true);
    expect(openAndroidStudio).toHaveBeenCalledWith();
    expect(
      run.simulator_preferences_update(
        { agentsEnabled: true, idleShutdown: "2h", showAgentTouches: false },
        trusted,
      ),
    ).toBe(true);
    expect(hub.setPreferences).toHaveBeenCalledWith({
      agentsEnabled: true,
      idleShutdown: "2h",
      showAgentTouches: false,
    });
    await expect(run.simulator_device_shape({ deviceId: PHONE }, trusted)).resolves.toBeNull();
    await expect(
      run.simulator_rotate({ deviceId: PHONE, orientation: "landscape-left" }, trusted),
    ).resolves.toBe(true);
    expect(hub.rotate).toHaveBeenCalledWith(PHONE, "landscape-left");
  });

  it("save captures and hand them back only by the ids main gave out", async () => {
    const { run, captures, startDrag } = commands();
    await expect(run.simulator_screenshot({ deviceId: PHONE }, trusted)).resolves.toEqual(CAPTURE);
    await expect(run.simulator_recording_start({ deviceId: PHONE }, trusted)).resolves.toEqual({
      deviceId: PHONE,
      startedAt: 5,
    });
    await expect(run.simulator_recording_stop({ deviceId: PHONE }, trusted)).resolves.toMatchObject({
      kind: "recording",
    });
    expect(run.simulator_recordings({}, trusted)).toEqual({ version: 1, recordings: [] });
    await expect(
      run.simulator_capture_file({ captureId: "capture-1", path: "/etc/passwd" }, trusted),
    ).resolves.toMatchObject({ mimeType: "image/png" });
    expect(captures.file).toHaveBeenCalledWith("capture-1");
    await expect(run.simulator_capture_drag({ captureId: "capture-1" }, trusted)).resolves.toBe(true);
    expect(startDrag).toHaveBeenCalledWith(trusted, SAVED);
    await expect(
      run.simulator_recording_timeline({ fingerprint: FINGERPRINT }, trusted),
    ).resolves.toBeNull();
    expect(captures.timeline).toHaveBeenCalledWith(FINGERPRINT);
    await expect(run.simulator_annotation_snapshot({ deviceId: PHONE }, trusted)).resolves.toEqual({
      deviceName: "iPhone 17",
    });

    for (const captureId of [undefined, "capture-", "../capture-1", "/Users/me/Downloads/a.png"]) {
      await expect(async () => run.simulator_capture_file({ captureId }, trusted)).rejects.toThrow(
        "Invalid simulator capture.",
      );
      await expect(async () => run.simulator_capture_drag({ captureId }, trusted)).rejects.toThrow(
        "Invalid simulator capture.",
      );
    }
    await expect(async () =>
      run.simulator_recording_timeline({ fingerprint: "/tmp/a.json" }, trusted),
    ).rejects.toThrow("Invalid recording.");
    await expect(async () => run.simulator_screenshot({ deviceId: "--all" }, trusted)).rejects.toThrow(
      "Invalid simulator request.",
    );
    expect(captures.savedFile).toHaveBeenCalledTimes(1);
    expect(startDrag).toHaveBeenCalledTimes(1);
  });

  it("log what the user does for a recording's timeline, once it reached the device", async () => {
    const { run, hub, captures } = commands();
    await run.simulator_input({ deviceId: PHONE, input: { kind: "tap", at: { x: 10, y: 20 } } }, trusted);
    await run.simulator_input(
      { deviceId: PHONE, input: { kind: "drag", from: { x: 5, y: 6 }, to: { x: 5, y: 6 }, durationMs: 700 } },
      trusted,
    );
    await run.simulator_rotate({ deviceId: PHONE, orientation: "landscape-left" }, trusted);
    await run.simulator_appearance_set({ deviceId: PHONE, appearance: "dark" }, trusted);
    hub.input.mockRejectedValueOnce(new Error("That didn't reach iPhone 17."));
    await expect(
      run.simulator_input({ deviceId: PHONE, input: { kind: "text", text: "hi" } }, trusted),
    ).rejects.toThrow("That didn't reach iPhone 17.");
    expect(captures.noteAction.mock.calls).toEqual([
      [PHONE, null, { kind: "tap", at: { x: 10, y: 20 }, portrait: true }],
      [PHONE, null, { kind: "long-press", at: { x: 5, y: 6 }, portrait: true }],
      [PHONE, null, { kind: "rotate", orientation: "landscape-left" }],
      [PHONE, null, { kind: "appearance", appearance: "dark" }],
    ]);
  });

  it("stream the user's finger and log the press once it lifts", async () => {
    const { run, hub, captures } = commands();
    const step = (touch: unknown) =>
      run.simulator_touch({ deviceId: PHONE, viewId: "view-1", touch }, trusted);
    await expect(step({ phase: "down", at: { x: 10.04, y: 20 } })).resolves.toBe(true);
    await expect(step({ phase: "move", at: { x: 10, y: 60 } })).resolves.toBe(true);
    hub.touch.mockResolvedValueOnce({
      kind: "drag",
      from: { x: 10, y: 20 },
      to: { x: 10, y: 90 },
      durationMs: 300,
    });
    await expect(step({ phase: "up", at: { x: 10, y: 90 } })).resolves.toBe(true);
    await expect(
      step({ phase: "down", at: { x: 100, y: 200 }, second: { x: 200, y: 300 } }),
    ).resolves.toBe(true);
    hub.touch.mockResolvedValueOnce(null);
    await expect(
      step({ phase: "cancel", at: { x: 100, y: 200 }, second: { x: 200, y: 300 } }),
    ).resolves.toBe(true);
    expect(hub.touch.mock.calls).toEqual([
      [PHONE, "view-1", { phase: "down", at: { x: 10, y: 20 } }],
      [PHONE, "view-1", { phase: "move", at: { x: 10, y: 60 } }],
      [PHONE, "view-1", { phase: "up", at: { x: 10, y: 90 } }],
      [PHONE, "view-1", { phase: "down", at: { x: 100, y: 200 }, second: { x: 200, y: 300 } }],
      [PHONE, "view-1", { phase: "cancel", at: { x: 100, y: 200 }, second: { x: 200, y: 300 } }],
    ]);
    expect(captures.noteAction.mock.calls).toEqual([
      [PHONE, null, { kind: "swipe", from: { x: 10, y: 20 }, to: { x: 10, y: 90 }, portrait: true }],
    ]);

    hub.touch.mockRejectedValueOnce(new Error("iPhone 17 isn't running."));
    await expect(step({ phase: "down", at: { x: 1, y: 2 } })).rejects.toThrow("isn't running");
    expect(captures.noteAction).toHaveBeenCalledTimes(1);
  });

  it("refuse malformed touches before they reach DeviceHub", async () => {
    const { run, hub } = commands();
    const at = { x: 1, y: 2 };
    for (const args of [
      { deviceId: "--all", viewId: "view-1", touch: { phase: "down", at } },
      { deviceId: PHONE, viewId: "view-", touch: { phase: "down", at } },
      { deviceId: PHONE, viewId: 1, touch: { phase: "down", at } },
    ]) {
      await expect(async () => run.simulator_touch(args, trusted)).rejects.toThrow(
        "Invalid simulator request.",
      );
    }
    for (const touch of [
      undefined,
      { phase: "hover", at },
      { phase: "down", at: { x: -1, y: 2 } },
      { phase: "move", at, second: { x: "1", y: 2 } },
    ]) {
      await expect(async () =>
        run.simulator_touch({ deviceId: PHONE, viewId: "view-1", touch }, trusted),
      ).rejects.toThrow("Invalid simulator touch.");
    }
    expect(hub.touch).not.toHaveBeenCalled();
  });

  it("report and stop agents on simulators", () => {
    const { run, deviceUse } = commands();
    expect(run.simulator_agent_state({}, trusted)).toEqual(HOLDERS);
    expect(run.simulator_agent_stop({ deviceId: PHONE }, trusted)).toBe(true);
    expect(deviceUse?.stopFromUser).toHaveBeenCalledWith(PHONE);
    expect(() => run.simulator_agent_stop({ deviceId: "--all" }, trusted)).toThrow(
      "Invalid simulator request.",
    );

    const without = commands({ withDeviceUse: false });
    expect(without.run.simulator_agent_state({}, trusted)).toEqual({ version: 1, holders: [] });
    expect(without.run.simulator_agent_stop({ deviceId: PHONE }, trusted)).toBe(false);
  });

  it("refuse malformed ids, input, appearance and preferences", async () => {
    const { run, hub } = commands();
    for (const deviceId of [undefined, "", "--erase", "../x", 7]) {
      expect(() => run.simulator_boot({ deviceId }, trusted)).toThrow("Invalid simulator request.");
    }
    expect(() => run.simulator_view_stop({ viewId: 3 }, trusted)).toThrow("Invalid");
    await expect(
      run.simulator_input({ deviceId: PHONE, input: { kind: "shell", command: "rm" } }, trusted),
    ).rejects.toThrow("Invalid simulator input.");
    await expect(
      run.simulator_input({ deviceId: PHONE, input: { kind: "tap", at: { x: -1, y: 0 } } }, trusted),
    ).rejects.toThrow("Invalid simulator input.");
    await expect(
      run.simulator_appearance_set({ deviceId: PHONE, appearance: "sepia" }, trusted),
    ).rejects.toThrow("Invalid simulator appearance.");
    await expect(
      run.simulator_rotate({ deviceId: PHONE, orientation: "sideways" }, trusted),
    ).rejects.toThrow("Invalid simulator orientation.");
    expect(hub.rotate).not.toHaveBeenCalled();
    expect(() =>
      run.simulator_preferences_update({ agentsEnabled: true, idleShutdown: "5m" }, trusted),
    ).toThrow("Invalid simulator preferences.");
    expect(hub.boot).not.toHaveBeenCalled();
    expect(hub.input).not.toHaveBeenCalled();
    expect(hub.setAppearance).not.toHaveBeenCalled();
    expect(hub.setPreferences).not.toHaveBeenCalled();
  });
});
