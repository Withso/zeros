import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_PERMISSION_SETTINGS_URLS,
  createMacComputerPermissions,
  isComputerPermissionKind,
} from "../computer-use/permissions";

function setup(
  grants: { accessibility: boolean; screen: string },
  platform: NodeJS.Platform = "darwin",
) {
  const systemPreferences = {
    isTrustedAccessibilityClient: vi.fn(() => grants.accessibility),
    getMediaAccessStatus: vi.fn(() => grants.screen),
  };
  const openExternal = vi.fn(async () => undefined);
  const requestWithSdk = vi.fn(async () => {
    grants.accessibility = true;
  });
  const permissions = createMacComputerPermissions({
    platform,
    systemPreferences: systemPreferences as never,
    openExternal,
    requestWithSdk,
  });
  return { permissions, systemPreferences, openExternal, requestWithSdk };
}

describe("computer-use permissions", () => {
  it("reads both grants without prompting", () => {
    const { permissions, systemPreferences } = setup({
      accessibility: true,
      screen: "granted",
    });
    expect(permissions.status()).toEqual({
      accessibility: true,
      screenRecording: true,
    });
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(
      false,
    );
    expect(systemPreferences.getMediaAccessStatus).toHaveBeenCalledWith(
      "screen",
    );
  });

  it("counts anything but granted, or a failed check, as missing", () => {
    for (const screen of ["denied", "not-determined", "restricted", "unknown"]) {
      expect(
        setup({ accessibility: false, screen }).permissions.status(),
      ).toEqual({ accessibility: false, screenRecording: false });
    }
    const { permissions, systemPreferences } = setup({
      accessibility: true,
      screen: "granted",
    });
    systemPreferences.getMediaAccessStatus.mockImplementation(() => {
      throw new Error("unsupported");
    });
    expect(permissions.status()).toEqual({
      accessibility: true,
      screenRecording: false,
    });
  });

  it("asks macOS only for missing grants and returns the fresh status", async () => {
    const granted = setup({ accessibility: true, screen: "granted" });
    await granted.permissions.request();
    expect(granted.requestWithSdk).not.toHaveBeenCalled();

    const missing = setup({ accessibility: false, screen: "granted" });
    expect(await missing.permissions.request()).toEqual({
      accessibility: true,
      screenRecording: true,
    });
    expect(missing.requestWithSdk).toHaveBeenCalledTimes(1);
  });

  it("opens the matching Privacy & Security pane", async () => {
    const { permissions, openExternal } = setup({
      accessibility: false,
      screen: "denied",
    });
    await permissions.openSettings("accessibility");
    await permissions.openSettings("screen-recording");
    expect(openExternal.mock.calls).toEqual([
      [COMPUTER_PERMISSION_SETTINGS_URLS.accessibility],
      [COMPUTER_PERMISSION_SETTINGS_URLS["screen-recording"]],
    ]);
    expect(COMPUTER_PERMISSION_SETTINGS_URLS["screen-recording"]).toContain(
      "Privacy_ScreenCapture",
    );
    expect(isComputerPermissionKind("accessibility")).toBe(true);
    expect(isComputerPermissionKind("camera")).toBe(false);
  });

  it("reports nothing granted and does nothing off macOS", async () => {
    const { permissions, systemPreferences, openExternal, requestWithSdk } =
      setup({ accessibility: true, screen: "granted" }, "linux");
    expect(permissions.status()).toEqual({
      accessibility: false,
      screenRecording: false,
    });
    await permissions.request();
    await permissions.openSettings("accessibility");
    expect(systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(requestWithSdk).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
