// The macOS grants computer use needs, read the way Settings shows them.
// Reading uses Electron's own checks so it never loads the driver SDK; asking
// uses the SDK's request, which also lists Zeros in both System Settings
// panes so the user only has to turn it on.

import type { SystemPreferences } from "electron";

import type { ComputerPermissions, ComputerPermissionStatus } from "./ports";

export type ComputerPermissionKind = "accessibility" | "screen-recording";

export const COMPUTER_PERMISSION_SETTINGS_URLS: Record<
  ComputerPermissionKind,
  string
> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export function isComputerPermissionKind(
  value: unknown,
): value is ComputerPermissionKind {
  return value === "accessibility" || value === "screen-recording";
}

export interface MacComputerPermissions extends ComputerPermissions {
  /** Ask macOS for whichever grants are missing. */
  request(): Promise<ComputerPermissionStatus>;
  openSettings(kind: ComputerPermissionKind): Promise<void>;
}

const NONE: ComputerPermissionStatus = {
  accessibility: false,
  screenRecording: false,
};

export function createMacComputerPermissions(options: {
  platform: NodeJS.Platform;
  systemPreferences: Pick<
    SystemPreferences,
    "isTrustedAccessibilityClient" | "getMediaAccessStatus"
  >;
  openExternal(url: string): Promise<void>;
  /** The driver SDK's own request, which prompts for both grants. */
  requestWithSdk(): Promise<void>;
}): MacComputerPermissions {
  const status = (): ComputerPermissionStatus => {
    if (options.platform !== "darwin") return { ...NONE };
    let accessibility = false;
    let screenRecording = false;
    try {
      accessibility =
        options.systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      // Unknown counts as not granted.
    }
    try {
      screenRecording =
        options.systemPreferences.getMediaAccessStatus("screen") === "granted";
    } catch {
      // Unknown counts as not granted.
    }
    return { accessibility, screenRecording };
  };

  return {
    status,
    async request() {
      const current = status();
      if (
        options.platform !== "darwin" ||
        (current.accessibility && current.screenRecording)
      ) {
        return current;
      }
      await options.requestWithSdk();
      return status();
    },
    async openSettings(kind) {
      if (options.platform !== "darwin") return;
      await options.openExternal(COMPUTER_PERMISSION_SETTINGS_URLS[kind]);
    },
  };
}
