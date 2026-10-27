import path from "node:path";
import { app, shell, type IpcMainInvokeEvent } from "electron";

import type { FullDiskAccessSnapshot } from "../../../shared/full-disk-access";
import {
  applicationBundlePath,
  probeFullDiskAccess,
} from "../../full-disk-access";
import { getMainWindow } from "../events";
import type { CommandHandler } from "../router";

const SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

function requireAppWindow(
  args: Record<string, unknown>,
  event: IpcMainInvokeEvent,
): void {
  const window = getMainWindow();
  if (
    !window ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("Full Disk Access settings require the app window.");
  }
  // No renderer-supplied paths, URLs, workspace targets or permission values.
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).length
  ) {
    throw new Error("Full Disk Access commands do not accept arguments.");
  }
}

let pending: Promise<FullDiskAccessSnapshot> | undefined;

export const fullDiskAccessStatus: CommandHandler = async (args, event) => {
  requireAppWindow(args, event);
  if (!pending) {
    pending = (async () => {
      const bundle =
        process.platform === "darwin"
          ? applicationBundlePath(process.execPath)
          : null;
      return {
        status: await probeFullDiskAccess({
          platform: process.platform,
          home: app.getPath("home"),
        }),
        appName: bundle ? path.basename(bundle, ".app") : app.getName(),
        canRevealApp: bundle !== null,
      };
    })().finally(() => {
      pending = undefined;
    });
  }
  // Share concurrent reads only. A later read must see revocation/relaunch.
  const snapshot = await pending;
  requireAppWindow(args, event);
  return snapshot;
};

export const fullDiskAccessOpenSettings: CommandHandler = async (
  args,
  event,
) => {
  requireAppWindow(args, event);
  if (process.platform !== "darwin")
    throw new Error("Full Disk Access requires macOS.");
  try {
    await shell.openExternal(SETTINGS_URL);
  } catch {
    throw new Error(
      "Could not open System Settings. Open Privacy & Security > Full Disk Access manually.",
    );
  }
};

export const fullDiskAccessRevealApp: CommandHandler = (args, event) => {
  requireAppWindow(args, event);
  const bundle =
    process.platform === "darwin"
      ? applicationBundlePath(process.execPath)
      : null;
  if (!bundle) throw new Error("The running app bundle could not be located.");
  shell.showItemInFolder(bundle);
};
