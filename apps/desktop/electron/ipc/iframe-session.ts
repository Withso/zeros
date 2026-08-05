// ──────────────────────────────────────────────────────────
// Iframe session commands — clear cache, clear cookies
// ──────────────────────────────────────────────────────────
//
// Iframes can call
// `location.reload(true)` for a hard reload, but they CAN'T clear
// cache or cookies — those operations are session-scoped, not
// frame-scoped. Main process owns the session and handles these.
// Scoped to the main window's webContents.session so we don't
// touch other partitions.

import { type BrowserWindow } from "electron";
import { setCommand } from "./router";

let mainWindowRef: BrowserWindow | null = null;

async function handleClearCache(): Promise<{ ok: true }> {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    await mainWindowRef.webContents.session.clearCache();
  }
  return { ok: true };
}

async function handleClearCookies(): Promise<{ ok: true }> {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    await mainWindowRef.webContents.session.clearStorageData({
      storages: ["cookies"],
    });
  }
  return { ok: true };
}

export function registerIframeSessionCommands(opts: {
  mainWindow: BrowserWindow;
}): void {
  mainWindowRef = opts.mainWindow;
  setCommand("iframe:clear-cache", () => handleClearCache());
  setCommand("iframe:clear-cookies", () => handleClearCookies());

  opts.mainWindow.on("closed", () => {
    if (mainWindowRef === opts.mainWindow) mainWindowRef = null;
  });
}
