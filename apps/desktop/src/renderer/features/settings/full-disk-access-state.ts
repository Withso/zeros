import type { FullDiskAccessSnapshot } from "../../../../shared/full-disk-access";
import { nativeInvoke } from "../../platform/runtime";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { documentIsVisible } from "../../state/use-document-active";

// Device state belongs to this desktop process, regardless of selected owner
// or workspace placement. It is never synced to settings.toml or the cloud.
export const FULL_DISK_ACCESS_KEY = "this-mac";
export const fullDiskAccessCache = new KeyedAsyncCache<FullDiskAccessSnapshot>(
  1,
);
let observers = 0;
let stopObservation: (() => void) | undefined;

export function parseFullDiskAccessSnapshot(
  value: unknown,
): FullDiskAccessSnapshot {
  const snapshot = value as Partial<FullDiskAccessSnapshot> | null;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !["available", "denied", "unknown", "unsupported"].includes(
      snapshot.status ?? "",
    ) ||
    typeof snapshot.appName !== "string" ||
    !snapshot.appName.trim() ||
    snapshot.appName.length > 256 ||
    typeof snapshot.canRevealApp !== "boolean"
  ) {
    throw new Error("Could not verify Full Disk Access.");
  }
  return {
    status: snapshot.status!,
    appName: snapshot.appName,
    canRevealApp: snapshot.canRevealApp,
  };
}

export function observeFullDiskAccess(): () => void {
  if (observers++ === 0) {
    const invalidate = () =>
      fullDiskAccessCache.invalidate(FULL_DISK_ACCESS_KEY);
    window.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    stopObservation = () => {
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--observers === 0) {
      stopObservation?.();
      stopObservation = undefined;
      // A late reply must not become fresh while the Settings panel is hidden.
      fullDiskAccessCache.invalidate(FULL_DISK_ACCESS_KEY);
    }
  };
}

export async function readFullDiskAccess(): Promise<FullDiskAccessSnapshot> {
  const requireVisibleObserver = () => {
    if (!observers || !documentIsVisible()) {
      fullDiskAccessCache.invalidate(FULL_DISK_ACCESS_KEY);
      throw new Error("Full Disk Access checking is inactive.");
    }
  };
  // An already-queued cache refresh may outlive the last visible observer.
  requireVisibleObserver();
  try {
    return parseFullDiskAccessSnapshot(
      await nativeInvoke<unknown>("full_disk_access_status"),
    );
  } finally {
    // Retire failures as well as successful replies if visibility changed
    // before React or the visibility event could detach this observer.
    requireVisibleObserver();
  }
}
