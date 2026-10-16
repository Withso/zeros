import { useCallback, useSyncExternalStore } from "react";
import {
  deviceUseHolder,
  readDeviceAgentTouch,
  readDeviceUseState,
  type DeviceAgentTouch,
  type DeviceUseHolder,
  type DeviceUseStateSnapshot,
} from "@zeros/protocol/device-tools";

import { nativeInvoke, nativeListen } from "../../platform/runtime";

// Main owns which chat uses which simulator. The renderer keeps its latest
// snapshot for the control bars, and hands each agent touch straight to the
// screens showing that device: touches are drawn once, never kept.

let state: DeviceUseStateSnapshot | null = null;
const listeners = new Set<() => void>();
const touchListeners = new Map<string, Set<(touch: DeviceAgentTouch) => void>>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Accept one snapshot from main. A malformed one is ignored. */
export function publishSimulatorAgentState(value: unknown): boolean {
  const next = readDeviceUseState(value);
  if (!next) return false;
  state = next;
  notify();
  return true;
}

export function clearSimulatorAgentState(): void {
  if (!state) return;
  state = null;
  notify();
}

export function simulatorAgentState(): DeviceUseStateSnapshot | null {
  return state;
}

/** The chat using `deviceId`, as the same object until main publishes again. */
export function simulatorAgentHolder(deviceId: string): DeviceUseHolder | null {
  return deviceUseHolder(state, deviceId);
}

export function subscribeSimulatorAgentState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSimulatorAgentHolder(deviceId: string): DeviceUseHolder | null {
  const getSnapshot = useCallback(() => simulatorAgentHolder(deviceId), [deviceId]);
  return useSyncExternalStore(subscribeSimulatorAgentState, getSnapshot, () => null);
}

/** Accept one touch from main and pass it to the screens showing its device. */
export function publishSimulatorAgentTouch(value: unknown): boolean {
  const touch = readDeviceAgentTouch(value);
  if (!touch) return false;
  for (const listener of touchListeners.get(touch.deviceId) ?? []) listener(touch);
  return true;
}

export function listenToSimulatorAgentTouches(
  deviceId: string,
  listener: (touch: DeviceAgentTouch) => void,
): () => void {
  let set = touchListeners.get(deviceId);
  if (!set) {
    set = new Set();
    touchListeners.set(deviceId, set);
  }
  set.add(listener);
  return () => {
    const current = touchListeners.get(deviceId);
    current?.delete(listener);
    if (current?.size === 0) touchListeners.delete(deviceId);
  };
}

/** Follows main's holders and touches until the returned function runs. */
export function followSimulatorAgents(): () => void {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  // A live event beats the recovery read: main emits on every change, so an
  // older snapshot must not overwrite one that arrived while it loaded.
  let liveEventSeen = false;
  const keep = (unlisten: () => void) => {
    if (disposed) unlisten();
    else unlisteners.push(unlisten);
  };
  void nativeListen<unknown>("simulator-agent-touch", publishSimulatorAgentTouch)
    .then(keep)
    .catch(() => undefined);
  void nativeListen<unknown>("simulator-agent-state", (value) => {
    liveEventSeen = true;
    publishSimulatorAgentState(value);
  })
    .then(async (unlisten) => {
      keep(unlisten);
      if (disposed) return;
      const snapshot = await nativeInvoke<unknown>("simulator_agent_state");
      if (!disposed && !liveEventSeen) publishSimulatorAgentState(snapshot);
    })
    .catch(() => {
      if (!disposed) clearSimulatorAgentState();
    });
  return () => {
    disposed = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
    clearSimulatorAgentState();
  };
}
