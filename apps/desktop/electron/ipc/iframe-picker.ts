// ──────────────────────────────────────────────────────────
// Iframe picker IPC + auto-inject hook
// ──────────────────────────────────────────────────────────
//
// Replaces the deleted WebContentsView preload-script lifecycle.
// Two pieces:
//
// 1. Auto-inject. We hook `did-frame-finish-load` on the main
//    window. Every time a named Browser-tab iframe finishes a LOOPBACK
//    navigation, we execute the picker script in that frame's main world via
//    `WebFrameMain.executeJavaScript`. Public pages are tracked for browser
//    chrome/history, but never receive privileged picker code.
//
//    The picker IIFE is idempotent (sentinel-guarded). Repeat
//    injection on SPA navigations / hot-reloads is harmless.
//
// 2. `iframe-picker:capture-region` — given a CSS-px rect in the
//    main window's coordinate space, return a base64 PNG of that
//    region (via `webContents.capturePage`). Renderer uses this
//    to produce the picker chip's element thumbnail.
//
// Frame identification: each Browser iframe has a stable, tab-derived `name`.
// Main includes it in trusted navigation events so several mounted browsers
// cannot update one another's address/title state.

import { webFrameMain, type BrowserWindow, type WebFrameMain } from "electron";
import { setCommand } from "./router";
import { emitEvent } from "./events";
import { PICKER_SCRIPT } from "../iframe-picker-script";
import { isLoopbackUrl } from "../../src/renderer/shell/workbench/tabs/localhost-url";
import { PendingIframeNavigations } from "../iframe-navigation-state";

let mainWindowRef: BrowserWindow | null = null;
// `window.name` is page-mutable. Pin the DOM iframe's original React-assigned
// name to Chromium's stable frame-tree id before visited code can change it.
const browserFrameNames = new Map<number, string>();
const pendingBrowserNavigations = new PendingIframeNavigations();

interface CaptureRegionArgs {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// ──────────────────────────────────────────────────────────
// Auto-inject — picker into every top-level child iframe
// ──────────────────────────────────────────────────────────
//
// Top-level here means "child of the main frame" — NOT a nested
// frame inside one of our browser tabs (those would be ads,
// embedded videos, etc., where we don't want our picker
// interfering with the parent site's behavior).

function isTopLevelChildFrame(
  frame: WebFrameMain,
  mainFrame: WebFrameMain | null,
): boolean {
  if (!mainFrame) return false;
  if (frame === mainFrame) return false; // skip the main frame itself
  return frame.parent === mainFrame;
}

function browserFrameName(frame: WebFrameMain): string | null {
  const known = browserFrameNames.get(frame.frameTreeNodeId);
  if (known) return known;
  const initial = frame.name;
  if (!initial.startsWith("zeros-browser-")) return null;
  browserFrameNames.set(frame.frameTreeNodeId, initial);
  return initial;
}

function isBrowserTabFrame(
  frame: WebFrameMain,
  mainFrame: WebFrameMain | null,
): boolean {
  return (
    isTopLevelChildFrame(frame, mainFrame) && browserFrameName(frame) != null
  );
}

function emitBrowserNavigation(
  frame: WebFrameMain,
  url: string,
  title = "",
  loading = false,
  inPage = false,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  // Never send or persist HTTP basic-auth credentials through renderer state.
  parsed.username = "";
  parsed.password = "";
  const frameName = browserFrameName(frame);
  if (!frameName) return;
  emitEvent("browser-frame-navigated", {
    frameName,
    url: parsed.href,
    title: title.slice(0, 512),
    loading,
    inPage,
  });
}

/** A provisional navigation was cancelled before commit. Restore the URL that
 * was committed when the attempt began; an empty URL means the frame was blank. */
function emitCancelledBrowserNavigation(
  frame: WebFrameMain,
  cancelledUrl: string,
  previousUrl: string,
): void {
  const frameName = browserFrameName(frame);
  if (!frameName) return;
  emitEvent("browser-frame-navigated", {
    frameName,
    url: previousUrl,
    title: "",
    loading: false,
    cancelled: true,
    cancelledUrl,
  });
  // Restore the real title after the immediate cancellation state stops the
  // spinner. This is harmless if the frame was blank or disappeared meanwhile.
  void emitFinishedBrowserNavigation(frame);
}

async function emitFinishedBrowserNavigation(
  frame: WebFrameMain,
  inPage = false,
): Promise<void> {
  const frameName = browserFrameName(frame);
  if (
    !frameName ||
    !pendingBrowserNavigations.isCurrentFrame(frameName, frame.frameTreeNodeId)
  )
    return;
  const url = frame.url;
  if (!/^https?:\/\//i.test(url)) return;
  let title = "";
  try {
    const value = await frame.executeJavaScript("document.title", true);
    if (typeof value === "string") title = value;
  } catch {
    // A destroyed/OOP frame can disappear between finish-load and this read;
    // the URL event is still useful and gets a hostname fallback in React.
  }
  // `document.title` crosses an async OOP-frame boundary. If another
  // navigation committed meanwhile, dropping this result prevents a late old
  // title/URL from rolling the tab back in the renderer.
  try {
    if (
      frame.url !== url ||
      !pendingBrowserNavigations.isCurrentFrame(
        frameName,
        frame.frameTreeNodeId,
      )
    )
      return;
  } catch {
    return;
  }
  emitBrowserNavigation(frame, url, title, false, inPage);
}

async function injectPicker(frame: WebFrameMain): Promise<void> {
  try {
    await frame.executeJavaScript(PICKER_SCRIPT, true);
  } catch (err) {
    console.warn(
      "[Zeros iframe-picker] inject failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function reinjectBrowserPicker(
  win: BrowserWindow,
  targetFrameName?: string,
): Promise<boolean> {
  if (win.isDestroyed()) return false;
  const mainFrame = win.webContents.mainFrame;
  let injected = false;
  for (const child of mainFrame.framesInSubtree) {
    if (!isBrowserTabFrame(child, mainFrame)) continue;
    if (targetFrameName && browserFrameName(child) !== targetFrameName)
      continue;
    await emitFinishedBrowserNavigation(child);
    if (isLoopbackUrl(child.url)) {
      await injectPicker(child);
      injected = true;
    }
  }
  return injected;
}

function attachAutoInject(win: BrowserWindow): void {
  // Track the intended URL before commit so an in-page link leaving localhost
  // hides local-only controls immediately. Unlike the former navigation guard,
  // this observer never cancels or redirects the navigation.
  win.webContents.on("will-frame-navigate", (event) => {
    const frame = event.frame;
    if (!frame || !isBrowserTabFrame(frame, win.webContents.mainFrame)) return;
    const frameName = browserFrameName(frame);
    if (!frameName) return;
    const pending = pendingBrowserNavigations.begin(
      frameName,
      frame.frameTreeNodeId,
      event.url,
      frame.url,
    );
    if (!pending) return;
    emitBrowserNavigation(frame, event.url, "", true);
  });

  // A redirect replaces the provisional target but still belongs to the same
  // navigation. Moving the token prevents Chromium's abort of the old request
  // from looking like a terminal cancellation.
  win.webContents.on("did-redirect-navigation", (details) => {
    const frame = details.frame;
    if (
      details.isSameDocument ||
      !frame ||
      !isBrowserTabFrame(frame, win.webContents.mainFrame)
    )
      return;
    const frameName = browserFrameName(frame);
    if (!frameName) return;
    const pending = pendingBrowserNavigations.redirect(
      frameName,
      frame.frameTreeNodeId,
      details.url,
    );
    if (pending) emitBrowserNavigation(frame, details.url, "", true);
  });

  win.webContents.on(
    "did-frame-finish-load",
    (_event, isMainFrame, frameProcessId, frameRoutingId) => {
      // Main frame is OUR renderer (the React shell). The picker
      // would be useless there — it's the iframes' contents we
      // want to pick from.
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;
      if (!isBrowserTabFrame(frame, win.webContents.mainFrame)) return;
      const frameName = browserFrameName(frame);
      if (
        !frameName ||
        !pendingBrowserNavigations.completeFrame(
          frameName,
          frame.frameTreeNodeId,
          frame.url,
        )
      )
        return;
      void emitFinishedBrowserNavigation(frame);
      // Picker code is privileged main-world injection: external pages never
      // receive it, even if they forge renderer postMessages or redirects.
      if (isLoopbackUrl(frame.url)) void injectPicker(frame);
    },
  );

  const handleFailedBrowserNavigation = (args: {
    errorCode: number;
    validatedUrl: string;
    isMainFrame: boolean;
    frameProcessId: number;
    frameRoutingId: number;
  }) => {
    if (args.isMainFrame) return;
    const frame = webFrameMain.fromId(args.frameProcessId, args.frameRoutingId);
    if (!frame || !isBrowserTabFrame(frame, win.webContents.mainFrame)) return;

    const frameName = browserFrameName(frame);
    if (!frameName) return;
    const frameId = frame.frameTreeNodeId;
    const current = pendingBrowserNavigations.current(frameName);
    const failed = pendingBrowserNavigations.matchesFailure(
      frameName,
      frameId,
      args.validatedUrl,
    );
    // A failure from an older request must not roll back the newer navigation
    // that now owns this frame.
    if (current && !failed) return;

    if (args.errorCode === -3) {
      if (!failed) return;
      // Redirects and rapid user navigation often abort the older provisional
      // load immediately before the replacement starts. Defer one task so that
      // replacement can install its own token; only an unsuperseded abort rolls
      // the renderer back to the committed URL.
      setTimeout(() => {
        if (!pendingBrowserNavigations.complete(frameName, failed)) return;
        emitCancelledBrowserNavigation(
          frame,
          failed.requestedUrl,
          failed.previousUrl,
        );
      }, 0);
      return;
    }

    if (current) pendingBrowserNavigations.complete(frameName, current);
    if (!pendingBrowserNavigations.isCurrentFrame(frameName, frameId)) return;
    // A real network/HTTP failure is still the terminal state of the address
    // navigation: Chromium displays its error page at the requested URL.
    emitBrowserNavigation(frame, args.validatedUrl, "", false);
  };

  // Failed public/local loads still complete an address-bar navigation. Both
  // events matter: Electron reports a pre-commit cancellation through
  // did-fail-provisional-load, while ordinary failures reach did-fail-load.
  win.webContents.on(
    "did-fail-load",
    (
      _event,
      errorCode,
      _errorDescription,
      validatedUrl,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      handleFailedBrowserNavigation({
        errorCode,
        validatedUrl,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      });
    },
  );
  win.webContents.on(
    "did-fail-provisional-load",
    (
      _event,
      errorCode,
      _errorDescription,
      validatedUrl,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      handleFailedBrowserNavigation({
        errorCode,
        validatedUrl,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      });
    },
  );

  // History API/hash navigations do not fire a full frame load. Keep the URL
  // bar, tab persistence, and localhost tool gating current for those too.
  win.webContents.on(
    "did-navigate-in-page",
    (_event, url, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame || !isBrowserTabFrame(frame, win.webContents.mainFrame))
        return;
      const frameName = browserFrameName(frame);
      if (
        !frameName ||
        !pendingBrowserNavigations.isCurrentFrame(
          frameName,
          frame.frameTreeNodeId,
        )
      )
        return;
      void emitFinishedBrowserNavigation(frame, true);
    },
  );
}

// ──────────────────────────────────────────────────────────
// Capture region — renderer-driven, for picker chip thumbnails
// ──────────────────────────────────────────────────────────

async function handleCaptureRegion(
  args: CaptureRegionArgs,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return { ok: false, error: "main window not available" };
  }
  if (
    !isPositiveInt(args.x) ||
    !isPositiveInt(args.y) ||
    !isPositiveInt(args.width) ||
    !isPositiveInt(args.height)
  ) {
    return { ok: false, error: "x/y/width/height required" };
  }
  if (args.width === 0 || args.height === 0) {
    return { ok: false, error: "zero-sized rect" };
  }
  // Clamp to window content bounds — capturePage errors on
  // partially off-screen rects (e.g., picked element at viewport
  // edge with the rect spilling past the right border).
  const bounds = mainWindowRef.getContentBounds();
  const x = Math.max(0, Math.min(args.x, bounds.width - 1));
  const y = Math.max(0, Math.min(args.y, bounds.height - 1));
  const w = Math.min(args.width, bounds.width - x);
  const h = Math.min(args.height, bounds.height - y);
  if (w <= 0 || h <= 0) {
    return { ok: false, error: "clamped to empty rect" };
  }
  try {
    const img = await mainWindowRef.webContents.capturePage({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(w),
      height: Math.round(h),
    });
    return { ok: true, dataUrl: img.toDataURL() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerIframePickerCommands(opts: {
  mainWindow: BrowserWindow;
}): void {
  browserFrameNames.clear();
  pendingBrowserNavigations.clear();
  mainWindowRef = opts.mainWindow;
  attachAutoInject(opts.mainWindow);
  setCommand("iframe-picker:capture-region", (a) =>
    handleCaptureRegion(a as CaptureRegionArgs),
  );
  setCommand("browser:reinject-picker", async (args) => {
    const frameName =
      typeof args.frameName === "string" &&
      args.frameName.startsWith("zeros-browser-") &&
      args.frameName.length <= 320
        ? args.frameName
        : undefined;
    const ok = await reinjectBrowserPicker(opts.mainWindow, frameName);
    return { ok };
  });

  opts.mainWindow.on("closed", () => {
    if (mainWindowRef === opts.mainWindow) {
      mainWindowRef = null;
      browserFrameNames.clear();
      pendingBrowserNavigations.clear();
    }
  });
}
