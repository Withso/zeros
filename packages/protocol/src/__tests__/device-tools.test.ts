import { describe, expect, it } from "vitest";

import {
  DEVICE_TOOL_DEFINITIONS,
  DEVICE_TOOL_NAMES,
  DEVICE_TOOL_NAMESPACE,
  deviceControlDetail,
  deviceUseHolder,
  deviceUseTitle,
  isDeviceAppId,
  isDeviceToolName,
  parseDeviceToolCall,
  readDeviceAgentTouch,
  readDeviceUseState,
  resolveDeviceToolRoute,
} from "../device-tools";

const UDID = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";

describe("Zeros simulator tool contract", () => {
  it("publishes a curated manifest with no session, runner or config tools", () => {
    expect(DEVICE_TOOL_NAMESPACE).toBe("zeros_device");
    expect(DEVICE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(DEVICE_TOOL_NAMES);
    expect(new Set(DEVICE_TOOL_NAMES).size).toBe(DEVICE_TOOL_NAMES.length);
    for (const forbidden of [
      "shutdown_device",
      "erase_device",
      "batch",
      "replay",
      "record",
      "logs",
      "clipboard",
      "settings",
    ]) {
      expect(isDeviceToolName(forbidden)).toBe(false);
    }
    for (const tool of DEVICE_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toMatch(/\S/);
      const properties = Object.keys(tool.inputSchema.properties);
      for (const reserved of ["session", "state_dir", "config", "udid", "platform"]) {
        expect(properties).not.toContain(reserved);
      }
      if (tool.name !== "list_devices") {
        expect(tool.inputSchema.required).toContain("device_id");
      }
    }
  });

  it("serves every agent while agents may use simulators", () => {
    for (const agent of ["claude", "codex", "cursor"]) {
      expect(resolveDeviceToolRoute(agent, { enabled: true })).toBe("zeros");
      expect(resolveDeviceToolRoute(agent, { enabled: false })).toBe("off");
    }
    expect(resolveDeviceToolRoute("gemini", { enabled: true })).toBe("off");
  });

  it("accepts iOS bundle IDs and Android package names, never flags", () => {
    expect(isDeviceAppId("com.apple.mobilesafari")).toBe(true);
    expect(isDeviceAppId("com.example.my_app")).toBe(true);
    expect(isDeviceAppId("-com.example")).toBe(false);
    expect(isDeviceAppId("Safari")).toBe(false);
    expect(isDeviceAppId("com..apple")).toBe(false);
    expect(isDeviceAppId(`com.${"a".repeat(300)}`)).toBe(false);
  });

  it("names the simulator the agent is using", () => {
    expect(deviceControlDetail("iPhone 17")).toBe("is using iPhone 17");
  });
});

describe("simulator tool argument validation", () => {
  it("names one simulator for every action but the device list", () => {
    expect(parseDeviceToolCall("list_devices", {})).toEqual({
      ok: true,
      call: { tool: "list_devices" },
    });
    expect(parseDeviceToolCall("screenshot", {})).toEqual({
      ok: false,
      error: "device_id must be a simulator ID from list_devices.",
    });
    expect(parseDeviceToolCall("screenshot", { device_id: "--udid" })).toMatchObject({
      ok: false,
    });
    expect(parseDeviceToolCall("boot_device", { device_id: UDID })).toEqual({
      ok: true,
      call: { tool: "boot_device", deviceId: UDID },
    });
    expect(parseDeviceToolCall("list_devices", { device_id: UDID })).toEqual({
      ok: false,
      error: "Unknown argument: device_id.",
    });
  });

  it("taps a snapshot ref or a screenshot point", () => {
    expect(parseDeviceToolCall("tap", { device_id: UDID, ref: "e12" })).toEqual({
      ok: true,
      call: { tool: "tap", deviceId: UDID, ref: "@e12" },
    });
    expect(
      parseDeviceToolCall("tap", { device_id: UDID, ref: "@e3~s648335", count: 2 }),
    ).toEqual({
      ok: true,
      call: { tool: "tap", deviceId: UDID, ref: "@e3~s648335", count: 2 },
    });
    expect(
      parseDeviceToolCall("tap", { device_id: UDID, x: 200.4, y: 319.6, hold_ms: 800 }),
    ).toEqual({
      ok: true,
      call: { tool: "tap", deviceId: UDID, x: 200, y: 320, holdMs: 800 },
    });
    for (const [args, error] of [
      [{}, "Pass a ref from the latest snapshot, or x and y."],
      [{ x: 1 }, "Pass x and y together."],
      [{ ref: "@e1", x: 1, y: 2 }, "Pass ref or x and y, not both."],
      [{ ref: "button" }, "ref must be an element ref such as @e3 from the latest snapshot."],
      [{ ref: "@e1", hold_ms: 500, count: 2 }, "A long press can't be a double-tap."],
      [{ x: -1, y: 2 }, "x must be a position in points of the latest screenshot."],
    ] as const) {
      expect(parseDeviceToolCall("tap", { device_id: UDID, ...args })).toEqual({
        ok: false,
        error,
      });
    }
  });

  it("types bounded text into the focused field or a ref", () => {
    expect(
      parseDeviceToolCall("type_text", { device_id: UDID, text: "hello\nworld" }),
    ).toEqual({
      ok: true,
      call: { tool: "type_text", deviceId: UDID, text: "hello\nworld" },
    });
    expect(
      parseDeviceToolCall("type_text", { device_id: UDID, text: "", ref: "@e4" }),
    ).toEqual({
      ok: true,
      call: { tool: "type_text", deviceId: UDID, text: "", ref: "@e4" },
    });
    expect(parseDeviceToolCall("type_text", { device_id: UDID, text: "" })).toMatchObject({
      ok: false,
    });
    expect(
      parseDeviceToolCall("type_text", { device_id: UDID, text: "a\u0000b" }),
    ).toMatchObject({ ok: false });
    expect(
      parseDeviceToolCall("type_text", { device_id: UDID, text: "a".repeat(2_001) }),
    ).toMatchObject({ ok: false });
  });

  it("opens web addresses and deep links, never local files or scripts", () => {
    for (const url of ["https://example.com/a?b=1", "myapp://settings/profile"]) {
      expect(parseDeviceToolCall("open_url", { device_id: UDID, url })).toEqual({
        ok: true,
        call: { tool: "open_url", deviceId: UDID, url },
      });
    }
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "example.com",
      "https://exa mple.com",
      "https://",
    ]) {
      expect(parseDeviceToolCall("open_url", { device_id: UDID, url })).toMatchObject({
        ok: false,
      });
    }
  });

  it("installs only an absolute .app bundle and launches by bundle ID", () => {
    expect(
      parseDeviceToolCall("install_app", {
        device_id: UDID,
        path: "/Users/me/Library/Developer/Xcode/DerivedData/App/Build/Products/Debug-iphonesimulator/App.app/",
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "install_app",
        deviceId: UDID,
        path: "/Users/me/Library/Developer/Xcode/DerivedData/App/Build/Products/Debug-iphonesimulator/App.app",
      },
    });
    expect(
      parseDeviceToolCall("install_app", {
        device_id: "Pixel_10",
        path: "/Users/me/app/build/outputs/apk/debug/app-debug.apk",
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "install_app",
        deviceId: "Pixel_10",
        path: "/Users/me/app/build/outputs/apk/debug/app-debug.apk",
      },
    });
    for (const path of [
      "App.app",
      "/tmp/App.ipa",
      "/tmp/../etc/App.app",
      "/tmp/a\nb.app",
      "/tmp/app.apk/",
      "/tmp/../app.apk",
      "/tmp/app.aab",
    ]) {
      expect(parseDeviceToolCall("install_app", { device_id: UDID, path })).toMatchObject({
        ok: false,
      });
    }
    expect(
      parseDeviceToolCall("launch_app", {
        device_id: UDID,
        bundle_id: "com.apple.Preferences",
        relaunch: true,
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "launch_app",
        deviceId: UDID,
        bundleId: "com.apple.Preferences",
        relaunch: true,
      },
    });
    expect(
      parseDeviceToolCall("launch_app", { device_id: UDID, bundle_id: "--relaunch" }),
    ).toMatchObject({ ok: false });
  });

  it("bounds swipes, scrolls, pinches and the fixed choices", () => {
    expect(
      parseDeviceToolCall("swipe", {
        device_id: UDID,
        from_x: 200,
        from_y: 700,
        to_x: 200,
        to_y: 200,
        duration_ms: 400,
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: "swipe",
        deviceId: UDID,
        x: 200,
        y: 700,
        toX: 200,
        toY: 200,
        durationMs: 400,
      },
    });
    expect(
      parseDeviceToolCall("swipe", { device_id: UDID, from_x: 1, from_y: 1, to_x: 1, to_y: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      parseDeviceToolCall("scroll", { device_id: UDID, direction: "down", amount: 0.333 }),
    ).toEqual({
      ok: true,
      call: { tool: "scroll", deviceId: UDID, direction: "down", amount: 0.33 },
    });
    expect(
      parseDeviceToolCall("scroll", { device_id: UDID, direction: "down", amount: 2 }),
    ).toMatchObject({ ok: false });
    expect(parseDeviceToolCall("pinch", { device_id: UDID, scale: 2, x: 100 })).toEqual({
      ok: false,
      error: "Pass x and y together.",
    });
    expect(parseDeviceToolCall("pinch", { device_id: UDID, scale: 1 })).toMatchObject({
      ok: false,
    });
    expect(parseDeviceToolCall("pinch", { device_id: UDID, scale: 0.5 })).toEqual({
      ok: true,
      call: { tool: "pinch", deviceId: UDID, scale: 0.5 },
    });
    expect(parseDeviceToolCall("press_key", { device_id: UDID, key: "enter" })).toEqual({
      ok: true,
      call: { tool: "press_key", deviceId: UDID, key: "enter" },
    });
    expect(parseDeviceToolCall("press_key", { device_id: UDID, key: "cmd" })).toMatchObject({
      ok: false,
    });
    expect(parseDeviceToolCall("press_button", { device_id: UDID, button: "home" })).toEqual({
      ok: true,
      call: { tool: "press_button", deviceId: UDID, button: "home" },
    });
    expect(parseDeviceToolCall("press_button", { device_id: UDID, button: "back" })).toEqual({
      ok: true,
      call: { tool: "press_button", deviceId: UDID, button: "back" },
    });
    expect(
      parseDeviceToolCall("rotate", { device_id: UDID, orientation: "landscape-left" }),
    ).toEqual({
      ok: true,
      call: { tool: "rotate", deviceId: UDID, orientation: "landscape-left" },
    });
    expect(
      parseDeviceToolCall("set_appearance", { device_id: UDID, appearance: "dim" }),
    ).toMatchObject({ ok: false });
  });

  it("rejects unknown tools and non-object arguments", () => {
    expect(parseDeviceToolCall("shutdown_device", { device_id: UDID })).toEqual({
      ok: false,
      error: "Unknown Zeros simulator tool.",
    });
    expect(parseDeviceToolCall("screenshot", [UDID])).toEqual({
      ok: false,
      error: "Simulator tool arguments must be an object.",
    });
    expect(
      parseDeviceToolCall("screenshot", { device_id: UDID, session: "other" }),
    ).toEqual({ ok: false, error: "Unknown argument: session." });
  });
});

describe("simulator use for the Simulator tab", () => {
  const holder = {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    agent: "codex",
    deviceId: UDID,
    deviceName: "iPhone 17",
    platform: "ios",
  };

  it("reads the holders main publishes and names them", () => {
    const state = readDeviceUseState({ version: 1, holders: [holder] });
    expect(state).toEqual({ version: 1, holders: [holder] });
    expect(deviceUseHolder(state, UDID)).toEqual(holder);
    expect(deviceUseHolder(state, "other")).toBeNull();
    expect(deviceUseTitle(state!.holders[0]!)).toBe("Codex is using iPhone 17");
  });

  it("rejects a malformed state as a whole", () => {
    expect(readDeviceUseState({ version: 2, holders: [] })).toBeNull();
    expect(
      readDeviceUseState({ version: 1, holders: [{ ...holder, agent: "gemini" }] }),
    ).toBeNull();
    expect(
      readDeviceUseState({ version: 1, holders: [{ ...holder, deviceId: "-x" }] }),
    ).toBeNull();
    expect(
      readDeviceUseState({ version: 1, holders: [{ ...holder, platform: "watchos" }] }),
    ).toBeNull();
    expect(
      readDeviceUseState({ version: 1, holders: Array.from({ length: 65 }, () => holder) }),
    ).toBeNull();
  });

  it("reads agent touches, with an end point only for swipes", () => {
    expect(
      readDeviceAgentTouch({ deviceId: UDID, kind: "tap", at: { x: 10, y: 20 } }),
    ).toEqual({ deviceId: UDID, kind: "tap", at: { x: 10, y: 20 } });
    expect(
      readDeviceAgentTouch({
        deviceId: UDID,
        kind: "swipe",
        at: { x: 10, y: 20 },
        to: { x: 10, y: 400 },
      }),
    ).toEqual({ deviceId: UDID, kind: "swipe", at: { x: 10, y: 20 }, to: { x: 10, y: 400 } });
    expect(
      readDeviceAgentTouch({ deviceId: UDID, kind: "swipe", at: { x: 10, y: 20 } }),
    ).toBeNull();
    expect(
      readDeviceAgentTouch({ deviceId: UDID, kind: "poke", at: { x: 10, y: 20 } }),
    ).toBeNull();
    expect(
      readDeviceAgentTouch({ deviceId: UDID, kind: "tap", at: { x: -1, y: 20 } }),
    ).toBeNull();
  });

  it("reads how far a pinch zooms, and only for a pinch", () => {
    const pinch = { deviceId: UDID, kind: "pinch", at: { x: 10, y: 20 } };
    expect(readDeviceAgentTouch({ ...pinch, scale: 2 })).toEqual({ ...pinch, scale: 2 });
    expect(readDeviceAgentTouch(pinch)).toEqual(pinch);
    for (const scale of [0.05, 11, Number.NaN, "2"]) {
      expect(readDeviceAgentTouch({ ...pinch, scale })).toBeNull();
    }
    expect(readDeviceAgentTouch({ ...pinch, kind: "tap", scale: 2 })).toEqual({
      deviceId: UDID,
      kind: "tap",
      at: { x: 10, y: 20 },
    });
  });
});
