// ──────────────────────────────────────────────────────────
// IPC command: app info (runtime mode + version + platform)
// ──────────────────────────────────────────────────────────
//
// The renderer (browser context) can't read `process.env` or
// `process.defaultApp`, so it can't tell whether it's the dev app
// ("Zeros Dev" / com.zeros.dev) or the packaged prod app. The
// analytics layer needs that distinction to route events to the
// right PostHog project (Zeros Dev vs Zeros). This command hands
// the renderer the authoritative values from the main process,
// where IS_DEV (electron/runtime-mode.ts) is the source of truth.
//
// Metadata only — no user data of any kind crosses this boundary.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { IS_DEV } from "../../runtime-mode";
import { channel, type Channel } from "../../../src/engine/runtime";
import { currentRoot, spawnEngine } from "../../sidecar";
import { emitEvent } from "../events";
import type { CommandHandler } from "../router";

export interface AppInfo {
  runtimeMode: "dev" | "prod";
  /** Release channel — the authoritative value from the main process (keyed off
   *  the seeded ZEROS_CHANNEL). The renderer derives the deep-link scheme from
   *  this (schemeForChannel) so the /launch URL it builds always matches the
   *  scheme electron/deep-link.ts registered + validates. `runtimeMode` can't
   *  carry it: a Beta build is runtimeMode "prod" yet channel "beta". */
  channel: Channel;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
}

export const appInfo: CommandHandler = async (): Promise<AppInfo> => {
  return {
    runtimeMode: IS_DEV ? "dev" : "prod",
    channel: channel(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
};

// ──────────────────────────────────────────────────────────
// App settings — plain-JSON store readable from the main process
// ──────────────────────────────────────────────────────────
//
// The renderer's src/native/settings.ts is localStorage-backed, which the
// main process (and therefore the engine sidecar) can't read. A small set of
// app-level runtime preferences must be visible to spawnEngine() so it can
// forward them to the engine child as env vars. This is the ONE such store: a
// NON-secret JSON file at <userData>/app-settings.json, mirroring
// secret-store.ts's atomic-write file handling but WITHOUT safeStorage. API
// keys / tokens still go through the encrypted secret-store; nothing sensitive
// belongs here.
//
function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "app-settings.json");
}

function readAllSettings(): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFilePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.warn(`[app-settings] read failed: ${(err as Error).message}`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch {
    /* fall through */
  }
  console.warn(`[app-settings] app-settings.json malformed — ignoring`);
  return {};
}

function writeAllSettings(data: Record<string, string>): void {
  const file = settingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Read a single app setting. Returns "" when unset (callers treat empty as
 *  "not configured"). Synchronous + main-process only. */
export function getAppSetting(key: string): string {
  const v = readAllSettings()[key];
  return typeof v === "string" ? v : "";
}

/** Persist a single app setting. An empty value DELETES the key so the file
 *  doesn't accumulate blank entries (and so "" round-trips cleanly back to
 *  "unset"). */
export function setAppSetting(key: string, value: string): void {
  const data = readAllSettings();
  if (value === "") {
    if (!(key in data)) return;
    delete data[key];
  } else {
    data[key] = value;
  }
  writeAllSettings(data);
}

export const appSettingGet: CommandHandler = async (args) => {
  const key = String(args.key ?? "");
  if (!key) throw new Error("app_setting_get: missing key");
  return getAppSetting(key);
};

export const appSettingSet: CommandHandler = async (args) => {
  const key = String(args.key ?? "");
  if (!key) throw new Error("app_setting_set: missing key");
  // Coerce to string; an explicit empty string clears the setting.
  const value = args.value == null ? "" : String(args.value);
  setAppSetting(key, value);
};

/** Restart the engine in place so a settings change that only takes effect at
 *  engine startup is applied without a full app relaunch. Respawns at the CURRENT
 *  root and emits `engine-restarted` so the renderer's bridge drops its cached
 *  port and reconnects (use-bridge.tsx already listens). Returns the new port, or
 *  null when no engine root is bound yet (apply-on-next-launch). */
export const engineRestart: CommandHandler = async () => {
  const root = currentRoot();
  if (!root) return null;
  const port = await spawnEngine(root);
  emitEvent("engine-restarted", port);
  return port;
};
