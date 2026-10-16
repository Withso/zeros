// Simulator tab calls into DeviceHub in Electron main. Every reply is
// validated here, so the tab only ever renders checked shapes.

import {
  readSimulatorAnnotationSnapshot,
  readSimulatorCapture,
  readSimulatorCaptureFile,
  readSimulatorRecording,
  readSimulatorRecordingTimeline,
  readSimulatorRecordings,
  type SimulatorAnnotationSnapshot,
  type SimulatorCapture,
  type SimulatorCaptureFile,
  type SimulatorRecording,
  type SimulatorRecordingTimeline,
  type SimulatorRecordingsSnapshot,
} from "@zeros/protocol/simulator-captures";
import {
  isSimulatorDeviceId,
  readSimulatorBootWarnings,
  readSimulatorDeviceShape,
  readSimulatorFrame,
  readSimulatorHubSnapshot,
  readSimulatorViewStart,
  type SimulatorAppearance,
  type SimulatorBootOutcome,
  type SimulatorBootWarning,
  type SimulatorDeviceShape,
  type SimulatorFrame,
  type SimulatorHubSnapshot,
  type SimulatorInput,
  type SimulatorOrientation,
  type SimulatorPreferences,
  type SimulatorScreen,
  type SimulatorTouch,
  type SimulatorViewStart,
} from "@zeros/protocol/simulators";

import { nativeInvoke, nativeListen } from "../../platform/runtime";

function unreadable(): never {
  throw new Error("Zeros couldn't read the simulators.");
}

function unreadableCapture(): never {
  throw new Error("Zeros couldn't read the capture.");
}

export async function readSimulatorHub(): Promise<SimulatorHubSnapshot> {
  const value = await nativeInvoke<unknown>("simulator_hub_state");
  return readSimulatorHubSnapshot(value) ?? unreadable();
}

/** Re-reads each platform's setup and devices ("Check again"). */
export async function refreshSimulatorHub(): Promise<SimulatorHubSnapshot> {
  const value = await nativeInvoke<unknown>("simulator_hub_refresh");
  return readSimulatorHubSnapshot(value) ?? unreadable();
}

export async function simulatorBootWarnings(
  deviceId: string,
): Promise<SimulatorBootWarning[]> {
  const value = await nativeInvoke<unknown>("simulator_boot_warnings", { deviceId });
  return readSimulatorBootWarnings(value);
}

export async function bootSimulator(deviceId: string): Promise<SimulatorBootOutcome> {
  const outcome = await nativeInvoke<unknown>("simulator_boot", { deviceId });
  return outcome === "booted" || outcome === "cancelled" ? outcome : unreadable();
}

export async function cancelSimulatorBoot(deviceId: string): Promise<void> {
  await nativeInvoke<unknown>("simulator_boot_cancel", { deviceId });
}

export async function shutDownSimulator(deviceId: string): Promise<void> {
  await nativeInvoke<unknown>("simulator_shutdown", { deviceId });
}

export async function startSimulatorView(deviceId: string): Promise<SimulatorViewStart> {
  const value = await nativeInvoke<unknown>("simulator_view_start", { deviceId });
  return readSimulatorViewStart(value) ?? unreadable();
}

export function stopSimulatorView(viewId: string): void {
  void nativeInvoke<unknown>("simulator_view_stop", { viewId }).catch(() => {});
}

export async function sendSimulatorInput(
  deviceId: string,
  input: SimulatorInput,
): Promise<void> {
  await nativeInvoke<unknown>("simulator_input", { deviceId, input });
}

/** One step of the user's finger on an open live view, as it happens. */
export async function sendSimulatorTouch(
  deviceId: string,
  viewId: string,
  touch: SimulatorTouch,
): Promise<void> {
  await nativeInvoke<unknown>("simulator_touch", { deviceId, viewId, touch });
}

export async function readSimulatorAppearance(
  deviceId: string,
): Promise<SimulatorAppearance | null> {
  const value = await nativeInvoke<unknown>("simulator_appearance", { deviceId });
  return value === "light" || value === "dark" ? value : null;
}

export async function setSimulatorAppearance(
  deviceId: string,
  appearance: SimulatorAppearance,
): Promise<void> {
  await nativeInvoke<unknown>("simulator_appearance_set", { deviceId, appearance });
}

/** Turns the device; DeviceHub publishes its new orientation as the turn
 * starts, and the old one again if it fails. */
export async function rotateSimulator(
  deviceId: string,
  orientation: SimulatorOrientation,
): Promise<void> {
  await nativeInvoke<unknown>("simulator_rotate", { deviceId, orientation });
}

/** The control bar's Stop: ends the agent's use of the device, not its turn.
 * False when no agent was using it. */
export async function stopSimulatorAgent(deviceId: string): Promise<boolean> {
  return (await nativeInvoke<unknown>("simulator_agent_stop", { deviceId })) === true;
}

/** "Keep running" on the idle-shutdown notice. */
export async function keepSimulatorRunning(deviceId: string): Promise<void> {
  await nativeInvoke<unknown>("simulator_keep_running", { deviceId });
}

/** False when a download is already running or Xcode can't take one. */
export async function installSimulatorRuntime(): Promise<boolean> {
  return (await nativeInvoke<unknown>("simulator_runtime_install")) === true;
}

export async function cancelSimulatorRuntimeInstall(): Promise<void> {
  await nativeInvoke<unknown>("simulator_runtime_install_cancel");
}

/** Setup's "Create device"; resolves to the new device's id once the hub
 * lists it. */
export async function createAndroidDevice(): Promise<string> {
  const deviceId = await nativeInvoke<unknown>("simulator_android_device_create");
  return isSimulatorDeviceId(deviceId) ? deviceId : unreadable();
}

/** False when the last check found no Android Studio to open. */
export async function openAndroidStudio(): Promise<boolean> {
  return (await nativeInvoke<unknown>("simulator_android_studio_open")) === true;
}

export async function updateSimulatorPreferences(
  preferences: SimulatorPreferences,
): Promise<void> {
  await nativeInvoke<unknown>("simulator_preferences_update", { ...preferences });
}

/** The device's screen and its platform's frame for it, in any state. Null
 * when Zeros can't show the device. */
export async function loadSimulatorDeviceShape(
  deviceId: string,
): Promise<SimulatorDeviceShape | null> {
  const value = await nativeInvoke<unknown>("simulator_device_shape", { deviceId });
  return value === null ? null : readSimulatorDeviceShape(value);
}

function deviceCapture(
  value: unknown,
  deviceId: string,
  kind: SimulatorCapture["kind"],
): SimulatorCapture {
  const capture = readSimulatorCapture(value);
  return capture?.deviceId === deviceId && capture.kind === kind ? capture : unreadableCapture();
}

/** Saves the device's screen to Downloads. */
export async function takeSimulatorScreenshot(deviceId: string): Promise<SimulatorCapture> {
  const value = await nativeInvoke<unknown>("simulator_screenshot", { deviceId });
  return deviceCapture(value, deviceId, "screenshot");
}

/** Starts recording the device, or answers with the recording already
 * running. */
export async function startSimulatorRecording(deviceId: string): Promise<SimulatorRecording> {
  const value = await nativeInvoke<unknown>("simulator_recording_start", { deviceId });
  const recording = readSimulatorRecording(value);
  return recording?.deviceId === deviceId ? recording : unreadableCapture();
}

/** Stops the device's recording and saves it to Downloads. */
export async function stopSimulatorRecording(deviceId: string): Promise<SimulatorCapture> {
  const value = await nativeInvoke<unknown>("simulator_recording_stop", { deviceId });
  return deviceCapture(value, deviceId, "recording");
}

/** Which devices are recording now; main sends changes as they happen. */
export async function loadSimulatorRecordings(): Promise<SimulatorRecordingsSnapshot> {
  const value = await nativeInvoke<unknown>("simulator_recordings");
  return readSimulatorRecordings(value) ?? unreadableCapture();
}

/** A capture's bytes, for Add to chat. */
export async function loadSimulatorCaptureFile(captureId: string): Promise<SimulatorCaptureFile> {
  const value = await nativeInvoke<unknown>("simulator_capture_file", { captureId });
  return readSimulatorCaptureFile(value) ?? unreadableCapture();
}

/** Hands the capture's saved file to the drag that is starting, so it drops
 * as a real file. Call from `dragstart`. */
export async function dragSimulatorCapture(captureId: string): Promise<void> {
  await nativeInvoke<unknown>("simulator_capture_drag", { captureId });
}

/** What happened during a recording, found by the video's fingerprint. Null
 * for a video Zeros didn't record, or one whose timeline is gone. */
export async function loadSimulatorRecordingTimeline(
  fingerprint: string,
): Promise<SimulatorRecordingTimeline | null> {
  const value = await nativeInvoke<unknown>("simulator_recording_timeline", { fingerprint });
  return value === null ? null : readSimulatorRecordingTimeline(value);
}

/** The device's screen as it is now, with what is on it, for Annotate. */
export async function loadSimulatorAnnotationSnapshot(
  deviceId: string,
): Promise<SimulatorAnnotationSnapshot> {
  const value = await nativeInvoke<unknown>("simulator_annotation_snapshot", { deviceId });
  return readSimulatorAnnotationSnapshot(value) ?? unreadableCapture();
}

type FrameHandler = (frame: SimulatorFrame) => void;

// One native subscription fans frames out by view, so a frame is checked once
// however many Simulator tabs are open. Main sends a view's first frame as it
// opens the view, which can beat its reply here, so the latest frames of views
// nobody has claimed yet are kept for a moment.
const frameHandlers = new Map<string, FrameHandler>();
const unclaimedFrames = new Map<string, SimulatorFrame>();
const MAX_UNCLAIMED_FRAMES = 4;
let frameUsers = 0;
let frameSubscription: Promise<() => void> | null = null;

function deliverFrame(payload: unknown): void {
  const frame = readSimulatorFrame(payload);
  if (!frame) return;
  const handler = frameHandlers.get(frame.viewId);
  if (handler) {
    handler(frame);
    return;
  }
  unclaimedFrames.delete(frame.viewId);
  unclaimedFrames.set(frame.viewId, frame);
  for (const viewId of unclaimedFrames.keys()) {
    if (unclaimedFrames.size <= MAX_UNCLAIMED_FRAMES) break;
    unclaimedFrames.delete(viewId);
  }
}

function retainFrames(): Promise<() => void> {
  frameUsers += 1;
  frameSubscription ??= nativeListen<unknown>("simulator-frame", deliverFrame);
  return frameSubscription;
}

function releaseFrames(): void {
  frameUsers = Math.max(0, frameUsers - 1);
  if (frameUsers > 0 || !frameSubscription) return;
  const subscription = frameSubscription;
  frameSubscription = null;
  unclaimedFrames.clear();
  void subscription.then(
    (unlisten) => unlisten(),
    () => undefined,
  );
}

export interface SimulatorView {
  viewId: string;
  screen: SimulatorScreen;
  close(): void;
}

/** Opens a live view of a running device. `onFrame` gets every frame from the
 * first, which may arrive before this resolves. */
export async function openSimulatorView(
  deviceId: string,
  onFrame: FrameHandler,
): Promise<SimulatorView> {
  let start: SimulatorViewStart;
  try {
    await retainFrames();
    start = await startSimulatorView(deviceId);
  } catch (error) {
    releaseFrames();
    throw error;
  }
  const { viewId } = start;
  frameHandlers.set(viewId, onFrame);
  const first = unclaimedFrames.get(viewId);
  unclaimedFrames.delete(viewId);
  if (first) onFrame(first);
  let open = true;
  return {
    viewId,
    screen: start.screen,
    close() {
      if (!open) return;
      open = false;
      if (frameHandlers.get(viewId) === onFrame) frameHandlers.delete(viewId);
      unclaimedFrames.delete(viewId);
      stopSimulatorView(viewId);
      releaseFrames();
    },
  };
}
