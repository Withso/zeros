import os from "node:os";
import path from "node:path";
import {
  zerosDesignWorkspacesRoot,
  zerosStateRoot,
  zerosWorkspacesRoot,
} from "../../src/engine/db/paths";
import { syncChannelFolder } from "../workspace-sync/default-folder";

/** What only the running app knows. `sessionData` is Electron's own answer for
 * the Chromium profile in use, never re-derived here: it differs between
 * installed channels, new and legacy Local profiles, and may move. */
export interface LocalStorageRuntime {
  userData: string;
  sessionData: string;
  logDir: string | null;
  /** The folder holding secrets.json; provider accounts live beside it. */
  secretsDir: string;
  updates: readonly string[];
}

export interface LocalStorageLocations {
  home: string;
  dataDir: string;
  sessionData: string;
  stateRoot: string;
  logDir: string | null;
  providerAccounts: string;
  workspaces: string;
  designWorkspaces: string;
  cloudSync: string;
  updates: readonly string[];
}

export function resolveLocalStorageLocations(runtime: LocalStorageRuntime): LocalStorageLocations {
  const workspaces = zerosWorkspacesRoot();
  return {
    home: os.homedir(),
    dataDir: runtime.userData,
    sessionData: runtime.sessionData,
    stateRoot: zerosStateRoot(),
    logDir: runtime.logDir,
    providerAccounts: path.join(runtime.secretsDir, "provider-accounts"),
    workspaces,
    designWorkspaces: zerosDesignWorkspacesRoot(),
    cloudSync: path.join(syncChannelFolder(workspaces), "cloud-sync"),
    updates: runtime.updates,
  };
}

/** electron-updater's download folder and Squirrel.Mac's staging folder. Only a
 * packaged app updates. The download folder is named by the package, so
 * Stable and Alpha share it; neither folder is ever modified from here. */
export function updaterLocations(input: {
  packaged: boolean;
  platform: NodeJS.Platform;
  cacheRoot: string;
  updaterCacheDirName: string | null;
  bundleId: string;
}): string[] {
  if (!input.packaged || input.platform !== "darwin") return [];
  const roots = [path.join(input.cacheRoot, `${input.bundleId}.ShipIt`)];
  const name = input.updaterCacheDirName;
  if (name && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) && name !== "..")
    roots.unshift(path.join(input.cacheRoot, name));
  return roots;
}

/** `updaterCacheDirName` from electron-builder's app-update.yml. */
export function parseUpdaterCacheDirName(yaml: string): string | null {
  const match = /^updaterCacheDirName:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(yaml);
  return match ? match[1]! : null;
}
