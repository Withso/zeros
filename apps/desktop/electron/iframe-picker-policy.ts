// ──────────────────────────────────────────────────────────
// Design Mode picker policy for ordinary Browser iframes
// ──────────────────────────────────────────────────────────
//
// The picker runs in the visited page's main world (WebFrameMain exposes no
// isolated-world API), so any value that later reaches main through the
// renderer may have been forged by that page. These helpers keep the main-side
// decisions pure and testable: which frames receive the picker, and how a
// renderer-requested element screenshot is bounded to the requesting iframe.

export const BROWSER_FRAME_NAME_PREFIX = "zeros-browser-";
export const BROWSER_FRAME_NAME_MAX = 320;

/** Upper bound for any coordinate main accepts from the renderer. Far beyond
 *  any real display, small enough to keep arithmetic exact. */
const MAX_COORDINATE = 1_000_000;

export function isBrowserFrameName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(BROWSER_FRAME_NAME_PREFIX) &&
    value.length > BROWSER_FRAME_NAME_PREFIX.length &&
    value.length <= BROWSER_FRAME_NAME_MAX
  );
}

/** Design Mode is available on every ordinary web page shown in a Browser
 *  frame. Error pages, about:, data:, blob:, file:, devtools and extension
 *  schemes never receive the picker. */
export function pickerAllowedForUrl(url: string): boolean {
  if (typeof url !== "string" || url.length > 32_768) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function isBoundedNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_COORDINATE
  );
}

export function parseCaptureRegionArgs(
  args: unknown,
): { frameName: string; rect: CaptureRect } | null {
  if (!args || typeof args !== "object") return null;
  const raw = args as Record<string, unknown>;
  if (!isBrowserFrameName(raw.frameName)) return null;
  const { x, y, width, height } = raw;
  if (
    !isBoundedNumber(x) ||
    !isBoundedNumber(y) ||
    !isBoundedNumber(width) ||
    !isBoundedNumber(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0
  )
    return null;
  return { frameName: raw.frameName, rect: { x, y, width, height } };
}

export function parseFrameBounds(value: unknown): FrameBounds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { left, top, right, bottom } = raw;
  if (
    !isBoundedNumber(left) ||
    !isBoundedNumber(top) ||
    !isBoundedNumber(right) ||
    !isBoundedNumber(bottom) ||
    right <= left ||
    bottom <= top
  )
    return null;
  return { left, top, right, bottom };
}

/** Intersect a requested capture with the requesting iframe and the window
 *  content area. Edges round inward so the result never includes a pixel of
 *  app UI outside the iframe. */
export function clampCaptureRegion(
  rect: CaptureRect,
  frame: FrameBounds,
  content: { width: number; height: number },
): CaptureRect | null {
  const left = Math.ceil(Math.max(rect.x, frame.left, 0));
  const top = Math.ceil(Math.max(rect.y, frame.top, 0));
  const right = Math.floor(
    Math.min(rect.x + rect.width, frame.right, content.width),
  );
  const bottom = Math.floor(
    Math.min(rect.y + rect.height, frame.bottom, content.height),
  );
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Script evaluated in the trusted app renderer (never in a visited page) to
 *  read the requesting iframe's on-screen bounds. A hidden, inert (inactive
 *  tab) or ambiguous frame yields null, so capture fails closed. */
export function browserFrameBoundsScript(frameName: string): string {
  return `(() => {
  const name = ${JSON.stringify(frameName)};
  const matches = Array.prototype.filter.call(
    document.getElementsByTagName("iframe"),
    (frame) => frame.getAttribute("name") === name,
  );
  if (matches.length !== 1) return null;
  const frame = matches[0];
  if (!frame.isConnected || frame.closest("[inert]")) return null;
  if (
    typeof frame.checkVisibility === "function" &&
    !frame.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
    return null;
  const r = frame.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
})()`;
}
