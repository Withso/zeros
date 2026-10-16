// Simulators: the contract between DeviceHub in Electron main and the
// Simulator tab, Settings > Simulators and the idle-shutdown toasts.
//
// Device ids come from the platform's own tools (a CoreSimulator UDID, an
// Android Virtual Device name). The renderer only ever echoes ids it read in
// a hub snapshot; main validates every id and input again.

export const SIMULATOR_PLATFORMS = ["ios", "android"] as const;
export type SimulatorPlatform = (typeof SIMULATOR_PLATFORMS)[number];

export function isSimulatorPlatform(value: unknown): value is SimulatorPlatform {
  return (
    typeof value === "string" &&
    (SIMULATOR_PLATFORMS as readonly string[]).includes(value)
  );
}

export function simulatorPlatformLabel(platform: SimulatorPlatform): string {
  return platform === "ios" ? "iOS Simulator" : "Android Simulator";
}

// Ids reach simctl and the emulator as arguments, so one never starts like a
// flag or a relative path.
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSimulatorDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value);
}

const VIEW_ID = /^view-\d{1,9}$/;

export function isSimulatorViewId(value: unknown): value is string {
  return typeof value === "string" && VIEW_ID.test(value);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const MAX_LABEL = 200;
const MAX_LIST = 200;
const MAX_SIZE = 10_000;

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SIZE;
}

function isOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_SIZE
  );
}

export const SIMULATOR_DEVICE_STATES = [
  "shutdown",
  "booting",
  "booted",
  "shutting-down",
] as const;
export type SimulatorDeviceState = (typeof SIMULATOR_DEVICE_STATES)[number];

export type SimulatorFormFactor = "phone" | "tablet";

/** Named as the device sees itself, with the home indicator as "down". */
export const SIMULATOR_ORIENTATIONS = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
] as const;
export type SimulatorOrientation = (typeof SIMULATOR_ORIENTATIONS)[number];

export function isSimulatorOrientation(value: unknown): value is SimulatorOrientation {
  return typeof value === "string" && (SIMULATOR_ORIENTATIONS as readonly string[]).includes(value);
}

export interface SimulatorDevice {
  id: string;
  platform: SimulatorPlatform;
  /** As the platform names it, such as "iPhone 17". */
  name: string;
  /** Such as "iOS 27.0". */
  osLabel: string;
  formFactor: SimulatorFormFactor;
  state: SimulatorDeviceState;
  /** Zeros started it, so only Zeros' idle shutdown may stop it. */
  bootedByZeros: boolean;
  /**
   * Set only after Zeros turns a booted device. Missing means portrait; the
   * stream stays a portrait framebuffer either way.
   */
  orientation?: SimulatorOrientation;
}

/**
 * - `tools-missing`: no Xcode (Command Line Tools alone have no simulators).
 * - `runtime-missing`: Xcode is there but has no runtime for this platform.
 * - `unsupported`: not a Mac.
 */
export const SIMULATOR_SETUP_STATES = [
  "checking",
  "ready",
  "tools-missing",
  "runtime-missing",
  "unsupported",
] as const;
export type SimulatorSetupState = (typeof SIMULATOR_SETUP_STATES)[number];

export interface SimulatorRuntimeDownload {
  state: "downloading" | "failed";
  /** 0 to 1, or null before the tool reports a size. */
  progress: number | null;
}

export interface SimulatorSetupStatus {
  platform: SimulatorPlatform;
  state: SimulatorSetupState;
  /** Such as "Xcode 27.0", once found. */
  toolLabel: string | null;
  download: SimulatorRuntimeDownload | null;
  /** Android: what "Create device" makes, such as "Pixel 10 with Android
   * 17", or null when Zeros can't make one on this Mac. */
  newDevice?: string | null;
  /** Android: "Create device" is running. */
  creating?: boolean;
  /** Android: Android Studio is installed, so setup can open it. */
  studioInstalled?: boolean;
}

export interface SimulatorIdleWarning {
  deviceId: string;
  /** Epoch milliseconds when Zeros shuts the device down. */
  shutdownAt: number;
}

export const SIMULATOR_HUB_VERSION = 1;

export interface SimulatorHubSnapshot {
  version: typeof SIMULATOR_HUB_VERSION;
  devices: SimulatorDevice[];
  setup: SimulatorSetupStatus[];
  idleWarnings: SimulatorIdleWarning[];
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function readDevice(value: unknown): SimulatorDevice | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSimulatorDeviceId(record.id) ||
    !isSimulatorPlatform(record.platform) ||
    !isLabel(record.name) ||
    !isLabel(record.osLabel) ||
    (record.formFactor !== "phone" && record.formFactor !== "tablet") ||
    !oneOf(SIMULATOR_DEVICE_STATES, record.state) ||
    typeof record.bootedByZeros !== "boolean" ||
    (record.orientation !== undefined && !oneOf(SIMULATOR_ORIENTATIONS, record.orientation))
  ) {
    return null;
  }
  return {
    id: record.id,
    platform: record.platform,
    name: record.name,
    osLabel: record.osLabel,
    formFactor: record.formFactor,
    state: record.state,
    bootedByZeros: record.bootedByZeros,
    ...(record.orientation === undefined ? {} : { orientation: record.orientation }),
  };
}

function readDownload(value: unknown): SimulatorRuntimeDownload | null | undefined {
  if (value === null) return null;
  const record = plainRecord(value);
  if (
    !record ||
    (record.state !== "downloading" && record.state !== "failed") ||
    (record.progress !== null &&
      (typeof record.progress !== "number" ||
        !Number.isFinite(record.progress) ||
        record.progress < 0 ||
        record.progress > 1))
  ) {
    return undefined;
  }
  return { state: record.state, progress: record.progress };
}

function readSetup(value: unknown): SimulatorSetupStatus | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSimulatorPlatform(record.platform) ||
    !oneOf(SIMULATOR_SETUP_STATES, record.state) ||
    (record.toolLabel !== null && !isLabel(record.toolLabel))
  ) {
    return null;
  }
  const download = readDownload(record.download);
  if (download === undefined) return null;
  const { newDevice, creating, studioInstalled } = record;
  if (
    (newDevice !== undefined && newDevice !== null && !isLabel(newDevice)) ||
    (creating !== undefined && typeof creating !== "boolean") ||
    (studioInstalled !== undefined && typeof studioInstalled !== "boolean")
  ) {
    return null;
  }
  return {
    platform: record.platform,
    state: record.state,
    toolLabel: record.toolLabel,
    download,
    ...(newDevice === undefined ? {} : { newDevice }),
    ...(creating === undefined ? {} : { creating }),
    ...(studioInstalled === undefined ? {} : { studioInstalled }),
  };
}

function readIdleWarning(value: unknown): SimulatorIdleWarning | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSimulatorDeviceId(record.deviceId) ||
    typeof record.shutdownAt !== "number" ||
    !Number.isFinite(record.shutdownAt) ||
    record.shutdownAt < 0
  ) {
    return null;
  }
  return { deviceId: record.deviceId, shutdownAt: record.shutdownAt };
}

function readList<T>(value: unknown, read: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST) return null;
  const entries: T[] = [];
  for (const entry of value) {
    const next = read(entry);
    if (!next) return null;
    entries.push(next);
  }
  return entries;
}

/** The whole snapshot or nothing, so a malformed one never half-renders. */
export function readSimulatorHubSnapshot(value: unknown): SimulatorHubSnapshot | null {
  const record = plainRecord(value);
  if (!record || record.version !== SIMULATOR_HUB_VERSION) return null;
  const devices = readList(record.devices, readDevice);
  const setup = readList(record.setup, readSetup);
  const idleWarnings = readList(record.idleWarnings, readIdleWarning);
  if (!devices || !setup || !idleWarnings) return null;
  return { version: SIMULATOR_HUB_VERSION, devices, setup, idleWarnings };
}

/** What the user should hear before a boot starts. */
export const SIMULATOR_BOOT_WARNINGS = ["low-memory", "many-devices"] as const;
export type SimulatorBootWarning = (typeof SIMULATOR_BOOT_WARNINGS)[number];

export function readSimulatorBootWarnings(value: unknown): SimulatorBootWarning[] {
  if (!Array.isArray(value)) return [];
  return SIMULATOR_BOOT_WARNINGS.filter((warning) => value.includes(warning));
}

/** How a boot request ended. Failures reject instead. */
export type SimulatorBootOutcome = "booted" | "cancelled";

export type SimulatorAppearance = "light" | "dark";

export const SIMULATOR_IDLE_SHUTDOWN_CHOICES = [
  "15m",
  "30m",
  "1h",
  "2h",
  "never",
] as const;
export type SimulatorIdleShutdown =
  (typeof SIMULATOR_IDLE_SHUTDOWN_CHOICES)[number];

export function isSimulatorIdleShutdown(
  value: unknown,
): value is SimulatorIdleShutdown {
  return (
    typeof value === "string" &&
    (SIMULATOR_IDLE_SHUTDOWN_CHOICES as readonly string[]).includes(value)
  );
}

const MINUTE = 60_000;

/** Milliseconds without use before shutdown, or null for never. */
export function simulatorIdleShutdownMs(
  choice: SimulatorIdleShutdown,
): number | null {
  switch (choice) {
    case "15m":
      return 15 * MINUTE;
    case "30m":
      return 30 * MINUTE;
    case "1h":
      return 60 * MINUTE;
    case "2h":
      return 120 * MINUTE;
    case "never":
      return null;
  }
}

/** The `[simulators]` settings table as the engine resolves it. */
export interface SimulatorSettings {
  enabled: boolean;
  idle_shutdown: SimulatorIdleShutdown;
  show_agent_touches: boolean;
}

export const DEFAULT_SIMULATOR_SETTINGS: Readonly<SimulatorSettings> = {
  enabled: true,
  idle_shutdown: "30m",
  show_agent_touches: true,
};

/** The `[simulators]` table with the shipped defaults for anything missing
 * or malformed. */
export function simulatorSettings(raw: unknown): SimulatorSettings {
  const table = plainRecord(raw) ?? {};
  const flag = (key: "enabled" | "show_agent_touches") =>
    typeof table[key] === "boolean"
      ? (table[key] as boolean)
      : DEFAULT_SIMULATOR_SETTINGS[key];
  return {
    enabled: flag("enabled"),
    idle_shutdown: isSimulatorIdleShutdown(table.idle_shutdown)
      ? table.idle_shutdown
      : DEFAULT_SIMULATOR_SETTINGS.idle_shutdown,
    show_agent_touches: flag("show_agent_touches"),
  };
}

/** Renderer → main: the effective settings DeviceHub applies. */
export interface SimulatorPreferences {
  agentsEnabled: boolean;
  idleShutdown: SimulatorIdleShutdown;
  showAgentTouches: boolean;
}

export function simulatorPreferencesFromSettings(
  settings: SimulatorSettings,
): SimulatorPreferences {
  return {
    agentsEnabled: settings.enabled,
    idleShutdown: settings.idle_shutdown,
    showAgentTouches: settings.show_agent_touches,
  };
}

export function readSimulatorPreferences(
  value: unknown,
): SimulatorPreferences | null {
  const record = plainRecord(value);
  if (
    !record ||
    typeof record.agentsEnabled !== "boolean" ||
    !isSimulatorIdleShutdown(record.idleShutdown) ||
    typeof record.showAgentTouches !== "boolean"
  ) {
    return null;
  }
  return {
    agentsEnabled: record.agentsEnabled,
    idleShutdown: record.idleShutdown,
    showAgentTouches: record.showAgentTouches,
  };
}

/** The device screen a live view draws, sent when a view starts. */
export interface SimulatorScreen {
  /** Framebuffer pixels in the device's natural orientation: portrait, except
   * on Android tablets that are landscape by nature. */
  widthPx: number;
  heightPx: number;
  /** Pixels per point. Input coordinates are in points. */
  scale: number;
  /** Screen corner radius in points, for the mask. */
  cornerRadius: number;
}

export interface SimulatorViewStart {
  viewId: string;
  screen: SimulatorScreen;
}

function readScreen(value: unknown): SimulatorScreen | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSize(record.widthPx) ||
    !isSize(record.heightPx) ||
    typeof record.scale !== "number" ||
    !Number.isFinite(record.scale) ||
    record.scale < 1 ||
    record.scale > 4 ||
    typeof record.cornerRadius !== "number" ||
    !Number.isFinite(record.cornerRadius) ||
    record.cornerRadius < 0 ||
    record.cornerRadius > MAX_SIZE
  ) {
    return null;
  }
  return {
    widthPx: record.widthPx,
    heightPx: record.heightPx,
    scale: record.scale,
    cornerRadius: record.cornerRadius,
  };
}

export function readSimulatorViewStart(value: unknown): SimulatorViewStart | null {
  const record = plainRecord(value);
  if (!record || !isSimulatorViewId(record.viewId)) return null;
  const screen = readScreen(record.screen);
  return screen ? { viewId: record.viewId, screen } : null;
}

/** A PNG or WebP (data URL) and its size in points. */
export interface SimulatorFrameImage {
  url: string;
  width: number;
  height: number;
}

const IMAGE_DATA_URLS = ["data:image/png;base64,", "data:image/webp;base64,"];
const MAX_FRAME_IMAGE_CHARS = 8 * 1024 * 1024;

function readFrameImage(value: unknown): SimulatorFrameImage | null {
  const record = plainRecord(value);
  if (
    !record ||
    typeof record.url !== "string" ||
    !IMAGE_DATA_URLS.some((prefix) => (record.url as string).startsWith(prefix)) ||
    record.url.length > MAX_FRAME_IMAGE_CHARS ||
    !isSize(record.width) ||
    !isSize(record.height)
  ) {
    return null;
  }
  return { url: record.url, width: record.width, height: record.height };
}

export const SIMULATOR_FRAME_SLICES = [
  "topLeft",
  "top",
  "topRight",
  "right",
  "bottomRight",
  "bottom",
  "bottomLeft",
  "left",
] as const;
export type SimulatorFrameSlice = (typeof SIMULATOR_FRAME_SLICES)[number];

/** The device's own frame, from the user's Xcode or Android Studio, laid out
 * for its screen, in points from the frame's top-left. Never bundled with
 * Zeros. A frame has either `slices` or `image`. */
export interface SimulatorDeviceFrame {
  width: number;
  height: number;
  /** Where the screen sits inside the frame. */
  screen: { x: number; y: number; width: number; height: number };
  /** Xcode's nine-slice pieces; the corners keep their size, edges stretch.
   * The screen draws over the frame's opaque inner part. */
  slices?: Record<SimulatorFrameSlice, SimulatorFrameImage>;
  /** Android Studio's picture of the whole device, drawn from the frame's
   * top-left behind the screen. */
  image?: SimulatorFrameImage;
  /** Drawn over the screen, the screen's size: it rounds the corners and
   * covers the camera. */
  mask?: SimulatorFrameImage;
  /** Hardware buttons, such as "power" or "home". Side buttons draw behind
   * the frame and a home button over it. Positions may be negative. */
  buttons: Array<{
    name: string;
    image: SimulatorFrameImage;
    x: number;
    y: number;
    onTop: boolean;
  }>;
  /** Room the buttons need outside the frame. */
  outset: { top: number; left: number; bottom: number; right: number };
}

const MAX_FRAME_BUTTONS = 16;

function readFrameArt(
  record: Record<string, unknown>,
): Pick<SimulatorDeviceFrame, "slices" | "image" | "mask"> | null {
  if (record.slices !== undefined) {
    const rawSlices = plainRecord(record.slices);
    if (!rawSlices || record.image !== undefined || record.mask !== undefined) return null;
    const slices = {} as Record<SimulatorFrameSlice, SimulatorFrameImage>;
    for (const slice of SIMULATOR_FRAME_SLICES) {
      const image = readFrameImage(rawSlices[slice]);
      if (!image) return null;
      slices[slice] = image;
    }
    return { slices };
  }
  const image = readFrameImage(record.image);
  if (!image) return null;
  if (record.mask === undefined) return { image };
  const mask = readFrameImage(record.mask);
  return mask ? { image, mask } : null;
}

export function readSimulatorDeviceFrame(value: unknown): SimulatorDeviceFrame | null {
  const record = plainRecord(value);
  const screen = plainRecord(record?.screen);
  const outset = plainRecord(record?.outset);
  if (
    !record ||
    !screen ||
    !outset ||
    !isSize(record.width) ||
    !isSize(record.height) ||
    !isOffset(screen.x) ||
    !isOffset(screen.y) ||
    !isSize(screen.width) ||
    !isSize(screen.height) ||
    !isOffset(outset.top) ||
    !isOffset(outset.left) ||
    !isOffset(outset.bottom) ||
    !isOffset(outset.right) ||
    !Array.isArray(record.buttons) ||
    record.buttons.length > MAX_FRAME_BUTTONS
  ) {
    return null;
  }
  const art = readFrameArt(record);
  if (!art) return null;
  const buttons: SimulatorDeviceFrame["buttons"] = [];
  for (const entry of record.buttons) {
    const button = plainRecord(entry);
    const image = readFrameImage(button?.image);
    if (
      !button ||
      !image ||
      !isLabel(button.name) ||
      !isOffset(button.x) ||
      !isOffset(button.y) ||
      typeof button.onTop !== "boolean"
    ) {
      return null;
    }
    buttons.push({ name: button.name, image, x: button.x, y: button.y, onTop: button.onTop });
  }
  return {
    width: record.width,
    height: record.height,
    screen: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
    ...art,
    buttons,
    outset: {
      top: outset.top,
      left: outset.left,
      bottom: outset.bottom,
      right: outset.right,
    },
  };
}

/** How the tab draws a device in any state: its screen, and Xcode's frame for
 * it when there is one. */
export interface SimulatorDeviceShape {
  screen: SimulatorScreen;
  frame: SimulatorDeviceFrame | null;
}

export function readSimulatorDeviceShape(value: unknown): SimulatorDeviceShape | null {
  const record = plainRecord(value);
  const screen = readScreen(record?.screen);
  if (!record || !screen) return null;
  if (record.frame === null) return { screen, frame: null };
  const frame = readSimulatorDeviceFrame(record.frame);
  return frame ? { screen, frame } : null;
}

/** Main → renderer, one JPEG per changed frame while a view is open. */
export interface SimulatorFrame {
  viewId: string;
  seq: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function readSimulatorFrame(value: unknown): SimulatorFrame | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSimulatorViewId(record.viewId) ||
    typeof record.seq !== "number" ||
    !Number.isSafeInteger(record.seq) ||
    record.seq < 0 ||
    !isSize(record.width) ||
    !isSize(record.height) ||
    !Number.isInteger(record.width) ||
    !Number.isInteger(record.height) ||
    !(record.jpeg instanceof Uint8Array) ||
    record.jpeg.byteLength === 0 ||
    record.jpeg.byteLength > MAX_FRAME_BYTES
  ) {
    return null;
  }
  return {
    viewId: record.viewId,
    seq: record.seq,
    width: record.width,
    height: record.height,
    jpeg: record.jpeg,
  };
}

export const SIMULATOR_KEYS = [
  "enter",
  "backspace",
  "delete",
  "tab",
  "escape",
  "space",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
] as const;
export type SimulatorKey = (typeof SIMULATOR_KEYS)[number];

/** "back" is Android's; iOS has no Back button. */
export const SIMULATOR_BUTTONS = ["home", "lock", "back"] as const;
export type SimulatorButton = (typeof SIMULATOR_BUTTONS)[number];

export interface SimulatorPoint {
  x: number;
  y: number;
}

/** Renderer → main: what the user did on the live view, in device points. */
export type SimulatorInput =
  | { kind: "tap"; at: SimulatorPoint }
  | {
      kind: "drag";
      from: SimulatorPoint;
      to: SimulatorPoint;
      durationMs: number;
    }
  | { kind: "text"; text: string }
  | { kind: "key"; key: SimulatorKey }
  | { kind: "button"; button: SimulatorButton }
  /** Two fingers around the screen's center; above 1 zooms in. */
  | { kind: "pinch"; scale: number };

export const MAX_SIMULATOR_TEXT = 500;
export const MIN_SIMULATOR_PINCH = 0.1;
export const MAX_SIMULATOR_PINCH = 10;
const MAX_POINT = 10_000;

function readPoint(value: unknown): SimulatorPoint | null {
  const record = plainRecord(value);
  const x = record?.x;
  const y = record?.y;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > MAX_POINT ||
    y > MAX_POINT
  ) {
    return null;
  }
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

export function readSimulatorInput(value: unknown): SimulatorInput | null {
  const record = plainRecord(value);
  if (!record) return null;
  switch (record.kind) {
    case "tap": {
      const at = readPoint(record.at);
      return at ? { kind: "tap", at } : null;
    }
    case "drag": {
      const from = readPoint(record.from);
      const to = readPoint(record.to);
      const durationMs = record.durationMs;
      if (
        !from ||
        !to ||
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs)
      ) {
        return null;
      }
      return {
        kind: "drag",
        from,
        to,
        durationMs: Math.min(5_000, Math.max(50, Math.round(durationMs))),
      };
    }
    case "text":
      return typeof record.text === "string" &&
        record.text.length > 0 &&
        record.text.length <= MAX_SIMULATOR_TEXT
        ? { kind: "text", text: record.text }
        : null;
    case "key":
      return oneOf(SIMULATOR_KEYS, record.key) ? { kind: "key", key: record.key } : null;
    case "button":
      return oneOf(SIMULATOR_BUTTONS, record.button)
        ? { kind: "button", button: record.button }
        : null;
    case "pinch": {
      const scale =
        typeof record.scale === "number" ? Math.round(record.scale * 100) / 100 : Number.NaN;
      return scale >= MIN_SIMULATOR_PINCH && scale <= MAX_SIMULATOR_PINCH && scale !== 1
        ? { kind: "pinch", scale }
        : null;
    }
    default:
      return null;
  }
}

export const SIMULATOR_TOUCH_PHASES = ["down", "move", "up", "cancel"] as const;
export type SimulatorTouchPhase = (typeof SIMULATOR_TOUCH_PHASES)[number];

/** Renderer → main: one step of the user's finger on a live view, in device
 * points, sent as it happens so the device follows the finger. `second` is
 * the other finger of an Option-drag pinch. A cancel lifts the finger too,
 * but the press doesn't count as a gesture. */
export interface SimulatorTouch {
  phase: SimulatorTouchPhase;
  at: SimulatorPoint;
  second?: SimulatorPoint;
}

export function readSimulatorTouch(value: unknown): SimulatorTouch | null {
  const record = plainRecord(value);
  if (!record || !oneOf(SIMULATOR_TOUCH_PHASES, record.phase)) return null;
  const at = readPoint(record.at);
  if (!at) return null;
  if (record.second === undefined) return { phase: record.phase, at };
  const second = readPoint(record.second);
  return second ? { phase: record.phase, at, second } : null;
}

/** Movement under this many points is still a tap. */
const TAP_SLOP_POINTS = 6;
const LONG_PRESS_MS = 500;
/** Two fingers closer than this can't show how far they spread. */
const MIN_PINCH_SPREAD = 20;
const MIN_PINCH_CHANGE = 0.05;

const pointDistance = (a: SimulatorPoint, b: SimulatorPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const clampTo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** What a whole press from `start` to `end` did: a tap, a long press (a
 * drag that stays put), a swipe, or with two fingers a pinch. Null for a
 * pinch too small to zoom. */
export function simulatorPressGesture(
  start: SimulatorTouch,
  end: SimulatorTouch,
  elapsedMs: number,
): SimulatorInput | null {
  if (start.second && end.second) {
    const spread = pointDistance(start.at, start.second);
    if (spread < MIN_PINCH_SPREAD) return null;
    const ratio = pointDistance(end.at, end.second) / spread;
    const scale =
      Math.round(clampTo(ratio, MIN_SIMULATOR_PINCH, MAX_SIMULATOR_PINCH) * 100) / 100;
    return Math.abs(scale - 1) < MIN_PINCH_CHANGE ? null : { kind: "pinch", scale };
  }
  const durationMs = Math.round(clampTo(elapsedMs, 50, 5_000));
  if (pointDistance(start.at, end.at) > TAP_SLOP_POINTS) {
    return { kind: "drag", from: start.at, to: end.at, durationMs };
  }
  return elapsedMs >= LONG_PRESS_MS
    ? { kind: "drag", from: start.at, to: start.at, durationMs }
    : { kind: "tap", at: start.at };
}
