import { useEffect, useSyncExternalStore } from "react";
import {
  readSimulatorHubSnapshot,
  type SimulatorDevice,
  type SimulatorHubSnapshot,
  type SimulatorPlatform,
  type SimulatorSetupStatus,
} from "@zeros/protocol/simulators";

import { nativeListen } from "../../platform/runtime";
import { readSimulatorHub, refreshSimulatorHub } from "./simulator-api";
import { documentIsForeground, observeForeground } from "../../shared/lib/element-activity";

// DeviceHub in main owns the devices. The renderer mirrors its latest
// snapshot: main sends one whenever something changes, and the first
// Simulator tab reads it once, which is also what starts DeviceHub's device
// tools. Nothing here runs at app launch beyond listening.

export interface SimulatorHubState {
  snapshot: SimulatorHubSnapshot | null;
  /** Why the last read failed; the last snapshot stays. */
  error: string | null;
  loading: boolean;
}

const EMPTY: SimulatorHubState = { snapshot: null, error: null, loading: false };

let state: SimulatorHubState = EMPTY;
const listeners = new Set<() => void>();
let listening: Promise<void> | null = null;
let read: Promise<void> | null = null;
let readOnce = false;
/** Bumped by every live snapshot, so a read that overlapped one is dropped. */
let liveSerial = 0;

function update(next: Partial<SimulatorHubState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** A snapshot from main. A malformed one is ignored. */
export function acceptSimulatorHubSnapshot(value: unknown): boolean {
  const snapshot = readSimulatorHubSnapshot(value);
  if (!snapshot) return false;
  liveSerial += 1;
  update({ snapshot, error: null });
  return true;
}

/** Follows main's snapshots for the rest of the session. */
export function listenToSimulatorHub(): Promise<void> {
  listening ??= nativeListen<unknown>(
    "simulator-hub-state",
    acceptSimulatorHubSnapshot,
  ).then(
    () => undefined,
    () => {
      listening = null;
    },
  );
  return listening;
}

/** Reads the hub, sharing one read between callers. */
export function loadSimulatorHub(): Promise<void> {
  if (read) return read;
  update({ loading: true });
  read = (async () => {
    try {
      await listenToSimulatorHub();
      const serial = liveSerial;
      const snapshot = await readSimulatorHub();
      readOnce = true;
      // Main emits on every change, so a snapshot that arrived during the
      // read is at least as new as the read's reply.
      update(serial === liveSerial ? { snapshot, error: null } : { error: null });
    } catch (error) {
      update({
        error: error instanceof Error ? error.message : "Zeros couldn't read the simulators.",
      });
    } finally {
      read = null;
      update({ loading: false });
    }
  })();
  return read;
}

/** Starts the first read on intent to open a Simulator tab. */
export function warmSimulatorHub(): void {
  if (!readOnce) void loadSimulatorHub();
}

/** How often a followed hub is re-read. */
export const SIMULATOR_HUB_FOLLOW_MS = 10_000;

let followers = 0;
let followTimer: ReturnType<typeof setInterval> | null = null;
let stopFollowActivity: (() => void) | null = null;
let followRead: Promise<unknown> | null = null;

function refreshFollowed(): void {
  if (!followers || !documentIsForeground() || followRead) return;
  // Main publishes what the read finds; a failed read keeps the last snapshot.
  const request = refreshSimulatorHub().catch(() => undefined).finally(() => {
    if (followRead === request) followRead = null;
  });
  followRead = request;
}

function scheduleFollowing(refresh: boolean): void {
  if (followTimer !== null) clearInterval(followTimer);
  followTimer = null;
  if (!followers || !documentIsForeground()) return;
  if (refresh) refreshFollowed();
  followTimer = setInterval(refreshFollowed, SIMULATOR_HUB_FOLLOW_MS);
}

/** Main re-reads devices only while one is on screen, so a tab that shows
 * none follows the hub itself: a device started or made outside Zeros, from
 * Xcode or a terminal, then shows up. Shared by every follower until the
 * last lets go. */
export function followSimulatorHub(): () => void {
  followers += 1;
  if (followers === 1) {
    stopFollowActivity = observeForeground(() => scheduleFollowing(true));
    // The tab's first read is already on its way; a hub read earlier may be
    // out of date by now.
    scheduleFollowing(readOnce);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    followers -= 1;
    if (followers === 0) stopFollowing();
  };
}

function stopFollowing(): void {
  if (followTimer !== null) clearInterval(followTimer);
  followTimer = null;
  stopFollowActivity?.();
  stopFollowActivity = null;
}

/** Follows the hub while `on`. */
export function useFollowSimulatorHub(on: boolean): void {
  useEffect(() => (on ? followSimulatorHub() : undefined), [on]);
}

export function simulatorHubState(): SimulatorHubState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The hub as a Simulator tab sees it. The first mounted tab reads it. */
export function useSimulatorHub(): SimulatorHubState {
  useEffect(() => {
    if (!readOnce) void loadSimulatorHub();
  }, []);
  return useSyncExternalStore(subscribe, simulatorHubState, simulatorHubState);
}

/** Follows the hub without reading it, for app-wide notices. */
export function useSimulatorHubSnapshot(): SimulatorHubSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => state.snapshot,
    () => state.snapshot,
  );
}

export function simulatorSetup(
  snapshot: SimulatorHubSnapshot | null,
  platform: SimulatorPlatform,
): SimulatorSetupStatus | null {
  return snapshot?.setup.find((entry) => entry.platform === platform) ?? null;
}

export function simulatorDevice(
  snapshot: SimulatorHubSnapshot | null,
  deviceId: string | undefined,
): SimulatorDevice | null {
  if (!deviceId) return null;
  return snapshot?.devices.find((device) => device.id === deviceId) ?? null;
}

export function resetSimulatorHubForTests(): void {
  state = EMPTY;
  listening = null;
  read = null;
  readOnce = false;
  liveSerial = 0;
  stopFollowing();
  followRead = null;
  followers = 0;
  for (const listener of listeners) listener();
}
