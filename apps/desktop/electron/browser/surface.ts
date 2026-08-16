import type {
  BrowserJsonValue,
  BrowserSessionState,
  BrowserToolName,
} from "@zeros/protocol/browser-tools";

import { browserError } from "./errors";

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SAFE_FAVICON_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]);

const MAX_NATIVE_COORDINATE = 20_000;
const MAX_NATIVE_DIMENSION = 10_000;
const MIN_RENDERER_ZOOM = 0.25;
const MAX_RENDERER_ZOOM = 5;
const ROUNDING_OVERFLOW_PX = 2;

/** Title events may briefly contain Chromium's hostname fallback or a site's
 * intermediate client-render title. Commit only the newest candidate after a
 * quiet, loaded interval; navigation cancels the pending candidate. */
export interface BrowserTitleSettlement {
  confirmed: string;
  pending: string | null;
  generation: number;
}

export function queueBrowserTitleCandidate(
  state: BrowserTitleSettlement,
  rawTitle: string,
): BrowserTitleSettlement {
  const candidate = rawTitle.trim().slice(0, 512);
  if (!candidate) return state;
  return {
    confirmed: state.confirmed,
    pending: candidate,
    generation: state.generation + 1,
  };
}

export function cancelBrowserTitleCandidate(
  state: BrowserTitleSettlement,
): BrowserTitleSettlement {
  return {
    confirmed: state.confirmed,
    pending: null,
    generation: state.generation + 1,
  };
}

export function commitBrowserTitleCandidate(
  state: BrowserTitleSettlement,
  generation: number,
  loading: boolean,
): BrowserTitleSettlement {
  if (loading || generation !== state.generation || !state.pending) {
    return state;
  }
  return {
    confirmed: state.pending,
    pending: null,
    generation: state.generation,
  };
}

/** Keep an untrusted renderer from placing the native guest outside the app or
 * creating an unbounded compositor surface. Main additionally checks that the
 * IPC sender is the current trusted window before applying these bounds. */
export function normalizeBrowserViewBounds(
  value: unknown,
): BrowserViewBounds | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;
  if (![x, y, width, height].every(Number.isInteger)) return null;
  if (
    (x as number) < 0 ||
    (y as number) < 0 ||
    (x as number) > MAX_NATIVE_COORDINATE ||
    (y as number) > MAX_NATIVE_COORDINATE ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    (width as number) > MAX_NATIVE_DIMENSION ||
    (height as number) > MAX_NATIVE_DIMENSION
  ) {
    return null;
  }
  return {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
  };
}

/** Renderer DOMRects are expressed in CSS pixels, while a native child view
 * uses window device-independent pixels. Page zoom changes that ratio. Scale
 * both edges (rather than width alone), then reject anything materially
 * outside the trusted window; the two-pixel tolerance only absorbs fractional
 * layout rounding at the right and bottom edges. */
export function normalizeBrowserViewBoundsForHost(
  value: unknown,
  zoomFactor: number,
  host: { width: number; height: number },
): BrowserViewBounds | null {
  const bounds = normalizeBrowserViewBounds(value);
  if (
    !bounds ||
    !Number.isFinite(zoomFactor) ||
    zoomFactor < MIN_RENDERER_ZOOM ||
    zoomFactor > MAX_RENDERER_ZOOM ||
    !Number.isSafeInteger(host.width) ||
    !Number.isSafeInteger(host.height) ||
    host.width < 1 ||
    host.height < 1 ||
    host.width > MAX_NATIVE_COORDINATE ||
    host.height > MAX_NATIVE_COORDINATE
  ) {
    return null;
  }

  const left = Math.round(bounds.x * zoomFactor);
  const top = Math.round(bounds.y * zoomFactor);
  const rawRight = Math.round((bounds.x + bounds.width) * zoomFactor);
  const rawBottom = Math.round((bounds.y + bounds.height) * zoomFactor);
  if (
    left < 0 ||
    top < 0 ||
    left >= host.width ||
    top >= host.height ||
    rawRight - host.width > ROUNDING_OVERFLOW_PX ||
    rawBottom - host.height > ROUNDING_OVERFLOW_PX
  ) {
    return null;
  }
  const right = Math.min(rawRight, host.width);
  const bottom = Math.min(rawBottom, host.height);
  return normalizeBrowserViewBounds({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

/** The attached native rectangle is the responsive viewport users and Codex
 * actually see. Keep it exact (including compact PiP/split sizes) rather than
 * applying the explicit Resize tool's independent 320px minimum. */
export function browserViewportForAttachedBounds(bounds: BrowserViewBounds): {
  width: number;
  height: number;
} {
  return { width: bounds.width, height: bounds.height };
}

/** Choose the CSS viewport and Chromium page zoom for a native presentation.
 * Workbench uses a literal 1:1 responsive viewport. PiP keeps the last full
 * desktop viewport and scales it uniformly into the measured native host, so
 * a compact preview shows the same page layout rather than a mobile reflow. */
export function browserViewportPresentation(
  bounds: BrowserViewBounds,
  sourceViewport: { width: number; height: number },
  pictureInPicture: boolean,
): {
  viewport: { width: number; height: number };
  zoomFactor: number;
} {
  if (!pictureInPicture) {
    return {
      viewport: browserViewportForAttachedBounds(bounds),
      zoomFactor: 1,
    };
  }
  const zoomFactor = Math.min(
    bounds.width / sourceViewport.width,
    bounds.height / sourceViewport.height,
  );
  return {
    viewport: { ...sourceViewport },
    zoomFactor: Math.max(0.25, Math.min(5, zoomFactor)),
  };
}

/** An explicit plugin Resize changes the parked browser's viewport. While the
 * native page is attached, the host rectangle remains authoritative so CDP
 * coordinates cannot drift from what the user sees. */
export function browserViewportAfterExplicitResize(
  current: { width: number; height: number },
  requested: { width: number; height: number },
  attachedToParkingWindow: boolean,
): { width: number; height: number } {
  return attachedToParkingWindow ? requested : current;
}

/** Apply both user policy and trusted-surface availability at the host seam.
 * The engine performs the same policy read, but this second check closes the
 * queued/in-flight race for bindings created before a Settings edit. */
export function browserServiceInvocationBlockedReason(input: {
  browserEnabled: boolean;
  trustedSurfaceAvailable: boolean;
}): string | null {
  if (!input.browserEnabled) return "Browser use is disabled in Settings.";
  if (!input.trustedSurfaceAvailable) {
    return "Open the trusted Zeros window before using browser automation.";
  }
  return null;
}

export function browserRendererEventIsCurrent(input: {
  capturedEpoch: number;
  currentEpoch: number;
  sameWindow: boolean;
}): boolean {
  return input.sameWindow && input.capturedEpoch === input.currentEpoch;
}

export function shouldRevokeBrowserSurfaceForNavigation(input: {
  isMainFrame: boolean;
  isSameDocument: boolean;
}): boolean {
  return input.isMainFrame && !input.isSameDocument;
}

export function browserAgentActionStillOwnsPage(
  inspectedUserInputGeneration: number,
  currentUserInputGeneration: number,
): boolean {
  return inspectedUserInputGeneration === currentUserInputGeneration;
}

export interface BrowserInputTargetFingerprint {
  tagName: string;
  inputType: string;
  label: string;
  x?: number;
  y?: number;
}

/** A confirmation can leave arbitrary page JavaScript running. Recheck the
 * semantic input identity and its visible location after that pause so a site
 * cannot turn an approved password/file target into a different control. */
export function browserInputTargetStillMatches(
  inspected: BrowserInputTargetFingerprint,
  current: BrowserInputTargetFingerprint,
): boolean {
  if (
    inspected.tagName !== current.tagName ||
    inspected.inputType !== current.inputType ||
    inspected.label !== current.label
  ) {
    return false;
  }
  if (
    inspected.x === undefined ||
    inspected.y === undefined ||
    current.x === undefined ||
    current.y === undefined
  ) {
    return true;
  }
  return (
    Number.isFinite(inspected.x) &&
    Number.isFinite(inspected.y) &&
    Number.isFinite(current.x) &&
    Number.isFinite(current.y) &&
    Math.abs(inspected.x - current.x) <= 4 &&
    Math.abs(inspected.y - current.y) <= 4
  );
}

export function browserPolicySnapshotIsCurrent(
  capturedGeneration: number,
  currentGeneration: number,
): boolean {
  return capturedGeneration === currentGeneration;
}

/** Semantic validation failures are returned as ordinary tool results rather
 * than exceptions. If an action exits through one of those branches after the
 * host published `working`, settle it explicitly so the renderer does not
 * leave the Agent spinner and cursor ownership active indefinitely. */
export function browserOperationNeedsReadySettlement(
  status: BrowserSessionState["status"],
): boolean {
  return status === "working";
}

/** Trusted browser chrome starts history navigation on the current native
 * WebContents immediately. Agent tools still use the semantic path that waits
 * for a settled page snapshot; Back/Forward/Reload in the UI must not pay that
 * snapshot cost before Chromium can respond to the click. */
export function dispatchBrowserUserNavigation(input: {
  tool: "open" | "back" | "forward" | "reload";
  url?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  open(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
}): boolean {
  switch (input.tool) {
    case "open":
      if (!input.url) return false;
      input.open(input.url);
      return true;
    case "back":
      if (!input.canGoBack) return false;
      input.back();
      return true;
    case "forward":
      if (!input.canGoForward) return false;
      input.forward();
      return true;
    case "reload":
      input.reload();
      return true;
  }
}

/** Navigation/title events arrive independently from the invocation promise.
 * They enrich URL/title state but may not end an action that still owns the
 * page. */
export function browserNavigationPublishStatus(input: {
  currentStatus: BrowserSessionState["status"];
  activeOperations: number;
}): BrowserSessionState["status"] {
  return input.activeOperations > 0 && input.currentStatus === "working"
    ? "working"
    : input.currentStatus;
}

export type BrowserInputDisposition = "block" | "allow";

/** Native Browser ownership is turn-scoped, not command-scoped. A gap between
 * node_repl batches is still agent work, so direct page input stays blocked for
 * the whole provider-owned turn regardless of status or activity timers; only
 * finalize/turn-ended or Stop hands the same WebContents back to the user (both
 * run `releaseCodexNativeControl`). Input the host itself synthesized for the
 * current agent action is always allowed through. */
export function browserInputDisposition(input: {
  actor: "agent" | "user";
  /** Input synthesized by the trusted service for the current agent action. */
  agentDispatched?: boolean;
}): BrowserInputDisposition {
  if (input.agentDispatched) return "allow";
  return input.actor === "user" ? "allow" : "block";
}

export type BrowserAgentNavigationDisposition = "allow" | "confirm";

/** Main-frame navigations initiated by page code during agent ownership use
 * the same website gate as explicit `open` and cross-site links. Subframes are
 * ordinary page resources; gating them would turn ads and embeds into a prompt
 * storm. The service validates the URL/scheme before calling this helper. */
export function browserAgentNavigationDisposition(input: {
  actor: "agent" | "user";
  currentOrigin: string | null;
  targetOrigin: string;
  isMainFrame: boolean;
  navigationApproval: "always-ask" | "always-allow";
  siteAllowed: boolean;
  preapprovedOrigin: string | null;
  /** The official provider plugin already elicited this top-level origin.
   * Zeros must not stack a second native card over the provider's card. */
  officialProviderOwnsOriginApproval?: boolean;
}): BrowserAgentNavigationDisposition {
  if (
    !input.isMainFrame ||
    input.actor === "user" ||
    input.officialProviderOwnsOriginApproval === true ||
    input.navigationApproval === "always-allow" ||
    input.siteAllowed ||
    input.currentOrigin === input.targetOrigin ||
    input.preapprovedOrigin === input.targetOrigin
  ) {
    return "allow";
  }
  return "confirm";
}

export function normalizedBrowserFaviconMime(
  value: string | null,
): string | null {
  const mime = value?.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
  return SAFE_FAVICON_MIME_TYPES.has(mime) ? mime : null;
}

/** Preserve the site's declared preference, dedupe aliases, then try the
 * conventional origin paths. Some modern sites expose only `/favicon.svg`,
 * and Electron does not guarantee a page-favicon-updated event for every
 * client-side route, so retain it as a fallback after the classic ICO. */
export function orderedBrowserFaviconCandidates(
  pageUrl: string,
  advertised: readonly string[] = [],
): string[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [...new Set(advertised)];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return [...new Set(advertised)];
  }
  return [
    ...new Set([
      ...advertised,
      new URL("/favicon.ico", url).href,
      new URL("/favicon.svg", url).href,
      new URL("/apple-touch-icon.png", url).href,
    ]),
  ];
}

/** SVG is useful for modern sites but unlike raster bytes it must stay a
 * passive image. Reject active/event-bearing or externally-referencing SVG
 * before exposing it as a renderer data URL. */
export function safeBrowserSvgFavicon(bytes: Buffer): boolean {
  const source = bytes.toString("utf8");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source)) return false;
  if (
    /<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:|\/\/)|@import\b/i.test(
      source,
    )
  ) {
    return false;
  }
  for (const match of source.matchAll(/url\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi)) {
    if (!match[2]?.trim().startsWith("#")) return false;
  }
  return true;
}

interface BrowserFaviconFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

type BrowserFaviconFetch = (
  url: string,
  init: {
    signal: AbortSignal;
    redirect: "manual";
    referrer?: string;
    headers: Record<string, string>;
  },
) => Promise<BrowserFaviconFetchResponse>;

const BROWSER_FAVICON_MAX_BYTES = 192 * 1024;
const BROWSER_FAVICON_MAX_REDIRECTS = 5;

function normalizedBrowserFaviconUrl(
  value: string,
  baseUrl?: string,
): string | null {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.href.length > 8_192
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Fetch one website icon without trusting Electron's Response.url. Electron's
 * net-backed fetch currently documents that field as incorrect, so successful
 * icon responses are authenticated by the validated request/redirect chain
 * instead. Redirects stay manual and bounded so every hop is revalidated. */
export async function fetchBrowserFaviconDataUrl(input: {
  url: string;
  pageUrl?: string;
  fetch: BrowserFaviconFetch;
  normalizeRaster(bytes: Buffer): Buffer | null;
  maximumBytes?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  const maximumBytes = input.maximumBytes ?? BROWSER_FAVICON_MAX_BYTES;
  const initialUrl = normalizedBrowserFaviconUrl(input.url, input.pageUrl);
  if (!initialUrl || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return null;
  }
  let currentUrl = initialUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 4_000);
  timer.unref?.();
  try {
    for (
      let redirectCount = 0;
      redirectCount <= BROWSER_FAVICON_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      const response = await input.fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        ...(input.pageUrl ? { referrer: input.pageUrl } : {}),
        headers: {
          accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        const redirectedUrl: string | null = location
          ? normalizedBrowserFaviconUrl(location, currentUrl)
          : null;
        if (
          !redirectedUrl ||
          redirectCount === BROWSER_FAVICON_MAX_REDIRECTS
        ) {
          return null;
        }
        currentUrl = redirectedUrl;
        continue;
      }
      if (!response.ok) return null;

      const advertised = Number(
        response.headers.get("content-length") ?? 0,
      );
      if (Number.isFinite(advertised) && advertised > maximumBytes) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) return null;

      const mime = normalizedBrowserFaviconMime(
        response.headers.get("content-type"),
      );
      // Rasterizing an unsafe SVG is not a substitute for validating it: the
      // parser must never get a chance to resolve active/external resources.
      if (mime === "image/svg+xml" && !safeBrowserSvgFavicon(bytes)) {
        return null;
      }
      const raster = input.normalizeRaster(bytes);
      if (raster && raster.byteLength > 0 && raster.byteLength <= maximumBytes) {
        return `data:image/png;base64,${raster.toString("base64")}`;
      }
      return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
    }
  } catch {
    // Website artwork is optional decoration and never fails page navigation.
  } finally {
    clearTimeout(timer);
  }
  return null;
}

export type BrowserFaviconNavigationDisposition = "ignore" | "retain" | "reset";

/** Start the conventional-path fallback only when no website icon is already
 * confirmed and no request for the current favicon generation is in flight.
 * Otherwise a slower generic `/favicon.ico` fetch can invalidate the page's
 * advertised icon request and leave a permanent globe if the fallback fails. */
export function browserFaviconFallbackNeeded(input: {
  hasFavicon: boolean;
  currentGeneration: number;
  resolvingGeneration: number | null;
}): boolean {
  return (
    !input.hasFavicon &&
    input.resolvingGeneration !== input.currentGeneration
  );
}

/** Favicons belong to an exact web origin, but ordinary same-origin route
 * changes do not invalidate that identity. Electron may omit a new
 * `page-favicon-updated` event on SPA/history navigations, so clearing the icon
 * for every main-frame navigation turns a confirmed favicon into a permanent
 * globe. Cross-origin document changes still reset immediately so artwork can
 * never bleed between sites. */
export function browserFaviconNavigationDisposition(input: {
  currentOrigin: string | null;
  targetUrl: string;
  isMainFrame: boolean;
  isSameDocument: boolean;
}): BrowserFaviconNavigationDisposition {
  if (!input.isMainFrame) return "ignore";
  if (input.isSameDocument) return "retain";
  let targetOrigin: string | null = null;
  try {
    const target = new URL(input.targetUrl);
    if (target.protocol === "http:" || target.protocol === "https:") {
      targetOrigin = target.origin;
    }
  } catch {
    // A malformed/non-web target cannot inherit a prior website's identity.
  }
  return targetOrigin && targetOrigin === input.currentOrigin
    ? "retain"
    : "reset";
}

/** Deduplicate concurrent waits against one native target. Callers retain
 * exact promise identity, and settlement removes only its own generation so a
 * newly-started wait cannot be deleted by an older finally handler. */
export function createSharedBrowserWaiter<T extends object>(
  waitOnce: (target: T) => Promise<void>,
): (target: T) => Promise<void> {
  const pending = new WeakMap<T, Promise<void>>();
  return (target) => {
    const existing = pending.get(target);
    if (existing) return existing;
    const current = waitOnce(target).finally(() => {
      if (pending.get(target) === current) pending.delete(target);
    });
    pending.set(target, current);
    return current;
  };
}

/** Hidden leases are bounded by the idle timer, but a page visibly attached
 * to the workbench is not idle. Active serialized work likewise survives a
 * timeout tick and receives a fresh bounded window. */
export function browserSessionShouldRemainAlive(input: {
  activeOperations: number;
  surfaceAttached: boolean;
}): boolean {
  return input.activeOperations > 0 || input.surfaceAttached;
}

/** A native page can move from the full Workbench host to PiP while React is
 * still cleaning up the old host. Only the surface token that currently owns
 * the WebContentsView may park it; stale effect cleanup becomes a no-op. */
export function browserSurfaceDetachAllowed(
  currentSurfaceId: string | null,
  requestedSurfaceId: string,
): boolean {
  return currentSurfaceId === requestedSurfaceId;
}

/** Approval UI is rendered in the trusted chat column, so it must not blank a
 * live browser that is already attached beside it. A hidden parking window can
 * still suppress its child while confirmation is pending; once the depth
 * returns to zero the page resumes background rendering normally. */
export function browserSurfaceShouldBeVisible(input: {
  attachedToTrustedWindow: boolean;
  confirmationDepth: number;
}): boolean {
  return input.attachedToTrustedWindow || input.confirmationDepth === 0;
}

/** Resizing an already attached native guest must not clear hover: the PiP
 * uses that state to reserve clickable toolbar chrome. Rehosting to another
 * surface does clear it so hover never leaks between Workbench and PiP. */
export function browserSurfaceHoverAfterAttach(
  surfaceChanged: boolean,
  currentlyHovered: boolean,
): boolean {
  return surfaceChanged ? false : currentlyHovered;
}

interface BrowserSurfaceCaptureImage {
  toDataURL(): string;
  toJPEG(quality: number): Buffer;
}

/** Renderer menus and toasts need a still image before the native guest can
 * be parked beneath React. Prefer lossless PNG, but a large/high-DPI page can
 * exceed the bounded IPC response even for a viewport capture. Fall back to a
 * compact JPEG rather than leaving the native child above the trusted overlay.
 */
export function browserSurfaceCaptureDataUrl(
  image: BrowserSurfaceCaptureImage,
  maximumBytes: number,
): string | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return null;
  const png = image.toDataURL();
  if (Buffer.byteLength(png, "utf8") <= maximumBytes) return png;
  const jpeg = `data:image/jpeg;base64,${image.toJPEG(82).toString("base64")}`;
  return Buffer.byteLength(jpeg, "utf8") <= maximumBytes ? jpeg : null;
}

function actionRecord(
  value: BrowserJsonValue,
): Record<string, BrowserJsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/** Trusted, non-sensitive copy for the browser chrome. */
export function browserActionLabel(
  tool: BrowserToolName,
  rawArguments: BrowserJsonValue,
): string {
  const args = actionRecord(rawArguments);
  switch (tool) {
    case "open": {
      try {
        const host = new URL(String(args.url ?? "")).hostname;
        return host ? `Opening ${host}…` : "Opening website…";
      } catch {
        return "Opening website…";
      }
    }
    case "snapshot":
      return "Reading page…";
    case "click":
      return "Clicking…";
    case "type":
      return "Typing…";
    case "scroll": {
      const y = Number(args.y ?? 0);
      if (y > 0) return "Scrolling down…";
      if (y < 0) return "Scrolling up…";
      return "Scrolling page…";
    }
    case "upload":
      return "Preparing upload…";
    case "resize":
      return "Resizing browser…";
    case "back":
      return "Going back…";
    case "forward":
      return "Going forward…";
    case "reload":
      return "Reloading page…";
    case "screenshot":
      return "Taking screenshot…";
    case "trace":
      return "Saving browser trace…";
    case "close":
      return "Finishing browser session…";
  }
}

/** Build the page-level cyan working treatment shown above the shared native
 * WebContents. It is visual only: `pointer-events:none` is load-bearing because
 * native Codex clicks are dispatched through CDP and must hit the underlying
 * site. Electron's before-input-event/before-mouse-event policy—not this
 * untrusted DOM node—blocks direct user interaction while the agent owns the
 * turn. */
export function browserAgentWorkingOverlayScript(
  overlayId: string,
  active: boolean,
): string {
  return `(() => {
    const id=${JSON.stringify(overlayId)};
    const cursorStyleId=id+"-hide-user-cursor";
    let root=document.getElementById(id);
    if (${JSON.stringify(active)}) {
      let cursorStyle=document.getElementById(cursorStyleId);
      if (!cursorStyle) {
        cursorStyle=document.createElement("style");
        cursorStyle.id=cursorStyleId;
        cursorStyle.textContent="html,body,*{cursor:none!important}";
        (document.head||document.documentElement).appendChild(cursorStyle);
      }
      if (!root) {
        root=document.createElement("div");
        root.id=id;
        root.setAttribute("aria-hidden","true");
        root.style.cssText="position:fixed;inset:0;z-index:2147483645;pointer-events:none;user-select:none;opacity:0;transition:opacity 180ms ease;background:radial-gradient(ellipse at 50% 112%,rgba(21,174,229,.30),transparent 48%),linear-gradient(180deg,rgba(24,181,229,.10),rgba(19,127,210,.20));box-shadow:inset 0 0 72px rgba(28,192,236,.46),inset 0 -34px 70px rgba(28,110,235,.34)";
        (document.documentElement||document.body).appendChild(root);
      }
      requestAnimationFrame(()=>{ if(root?.isConnected) root.style.opacity="1"; });
      return true;
    }
    document.getElementById(cursorStyleId)?.remove();
    if (!root?.isConnected) return true;
    root.style.opacity="0";
    setTimeout(()=>root?.remove(),190);
    return true;
  })()`;
}

/** Build the page-owned visual cursor for native agent input. Exported as a
 * pure script factory so the trusted style/interaction contract is covered
 * without booting Electron. */
export function browserAgentPointerOverlayScript(
  overlayId: string,
  pointer: NonNullable<BrowserSessionState["pointer"]>,
): string {
  return `(() => {
    const id = ${JSON.stringify(overlayId)};
    const version = "compact-v2";
    let root = document.getElementById(id);
    if (root && root.dataset.zerosCursorVersion !== version) {
      root.remove();
      root = null;
    }
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      root.dataset.zerosCursorVersion = version;
      root.setAttribute("aria-hidden", "true");
      root.style.cssText = "position:fixed;z-index:2147483647;display:flex;align-items:flex-start;pointer-events:none;user-select:none;transition:left 90ms ease-out,top 90ms ease-out;filter:drop-shadow(0 1px 1px rgba(0,0,0,.76)) drop-shadow(0 0 2px rgba(103,80,255,.96)) drop-shadow(0 0 6px rgba(103,80,255,.42))";
      const cursor = document.createElement("span");
      cursor.style.cssText = "display:block;width:16px;height:18px;transform:translate(-2px,-2px)";
      cursor.innerHTML = '<svg width="16" height="18" viewBox="0 0 16 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.75 1.45 14.35 10.8l-5.05 1.05-2.75 4.55-4.8-14.95Z" fill="#050505" stroke="#fff" stroke-width="1.35" stroke-linejoin="round"/></svg>';
      root.append(cursor);
      (document.documentElement || document.body).appendChild(root);
    }
    root.style.left = ${JSON.stringify(`${pointer.x}px`)};
    root.style.top = ${JSON.stringify(`${pointer.y}px`)};
    root.style.opacity = "1";
    if (${JSON.stringify(pointer.action)} === "click" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const pulse = document.createElement("span");
      pulse.style.cssText = "position:absolute;left:-5px;top:-5px;width:20px;height:20px;border-radius:999px;background:radial-gradient(circle,rgba(124,58,237,.42),rgba(47,190,235,.18) 48%,transparent 72%);filter:blur(.2px)";
      root.appendChild(pulse);
      pulse.animate(
        [{ transform: "scale(.55)", opacity: .9 }, { transform: "scale(1.45)", opacity: 0 }],
        { duration: 360, easing: "ease-out" }
      ).finished.then(() => pulse.remove(), () => pulse.remove());
    }
    return true;
  })()`;
}

/** Chromium reports Page.navigate `ERR_ABORTED` for a successful redirect
 * when the original request is superseded. Recover only after a different,
 * usable HTTP(S) document has committed; blocked/unchanged pages and every
 * other network error remain genuine failures. */
export function normalizeCodexPageNavigateResult(
  result: unknown,
  context: {
    requestedUrl: string;
    previousUrl: string;
    currentUrl: string;
    usableDocument: boolean;
  },
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const response = result as Record<string, unknown>;
  if (
    response.errorText !== "net::ERR_ABORTED" ||
    !context.usableDocument ||
    !differentHttpDocument(context.previousUrl, context.currentUrl) ||
    !differentHttpDocument(context.requestedUrl, context.currentUrl)
  ) {
    return result;
  }
  const normalized = { ...response };
  delete normalized.errorText;
  return normalized;
}

function differentHttpDocument(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      (rightUrl.protocol === "http:" || rightUrl.protocol === "https:") &&
      leftUrl.href !== rightUrl.href
    );
  } catch {
    return false;
  }
}

/** Add the page's accessible control name to trusted activity chrome without
 * ever using its value. Callers supply only aria/label/title/name-derived copy;
 * typed text and upload paths never enter this function. */
export function browserElementActionLabel(
  tool: "click" | "type" | "upload",
  value: string,
): string {
  const label = value.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!label) return browserActionLabel(tool, {});
  switch (tool) {
    case "click":
      return `Clicking ${label}…`.slice(0, 160);
    case "type":
      return `Typing in ${label}…`.slice(0, 160);
    case "upload":
      return `Uploading to ${label}…`.slice(0, 160);
  }
}

export interface BrowserDomMarkers {
  refAttribute: string;
  refScope: string;
  pointerId: string;
  annotationId: string;
}

/** Page markup is untrusted. Namespace every marker injected by the host so a
 * site cannot pre-seed the legacy fixed ids/attributes and redirect an action
 * to a different element before the first snapshot. */
export function browserDomMarkers(token: string): BrowserDomMarkers {
  if (!/^[a-f0-9]{24}$/.test(token)) {
    throw browserError("Invalid browser DOM marker token.");
  }
  return {
    refAttribute: `data-zeros-browser-ref-${token}`,
    refScope: token,
    pointerId: `__zeros-agent-pointer-${token}`,
    annotationId: `__zeros-browser-annotations-${token}`,
  };
}

export interface BrowserDocumentReadiness {
  url: string;
  readyState: string;
  hasDocumentElement: boolean;
}

/** Chromium can keep a long-lived request open after the useful document has
 * rendered. A timeout may be treated as success only for a real HTTP(S)
 * document whose DOM is already interactive; about:blank and partial loads
 * still fail closed. */
export function usableBrowserDocument(
  value: BrowserDocumentReadiness,
): boolean {
  let protocol: string;
  try {
    protocol = new URL(value.url).protocol;
  } catch {
    return false;
  }
  return (
    (protocol === "http:" || protocol === "https:") &&
    value.hasDocumentElement &&
    (value.readyState === "interactive" || value.readyState === "complete")
  );
}
