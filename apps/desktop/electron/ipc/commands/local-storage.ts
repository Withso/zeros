import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, session, shell, type IpcMainInvokeEvent } from "electron";
import {
  LOCAL_STORAGE_CLEARABLE,
  LOCAL_STORAGE_PROGRESS_EVENT,
  LOCAL_STORAGE_REVEALABLE,
  isLocalStorageCategoryId,
  type LocalStorageCategoryId,
} from "../../../shared/local-storage";
import { appIdentity } from "../../../src/engine/db/paths";
import { measureWithDu } from "../../local-storage/du";
import {
  parseUpdaterCacheDirName,
  resolveLocalStorageLocations,
  updaterLocations,
  type LocalStorageLocations,
} from "../../local-storage/locations";
import { planLocalStorage, revealTarget } from "../../local-storage/plan";
import { createLocalStorageService, type LocalStorageService } from "../../local-storage/service";
import { logStoreDir } from "../../log-store";
import { secretsFilePath } from "../../secret-store";
import { emitEvent, getMainWindow } from "../events";
import type { CommandHandler } from "../router";

function requireAppWindow(event: IpcMainInvokeEvent): void {
  const window = getMainWindow();
  if (
    !window ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Local Storage requires the app window.");
  // Sizes come from the system du and folder layout of macOS; elsewhere the
  // page is hidden rather than showing numbers it cannot stand behind.
  if (process.platform !== "darwin") throw new Error("Local Storage is available on macOS only.");
}

function requireNoArgs(args: unknown): void {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)
    throw new Error("Local Storage commands do not accept arguments.");
}

/** The renderer names a row from the closed set; it never supplies a path. */
export function requireCategory(
  args: unknown,
  allowed: ReadonlySet<LocalStorageCategoryId>,
): LocalStorageCategoryId {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Local Storage needs a category.");
  const keys = Object.keys(args);
  const category = (args as { category?: unknown }).category;
  if (keys.length !== 1 || keys[0] !== "category" || !isLocalStorageCategoryId(category) || !allowed.has(category))
    throw new Error("Unknown Local Storage category.");
  return category;
}

async function updaterCacheDirName(): Promise<string> {
  try {
    const name = parseUpdaterCacheDirName(await readFile(path.join(process.resourcesPath, "app-update.yml"), "utf8"));
    if (name) return name;
  } catch {
    /* electron-updater falls back to the app name the same way */
  }
  return app.getName();
}

async function currentLocations(): Promise<LocalStorageLocations> {
  // @ts-expect-error - "cache" is a valid runtime path name, absent from the types.
  const cacheRoot: string = app.getPath("cache");
  return resolveLocalStorageLocations({
    userData: app.getPath("userData"),
    // Read from Electron at the moment of measuring: the profile location
    // differs by identity and is not this module's to derive.
    sessionData: app.getPath("sessionData"),
    logDir: logStoreDir(),
    secretsDir: path.dirname(secretsFilePath()),
    updates: updaterLocations({
      packaged: app.isPackaged,
      platform: process.platform,
      cacheRoot,
      updaterCacheDirName: app.isPackaged ? await updaterCacheDirName() : null,
      bundleId: appIdentity(),
    }),
  });
}

let service: LocalStorageService | null = null;

/** Created on the first Local Storage command, so a launch that never opens
 * the page does no storage work at all. */
function storageService(): LocalStorageService {
  if (service) return service;
  const created = createLocalStorageService({
    locations: currentLocations,
    plan: planLocalStorage,
    revealTarget,
    measure: measureWithDu,
    emit: (report) => emitEvent(LOCAL_STORAGE_PROGRESS_EVENT, report),
  });
  app.once("will-quit", () => created.cancel());
  service = created;
  return created;
}

/** Electron's own cache APIs on the app session only. Storage data, cookies,
 * GPU and shader caches (the Design canvas relies on them), logs and updater
 * downloads are never touched, and no file is removed by path. */
export async function clearAppCache(target = session.defaultSession): Promise<void> {
  await target.clearCache();
  await target.clearCodeCaches({});
}

export const localStorageMeasure: CommandHandler = (args, event) => {
  requireAppWindow(event);
  requireNoArgs(args);
  return storageService().measure();
};

export const localStorageCancel: CommandHandler = (args, event) => {
  requireAppWindow(event);
  requireNoArgs(args);
  service?.cancel();
  return null;
};

export const localStorageClearCache: CommandHandler = (args, event) => {
  requireAppWindow(event);
  requireCategory(args, LOCAL_STORAGE_CLEARABLE);
  return storageService().clearCache(() => clearAppCache());
};

export const localStorageReveal: CommandHandler = async (args, event) => {
  requireAppWindow(event);
  const category = requireCategory(args, LOCAL_STORAGE_REVEALABLE);
  const target = await storageService().reveal(category);
  if (!target) throw new Error("This folder does not exist yet.");
  shell.showItemInFolder(target);
  return null;
};

export function _resetLocalStorageForTests(): void {
  service = null;
}
