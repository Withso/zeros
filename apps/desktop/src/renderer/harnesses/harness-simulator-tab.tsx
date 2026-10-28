// Development-only DeviceHub. The real Simulator tab, its frame, toolbar and
// island run against in-memory devices that paint JPEG frames; no simulator,
// Xcode or native process is involved. `?settings` shows Settings →
// Simulators against the same devices and an in-memory settings file.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import "../features/settings/settings-page.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentControlFamily } from "@zeros/protocol/browser-tools";
import type { DeviceAgentTouch, DeviceUseHolder } from "@zeros/protocol/device-tools";
import type { ConversationId, WorkspaceId } from "@zeros/protocol/identities";
import type {
  SimulatorAnnotationSnapshot,
  SimulatorCapture,
  SimulatorRecordingEndReason,
  SimulatorUiElement,
} from "@zeros/protocol/simulator-captures";
import {
  DEFAULT_SIMULATOR_SETTINGS,
  readSimulatorTouch,
  simulatorPressGesture,
  type SimulatorAppearance,
  type SimulatorBootOutcome,
  type SimulatorDevice,
  type SimulatorDeviceFrame,
  type SimulatorDeviceState,
  type SimulatorHubSnapshot,
  type SimulatorInput,
  type SimulatorOrientation,
  type SimulatorScreen,
  type SimulatorSetupStatus,
  type SimulatorTouch,
} from "@zeros/protocol/simulators";

import { setActiveBridge } from "../platform/bridge/active-bridge";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { BridgeMessage } from "../platform/bridge/messages";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import type { ChatThread } from "../state/store";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { toast } from "../shared/ui/primitives/elements";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { SimulatorsPanel } from "../features/settings/simulators-panel";
import { registerLiveChatFileStager } from "../features/agent/composer-file-attachment-delivery";
import { SimulatorAgentController } from "../features/simulators/simulator-agent-controller";
import {
  followSimulatorAnnotationTabs,
  leaveSimulatorAnnotation,
} from "../features/simulators/simulator-annotation-actions";
import { SimulatorAnnotationLeaveDialog } from "../features/simulators/simulator-annotation-dialog";
import { simulatorAnnotations } from "../features/simulators/simulator-annotation-store";
import { showRecordingEnd } from "../features/simulators/simulator-capture-actions";
import { SimulatorCaptureStack } from "../features/simulators/simulator-capture-stack";
import { followSimulatorCaptures } from "../features/simulators/simulator-capture-store";
import { orientationTurns, turnedArea } from "../features/simulators/simulator-geometry";
import { WorkbenchTabContent } from "../shell/workbench/tab-content";
import { createSimulatorTab } from "../shell/workbench/tab-model";
import { selectWorkbench, useWorkspaceStore } from "../state/workspace-store";
import { warmSimulatorTab } from "../features/simulators/simulator-tab";

const params = new URLSearchParams(location.search);
const cloudTarget = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = params.has("cloud")
  ? cloudWorkspaceKey(cloudTarget)
  : "/simulator-fixture/app";

const SCREENS: Record<SimulatorDevice["formFactor"], SimulatorScreen> = {
  phone: { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 55 },
  tablet: { widthPx: 1640, heightPx: 2360, scale: 2, cornerRadius: 18 },
};
const ANDROID_SCREEN: SimulatorScreen = {
  widthPx: 1080,
  heightPx: 2424,
  scale: 2.625,
  cornerRadius: 33,
};

function screenOf(target: SimulatorDevice): SimulatorScreen {
  return target.platform === "android" ? ANDROID_SCREEN : SCREENS[target.formFactor];
}

/** `?android` opens an Android tab, with Android setup that has no device
 * until "Create device" makes one. */
const android = params.has("android");
const CREATED_ANDROID: SimulatorDevice = {
  id: "Pixel_10_API_37",
  platform: "android",
  name: "Pixel 10",
  osLabel: "Android 17",
  formFactor: "phone",
  state: "shutdown",
  bootedByZeros: false,
};

const devices: SimulatorDevice[] = [
  {
    id: "FIXTURE-IPAD",
    platform: "ios",
    name: "iPad Air 11-inch (M3)",
    osLabel: "iOS 26.0",
    formFactor: "tablet",
    state: "booted",
    bootedByZeros: false,
  },
  {
    id: "FIXTURE-IPHONE",
    platform: "ios",
    name: "iPhone 17 Pro",
    osLabel: "iOS 26.0",
    formFactor: "phone",
    state: "shutdown",
    bootedByZeros: false,
  },
];

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const inputs: { deviceId: string; input: SimulatorInput }[] = [];
/** Each step of the user's finger as it reached the device. */
const touches: { deviceId: string; viewId: string; phase: SimulatorTouch["phase"] }[] = [];
const presses = new Map<string, { start: SimulatorTouch; startedAt: number }>();
const appearances = new Map<string, SimulatorAppearance>();
const views = new Map<string, { deviceId: string; timer: number; seq: number }>();
const boots = new Map<string, (outcome: SimulatorBootOutcome) => void>();
const calls: string[] = [];
const rotations: { deviceId: string; orientation: SimulatorOrientation }[] = [];
const agentStops: string[] = [];
let holders: DeviceUseHolder[] = [];
let reveals = 0;
let nextView = 0;
let framesSent = 0;
let failAppearance = false;
let iosSetup: SimulatorSetupStatus = {
  platform: "ios",
  state: "ready",
  toolLabel: "Xcode 26.0",
  download: null,
};
let androidSetup: SimulatorSetupStatus = {
  platform: "android",
  state: "ready",
  toolLabel: "Android Emulator 36.1.9",
  download: null,
  newDevice: "Pixel 10 with Android 17",
  creating: false,
  studioInstalled: true,
};
/** The user settings file's `[simulators]` table. */
let userSimulators: Record<string, unknown> = {};
const settingsWrites: unknown[] = [];
const openedUrls: string[] = [];
const bridgeListeners = new Map<string, Set<(message: unknown) => void>>();
/** Recording devices, by when their recording began. */
const recordings = new Map<string, number>();
const savedCaptures = new Map<
  string,
  { capture: SimulatorCapture; mimeType: "image/png" | "video/mp4"; bytes: Uint8Array }
>();
let nextCapture = 0;
let failScreenshot = false;
const drags: string[] = [];
const deliveries: {
  chatId: string;
  id: string;
  files: { name: string; type: string; size: number; text?: string }[];
}[] = [];

/** The chat on screen, and one in the background, both in this workspace. */
const CHATS = ["chat-on-screen", "chat-in-background"];

function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

function agentState() {
  return { version: 1, holders: holders.map((holder) => ({ ...holder })) };
}

function setHolders(next: DeviceUseHolder[]): void {
  holders = next;
  emit("simulator-agent-state", agentState());
}

function snapshot(): SimulatorHubSnapshot {
  return {
    version: 1,
    devices: devices.map((device) => ({ ...device })),
    setup: android ? [{ ...iosSetup }, { ...androidSetup }] : [{ ...iosSetup }],
    idleWarnings: [],
  };
}

function resolvedSettings() {
  return {
    effective: { simulators: { ...DEFAULT_SIMULATOR_SETTINGS, ...userSimulators } },
    sources: Object.fromEntries(
      Object.keys(userSimulators).map((key) => [`simulators.${key}`, "user"]),
    ),
    layers: [],
  };
}

/** The engine's settings ops, enough for Settings → Simulators. A write
 * echoes the settings broadcast, as the engine does to its writer. */
async function settingsRequest(message: {
  op?: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const reply = (result: unknown) => ({ type: "WORKSPACE_RESPONSE", result });
  const layer = () => ({
    layer: "user",
    path: "/simulator-fixture/settings.toml",
    doc: { simulators: { ...userSimulators } },
    exists: true,
  });
  switch (message.op) {
    case "settings.resolve":
      return reply(resolvedSettings());
    case "settings.read":
      return reply(layer());
    case "settings.write": {
      const patch = (message.params?.patch ?? {}) as { simulators?: Record<string, unknown> };
      settingsWrites.push(patch);
      userSimulators = { ...userSimulators, ...patch.simulators };
      setTimeout(() => {
        for (const listener of bridgeListeners.get("DB_CHANGED") ?? []) {
          listener({ type: "DB_CHANGED", kinds: ["settings"] });
        }
      }, 30);
      return reply({ ...layer(), warnings: [] });
    }
    default:
      return reply(null);
  }
}

function listenToBridge(type: string, handler: (message: never) => void): () => void {
  const listener = handler as (message: unknown) => void;
  if (!bridgeListeners.has(type)) bridgeListeners.set(type, new Set());
  bridgeListeners.get(type)!.add(listener);
  return () => {
    bridgeListeners.get(type)?.delete(listener);
  };
}

// Settings hooks read BridgeProvider's client, so its transport is the
// fixture engine above.
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.forceReconnect = () => Promise.resolve();
RuntimeClient.prototype.send = () => {};
RuntimeClient.prototype.on = listenToBridge;
RuntimeClient.prototype.request = async function <T extends BridgeMessage = BridgeMessage>(
  message: Partial<BridgeMessage> & { type: string },
): Promise<T> {
  return (await settingsRequest(message as Parameters<typeof settingsRequest>[0])) as T;
};

function device(deviceId: unknown): SimulatorDevice {
  const found = devices.find((entry) => entry.id === deviceId);
  if (!found) throw new Error("That simulator isn't on this Mac anymore.");
  return found;
}

function setState(target: SimulatorDevice, state: SimulatorDeviceState): void {
  target.state = state;
  if (state !== "booted") {
    for (const [viewId, view] of views) {
      if (view.deviceId !== target.id) continue;
      clearInterval(view.timer);
      views.delete(viewId);
    }
  }
  emit("simulator-hub-state", snapshot());
}

// Pictures are encoded synchronously, as main answers a view's start at once.
// Chromium's `convertToBlob` waits for the page to go idle, about a second per
// frame while a view streams, and can fail to settle at all.
function drawing(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function dataUrlBytes(url: string): Uint8Array {
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0));
}

function frameJpeg(target: SimulatorDevice, seq: number): Uint8Array {
  const screen = screenOf(target);
  const width = Math.round(screen.widthPx / screen.scale);
  const height = Math.round(screen.heightPx / screen.scale);
  const canvas = drawing(width, height);
  const context = canvas.getContext("2d")!;
  const dark = appearances.get(target.id) === "dark";
  context.fillStyle = dark ? "#111214" : "#f2f3f5"; // check:ui ignore-line (fake device framebuffer pixels)
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#2f6fed"; // check:ui ignore-line (fake device framebuffer pixels)
  context.fillRect(0, 0, width, 96);
  context.fillStyle = dark ? "#f2f3f5" : "#111214"; // check:ui ignore-line (fake device framebuffer pixels)
  context.font = "600 22px sans-serif";
  context.fillText(target.name, 24, 150);
  context.font = "15px sans-serif";
  context.fillText(`Frame ${seq}`, 24, 180);
  return dataUrlBytes(canvas.toDataURL("image/jpeg", 0.85));
}

let androidArt: SimulatorDeviceFrame | null = null;

/** Android Studio's art as main reads it: a picture of the whole device
 * behind the screen, and a mask over the screen that rounds its corners and
 * covers the camera. Both in the canvas's default black. */
function androidFrame(): SimulatorDeviceFrame {
  androidArt ??= (() => {
    const width = ANDROID_SCREEN.widthPx / ANDROID_SCREEN.scale;
    const height = ANDROID_SCREEN.heightPx / ANDROID_SCREEN.scale;
    const bezel = 18;
    const picture = drawing(Math.round(width + bezel * 2), Math.round(height + bezel * 2));
    const body = picture.getContext("2d")!;
    body.beginPath();
    body.roundRect(0, 0, picture.width, picture.height, ANDROID_SCREEN.cornerRadius + bezel);
    body.fill();
    const mask = drawing(Math.round(width), Math.round(height));
    const cover = mask.getContext("2d")!;
    cover.fillRect(0, 0, mask.width, mask.height);
    cover.globalCompositeOperation = "destination-out";
    cover.beginPath();
    cover.roundRect(0, 0, mask.width, mask.height, ANDROID_SCREEN.cornerRadius);
    cover.fill();
    cover.globalCompositeOperation = "source-over";
    cover.beginPath();
    cover.arc(mask.width / 2, 22, 9, 0, Math.PI * 2);
    cover.fill();
    const image = (canvas: HTMLCanvasElement) => ({
      url: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    });
    return {
      width: picture.width,
      height: picture.height,
      screen: { x: bezel, y: bezel, width, height },
      image: image(picture),
      mask: { ...image(mask), width, height },
      buttons: [],
      outset: { top: 0, left: 0, bottom: 0, right: 0 },
    };
  })();
  return androidArt;
}

function recordingsSnapshot() {
  return {
    version: 1,
    recordings: [...recordings].map(([deviceId, startedAt]) => ({ deviceId, startedAt })),
  };
}

/** A capture of the device's screen, as main saves one: a PNG of the screen,
 * and a thumbnail at most 360 pixels long. */
async function saveCapture(
  target: SimulatorDevice,
  kind: SimulatorCapture["kind"],
  durationMs?: number,
): Promise<SimulatorCapture> {
  const jpeg = frameJpeg(target, 0);
  const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
  const fit = 360 / Math.max(bitmap.width, bitmap.height);
  const canvas = drawing(Math.round(bitmap.width * fit), Math.round(bitmap.height * fit));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const thumbnail = canvas.toDataURL("image/png");
  nextCapture += 1;
  const capture: SimulatorCapture = {
    id: `capture-${nextCapture}`,
    kind,
    deviceId: target.id,
    deviceName: target.name,
    fileName:
      kind === "screenshot"
        ? `Simulator Screenshot - ${target.name} - ${nextCapture}.png`
        : `Simulator Screen Recording - ${target.name} - ${nextCapture}.mp4`,
    thumbnail,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  savedCaptures.set(capture.id, {
    capture,
    mimeType: kind === "screenshot" ? "image/png" : "video/mp4",
    bytes:
      kind === "screenshot"
        ? dataUrlBytes(thumbnail)
        : new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
  });
  return capture;
}

/** The PNG's pixels per point, as on a Retina screen. */
const ANNOTATION_PX_PER_POINT = 2;

/** What the fake screen shows, in upright points, as main reads it from the
 * accessibility tree. Only the portrait screen lists its elements. */
function annotationElements(target: SimulatorDevice, width: number): SimulatorUiElement[] {
  const element = (
    type: string,
    label: string,
    frame: SimulatorUiElement["frame"],
  ): SimulatorUiElement => ({ type, label, value: null, identifier: null, frame });
  return [
    element("Other", "Header", { x: 0, y: 0, width, height: 96 }),
    element("StaticText", target.name, { x: 24, y: 128, width: 260, height: 28 }),
    element("StaticText", "Frame 0", { x: 24, y: 166, width: 90, height: 20 }),
  ];
}

/** The screen as Annotate freezes it: upright, as main turns it, with what
 * is on it. */
async function annotationSnapshot(target: SimulatorDevice): Promise<SimulatorAnnotationSnapshot> {
  const screen = screenOf(target);
  const native = {
    width: Math.round(screen.widthPx / screen.scale),
    height: Math.round(screen.heightPx / screen.scale),
  };
  const orientation = target.orientation ?? "portrait";
  const turns = orientationTurns(orientation);
  const upright = turnedArea(native, turns);
  const frame = await createImageBitmap(
    new Blob([frameJpeg(target, 0) as BlobPart], { type: "image/jpeg" }),
  );
  const canvas = drawing(
    upright.width * ANNOTATION_PX_PER_POINT,
    upright.height * ANNOTATION_PX_PER_POINT,
  );
  const context = canvas.getContext("2d")!;
  context.scale(ANNOTATION_PX_PER_POINT, ANNOTATION_PX_PER_POINT);
  context.translate(upright.width / 2, upright.height / 2);
  context.rotate((turns * Math.PI) / 2);
  context.drawImage(frame, -native.width / 2, -native.height / 2, native.width, native.height);
  frame.close();
  return {
    png: dataUrlBytes(canvas.toDataURL("image/png")),
    widthPx: canvas.width,
    heightPx: canvas.height,
    width: upright.width,
    height: upright.height,
    orientation,
    deviceName: target.name,
    osLabel: target.osLabel,
    appName: "Fixture",
    appId: "dev.zeros.fixture",
    elements: turns === 0 ? annotationElements(target, upright.width) : [],
  };
}

async function endRecording(deviceId: string): Promise<SimulatorCapture> {
  const target = device(deviceId);
  const startedAt = recordings.get(target.id);
  if (startedAt === undefined) throw new Error(`${target.name} isn't recording.`);
  recordings.delete(target.id);
  emit("simulator-recordings", recordingsSnapshot());
  // Main waits for the recorder to write the video.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return saveCapture(target, "recording", Date.now() - startedAt);
}

function sendFrame(viewId: string): void {
  const view = views.get(viewId);
  if (!view) return;
  const target = device(view.deviceId);
  const seq = view.seq++;
  const jpeg = frameJpeg(target, seq);
  const screen = screenOf(target);
  framesSent += 1;
  emit("simulator-frame", {
    viewId,
    seq,
    width: Math.round(screen.widthPx / screen.scale),
    height: Math.round(screen.heightPx / screen.scale),
    jpeg,
  });
}

async function invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  calls.push(command);
  switch (command) {
    case "simulator_hub_state":
      return snapshot();
    case "simulator_hub_refresh":
      // DeviceHub publishes what a refresh finds before it replies.
      emit("simulator-hub-state", snapshot());
      return snapshot();
    case "simulator_boot_warnings":
      return [];
    case "simulator_boot": {
      const target = device(args.deviceId);
      if (target.state === "booted") return "booted";
      setState(target, "booting");
      return new Promise<SimulatorBootOutcome>((resolve) => boots.set(target.id, resolve));
    }
    case "simulator_boot_cancel": {
      const target = device(args.deviceId);
      boots.get(target.id)?.("cancelled");
      boots.delete(target.id);
      setState(target, "shutdown");
      return null;
    }
    case "simulator_shutdown": {
      const target = device(args.deviceId);
      setState(target, "shutting-down");
      await new Promise((resolve) => setTimeout(resolve, 50));
      setState(target, "shutdown");
      return null;
    }
    case "simulator_device_shape": {
      const target = device(args.deviceId);
      return {
        screen: screenOf(target),
        frame: target.platform === "android" ? androidFrame() : null,
      };
    }
    case "simulator_android_device_create": {
      if (androidSetup.creating) throw new Error("A device is already being created.");
      androidSetup = { ...androidSetup, creating: true };
      emit("simulator-hub-state", snapshot());
      // avdmanager takes a few seconds.
      await new Promise((resolve) => setTimeout(resolve, 400));
      devices.push({ ...CREATED_ANDROID });
      androidSetup = { ...androidSetup, creating: false };
      emit("simulator-hub-state", snapshot());
      return CREATED_ANDROID.id;
    }
    case "simulator_android_studio_open":
      return androidSetup.studioInstalled === true;
    case "simulator_view_start": {
      const target = device(args.deviceId);
      if (target.state !== "booted") throw new Error(`${target.name} isn't running.`);
      nextView += 1;
      const viewId = `view-${nextView}`;
      const timer = window.setInterval(() => sendFrame(viewId), 250);
      views.set(viewId, { deviceId: target.id, timer, seq: 0 });
      // Main sends a view's first frame before its reply.
      sendFrame(viewId);
      return { viewId, screen: screenOf(target) };
    }
    case "simulator_view_stop": {
      const view = views.get(String(args.viewId));
      if (view) clearInterval(view.timer);
      views.delete(String(args.viewId));
      return null;
    }
    case "simulator_input":
      inputs.push({ deviceId: String(args.deviceId), input: args.input as SimulatorInput });
      return null;
    case "simulator_touch": {
      // Like main: steps reach the device as they happen, and a lift logs
      // what the whole press did.
      const target = device(args.deviceId);
      const touch = readSimulatorTouch(args.touch);
      const viewId = String(args.viewId);
      if (!touch) throw new Error("Invalid simulator touch.");
      if (target.state !== "booted") {
        if (touch.phase === "down") throw new Error(`${target.name} isn't running.`);
        return true;
      }
      if (views.get(viewId)?.deviceId !== target.id) return true;
      touches.push({ deviceId: target.id, viewId, phase: touch.phase });
      if (touch.phase === "down") {
        presses.set(target.id, { start: touch, startedAt: performance.now() });
        return true;
      }
      const press = presses.get(target.id);
      if (!press || touch.phase === "move") return true;
      presses.delete(target.id);
      const gesture =
        touch.phase === "up"
          ? simulatorPressGesture(press.start, touch, performance.now() - press.startedAt)
          : null;
      if (gesture) inputs.push({ deviceId: target.id, input: gesture });
      return true;
    }
    case "simulator_appearance":
      return appearances.get(device(args.deviceId).id) ?? "light";
    case "simulator_appearance_set": {
      const target = device(args.deviceId);
      if (failAppearance) throw new Error(`${target.name} didn't change its appearance.`);
      appearances.set(target.id, args.appearance as SimulatorAppearance);
      return null;
    }
    case "simulator_rotate": {
      const target = device(args.deviceId);
      const orientation = args.orientation as SimulatorOrientation;
      rotations.push({ deviceId: target.id, orientation });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (orientation === "portrait") delete target.orientation;
      else target.orientation = orientation;
      emit("simulator-hub-state", snapshot());
      return null;
    }
    case "simulator_agent_state":
      return agentState();
    case "simulator_agent_stop": {
      const deviceId = String(args.deviceId);
      agentStops.push(deviceId);
      const held = holders.some((holder) => holder.deviceId === deviceId);
      if (held) setHolders(holders.filter((holder) => holder.deviceId !== deviceId));
      return held;
    }
    case "simulator_screenshot": {
      const target = device(args.deviceId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (failScreenshot) throw new Error(`Couldn't capture ${target.name}'s screen.`);
      return saveCapture(target, "screenshot");
    }
    case "simulator_recording_start": {
      const target = device(args.deviceId);
      if (target.state !== "booted") throw new Error(`${target.name} isn't running.`);
      const startedAt = recordings.get(target.id) ?? Date.now();
      recordings.set(target.id, startedAt);
      emit("simulator-recordings", recordingsSnapshot());
      return { deviceId: target.id, startedAt };
    }
    case "simulator_recording_stop":
      return endRecording(String(args.deviceId));
    case "simulator_recordings":
      return recordingsSnapshot();
    case "simulator_capture_file": {
      const saved = savedCaptures.get(String(args.captureId));
      if (!saved) throw new Error("That capture is no longer available.");
      return { fileName: saved.capture.fileName, mimeType: saved.mimeType, bytes: saved.bytes };
    }
    case "simulator_capture_drag":
      if (!savedCaptures.has(String(args.captureId))) {
        throw new Error("That capture is no longer available.");
      }
      drags.push(String(args.captureId));
      return true;
    case "simulator_recording_timeline":
      return null;
    case "simulator_annotation_snapshot": {
      const target = device(args.deviceId);
      if (target.state !== "booted") throw new Error(`${target.name} isn't running.`);
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (failScreenshot) throw new Error(`Couldn't capture ${target.name}'s screen.`);
      return annotationSnapshot(target);
    }
    case "shell_open_url":
      openedUrls.push(String(args.url));
      return null;
    default:
      return null;
  }
}

window.__ZEROS_NATIVE__ = {
  // `?public` exercises availability without trusted development access.
  localDevelopment: !params.has("public"),
  invoke: <T,>(command: string, args?: Record<string, unknown>) =>
    invoke(command, args) as Promise<T>,
  on: <T,>(name: string, callback: (payload: T) => void) => {
    const listener = callback as (payload: unknown) => void;
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return () => {
      listeners.get(name)?.delete(listener);
    };
  },
};
setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
  status: "connected",
  on: listenToBridge,
  onStatusChange: () => () => {},
  onMessage: () => () => {},
  request: settingsRequest,
} as unknown as RuntimeClient);
if (params.has("cloud")) {
  acceptCloudWorkspaceDocument({
    id: cloudTarget.workspaceId,
    organizationId: cloudTarget.organizationId,
    teamId: cloudTarget.organizationId,
    createdBy: cloudTarget.organizationId,
    name: "Simulator fixture",
    placement: "cloud",
    status: "ready",
    version: 1,
    error: null,
    deletedAt: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "app", revision: "refs/heads/main" },
    generation: {
      number: 1,
      architecture: "x86_64",
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: "running",
      lastObservedAt: null,
    },
  });
}
useWorkspaceStore.setState({
  // The controller reads only which workspace each chat is in.
  chats: CHATS.map((id) => ({ id, folder }) as ChatThread),
  activeChatId: CHATS[0],
  newAgentFolder: folder,
  activePage: "workspace",
});
if (!params.has("intent")) useWorkspaceStore
  .getState()
  .dispatch({ type: "ADD_WORKBENCH_TAB", tab: createSimulatorTab(android ? "android" : "ios") });

let setActive: (active: boolean) => void = () => {};

Object.assign(window, {
  simulatorFixture: {
    warm: () => warmSimulatorTab(folder),
    openNow: () => {
      flushSync(() => useWorkspaceStore.getState().dispatch({ type: "ADD_WORKBENCH_TAB", tab: createSimulatorTab("ios") }));
      return document.querySelector("[data-simulator-setup-screen]") !== null;
    },
    inputs,
    touches,
    calls,
    appearances,
    views: () => [...views.values()].map((view) => view.deviceId),
    framesSent: () => framesSent,
    finishBoot: (deviceId: string) => {
      const target = device(deviceId);
      setState(target, "booted");
      boots.get(deviceId)?.("booted");
      boots.delete(deviceId);
    },
    failAppearance: (value: boolean) => {
      failAppearance = value;
    },
    setActive: (active: boolean) => setActive(active),
    tab: () => selectWorkbench(useWorkspaceStore.getState()).tabs.find((tab) => tab.type === "simulator"),
    simulatorTabs: () => {
      const workbench = selectWorkbench(useWorkspaceStore.getState());
      return workbench.tabs
        .filter((tab) => tab.type === "simulator")
        .map((tab) => ({
          deviceId: tab.simulatorDeviceId ?? null,
          active: tab.id === workbench.activeId,
        }));
    },
    rotations,
    agentStops,
    reveals: () => reveals,
    /** An agent in `chat` starts using the device. */
    holdDevice: (deviceId: string, chat: string, agent: AgentControlFamily = "codex") => {
      const target = device(deviceId);
      setHolders([
        ...holders.filter((holder) => holder.deviceId !== deviceId),
        {
          workspaceId: "workspace-fixture" as WorkspaceId,
          conversationId: chat as ConversationId,
          agent,
          deviceId,
          deviceName: target.name,
          platform: target.platform,
        },
      ]);
    },
    releaseDevices: () => setHolders([]),
    agentTouch: (touch: DeviceAgentTouch) => emit("simulator-agent-touch", touch),
    showChat: (chat: string) => useWorkspaceStore.setState({ activeChatId: chat }),
    dismissToasts: () => toast.dismiss(),
    settingsWrites,
    openedUrls,
    /** Xcode's state as DeviceHub next reads it; `broadcast` publishes it now,
     * as the hub does when it notices the change itself. */
    setSetup: (state: SimulatorSetupStatus["state"], broadcast = true) => {
      iosSetup = { ...iosSetup, state };
      if (broadcast) emit("simulator-hub-state", snapshot());
    },
    /** Android's setup as DeviceHub next reads it, as for `setSetup`. */
    setAndroidSetup: (changes: Partial<SimulatorSetupStatus>, broadcast = true) => {
      androidSetup = { ...androidSetup, ...changes };
      if (broadcast) emit("simulator-hub-state", snapshot());
    },
    recordings: () => recordingsSnapshot().recordings,
    captures: () => [...savedCaptures.values()].map(({ capture }) => capture),
    drags,
    deliveries,
    failScreenshot: (value: boolean) => {
      failScreenshot = value;
    },
    /** The device's recording ends without Stop, as main reports it. */
    endRecording: async (deviceId: string, reason: SimulatorRecordingEndReason, error?: string) => {
      if (error) {
        recordings.delete(deviceId);
        emit("simulator-recordings", recordingsSnapshot());
        emit("simulator-recording-end", { deviceId, reason, error });
        return;
      }
      const capture = await endRecording(deviceId);
      emit("simulator-recording-end", { deviceId, reason, capture });
    },
    /** A Simulator tab's annotation, if it has one: the first tab's unless
     * another is named. */
    annotation: (tabId?: string) => {
      const id =
        tabId ??
        selectWorkbench(useWorkspaceStore.getState()).tabs.find(
          (entry) => entry.type === "simulator",
        )?.id;
      const annotation = id ? simulatorAnnotations.get(id) : null;
      return annotation
        ? {
            frozen: annotation.snapshot !== null,
            marks: annotation.history.marks.map(({ kind, color, note }) => ({ kind, color, note })),
            tool: annotation.tool,
            color: annotation.color,
          }
        : null;
    },
    /** The tab strip's ✕ on the Simulator tab. */
    closeTab: () => {
      const tab = selectWorkbench(useWorkspaceStore.getState()).tabs.find(
        (entry) => entry.type === "simulator",
      );
      if (!tab) return;
      leaveSimulatorAnnotation(tab.id, () =>
        useWorkspaceStore.getState().dispatch({ type: "REMOVE_WORKBENCH_TAB", id: tab.id }),
      );
    },
    /** The tab goes without asking, as when its workspace is removed. */
    removeTab: () => {
      const tab = selectWorkbench(useWorkspaceStore.getState()).tabs.find(
        (entry) => entry.type === "simulator",
      );
      if (tab) useWorkspaceStore.getState().dispatch({ type: "REMOVE_WORKBENCH_TAB", id: tab.id });
    },
    openTab: (deviceId?: string) =>
      useWorkspaceStore
        .getState()
        .dispatch({ type: "ADD_WORKBENCH_TAB", tab: createSimulatorTab("ios", deviceId) }),
  },
});

// The chat on screen takes files as its composer does.
registerLiveChatFileStager(CHATS[0]!, (delivery) => {
  const files = delivery.files.map((file) => {
    const entry: (typeof deliveries)[number]["files"][number] = {
      name: file.name,
      type: file.type,
      size: file.size,
    };
    if (file.type === "text/plain") void file.text().then((text) => (entry.text = text));
    return entry;
  });
  deliveries.push({ chatId: CHATS[0]!, id: delivery.id, files });
  return true;
});

/** App-wide in the shell. */
function CaptureController() {
  useEffect(() => followSimulatorCaptures(showRecordingEnd), []);
  useEffect(() => followSimulatorAnnotationTabs(), []);
  return (
    <>
      <SimulatorCaptureStack />
      <SimulatorAnnotationLeaveDialog />
    </>
  );
}

function SettingsHarness() {
  // The Settings page's own column and heading.
  return (
    <BridgeProvider>
      <main className="bg-bg1 text-fg1 h-screen overflow-y-auto">
        <div className="settings-type-scale mx-auto flex w-full max-w-[680px] flex-col gap-6 pt-10 pb-16">
          <h1 className="text-fg1 m-0 text-lg leading-tight font-medium">Simulators</h1>
          <SimulatorsPanel />
        </div>
      </main>
    </BridgeProvider>
  );
}

function Harness() {
  const [active, setActiveState] = useState(true);
  setActive = setActiveState;
  const tab = useWorkspaceStore((state) =>
    selectWorkbench(state).tabs.find((entry) => entry.type === "simulator"),
  );
  return (
    <main className="bg-bg1 text-fg1 flex h-screen min-h-0 flex-col">
      {/* App-wide in the shell; a cloud tab must read nothing on its own. */}
      {!params.has("cloud") && (
        <>
          <SimulatorAgentController onRevealWorkbench={() => (reveals += 1)} />
          <CaptureController />
        </>
      )}
      {tab && <WorkbenchTabContent tab={tab} active={active} />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {params.has("settings") ? <SettingsHarness /> : <Harness />}
    <Toaster />
  </TooltipProvider>,
);
