// ──────────────────────────────────────────────────────────
// Iframe picker IPC + auto-inject hook
// ──────────────────────────────────────────────────────────
//
// Replaces the deleted WebContentsView preload-script lifecycle.
// Two pieces:
//
// 1. Browser metadata + auto-inject. We hook `did-frame-finish-load` on the
//    main window. Every named Browser-tab iframe publishes trusted URL/title
//    metadata and a validated favicon. Every http(s) page in such a frame also
//    receives the dormant Design Mode picker through
//    `WebFrameMain.executeJavaScript`. That API has no isolated world, so the
//    picker shares the page's main world: everything it reports is treated as
//    untrusted page input by the renderer and by the capture handler below.
//
//    The picker IIFE is idempotent (sentinel-guarded). Repeat
//    injection on SPA navigations / hot-reloads is harmless.
//
// 2. `iframe-picker:capture-region` — given a CSS-px rect in the
//    main window's coordinate space, return a base64 PNG of that
//    region (via `webContents.capturePage`). Renderer uses this
//    to produce the picker chip's element thumbnail. The rect is clamped to
//    the named iframe's own on-screen bounds, so a forged selection can never
//    capture app UI or another tab.
//
// Frame identification: each Browser iframe has a stable, tab-derived `name`.
// Main includes it in trusted navigation/favicon events so several mounted
// browsers cannot update one another's address/title/artwork state.

import { webFrameMain, type BrowserWindow, type WebFrameMain } from "electron";
import { setCommand } from "./router";
import { emitEvent } from "./events";
import { PICKER_SCRIPT } from "../iframe-picker-script";
import {
  browserFrameBoundsScript,
  clampCaptureRegion,
  isBrowserFrameName,
  parseCaptureRegionArgs,
  parseFrameBounds,
  pickerAllowedForUrl,
} from "../iframe-picker-policy";
import { PendingIframeNavigations } from "../iframe-navigation-state";
import { previewFrameAuthorizations } from "../preview-frame-authorizations";
import {
  declaredIframeFaviconUrls,
  iframeFaviconNavigationDisposition,
  resolveIframeFaviconDataUrl,
} from "../iframe-favicon";
import {
  controlBrowserIframe,
  parseBrowserIframeControl,
} from "../iframe-frame-control";
import {
  disposeCloudWorkspaceAccessBroker,
  getCloudWorkspaceAccessBroker,
  revokeCloudWorkspacePreviewFrame,
} from "../cloud-workspace-access-runtime";
import { isOwnedMainRendererFrame } from "../preview-frame-ipc-authority";
import { CloudPreviewFrameAdmissions } from "../cloud-preview-frame-admissions";
import { isCloudAgentPreviewTarget } from "@zeros/protocol/containment";

let mainWindowRef: BrowserWindow | null = null;
// `window.name` is page-mutable. Pin the DOM iframe's original React-assigned
// name to Chromium's stable frame-tree id before visited code can change it.
const browserFrameNames = new Map<number, string>();
const pendingBrowserNavigations = new PendingIframeNavigations();
const cloudPreviewFrameAdmissions = new CloudPreviewFrameAdmissions<WebFrameMain>();
const iframeFaviconGenerationByName = new Map<string, number>();
const iframeFaviconUrlByName = new Map<string, string>();

// A page that never finishes evaluating (busy loop, hung renderer) must not
// leave main awaiting it indefinitely.
const FRAME_SCRIPT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("frame script timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

/** Callers have already proven `frame` is a named top-level Browser frame of
 *  the main window. Nested frames (ads, embeds) and app frames never qualify.
 *  Volatile cloud preview origins are ordinary https pages here; their
 *  admission still governs headers and navigation, not picker injection. */
function pickerAllowedForFrame(frame: WebFrameMain): boolean {
  try {
    return (
      !frame.isDestroyed() &&
      browserFrameName(frame) != null &&
      pickerAllowedForUrl(frame.url)
    );
  } catch {
    return false;
  }
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
    // No user gesture: a page-defined `title` getter must not gain activation.
    const value = await withTimeout(
      frame.executeJavaScript("document.title", false),
      FRAME_SCRIPT_TIMEOUT_MS,
    );
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

function browserFrameStillCurrent(frame: WebFrameMain): boolean {
  const frameName = browserFrameName(frame);
  return Boolean(
    frameName &&
    !frame.isDestroyed() &&
    pendingBrowserNavigations.isCurrentFrame(frameName, frame.frameTreeNodeId),
  );
}

function nextIframeFaviconGeneration(frameName: string): number {
  const generation = (iframeFaviconGenerationByName.get(frameName) ?? 0) + 1;
  iframeFaviconGenerationByName.set(frameName, generation);
  return generation;
}

function beginIframeFaviconNavigation(frame: WebFrameMain, targetUrl: string) {
  const frameName = browserFrameName(frame);
  if (!frameName) return;
  const currentUrl = iframeFaviconUrlByName.get(frameName) ?? frame.url;
  if (iframeFaviconNavigationDisposition(currentUrl, targetUrl) === "reset") {
    nextIframeFaviconGeneration(frameName);
  }
  iframeFaviconUrlByName.set(frameName, targetUrl);
}

async function emitIframeFavicon(
  win: BrowserWindow,
  frame: WebFrameMain,
): Promise<void> {
  const frameName = browserFrameName(frame);
  if (
    !frameName ||
    !browserFrameStillCurrent(frame) ||
    !/^https?:\/\//i.test(frame.url)
  )
    return;
  const pageUrl = frame.url;
  iframeFaviconUrlByName.set(frameName, pageUrl);
  const generation = nextIframeFaviconGeneration(frameName);
  const advertised = await declaredIframeFaviconUrls((code, userGesture) =>
    frame.executeJavaScript(code, userGesture),
  );
  if (
    iframeFaviconGenerationByName.get(frameName) !== generation ||
    iframeFaviconUrlByName.get(frameName) !== pageUrl ||
    !browserFrameStillCurrent(frame) ||
    frame.url !== pageUrl
  ) {
    return;
  }
  const faviconDataUrl = await resolveIframeFaviconDataUrl({
    browserSession: win.webContents.session,
    pageUrl,
    advertised,
  });
  if (
    !faviconDataUrl ||
    iframeFaviconGenerationByName.get(frameName) !== generation ||
    iframeFaviconUrlByName.get(frameName) !== pageUrl ||
    !browserFrameStillCurrent(frame) ||
    frame.url !== pageUrl
  ) {
    return;
  }
  emitEvent("browser-frame-favicon", {
    frameName,
    pageUrl,
    faviconDataUrl,
  });
}

async function injectPicker(frame: WebFrameMain): Promise<boolean> {
  try {
    // Never inject with a user gesture: page code reached from the picker's
    // setup (for example a hooked addEventListener) would otherwise receive
    // transient activation for popups, fullscreen or autoplay.
    await withTimeout(
      frame.executeJavaScript(PICKER_SCRIPT, false),
      FRAME_SCRIPT_TIMEOUT_MS,
    );
    return true;
  } catch {
    // Navigation races, crashed renderers and pages that break their own
    // intrinsics all leave Design Mode unavailable on that document; that is
    // the intended fail-closed outcome and not worth a log line per page.
    return false;
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
    await emitIframeFavicon(win, child);
    if (pickerAllowedForFrame(child) && (await injectPicker(child))) {
      injected = true;
    }
  }
  return injected;
}

function currentBrowserFrame(
  win: BrowserWindow,
  targetFrameName: string,
): WebFrameMain | null {
  if (win.isDestroyed()) return null;
  const mainFrame = win.webContents.mainFrame;
  for (const frame of mainFrame.framesInSubtree) {
    if (
      isBrowserTabFrame(frame, mainFrame) &&
      browserFrameName(frame) === targetFrameName &&
      browserFrameStillCurrent(frame)
    ) {
      return frame;
    }
  }
  return null;
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
    // The renderer must authorize a volatile provider origin before it mounts
    // the iframe, otherwise Chromium can send the first navigation before main
    // has installed the bypass grant. Bind that capability-free pending grant
    // here, after proving this is an exact top-level Browser frame owned by the
    // current WebContents and before its request headers are released.
    previewFrameAuthorizations.bindPendingFrame(
      frameName,
      event.url,
      frame.frameTreeNodeId,
    );
    const pending = pendingBrowserNavigations.begin(
      frameName,
      frame.frameTreeNodeId,
      event.url,
      frame.url,
    );
    if (!pending) return;
    beginIframeFaviconNavigation(frame, event.url);
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
    if (pending) {
      beginIframeFaviconNavigation(frame, details.url);
      emitBrowserNavigation(frame, details.url, "", true);
    }
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
      void emitIframeFavicon(win, frame);
      // The dormant picker shares the page's main world; the renderer treats
      // everything it posts as untrusted and only activates it on request.
      if (pickerAllowedForFrame(frame)) void injectPicker(frame);
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
  win: BrowserWindow,
  args: unknown,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (win.isDestroyed()) {
    return { ok: false, error: "main window not available" };
  }
  // The rect originates from page-controlled picker geometry. Accept it only
  // for a live named Browser frame and clamp it to that iframe's own on-screen
  // box, so no forged selection can capture app chrome or a neighboring tab.
  const request = parseCaptureRegionArgs(args);
  if (!request) {
    return { ok: false, error: "frameName/x/y/width/height required" };
  }
  if (!currentBrowserFrame(win, request.frameName)) {
    return { ok: false, error: "browser frame not available" };
  }
  let frameBounds;
  try {
    frameBounds = parseFrameBounds(
      await withTimeout(
        win.webContents.mainFrame.executeJavaScript(
          browserFrameBoundsScript(request.frameName),
          false,
        ),
        FRAME_SCRIPT_TIMEOUT_MS,
      ),
    );
  } catch {
    frameBounds = null;
  }
  if (!frameBounds || win.isDestroyed()) {
    return { ok: false, error: "browser frame not visible" };
  }
  const region = clampCaptureRegion(
    request.rect,
    frameBounds,
    win.getContentBounds(),
  );
  if (!region) {
    return { ok: false, error: "clamped to empty rect" };
  }
  try {
    const img = await win.webContents.capturePage(region);
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
  previewFrameAuthorizations.clear();
  cloudPreviewFrameAdmissions.clear();
  iframeFaviconGenerationByName.clear();
  iframeFaviconUrlByName.clear();
  mainWindowRef = opts.mainWindow;
  attachAutoInject(opts.mainWindow);
  setCommand("iframe-picker:capture-region", async (args, event) => {
    if (!isOwnedMainRendererFrame({
      windowDestroyed: opts.mainWindow.isDestroyed(), senderWebContents: event.sender,
      ownerWebContents: opts.mainWindow.webContents, senderFrame: event.senderFrame,
      ownerMainFrame: opts.mainWindow.webContents.mainFrame,
    })) return { ok: false, error: "capture renderer authority is unavailable" };
    return handleCaptureRegion(opts.mainWindow, args);
  });
  setCommand("browser:reinject-picker", async (args) => {
    const frameName = isBrowserFrameName(args.frameName)
      ? args.frameName
      : undefined;
    const ok = await reinjectBrowserPicker(opts.mainWindow, frameName);
    return { ok };
  });
  setCommand("browser:authorize-preview-origin", async (args, event) => {
    // First-open ordering is authorize -> mount iframe -> navigate. The exact
    // frame id therefore cannot exist yet. Keep this grant capability-free and
    // pending; `will-frame-navigate` binds it to the owned top-level frame
    // before iframe-headers can release the provider warning-bypass header.
    const ownedRenderer = isOwnedMainRendererFrame({
      windowDestroyed: opts.mainWindow.isDestroyed(),
      senderWebContents: event.sender,
      ownerWebContents: opts.mainWindow.webContents,
      senderFrame: event.senderFrame,
      ownerMainFrame: opts.mainWindow.webContents.mainFrame,
    });
    return {
      ok:
        ownedRenderer &&
        previewFrameAuthorizations.authorize(args, Date.now(), null),
    };
  });
  setCommand("browser:open-cloud-preview", async (args, event) => {
    if (!isOwnedMainRendererFrame({
      windowDestroyed: opts.mainWindow.isDestroyed(), senderWebContents: event.sender,
      ownerWebContents: opts.mainWindow.webContents, senderFrame: event.senderFrame,
      ownerMainFrame: opts.mainWindow.webContents.mainFrame,
    })) throw new Error("cloud preview renderer authority is unavailable");
    const frameName =
      typeof args.frameName === "string" &&
      args.frameName.startsWith("zeros-browser-") &&
      args.frameName.length <= 320
        ? args.frameName
        : null;
    const organizationId =
      typeof args.organizationId === "string" ? args.organizationId : "";
    const workspaceId =
      typeof args.workspaceId === "string" ? args.workspaceId : "";
    const port =
      typeof args.port === "number" && Number.isSafeInteger(args.port)
        ? args.port
        : 0;
    if (!frameName || !organizationId || !workspaceId || !port ||
      (args.target !== undefined && !isCloudAgentPreviewTarget(args.target))) {
      throw new Error("cloud preview request is invalid");
    }
    const original = currentBrowserFrame(opts.mainWindow, frameName);
    if (!original) {
      throw new Error("cloud preview Browser frame is unavailable");
    }
    const pendingAdmission = cloudPreviewFrameAdmissions.begin(frameName, original);
    return getCloudWorkspaceAccessBroker().openPreview(
      { frameName, organizationId, workspaceId, port, ...(isCloudAgentPreviewTarget(args.target) ? { target: args.target } : {}),
        ...(typeof args.authorityId === "string" ? { authorityId: args.authorityId, deviceId: args.deviceId as string | null, keyVersion: args.keyVersion as number | null } : {}) },
      (authorization) => {
        // Re-resolve after the network round trip. A closed/replaced iframe may
        // reuse no stale frame authority even when it kept the same tab id.
        const current = currentBrowserFrame(opts.mainWindow, frameName);
        if (
          !pendingAdmission.current(current) || current === null ||
          !previewFrameAuthorizations.authorizeCloudPreview(
            authorization,
            current.frameTreeNodeId,
          )
        ) {
          return false;
        }
        return () =>
          previewFrameAuthorizations.revoke(
            frameName,
            authorization.capability,
          );
      },
    );
  });
  setCommand("browser:revoke-preview-origin", async (args, event) => {
    if (!isOwnedMainRendererFrame({ windowDestroyed: opts.mainWindow.isDestroyed(), senderWebContents: event.sender,
      ownerWebContents: opts.mainWindow.webContents, senderFrame: event.senderFrame, ownerMainFrame: opts.mainWindow.webContents.mainFrame })) return { ok: false };
    const frameName =
      typeof args.frameName === "string" &&
      args.frameName.startsWith("zeros-browser-") &&
      args.frameName.length <= 320
        ? args.frameName
        : null;
    if (!frameName) return { ok: false };
    cloudPreviewFrameAdmissions.cancel(frameName);
    previewFrameAuthorizations.revoke(frameName);
    const remoteRevoked = await revokeCloudWorkspacePreviewFrame(
      frameName,
    ).catch(() => false);
    return { ok: true, remoteRevoked };
  });
  setCommand("browser:control-iframe", async (args, event) => {
    const request = parseBrowserIframeControl(args);
    if (!request) return { ok: false, frameTreeNodeId: null };
    if (request.action === "replace" && !isOwnedMainRendererFrame({
      windowDestroyed: opts.mainWindow.isDestroyed(), senderWebContents: event.sender,
      ownerWebContents: opts.mainWindow.webContents, senderFrame: event.senderFrame,
      ownerMainFrame: opts.mainWindow.webContents.mainFrame,
    })) return { ok: false, frameTreeNodeId: null };
    const frame = currentBrowserFrame(opts.mainWindow, request.frameName);
    if (!frame) return { ok: false, frameTreeNodeId: null };
    const control =
      request.action === "navigate" || request.action === "replace"
        ? { action: request.action, url: request.url }
        : { action: request.action };
    return {
      ok: await controlBrowserIframe(frame, control),
      frameTreeNodeId: frame.frameTreeNodeId,
    };
  });

  opts.mainWindow.on("closed", () => {
    if (mainWindowRef === opts.mainWindow) {
      mainWindowRef = null;
      browserFrameNames.clear();
      pendingBrowserNavigations.clear();
      previewFrameAuthorizations.clear();
      cloudPreviewFrameAdmissions.clear();
      void disposeCloudWorkspaceAccessBroker();
      iframeFaviconGenerationByName.clear();
      iframeFaviconUrlByName.clear();
    }
  });
}
