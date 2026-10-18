// ──────────────────────────────────────────────────────────
// Browser preview windows — a Browser tab's page in its own top-level window
// ──────────────────────────────────────────────────────────
//
// "Open separate preview window" loads a Browser tab's URL in a dedicated,
// preload-free BrowserWindow keyed by the tab's iframe frame name. ("Open
// DevTools" inspects the tab's own iframe instead and never opens a window
// here; see apps/desktop/electron/browser-frame-devtools.ts.)
//
// The window shares the app's default session on purpose, so the user's logins
// on the site carry over from the tab. That session's handlers stay correct for
// a top-level page: permissions are decided by requesting URL (sensitive ones
// denied to sites), framing headers are only rewritten for subframes, and the
// cloud preview capability header is only attached to requests whose frame
// ancestry contains the admitted Browser iframe — which this window never does.
//
// Cloud previews are not opened here. A cloud tab's logical
// `http://localhost:<port>` would hit the Mac's own server, and its volatile
// preview origin is admitted per iframe with renewal tied to the tab. Volatile
// origins (cloud and contained agent previews) are refused at every navigation
// so an existing admission can never be widened to a second window.

import { BrowserWindow, screen, shell, type WebContents } from "electron";
import { normalizeExternalHttpUrl } from "@zeros/protocol/external-url";
import { setCommand } from "./ipc/router";
import { isOwnedMainRendererFrame } from "./preview-frame-ipc-authority";
import { previewFrameAuthorizations } from "./preview-frame-authorizations";
import { rendererProcessOwners } from "./renderer-process-owners";

export const BROWSER_PREVIEW_KEY_PATTERN = /^zeros-browser-[A-Za-z0-9._:-]{1,300}$/;
export const MAX_BROWSER_PREVIEW_WINDOWS = 12;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;
const CASCADE_OFFSET = 24;
const SHOW_FALLBACK_MS = 2_000;
const MAX_TITLE_LENGTH = 200;

export type BrowserPreviewWindowFailure =
  | "invalid-request"
  | "unsupported-url"
  | "cloud-preview-unsupported"
  | "too-many-windows"
  | "unauthorized"
  | "unavailable";

export type BrowserPreviewWindowResult =
  | { ok: true; reused: boolean }
  | { ok: false; reason: BrowserPreviewWindowFailure };

interface ParsedRequest {
  key: string;
  url: string;
  title: string | null;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function sanitizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return clean ? clean.slice(0, MAX_TITLE_LENGTH) : null;
}

export function previewWindowTitle(pageTitle: string | null, url: string): string {
  let fallback = url;
  try {
    fallback = new URL(url).host || url;
  } catch {
    // keep the raw URL
  }
  return `Preview · ${sanitizeTitle(pageTitle) ?? fallback}`;
}

let mainWindowRef: BrowserWindow | null = null;
let isAppUrl: (url: string) => boolean = () => false;
const windows = new Map<string, BrowserWindow>();

/** A top-level preview page must be an ordinary web page: never the app's own
 * renderer (which would inherit app-origin permissions) and never an admitted
 * volatile preview origin (whose cookie/capability belongs to its iframe). */
function topLevelUrlRejection(
  raw: unknown,
): "unsupported-url" | "cloud-preview-unsupported" | null {
  const url = normalizeExternalHttpUrl(raw);
  if (!url || isAppUrl(url)) return "unsupported-url";
  if (previewFrameAuthorizations.allowsOrigin(url)) {
    return "cloud-preview-unsupported";
  }
  return null;
}

const SUBFRAME_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"]);

function subframeUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!SUBFRAME_SCHEMES.has(url.protocol)) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  return !isAppUrl(raw) && !previewFrameAuthorizations.allowsOrigin(raw);
}

export function parseBrowserPreviewWindowRequest(
  args: Record<string, unknown>,
): ParsedRequest | BrowserPreviewWindowFailure {
  if (typeof args.key !== "string" || !BROWSER_PREVIEW_KEY_PATTERN.test(args.key)) {
    return "invalid-request";
  }
  if (
    args.scope !== undefined &&
    (typeof args.scope !== "string" || args.scope.length > 4_096)
  ) {
    return "invalid-request";
  }
  const rejection = topLevelUrlRejection(args.url);
  if (rejection) return rejection;
  const url = normalizeExternalHttpUrl(args.url) as string;
  if (
    typeof args.scope === "string" &&
    /^cloud:\/\//i.test(args.scope) &&
    isLoopbackHostname(new URL(url).hostname)
  ) {
    return "cloud-preview-unsupported";
  }
  return {
    key: args.key,
    url,
    title: sanitizeTitle(args.title),
  };
}

function defaultBounds(): { width: number; height: number; x?: number; y?: number } {
  const main = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  const display = main
    ? screen.getDisplayMatching(main.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(DEFAULT_WIDTH, area.width);
  const height = Math.min(DEFAULT_HEIGHT, area.height);
  const cascade = (windows.size % 8) * CASCADE_OFFSET;
  const x = area.x + Math.max(0, Math.round((area.width - width) / 2) + cascade);
  const y = area.y + Math.max(0, Math.round((area.height - height) / 2) + cascade);
  return {
    width,
    height,
    x: Math.min(x, area.x + area.width - width),
    y: Math.min(y, area.y + area.height - height),
  };
}

function hardenContents(contents: WebContents): void {
  // Same policy as the app window: no in-app popups; a vetted http(s) target
  // opens in the user's real browser.
  contents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalHttpUrl(url);
    if (externalUrl) void shell.openExternal(externalUrl);
    return { action: "deny" };
  });
  contents.on("will-frame-navigate", (details) => {
    const allowed = details.isMainFrame
      ? topLevelUrlRejection(details.url) === null
      : subframeUrlAllowed(details.url);
    if (!allowed) details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    const allowed = details.isMainFrame
      ? topLevelUrlRejection(details.url) === null
      : subframeUrlAllowed(details.url);
    if (!allowed) details.preventDefault();
  });
  // A site's beforeunload handler must never keep this window (and with it,
  // app quit or main-window teardown) from closing.
  contents.on("will-prevent-unload", (event) => event.preventDefault());
}

// Reuse compares against the last URL Zeros asked for, not the live URL, so a
// redirect or in-window navigation is not undone by a repeat request.
const requestedUrls = new WeakMap<BrowserWindow, string>();

function loadInto(win: BrowserWindow, url: string): void {
  requestedUrls.set(win, url);
  // Load failures render Chromium's own error page; nothing to surface here.
  void win.loadURL(url).catch(() => undefined);
}

function createPreviewWindow(request: ParsedRequest): BrowserWindow {
  const main = mainWindowRef as BrowserWindow;
  const win = new BrowserWindow({
    ...defaultBounds(),
    minWidth: 320,
    minHeight: 240,
    show: false,
    title: previewWindowTitle(request.title, request.url),
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      session: main.webContents.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
  rendererProcessOwners.track(win.webContents, "Browser preview");
  hardenContents(win.webContents);
  win.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    if (!win.isDestroyed()) win.setTitle(previewWindowTitle(title, win.webContents.getURL()));
  });
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once("ready-to-show", show);
  const fallback = setTimeout(show, SHOW_FALLBACK_MS);
  win.on("closed", () => {
    clearTimeout(fallback);
    if (windows.get(request.key) === win) windows.delete(request.key);
  });
  windows.set(request.key, win);
  loadInto(win, request.url);
  return win;
}

export function openBrowserPreviewWindow(
  args: Record<string, unknown>,
): BrowserPreviewWindowResult {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return { ok: false, reason: "unavailable" };
  }
  const request = parseBrowserPreviewWindowRequest(args);
  if (typeof request === "string") return { ok: false, reason: request };

  const existing = windows.get(request.key);
  if (existing && !existing.isDestroyed()) {
    if (requestedUrls.get(existing) !== request.url) loadInto(existing, request.url);
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { ok: true, reused: true };
  }
  if (existing) windows.delete(request.key);
  if (windows.size >= MAX_BROWSER_PREVIEW_WINDOWS) {
    return { ok: false, reason: "too-many-windows" };
  }
  createPreviewWindow(request);
  return { ok: true, reused: false };
}

/** Close every preview window. Previews never outlive the app window: on macOS
 * a lingering window would also stop dock activation from recreating it. */
export function closeBrowserPreviewWindows(): void {
  for (const win of [...windows.values()]) {
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
}

/** Idempotent per main window: replaces the command handler and owner. */
export function registerBrowserPreviewWindowCommands(opts: {
  mainWindow: BrowserWindow;
  isAppUrl: (url: string) => boolean;
}): void {
  mainWindowRef = opts.mainWindow;
  isAppUrl = opts.isAppUrl;
  setCommand("browser:open-window", (args, event) => {
    const main = mainWindowRef;
    if (
      !main ||
      main !== opts.mainWindow ||
      !isOwnedMainRendererFrame({
        windowDestroyed: main.isDestroyed(),
        senderWebContents: event.sender,
        ownerWebContents: main.webContents,
        senderFrame: event.senderFrame,
        ownerMainFrame: main.webContents.mainFrame,
      })
    ) {
      return { ok: false, reason: "unauthorized" } satisfies BrowserPreviewWindowResult;
    }
    return openBrowserPreviewWindow(args);
  });
  opts.mainWindow.on("closed", () => {
    if (mainWindowRef !== opts.mainWindow) return;
    mainWindowRef = null;
    closeBrowserPreviewWindows();
  });
}
