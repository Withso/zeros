// ──────────────────────────────────────────────────────────
// Design Mode picker message guard
// ──────────────────────────────────────────────────────────
//
// The Design Mode picker runs in the visited page's main world, so on an
// arbitrary website the page can read the picker and forge every message it
// sends. Nothing here authenticates the sender; instead each message is
// treated as untrusted page input: strictly shaped, size-capped, rebuilt from
// known fields only, and its geometry clamped to the iframe's own viewport.
// A forged message can therefore change only the selection UI of the frame
// that sent it. Sending to chat still requires the user's own submit.

import type { SelectedElement } from "./use-iframe-webview";
import { isLoopbackUrl } from "../../shell/workbench/tabs/localhost-url";

export type PickedElement = Omit<SelectedElement, "screenshot">;

export interface PickerViewport {
  width: number;
  height: number;
}

export interface PickerCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STRING_MAX = 8192;
const COMPONENT_NAME_MAX = 512;
const TAG_MAX = 128;
const COORDINATE_MAX = 10_000_000;
const DEVICE_PIXEL_RATIO_MAX = 16;
export const PICKER_BATCH_MAX = 200;

/** The computed-style keys the picker reports (`STYLE_PROPS` in
 *  electron/iframe-picker-script.ts). Anything else is dropped. */
export const PICKER_STYLE_KEYS: readonly string[] = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "padding",
  "margin",
  "border",
  "borderRadius",
  "display",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "width",
  "height",
  "position",
  "opacity",
  "boxShadow",
];
const STYLE_KEY_SET = new Set(PICKER_STYLE_KEYS);

// Control and line-separator characters would let page text forge structure in
// the element blocks that are later placed into a chat draft.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/g;
const TAG_RE = /^[a-z][a-z0-9._:-]*$/;

function parsedHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** The picker is available on any ordinary http(s) page. */
export function isPickerPageUrl(url: string): boolean {
  return typeof url === "string" && url.length <= 32_768 && parsedHttpUrl(url) !== null;
}

/** A picker message must come from an http(s) document. Error pages, opaque
 *  ("null") and non-web origins never reach the selection UI. */
export function isPickerSenderOrigin(origin: string): boolean {
  if (typeof origin !== "string" || origin.length > 2048) return false;
  const parsed = parsedHttpUrl(origin);
  return parsed !== null && parsed.origin === origin;
}

/** Loopback dev servers and the engine-authorized cloud preview origin are the
 *  user's own application. Flows that write page-supplied text into a chat
 *  draft without the chip review step stay limited to those origins. */
export function isLocalDevelopmentPickerOrigin(
  origin: string,
  trustedPreviewOrigin?: string,
): boolean {
  if (!isPickerSenderOrigin(origin)) return false;
  if (isLoopbackUrl(origin)) return true;
  return Boolean(trustedPreviewOrigin) && origin === trustedPreviewOrigin;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  return value.replace(CONTROL_CHARS, " ");
}

function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= COORDINATE_MAX
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validViewport(viewport: PickerViewport): boolean {
  return (
    finite(viewport.width) &&
    finite(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0
  );
}

/** Intersect a page-reported element rect with the iframe viewport. */
export function clampPickerRect(
  rect: PickerCaptureRect,
  viewport: PickerViewport,
): PickerCaptureRect {
  const left = clamp(rect.x, 0, viewport.width);
  const top = clamp(rect.y, 0, viewport.height);
  const right = clamp(rect.x + rect.width, left, viewport.width);
  const bottom = clamp(rect.y + rect.height, top, viewport.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Validate and rebuild one picker selection. Returns null for any malformed,
 *  oversized or cross-origin payload. */
export function sanitizePickerSelection(
  value: unknown,
  context: { origin: string; viewport: PickerViewport },
): PickedElement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isPickerSenderOrigin(context.origin) || !validViewport(context.viewport))
    return null;
  const raw = value as Record<string, unknown>;

  const selector = cleanString(raw.selector, STRING_MAX);
  if (!selector) return null;
  const tag = typeof raw.tag === "string" ? raw.tag.toLowerCase() : "";
  if (tag.length === 0 || tag.length > TAG_MAX || !TAG_RE.test(tag)) return null;

  let componentName: string | null = null;
  if (raw.componentName != null) {
    const name = cleanString(raw.componentName, STRING_MAX);
    if (name === null) return null;
    componentName = name.slice(0, COMPONENT_NAME_MAX) || null;
  }

  const rawRect = raw.rect as Record<string, unknown> | null | undefined;
  if (
    !rawRect ||
    typeof rawRect !== "object" ||
    !finite(rawRect.x) ||
    !finite(rawRect.y) ||
    !finite(rawRect.width) ||
    !finite(rawRect.height) ||
    rawRect.width < 0 ||
    rawRect.height < 0
  )
    return null;
  const rect = clampPickerRect(
    {
      x: rawRect.x,
      y: rawRect.y,
      width: rawRect.width,
      height: rawRect.height,
    },
    context.viewport,
  );

  const rawClick = raw.click as Record<string, unknown> | null | undefined;
  if (
    !rawClick ||
    typeof rawClick !== "object" ||
    !finite(rawClick.x) ||
    !finite(rawClick.y)
  )
    return null;
  const click = {
    x: clamp(rawClick.x, 0, context.viewport.width),
    y: clamp(rawClick.y, 0, context.viewport.height),
  };

  if (typeof raw.altKey !== "boolean" || typeof raw.hasShadowRoot !== "boolean")
    return null;

  if (typeof raw.href !== "string" || raw.href.length > STRING_MAX) return null;
  let href = "";
  if (raw.href) {
    const parsed = parsedHttpUrl(raw.href);
    // A page may only describe its own document, never claim another origin.
    if (!parsed || parsed.origin !== context.origin) return null;
    parsed.username = "";
    parsed.password = "";
    href = parsed.href;
  }

  let devicePixelRatio: number | undefined;
  if (raw.devicePixelRatio != null) {
    if (
      !finite(raw.devicePixelRatio) ||
      raw.devicePixelRatio <= 0 ||
      raw.devicePixelRatio > DEVICE_PIXEL_RATIO_MAX
    )
      return null;
    devicePixelRatio = raw.devicePixelRatio;
  }

  let styles: Record<string, string> | undefined;
  if (raw.styles != null) {
    if (typeof raw.styles !== "object" || Array.isArray(raw.styles)) return null;
    const entries = Object.entries(raw.styles as Record<string, unknown>);
    if (entries.length > 100) return null;
    styles = {};
    for (const [key, styleValue] of entries) {
      const cleaned = cleanString(styleValue, STRING_MAX);
      if (cleaned === null) return null;
      if (STYLE_KEY_SET.has(key)) styles[key] = cleaned;
    }
  }

  return {
    selector,
    tag,
    componentName,
    rect,
    click,
    ...(styles ? { styles } : {}),
    altKey: raw.altKey,
    hasShadowRoot: raw.hasShadowRoot,
    href,
    ...(devicePixelRatio !== undefined ? { devicePixelRatio } : {}),
  };
}

/** Validate a Shift-batch. Oversized batches are dropped whole; individual
 *  malformed entries are skipped. */
export function sanitizePickerBatch(
  value: unknown,
  context: { origin: string; viewport: PickerViewport },
): PickedElement[] | null {
  if (!Array.isArray(value) || value.length > PICKER_BATCH_MAX) return null;
  const out: PickedElement[] = [];
  for (const item of value) {
    const element = sanitizePickerSelection(item, context);
    if (element) out.push(element);
  }
  return out;
}

export interface CaptureRegionInput {
  /** iframe.getBoundingClientRect() in main-window CSS px. */
  frame: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** iframe.offsetWidth/offsetHeight: unscaled layout size. */
  layout: { width: number; height: number };
  /** Element rect in iframe-viewport CSS px (already viewport-clamped). */
  element: PickerCaptureRect;
  /** Window viewport size. */
  window: { width: number; height: number };
  /** Bounds of overflow-clipping ancestors, per clipped axis. */
  clips?: ReadonlyArray<{
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  }>;
}

/** Translate a picked element rect into main-window coordinates, intersected
 *  with the iframe, every clipping ancestor and the window. Returns null when
 *  nothing of the element is visibly inside the iframe. */
export function computePickerCaptureRegion(
  input: CaptureRegionInput,
): PickerCaptureRect | null {
  const { frame, layout, element } = input;
  // Canvas Mode transforms the iframe wrapper. Picker rects remain in the
  // iframe's unscaled CSS coordinates, while capturePage expects main-window
  // coordinates, so apply the live transform scale on both axes.
  const scaleX = layout.width > 0 ? frame.width / layout.width : 1;
  const scaleY = layout.height > 0 ? frame.height / layout.height : 1;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
  const elLeft = frame.left + element.x * scaleX;
  const elTop = frame.top + element.y * scaleY;
  const elRight = elLeft + element.width * scaleX;
  const elBottom = elTop + element.height * scaleY;

  let clipLeft = Math.max(0, frame.left);
  let clipTop = Math.max(0, frame.top);
  let clipRight = Math.min(input.window.width, frame.right);
  let clipBottom = Math.min(input.window.height, frame.bottom);
  for (const clip of input.clips ?? []) {
    if (clip.left !== undefined) clipLeft = Math.max(clipLeft, clip.left);
    if (clip.right !== undefined) clipRight = Math.min(clipRight, clip.right);
    if (clip.top !== undefined) clipTop = Math.max(clipTop, clip.top);
    if (clip.bottom !== undefined) clipBottom = Math.min(clipBottom, clip.bottom);
  }
  const x = Math.max(clipLeft, elLeft);
  const y = Math.max(clipTop, elTop);
  const right = Math.min(clipRight, elRight);
  const bottom = Math.min(clipBottom, elBottom);
  const width = right - x;
  const height = bottom - y;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/** ⌘⇧D forwarded from inside the page is honored only while the user is
 *  actually focused in that iframe, and at most once per interval. */
export function createPickerToggleGate(minIntervalMs = 300) {
  let lastAcceptedAt = Number.NEGATIVE_INFINITY;
  return (context: {
    tabActive: boolean;
    windowFocused: boolean;
    frameFocused: boolean;
    now: number;
  }): boolean => {
    if (!context.tabActive || !context.windowFocused || !context.frameFocused)
      return false;
    if (context.now - lastAcceptedAt < minIntervalMs) return false;
    lastAcceptedAt = context.now;
    return true;
  };
}

/** Sliding-window limiter for page-originated selection messages, each of
 *  which can trigger screenshot IPC. */
export function createPickerRateLimiter(maxEvents = 20, windowMs = 1000) {
  const timestamps: number[] = [];
  return (now: number): boolean => {
    while (timestamps.length > 0 && now - timestamps[0] >= windowMs)
      timestamps.shift();
    if (timestamps.length >= maxEvents) return false;
    timestamps.push(now);
    return true;
  };
}
