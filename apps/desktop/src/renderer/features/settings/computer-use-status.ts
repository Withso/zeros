import { useEffect, useSyncExternalStore } from "react";
import {
  readComputerUseStatus,
  type ComputerUseStatus,
} from "@zeros/protocol/computer-use-tools";

import { nativeInvoke } from "../../platform/runtime";
import { pollWhileForeground } from "../../shared/lib/element-activity";

// Both General and Privacy share one poll for this Mac's grants.
let current: ComputerUseStatus | null = null;
const listeners = new Set<() => void>();
let watchers = 0;
let stopPolling: (() => void) | undefined;

function publish(next: ComputerUseStatus): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshComputerUseStatus(): Promise<ComputerUseStatus | null> {
  try {
    const next = readComputerUseStatus(
      await nativeInvoke<unknown>("computer_use_status"),
    );
    // A malformed answer keeps the last confirmed state on screen.
    if (next) publish(next);
    return next;
  } catch {
    // No native bridge (web preview): the permission rows stay out.
    return null;
  }
}

export async function requestComputerUsePermissions(): Promise<ComputerUseStatus | null> {
  const next = readComputerUseStatus(
    await nativeInvoke<unknown>("computer_use_permissions_request"),
  );
  if (next) publish(next);
  return next;
}

// Users change grants in System Settings; refresh when the window returns to the foreground.
export function watchComputerUseStatus(): () => void {
  if (watchers++ === 0) {
    stopPolling = pollWhileForeground(() => void refreshComputerUseStatus(), 5000);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--watchers === 0) {
      stopPolling?.();
      stopPolling = undefined;
    }
  };
}

export function useComputerUseStatus(active: boolean): ComputerUseStatus | null {
  useEffect(() => (active ? watchComputerUseStatus() : undefined), [active]);
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
