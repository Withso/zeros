// ──────────────────────────────────────────────────────────
// Browser frame DevTools: "Open DevTools" for a Browser tab's page
// ──────────────────────────────────────────────────────────
//
// A Browser tab is an <iframe> in the app window, and Electron attaches
// DevTools only to a whole WebContents (WebFrameMain has no DevTools API). So
// "Open DevTools" opens the app window's own DevTools, detached as ⌥⌘I does
// (apps/desktop/electron/devtools.ts), and points it at the tab: the page's
// <body> is selected in Elements and the Console runs in the tab's frame.
// Nothing loads in a second window, so this works for every page a tab can
// show, including cloud and agent previews.
//
// `webContents.inspectElement()` cannot do that alone. Packaged builds load the
// app from file://, so every http(s) page is a cross-site, out-of-process frame,
// and Electron hit-tests in the app's main frame: it selects the <iframe>
// element and leaves the Console on the app. Instead, once the DevTools
// frontend has loaded, main runs a fixed script in it that finds the frame by
// name and calls the Console's `inspect()` in that frame's default context.
// Those frontend modules are not a public API; if the script fails, main falls
// back to inspectElement at the frame's point, so DevTools still opens on the
// tab's <iframe>.

import type { BrowserWindow, WebContents } from "electron";
import { setCommand } from "./ipc/router";
import { isOwnedMainRendererFrame } from "./preview-frame-ipc-authority";

const BROWSER_FRAME_NAME = /^zeros-browser-[A-Za-z0-9._:-]{1,300}$/;
const MAX_COORDINATE = 100_000;
/** How long the frontend script waits for the tab's frame and its default
 * execution context once DevTools has loaded. */
export const FRAME_CONTEXT_WAIT_MS = 5_000;
const SELECTION_TIMEOUT_MS = FRAME_CONTEXT_WAIT_MS + 3_000;

export type BrowserFrameDevToolsFailure =
  | "invalid-request"
  | "unauthorized"
  | "unavailable";

export type BrowserFrameDevToolsResult =
  | { ok: true }
  | { ok: false; reason: BrowserFrameDevToolsFailure };

export interface BrowserFrameDevToolsRequest {
  frameName: string;
  /** A point inside the tab's iframe, in CSS px of the app window's viewport.
   * Used only by the inspectElement fallback. */
  point: { x: number; y: number } | null;
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_COORDINATE
  );
}

export function parseBrowserFrameDevToolsRequest(
  args: Record<string, unknown>,
): BrowserFrameDevToolsRequest | null {
  const { frameName, x, y } = args;
  if (typeof frameName !== "string" || !BROWSER_FRAME_NAME.test(frameName)) {
    return null;
  }
  if (x === undefined && y === undefined) return { frameName, point: null };
  if (!isCoordinate(x) || !isCoordinate(y)) return null;
  return { frameName, point: { x, y } };
}

/** Evaluated in the DevTools frontend. Resolves true once the Console targets
 * the tab's frame and its <body> is selected in Elements. The frame is matched
 * by its <iframe> element's `name` attribute, which the app owns; the page can
 * rename its window (`window.name`) but not that attribute. Only a direct child
 * of the app's top frame qualifies, so a nested frame never matches.
 *
 * With `raise`, an already-open detached DevTools window comes to the front
 * first. Electron has no API for that (`devToolsWebContents.focus()` focuses
 * the app window), but re-applying the undocked state makes Electron re-show
 * the window, activated, without reloading DevTools. */
export function browserFrameDevToolsScript(
  frameName: string,
  options: { raise?: boolean; waitMs?: number } = {},
): string {
  const waitMs = Math.max(0, Math.round(options.waitMs ?? FRAME_CONTEXT_WAIT_MS));
  return `(async (frameName, raise, waitMs) => {
  try {
    const [SDK, UI] = await Promise.all([
      import("devtools://devtools/bundled/core/sdk/sdk.js"),
      import("devtools://devtools/bundled/ui/legacy/legacy.js"),
    ]);
    if (raise) {
      try {
        if (UI.DockController.DockController.instance().dockSide() === "undocked") {
          await new Promise((resolve) => InspectorFrontendHost.setIsDocked(false, resolve));
        }
      } catch {}
    }
    const ownedByTab = async (candidate) => {
      if (candidate.parentFrame()?.isOutermostFrame() !== true) return false;
      const owner = await candidate.getOwnerDOMNodeOrDocument();
      return owner?.nodeName() === "IFRAME" && owner.getAttribute("name") === frameName;
    };
    const deadline = Date.now() + waitMs;
    for (;;) {
      let frame = null;
      for (const candidate of SDK.FrameManager.FrameManager.instance().getAllFrames()) {
        if (await ownedByTab(candidate)) {
          frame = candidate;
          break;
        }
      }
      const context = frame && SDK.TargetManager.TargetManager.instance()
        .models(SDK.RuntimeModel.RuntimeModel)
        .flatMap((model) => model.executionContexts())
        .find((candidate) => candidate.frameId === frame.id && candidate.isDefault);
      if (context) {
        UI.Context.Context.instance().setFlavor(SDK.RuntimeModel.ExecutionContext, context);
        const result = await context.evaluate({
          expression: "inspect(document.body ?? document.documentElement)",
          objectGroup: "zeros-browser-frame",
          includeCommandLineAPI: true,
          silent: true,
          returnByValue: false,
          generatePreview: false,
        }, false, false);
        return Boolean(result) && !("error" in result) && !result.exceptionDetails;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch {
    return false;
  }
})(${JSON.stringify(frameName)}, ${options.raise === true}, ${waitMs})`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function selectBrowserFrame(
  contents: WebContents,
  request: BrowserFrameDevToolsRequest,
  raise: boolean,
): Promise<void> {
  const devTools = contents.devToolsWebContents;
  const selected =
    devTools && !devTools.isDestroyed()
      ? await withTimeout(
          devTools
            .executeJavaScript(
              browserFrameDevToolsScript(request.frameName, { raise }),
            )
            .then((value: unknown) => value === true),
          SELECTION_TIMEOUT_MS,
          false,
        )
      : false;
  if (
    selected ||
    !request.point ||
    contents.isDestroyed() ||
    !contents.isDevToolsOpened()
  ) {
    return;
  }
  // inspectElement takes window DIPs; the renderer measured CSS px.
  const zoom = contents.getZoomFactor();
  contents.inspectElement(
    Math.round(request.point.x * zoom),
    Math.round(request.point.y * zoom),
  );
}

// The newest request per WebContents while its DevTools frontend loads, so
// repeat clicks select the latest tab once, after the frontend is ready.
const awaitingFrontend = new WeakMap<WebContents, BrowserFrameDevToolsRequest>();

export function openBrowserFrameDevTools(
  contents: WebContents,
  request: BrowserFrameDevToolsRequest,
): void {
  if (awaitingFrontend.has(contents)) {
    awaitingFrontend.set(contents, request);
    return;
  }
  if (contents.isDevToolsOpened()) {
    void selectBrowserFrame(contents, request, true);
    return;
  }
  awaitingFrontend.set(contents, request);
  const settle = (opened: boolean) => {
    contents.removeListener("devtools-opened", onOpened);
    contents.removeListener("devtools-closed", onClosed);
    const latest = awaitingFrontend.get(contents);
    awaitingFrontend.delete(contents);
    if (opened && latest) void selectBrowserFrame(contents, latest, false);
  };
  const onOpened = () => settle(true);
  const onClosed = () => settle(false);
  contents.on("devtools-opened", onOpened);
  contents.on("devtools-closed", onClosed);
  contents.openDevTools({ mode: "detach", activate: true });
}

/** Idempotent per main window: replaces the command handler and owner. */
export function registerBrowserFrameDevToolsCommand(opts: {
  mainWindow: BrowserWindow;
}): void {
  const main = opts.mainWindow;
  setCommand("browser:inspect-frame", (args, event) => {
    const destroyed = main.isDestroyed();
    if (
      destroyed ||
      !isOwnedMainRendererFrame({
        windowDestroyed: destroyed,
        senderWebContents: event.sender,
        ownerWebContents: main.webContents,
        senderFrame: event.senderFrame,
        ownerMainFrame: main.webContents.mainFrame,
      })
    ) {
      return { ok: false, reason: "unauthorized" } satisfies BrowserFrameDevToolsResult;
    }
    const request = parseBrowserFrameDevToolsRequest(args);
    if (!request) {
      return { ok: false, reason: "invalid-request" } satisfies BrowserFrameDevToolsResult;
    }
    openBrowserFrameDevTools(main.webContents, request);
    return { ok: true } satisfies BrowserFrameDevToolsResult;
  });
}
