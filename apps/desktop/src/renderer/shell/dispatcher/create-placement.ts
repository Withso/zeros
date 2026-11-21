import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../../platform/settings";

export type CreatePlacement = "local" | "cloud";

/** A device preference: the last place Create made a workspace. */
const KEY = "create:placement:v1";
const listeners = new Set<() => void>();

function saved(): CreatePlacement | null {
  const value = getSetting<unknown>(KEY, null);
  return value === "local" || value === "cloud" ? value : null;
}

export function rememberCreatePlacement(placement: CreatePlacement): void {
  if (saved() === placement) return;
  setSetting(KEY, placement);
  for (const listener of [...listeners]) listener();
}

/** Without cloud the control is hidden and Create is on this Mac. Without a
 * saved choice, a device with no local projects starts in the cloud only
 * where this owner can create there; otherwise This Mac's start actions lead. */
export function resolveCreatePlacement({
  savedPlacement,
  cloudAvailable,
  cloudCreatable = true,
  hasLocalProjects,
}: {
  savedPlacement: CreatePlacement | null;
  cloudAvailable: boolean;
  cloudCreatable?: boolean;
  hasLocalProjects: boolean;
}): CreatePlacement {
  if (!cloudAvailable) return "local";
  return savedPlacement ?? (hasLocalProjects || !cloudCreatable ? "local" : "cloud");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSavedCreatePlacement(): CreatePlacement | null {
  return useSyncExternalStore(subscribe, saved, saved);
}
