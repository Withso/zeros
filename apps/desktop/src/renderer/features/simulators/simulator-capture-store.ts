import { useCallback, useSyncExternalStore } from "react";
import {
  readSimulatorRecordingEnd,
  readSimulatorRecordings,
  type SimulatorCapture,
  type SimulatorRecordingEnd,
} from "@zeros/protocol/simulator-captures";

import { nativeListen } from "../../platform/runtime";
import { loadSimulatorRecordings } from "./simulator-api";

// Main owns captures and recordings. The renderer mirrors which devices are
// recording, keeps the thumbnails of captures the user just made, and hands
// screenshot flashes to the screens showing that device.

/** How long a thumbnail stays on its own. */
export const CAPTURE_THUMBNAIL_MS = 5_000;
/** After the pointer leaves, a thumbnail stays at least this much longer. */
export const CAPTURE_THUMBNAIL_LINGER_MS = 1_500;
/** Thumbnails shown at once; the oldest leaves when another arrives. */
export const MAX_CAPTURE_THUMBNAILS = 3;

export interface CaptureThumbnailTimers {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: CaptureThumbnailTimers = {
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Countdown {
  /** When it leaves, while nothing holds the thumbnails. */
  deadline: number;
  /** What was left when a hold began. */
  remaining: number | null;
  timer: unknown;
}

/** The thumbnails at the bottom right, newest first. Each leaves after a
 * while unless something holds them: the pointer, focus or a drag. */
export class CaptureThumbnails {
  private shown: readonly SimulatorCapture[] = [];
  private readonly countdowns = new Map<string, Countdown>();
  private readonly listeners = new Set<() => void>();
  private holds = 0;

  constructor(private readonly timers: CaptureThumbnailTimers = REAL_TIMERS) {}

  current(): readonly SimulatorCapture[] {
    return this.shown;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  show(capture: SimulatorCapture): void {
    const next = [capture, ...this.shown.filter((entry) => entry.id !== capture.id)];
    for (const dropped of next.slice(MAX_CAPTURE_THUMBNAILS)) this.stopCountdown(dropped.id);
    this.shown = next.slice(0, MAX_CAPTURE_THUMBNAILS);
    this.stopCountdown(capture.id);
    this.startCountdown(capture.id, CAPTURE_THUMBNAIL_MS);
    this.notify();
  }

  dismiss(captureId: string): void {
    if (!this.shown.some((entry) => entry.id === captureId)) return;
    this.stopCountdown(captureId);
    this.shown = this.shown.filter((entry) => entry.id !== captureId);
    this.notify();
  }

  /** Keeps every thumbnail until the returned release runs. */
  hold(): () => void {
    this.holds += 1;
    if (this.holds === 1) {
      const now = this.timers.now();
      for (const countdown of this.countdowns.values()) {
        this.timers.clear(countdown.timer);
        countdown.timer = null;
        countdown.remaining = Math.max(0, countdown.deadline - now);
      }
    }
    let released = false;
    return () => {
      if (released || this.holds === 0) return;
      released = true;
      this.holds -= 1;
      if (this.holds > 0) return;
      for (const [captureId, countdown] of [...this.countdowns]) {
        const remaining = Math.max(countdown.remaining ?? 0, CAPTURE_THUMBNAIL_LINGER_MS);
        this.countdowns.delete(captureId);
        this.startCountdown(captureId, remaining);
      }
    };
  }

  clear(): void {
    for (const captureId of [...this.countdowns.keys()]) this.stopCountdown(captureId);
    this.holds = 0;
    if (this.shown.length === 0) return;
    this.shown = [];
    this.notify();
  }

  private startCountdown(captureId: string, ms: number): void {
    const countdown: Countdown = {
      deadline: this.timers.now() + ms,
      remaining: this.holds > 0 ? ms : null,
      timer: null,
    };
    if (this.holds === 0) {
      countdown.timer = this.timers.set(() => {
        if (this.countdowns.get(captureId) === countdown) this.dismiss(captureId);
      }, ms);
    }
    this.countdowns.set(captureId, countdown);
  }

  private stopCountdown(captureId: string): void {
    const countdown = this.countdowns.get(captureId);
    if (!countdown) return;
    this.timers.clear(countdown.timer);
    this.countdowns.delete(captureId);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const captureThumbnails = new CaptureThumbnails();

const subscribeThumbnails = (listener: () => void) => captureThumbnails.subscribe(listener);
const currentThumbnails = () => captureThumbnails.current();

export function useCaptureThumbnails(): readonly SimulatorCapture[] {
  return useSyncExternalStore(subscribeThumbnails, currentThumbnails, currentThumbnails);
}

// ── Recordings ─────────────────────────────────────────────

let recordings: ReadonlyMap<string, number> = new Map();
const recordingListeners = new Set<() => void>();

/** Accept main's snapshot of which devices are recording. A malformed one is
 * ignored. */
export function acceptSimulatorRecordings(value: unknown): boolean {
  const snapshot = readSimulatorRecordings(value);
  if (!snapshot) return false;
  recordings = new Map(
    snapshot.recordings.map((recording) => [recording.deviceId, recording.startedAt]),
  );
  for (const listener of recordingListeners) listener();
  return true;
}

/** When the device's recording began, or null when it isn't recording. */
export function simulatorRecordingStartedAt(deviceId: string): number | null {
  return recordings.get(deviceId) ?? null;
}

function subscribeRecordings(listener: () => void): () => void {
  recordingListeners.add(listener);
  return () => {
    recordingListeners.delete(listener);
  };
}

export function useSimulatorRecordingStartedAt(deviceId: string): number | null {
  const read = useCallback(() => simulatorRecordingStartedAt(deviceId), [deviceId]);
  return useSyncExternalStore(subscribeRecordings, read, read);
}

/** Follows main's recordings, and hands each recording that ended without
 * the tab's Stop to `onEnd`, until the returned function runs. */
export function followSimulatorCaptures(onEnd: (end: SimulatorRecordingEnd) => void): () => void {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  // Main emits on every change, so a snapshot that arrived while the first
  // read was out is at least as new as its reply.
  let liveSnapshotSeen = false;
  const keep = (unlisten: () => void) => {
    if (disposed) unlisten();
    else unlisteners.push(unlisten);
  };
  void nativeListen<unknown>("simulator-recording-end", (value) => {
    const end = readSimulatorRecordingEnd(value);
    if (end && !disposed) onEnd(end);
  })
    .then(keep)
    .catch(() => undefined);
  void nativeListen<unknown>("simulator-recordings", (value) => {
    liveSnapshotSeen = true;
    acceptSimulatorRecordings(value);
  })
    .then(async (unlisten) => {
      keep(unlisten);
      if (disposed) return;
      const snapshot = await loadSimulatorRecordings();
      if (!disposed && !liveSnapshotSeen) acceptSimulatorRecordings(snapshot);
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}

// ── Screenshot flashes ─────────────────────────────────────

const flashListeners = new Map<string, Set<() => void>>();

/** Flashes the screens showing `deviceId`, as a screenshot is taken. */
export function flashSimulatorScreen(deviceId: string): void {
  for (const listener of flashListeners.get(deviceId) ?? []) listener();
}

export function listenToSimulatorFlashes(deviceId: string, listener: () => void): () => void {
  let set = flashListeners.get(deviceId);
  if (!set) {
    set = new Set();
    flashListeners.set(deviceId, set);
  }
  set.add(listener);
  return () => {
    const current = flashListeners.get(deviceId);
    current?.delete(listener);
    if (current?.size === 0) flashListeners.delete(deviceId);
  };
}

export function resetSimulatorCapturesForTests(): void {
  captureThumbnails.clear();
  recordings = new Map();
  for (const listener of recordingListeners) listener();
  flashListeners.clear();
}
