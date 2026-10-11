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
//
// `browser:list-local-servers` backs the Browser start page's loopback
// dev-server list for one workspace folder (`{ root, exclude }`, see
// ../browser/local-dev-servers.ts). Re-registering on window re-creation
// replaces the handler; the lister itself is shared.

import { type BrowserWindow } from "electron";
import { setCommand } from "./router";
import {
  createLocalDevServerLister,
  defaultListDeps,
  resolveLocalDevServerScope,
  zerosListenerExclusions,
} from "../browser/local-dev-servers";
import { IS_DEV } from "../runtime-mode";
import { currentPort, getEnginePid } from "../sidecar";
import { engineBasePort } from "../../src/engine/runtime";

let mainWindowRef: BrowserWindow | null = null;

const listLocalDevServers = createLocalDevServerLister(
  defaultListDeps(() =>
    zerosListenerExclusions({
      mainPid: process.pid,
      enginePid: getEnginePid(),
      enginePort: currentPort(),
      engineBase: engineBasePort(),
      // Mirrors main.ts DEV_URL: unpackaged builds load the renderer from vite.
      rendererDevUrl: IS_DEV
        ? (process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5193")
        : null,
      vitePort: IS_DEV ? process.env.ZEROS_VITE_PORT : undefined,
    }),
  ),
);

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
  setCommand("browser:list-local-servers", async (args) =>
    listLocalDevServers(await resolveLocalDevServerScope(args)),
  );

  opts.mainWindow.on("closed", () => {
    if (mainWindowRef === opts.mainWindow) mainWindowRef = null;
  });
}
