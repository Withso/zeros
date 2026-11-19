import { useEffect, useState } from "react";

import { getSetting, setSetting } from "./settings";
import { isNativeRuntime, nativeInvoke } from "./runtime";
import { canOpenPathLocally, openInTerminal, revealInFinder } from "./app";

export type OpenAppKind = "system" | "ide" | "cli";

export interface DetectedOpenApp {
  id: string;
  name: string;
  kind: OpenAppKind;
  /** Main may not have a bundle icon for CLI-only entries; consumers supply fallback artwork. */
  iconDataUrl: string | null;
}

export const FINDER_APP_ID = "finder";
export const TERMINAL_APP_ID = "terminal";

/** Finder and Terminal stay available before detection runs. */
const SYSTEM_APPS: DetectedOpenApp[] = [
  { id: FINDER_APP_ID, name: "Finder", kind: "system", iconDataUrl: null },
  { id: TERMINAL_APP_ID, name: "Terminal", kind: "system", iconDataUrl: null },
];

const DETECTED_KEY = "open-in-detected-apps";
const DEFAULT_KEY = "open-in-default-app";

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

/** null ⇒ detection has never run on this profile (cold cache). */
export function getDetectedOpenApps(): DetectedOpenApp[] | null {
  const raw = getSetting<DetectedOpenApp[] | null>(DETECTED_KEY, null);
  return Array.isArray(raw) ? raw : null;
}

let refreshInFlight: Promise<void> | null = null;

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

export function detectedIdeApps(
  detected: DetectedOpenApp[] | null,
): DetectedOpenApp[] {
  return (detected ?? []).filter((a) => a.kind !== "system");
}

export function findOpenApp(
  detected: DetectedOpenApp[] | null,
  id: string,
): DetectedOpenApp | null {
  const hit = (detected ?? []).find((a) => a.id === id);
  if (hit) return hit;
  return SYSTEM_APPS.find((a) => a.id === id) ?? null;
}

export function getOpenInDefaultId(): string {
  const id = getSetting<string>(DEFAULT_KEY, FINDER_APP_ID);
  return typeof id === "string" && id ? id : FINDER_APP_ID;
}

export function setOpenInDefaultId(id: string): void {
  setSetting(DEFAULT_KEY, id);
  notify();
}

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

/** Fall back at read time without overwriting the user's choice, so reinstalling the app restores it. */
export function resolveOpenInDefault(
  detected: DetectedOpenApp[] | null,
  defaultId: string,
): DetectedOpenApp {
  return (
    findOpenApp(detected, defaultId) ?? findOpenApp(detected, FINDER_APP_ID)!
  );
}

// For IDEs and CLIs, main resolves the installed launch target from the app ID.
export async function openPathWithApp(
  appId: string,
  path: string,
): Promise<void> {
  if (!canOpenPathLocally(path)) return;
  if (appId === FINDER_APP_ID) return revealInFinder(path);
  if (appId === TERMINAL_APP_ID) return openInTerminal(path);
  if (!isNativeRuntime()) return;
  await nativeInvoke<void>("open_in_app", { appId, path });
}
