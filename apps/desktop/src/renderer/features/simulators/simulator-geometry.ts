import {
  type SimulatorDevice,
  type SimulatorDeviceFrame,
  type SimulatorFormFactor,
  type SimulatorFrameSlice,
  type SimulatorInput,
  type SimulatorKey,
  type SimulatorOrientation,
  type SimulatorPlatform,
  type SimulatorPoint,
  type SimulatorScreen,
} from "@zeros/protocol/simulators";

// Layout and input math for the live view. Everything here is in device
// points unless a name says otherwise.

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface Edges {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function screenSize(screen: SimulatorScreen): Size {
  return { width: screen.widthPx / screen.scale, height: screen.heightPx / screen.scale };
}

/** A device's frame and screen, from the frame's top-left. */
export interface DeviceLayout {
  width: number;
  height: number;
  /** Room hardware buttons need outside the frame. */
  outset: Edges;
  screen: Rect;
  screenRadius: number;
  /** Outer corner radius of the frame Zeros draws. */
  frameRadius: number;
}

const NO_OUTSET: Edges = { top: 0, left: 0, bottom: 0, right: 0 };

/** The frame Zeros draws when the platform's own isn't available. */
export function drawnDeviceLayout(
  screen: SimulatorScreen,
  formFactor: SimulatorFormFactor,
): DeviceLayout {
  const size = screenSize(screen);
  const bezel = Math.round(
    Math.min(size.width, size.height) * (formFactor === "tablet" ? 0.03 : 0.04),
  );
  return {
    width: size.width + bezel * 2,
    height: size.height + bezel * 2,
    outset: NO_OUTSET,
    screen: { x: bezel, y: bezel, width: size.width, height: size.height },
    screenRadius: screen.cornerRadius,
    frameRadius: screen.cornerRadius > 0 ? screen.cornerRadius + bezel : bezel,
  };
}

/** A device in its platform's own frame, from Xcode or Android Studio. */
export function framedDeviceLayout(
  frame: SimulatorDeviceFrame,
  screen: SimulatorScreen,
): DeviceLayout {
  return {
    width: frame.width,
    height: frame.height,
    outset: frame.outset,
    screen: frame.screen,
    screenRadius: screen.cornerRadius,
    frameRadius: 0,
  };
}

/** One image of a frame's art, placed in frame points. */
export interface FramePiece {
  /** A nine-slice piece's name, or "image" for a whole-device picture. */
  key: SimulatorFrameSlice | "image";
  url: string;
  rect: Rect;
}

/** Where a frame's art goes under the screen: Android Studio's picture from
 * the frame's top-left, or Xcode's nine slices, whose corners keep their
 * size while the edges stretch between them. The screen covers the middle. */
export function framePieces(frame: SimulatorDeviceFrame): FramePiece[] {
  const { width, height, slices, image } = frame;
  if (image) {
    return [
      {
        key: "image",
        url: image.url,
        rect: { x: 0, y: 0, width: image.width, height: image.height },
      },
    ];
  }
  if (!slices) return [];
  const tl = slices.topLeft;
  const tr = slices.topRight;
  const bl = slices.bottomLeft;
  const br = slices.bottomRight;
  const piece = (slice: SimulatorFrameSlice, x: number, y: number, w: number, h: number) => ({
    key: slice,
    url: slices[slice].url,
    rect: { x, y, width: Math.max(0, w), height: Math.max(0, h) },
  });
  return [
    piece("topLeft", 0, 0, tl.width, tl.height),
    piece("top", tl.width, 0, width - tl.width - tr.width, slices.top.height),
    piece("topRight", width - tr.width, 0, tr.width, tr.height),
    piece("right", width - slices.right.width, tr.height, slices.right.width, height - tr.height - br.height),
    piece("bottomRight", width - br.width, height - br.height, br.width, br.height),
    piece("bottom", bl.width, height - slices.bottom.height, width - bl.width - br.width, slices.bottom.height),
    piece("bottomLeft", 0, height - bl.height, bl.width, bl.height),
    piece("left", 0, tl.height, slices.left.width, height - tl.height - bl.height),
  ];
}

/** The art drawn over the screen, stretched to it: it rounds the corners and
 * covers the camera. */
export function frameMask(frame: SimulatorDeviceFrame): { url: string; rect: Rect } | null {
  return frame.mask ? { url: frame.mask.url, rect: frame.screen } : null;
}

/** The setup screen's generic phone, shaped like a current iPhone. */
export const SETUP_PHONE_SCREEN: SimulatorScreen = {
  widthPx: 1206,
  heightPx: 2622,
  scale: 3,
  cornerRadius: 55,
};

function boxPoints(layout: DeviceLayout): Size {
  return {
    width: layout.width + layout.outset.left + layout.outset.right,
    height: layout.height + layout.outset.top + layout.outset.bottom,
  };
}

/** CSS pixels per point that fit the device and its buttons in `area`,
 * never larger than one CSS pixel per point. */
export function fitDeviceScale(layout: DeviceLayout, area: Size, maxScale = 1): number {
  const { width, height } = boxPoints(layout);
  if (area.width <= 0 || area.height <= 0 || width <= 0 || height <= 0) return 0;
  return Math.max(0, Math.min(maxScale, area.width / width, area.height / height));
}

/** The CSS size of the box holding the device and its buttons. */
export function deviceBoxSize(layout: DeviceLayout, scale: number): Size {
  const { width, height } = boxPoints(layout);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where `rect`, in frame points, sits in the device box in CSS pixels.
 * Both edges round on their own, so pieces that touch in points still touch
 * on screen at any scale. */
export function deviceBoxRect(layout: DeviceLayout, scale: number, rect: Rect): BoxRect {
  const left = Math.round((rect.x + layout.outset.left) * scale);
  const top = Math.round((rect.y + layout.outset.top) * scale);
  const right = Math.round((rect.x + layout.outset.left + rect.width) * scale);
  const bottom = Math.round((rect.y + layout.outset.top + rect.height) * scale);
  return { left, top, width: right - left, height: bottom - top };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Clockwise quarter turns of the drawn device. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** How far to turn the drawn device so a device in `orientation` reads
 * upright. Its stream stays a portrait framebuffer, with the app turned
 * inside it. */
export function orientationTurns(orientation: SimulatorOrientation | undefined): QuarterTurns {
  switch (orientation) {
    case "landscape-right":
      return 1;
    case "portrait-upside-down":
      return 2;
    case "landscape-left":
      return 3;
    default:
      return 0;
  }
}

/** Where Rotate turns the device: a quarter turn left from portrait, and
 * back to portrait from anywhere else. */
export function rotatedOrientation(
  orientation: SimulatorOrientation | undefined,
): SimulatorOrientation {
  return (orientation ?? "portrait") === "portrait" ? "landscape-left" : "portrait";
}

/** The angle, in degrees, that turns from `previous` to `turns` the short
 * way round, so a turn animates through 90° and never unwinds. */
export function nextTurnAngle(previous: number, turns: QuarterTurns): number {
  const delta = ((((turns * 90 - previous) % 360) + 540) % 360) - 180;
  return previous + delta;
}

/** The area a device turned `turns` fills: on its side it swaps. */
export function turnedArea(area: Size, turns: QuarterTurns): Size {
  return turns % 2 === 1 ? { width: area.height, height: area.width } : area;
}

/** A vector on the page as it runs on the upright device screen. */
export function unturn(vector: { x: number; y: number }, turns: QuarterTurns) {
  switch (turns) {
    case 1:
      return { x: vector.y, y: 0 - vector.x };
    case 2:
      return { x: 0 - vector.x, y: 0 - vector.y };
    case 3:
      return { x: 0 - vector.y, y: vector.x };
    default:
      return vector;
  }
}

/** Where a pointer at `client` lands on a screen drawn at `rect` (its box
 * on the page) and turned `turns`. */
export function pointOnScreen(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  size: Size,
  turns: QuarterTurns = 0,
): SimulatorPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const upright = turnedArea(rect, turns);
  const offset = unturn(
    { x: client.x - rect.left - rect.width / 2, y: client.y - rect.top - rect.height / 2 },
    turns,
  );
  return {
    x: round(clamp((offset.x / upright.width + 0.5) * size.width, 0, size.width)),
    y: round(clamp((offset.y / upright.height + 0.5) * size.height, 0, size.height)),
  };
}

/** The other finger of an Option-drag pinch, mirrored through the center. */
export function mirroredFinger(point: SimulatorPoint, size: Size): SimulatorPoint {
  return { x: round(size.width - point.x), y: round(size.height - point.y) };
}

const SCROLL_REACH = 0.8;
export const SCROLL_SWIPE_MS = 200;

/** A wheel or trackpad scroll of `delta` points as one swipe. The finger
 * moves against the scroll, and starts where it can travel the whole way. */
export function scrollInput(
  at: SimulatorPoint,
  delta: { x: number; y: number },
  size: Size,
): SimulatorInput | null {
  const dx = clamp(delta.x, -size.width * SCROLL_REACH, size.width * SCROLL_REACH);
  const dy = clamp(delta.y, -size.height * SCROLL_REACH, size.height * SCROLL_REACH);
  if (Math.hypot(dx, dy) < 1) return null;
  const from = {
    x: round(clamp(at.x, Math.max(0, dx), Math.min(size.width, size.width + dx))),
    y: round(clamp(at.y, Math.max(0, dy), Math.min(size.height, size.height + dy))),
  };
  return {
    kind: "drag",
    from,
    to: { x: round(from.x - dx), y: round(from.y - dy) },
    durationMs: SCROLL_SWIPE_MS,
  };
}

// Tab stays with Zeros so keyboard focus can always leave the screen.
const KEYS: Record<string, SimulatorKey> = {
  Enter: "enter",
  Backspace: "backspace",
  Delete: "delete",
  Escape: "escape",
  ArrowUp: "arrow-up",
  ArrowDown: "arrow-down",
  ArrowLeft: "arrow-left",
  ArrowRight: "arrow-right",
};

export type SimulatorKeystroke = { kind: "key"; key: SimulatorKey } | { kind: "text"; text: string };

/** A keystroke for the device, or null to leave it to Zeros (shortcuts,
 * composition, Tab, modifier keys on their own). */
export function keystroke(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
}): SimulatorKeystroke | null {
  if (event.metaKey || event.ctrlKey || event.isComposing) return null;
  const key = KEYS[event.key];
  if (key) return { kind: "key", key };
  return [...event.key].length === 1 ? { kind: "text", text: event.key } : null;
}

export interface SimulatorPickerSections {
  booted: SimulatorDevice[];
  available: SimulatorDevice[];
}

export function simulatorPickerSections(
  devices: readonly SimulatorDevice[],
  platform: SimulatorPlatform,
): SimulatorPickerSections {
  const own = devices.filter((device) => device.platform === platform);
  return {
    booted: own.filter((device) => device.state === "booted" || device.state === "booting"),
    available: own.filter(
      (device) => device.state === "shutdown" || device.state === "shutting-down",
    ),
  };
}

/** "Attach simulator": a running device no other tab shows, else the first
 * phone that can boot, else anything. */
export function defaultSimulatorDevice(
  devices: readonly SimulatorDevice[],
  platform: SimulatorPlatform,
  shownElsewhere: ReadonlySet<string>,
): SimulatorDevice | null {
  const own = devices.filter((device) => device.platform === platform);
  return (
    own.find((device) => device.state === "booted" && !shownElsewhere.has(device.id)) ??
    own.find((device) => device.state === "shutdown" && device.formFactor === "phone") ??
    own.find((device) => device.state === "shutdown") ??
    own[0] ??
    null
  );
}
