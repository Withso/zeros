// ──────────────────────────────────────────────────────────
// "Open in…" apps — detection cache + default-app preference
// ──────────────────────────────────────────────────────────
//
// Backs the Column-2 topbar split button (logo opens the current default,
// chevron opens the menu). Two localStorage-persisted pieces of state:
//
//   • The DETECTED app list — what `detect_open_apps` found on this Mac
//     (installed IDEs + Finder/Terminal, each with its real app icon as a
//     data URL). Re-probed every time a workspace is created (git.ts fires
//     refreshDetectedOpenApps() after each successful create — the user's
//     chosen detection point) and once on a cold cache, so the menu lists
//     exactly what's installed without probing on every paint.
//
//   • The DEFAULT app id — which app ⌘O / the logo button opens. Starts as
//     Finder; picking any menu app except Copy path re-points it. Falls
//     back to Finder at read time when the stored default is an IDE that's
//     no longer detected (uninstalled) — the stored value is kept, so a
//     reinstall restores the user's choice.
//
// Same pub/sub-hook shape as panels/default-agent.ts; hooks in src/native
// follow the runtime.ts precedent (useNativeRuntime).
// ──────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import { getSetting, setSetting } from "./settings";
import { isNativeRuntime, nativeInvoke } from "./runtime";
import { openInTerminal, revealInFinder } from "./native";

export type OpenAppKind = "system" | "ide" | "cli";

export interface DetectedOpenApp {
  id: string;
  name: string;
  kind: OpenAppKind;
  /** PNG data URL of the app's real icon (main-process sips extraction from
   *  the bundle .icns), or null when extraction failed / the app has no bundle
   *  (opencode CLI). Consumers fall back to a bundled/lucide mark. */
  iconDataUrl: string | null;
}

export const FINDER_APP_ID = "finder";
export const TERMINAL_APP_ID = "terminal";

/** Menu entries that exist on every Mac regardless of detection — also the
 *  render fallback while a cold cache is still probing. */
const SYSTEM_APPS: DetectedOpenApp[] = [
  { id: FINDER_APP_ID, name: "Finder", kind: "system", iconDataUrl: null },
  { id: TERMINAL_APP_ID, name: "Terminal", kind: "system", iconDataUrl: null },
];

const DETECTED_KEY = "open-in-detected-apps";
const DEFAULT_KEY = "open-in-default-app";

// ── Pub/sub bus (both keys share it — consumers render both) ──

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw; keep going */
    }
  }
}

// ── Detected list ─────────────────────────────────────────

/** null ⇒ detection has never run on this profile (cold cache). */
export function getDetectedOpenApps(): DetectedOpenApp[] | null {
  const raw = getSetting<DetectedOpenApp[] | null>(DETECTED_KEY, null);
  return Array.isArray(raw) ? raw : null;
}

let refreshInFlight: Promise<void> | null = null;

/** Re-probe installed apps over IPC and persist the result. Coalesces
 *  concurrent calls; never rejects (detection is best-effort — a failed
 *  probe keeps the previous cache). */
export function refreshDetectedOpenApps(): Promise<void> {
  if (!isNativeRuntime()) return Promise.resolve();
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const apps = await nativeInvoke<DetectedOpenApp[]>("detect_open_apps");
      if (Array.isArray(apps)) {
        setSetting(DETECTED_KEY, apps);
        notify();
      }
    } catch {
      /* keep the previous cache */
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Reactive detected-app list (null while never-detected). */
export function useDetectedOpenApps(): DetectedOpenApp[] | null {
  const [apps, setApps] = useState<DetectedOpenApp[] | null>(() =>
    getDetectedOpenApps(),
  );
  useEffect(() => {
    const sync = () => setApps(getDetectedOpenApps());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return apps;
}

/** The IDE rows for the menu (everything between Finder and Terminal),
 *  in detection (= registry = menu) order. */
export function detectedIdeApps(
  detected: DetectedOpenApp[] | null,
): DetectedOpenApp[] {
  return (detected ?? []).filter((a) => a.kind !== "system");
}

/** Resolve an app id against the detected list, synthesizing the
 *  always-available Finder/Terminal entries when detection hasn't run
 *  (or ran icon-less). Null for an undetected IDE id. */
export function findOpenApp(
  detected: DetectedOpenApp[] | null,
  id: string,
): DetectedOpenApp | null {
  const hit = (detected ?? []).find((a) => a.id === id);
  if (hit) return hit;
  return SYSTEM_APPS.find((a) => a.id === id) ?? null;
}

// ── Default app (what ⌘O / the logo button opens) ─────────

export function getOpenInDefaultId(): string {
  const id = getSetting<string>(DEFAULT_KEY, FINDER_APP_ID);
  return typeof id === "string" && id ? id : FINDER_APP_ID;
}

export function setOpenInDefaultId(id: string): void {
  setSetting(DEFAULT_KEY, id);
  notify();
}

/** Reactive default-app id (raw stored value — resolve before use). */
export function useOpenInDefaultId(): string {
  const [id, setId] = useState<string>(() => getOpenInDefaultId());
  useEffect(() => {
    const sync = () => setId(getOpenInDefaultId());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return id;
}

/** The entry the logo button / ⌘O should act on RIGHT NOW: the stored
 *  default when it's still available, else Finder. */
export function resolveOpenInDefault(
  detected: DetectedOpenApp[] | null,
  defaultId: string,
): DetectedOpenApp {
  return (
    findOpenApp(detected, defaultId) ?? findOpenApp(detected, FINDER_APP_ID)!
  );
}

// ── Open dispatch ─────────────────────────────────────────

/** Open `path` with an app id from the menu. Finder/Terminal keep their
 *  existing dedicated commands (reveal_in_finder / open_in_terminal);
 *  IDE ids go through open_in_app, which resolves the launch target in
 *  the main process from its own probe. Throws on failure so callers
 *  can toast. */
export async function openPathWithApp(
  appId: string,
  path: string,
): Promise<void> {
  if (appId === FINDER_APP_ID) return revealInFinder(path);
  if (appId === TERMINAL_APP_ID) return openInTerminal(path);
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("open_in_app", { appId, path });
}
