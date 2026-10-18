// ──────────────────────────────────────────────────────────
// Agent control bar over a native page
// ──────────────────────────────────────────────────────────
//
// A live Browser page is a native WebContentsView composited above the
// renderer, so renderer DOM can never sit on top of it. The Browser tab's
// control bar is therefore its own small transparent view, stacked directly
// above the page and loading `agent-control.html`. Being a separate view also
// keeps the bar out of the page's screenshots.
//
// The bar view takes the pointer across its whole rectangle, transparent
// margin included. That costs nothing while it is shown: the page refuses
// direct input for the whole agent-owned turn anyway.
// ──────────────────────────────────────────────────────────

import type {
  BaseWindow,
  IpcMain,
  IpcMainEvent,
  WebContentsView,
  WebPreferences,
} from "electron";

import type { BrowserViewBounds } from "../browser/surface";
import { rendererProcessOwners } from "../renderer-process-owners";
import {
  AGENT_CONTROL_CHANNELS,
  type AgentControlOverlayState,
} from "./channels";

/** Toolbar padding and border around a 24px compact button. */
const BAR_HEIGHT = 34;
/** `--shadow-dropdown` is `0 8px 24px`; keep its blur off the view's edges. */
const SHADOW_TOP = 16;
const SHADOW_SIDE = 24;
/** The bar's gap above the page's bottom edge, which also holds the shadow's
 * downward offset. */
const BOTTOM_INSET = 16;
const MAX_BAR_WIDTH = 560;
const MIN_PAGE_WIDTH = 240;
const MIN_PAGE_HEIGHT = 120;
/** A little longer than the bar's 120ms fade. */
export const AGENT_CONTROL_FADE_MS = 160;
/** How long a bar off screen keeps its renderer, so it reappears at once when
 * the user switches back to the page or the agent resumes. */
export const AGENT_CONTROL_RELEASE_MS = 30_000;

/** The bottom-center rectangle the bar view covers over a page, or `null`
 * when the page is too small to hold the bar. The bar page lays itself out
 * with the same insets (`px-6 pb-4`). */
export function agentControlOverlayBounds(
  page: BrowserViewBounds,
): BrowserViewBounds | null {
  if (page.width < MIN_PAGE_WIDTH || page.height < MIN_PAGE_HEIGHT) {
    return null;
  }
  const width = Math.min(page.width, MAX_BAR_WIDTH + 2 * SHADOW_SIDE);
  const height = SHADOW_TOP + BAR_HEIGHT + BOTTOM_INSET;
  return {
    x: page.x + Math.floor((page.width - width) / 2),
    y: page.y + page.height - height,
    width,
    height,
  };
}

/** The bar page is trusted app code, but it gets the same locked-down
 * renderer as every other Zeros surface. */
export function agentControlOverlayWebPreferences(
  preload: string,
): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    disableDialogs: true,
    spellcheck: false,
    // The bar must paint its fade as soon as it is stacked into a window.
    backgroundThrottling: false,
  };
}

export interface AgentControlPresentation {
  title: string;
  detail: string;
  window: BaseWindow;
  /** The controlled page. The bar stacks directly above it, and focus returns
   * to it when Stop hands the page back. */
  above: WebContentsView;
  /** The page's rectangle in window content coordinates. */
  bounds: BrowserViewBounds;
  /** The page was just re-added to its window, which raised it over the bar. */
  raise?: boolean;
}

export interface AgentControlPresenter {
  show(sessionId: string, presentation: AgentControlPresentation): void;
  /** Fade the bar out. `immediate` removes it at once, for when the page
   * itself has left, so the bar never floats over renderer UI. A bar that
   * stays hidden releases its renderer after `AGENT_CONTROL_RELEASE_MS`. */
  hide(sessionId: string, options?: { immediate?: boolean }): void;
  /** The session ended: release its bar and that bar's renderer. */
  dispose(sessionId: string): void;
}

export interface AgentControlOverlayHost extends AgentControlPresenter {
  disposeAll(): void;
}

interface OverlayEntry {
  view: WebContentsView;
  window: BaseWindow | null;
  above: WebContentsView | null;
  state: AgentControlOverlayState;
  ready: boolean;
  removeTimer: ReturnType<typeof setTimeout> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

export function createAgentControlOverlayHost(options: {
  ipc: Pick<IpcMain, "on" | "removeListener">;
  createView(): WebContentsView;
  load(view: WebContentsView): Promise<void>;
  /** The user pressed Stop, or Esc while the bar had focus. */
  onStop(sessionId: string): void;
  fadeMs?: number;
  releaseMs?: number;
}): AgentControlOverlayHost {
  const entries = new Map<string, OverlayEntry>();
  const fadeMs = options.fadeMs ?? AGENT_CONTROL_FADE_MS;
  const releaseMs = options.releaseMs ?? AGENT_CONTROL_RELEASE_MS;

  const send = (entry: OverlayEntry): void => {
    if (!entry.ready || entry.view.webContents.isDestroyed()) return;
    entry.view.webContents.send(AGENT_CONTROL_CHANNELS.state, entry.state);
  };

  const clearTimers = (entry: OverlayEntry): void => {
    if (entry.removeTimer) clearTimeout(entry.removeTimer);
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    entry.removeTimer = null;
    entry.releaseTimer = null;
  };

  const unstack = (entry: OverlayEntry): void => {
    clearTimers(entry);
    if (entry.window && !entry.window.isDestroyed()) {
      entry.window.contentView.removeChildView(entry.view);
    }
    entry.window = null;
  };

  /** Off screen, but ready to come back until the release timer runs out. */
  const retire = (sessionId: string, entry: OverlayEntry): void => {
    if (!entry.window && entry.releaseTimer) return;
    unstack(entry);
    entry.releaseTimer = setTimeout(() => {
      if (entries.get(sessionId) === entry) dispose(sessionId);
    }, releaseMs);
  };

  /** Only a bar page's own main frame may report readiness or Stop. */
  const sessionForSender = (event: IpcMainEvent): string | null => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      return null;
    }
    for (const [sessionId, entry] of entries) {
      if (entry.view.webContents === event.sender) return sessionId;
    }
    return null;
  };

  const onReady = (event: IpcMainEvent): void => {
    const sessionId = sessionForSender(event);
    const entry = sessionId ? entries.get(sessionId) : undefined;
    if (!entry) return;
    entry.ready = true;
    send(entry);
  };

  const onStop = (event: IpcMainEvent): void => {
    const sessionId = sessionForSender(event);
    if (!sessionId || !entries.get(sessionId)?.state.visible) return;
    options.onStop(sessionId);
  };

  options.ipc.on(AGENT_CONTROL_CHANNELS.ready, onReady);
  options.ipc.on(AGENT_CONTROL_CHANNELS.stop, onStop);

  const dispose = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    unstack(entry);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  };

  const create = (sessionId: string): OverlayEntry => {
    const view = options.createView();
    rendererProcessOwners.track(view.webContents, "Agent-control overlay");
    // Transparent around the bar, so the page shows through.
    view.setBackgroundColor("#00000000");
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    const entry: OverlayEntry = {
      view,
      window: null,
      above: null,
      state: { title: "", detail: "", visible: false },
      ready: false,
      removeTimer: null,
      releaseTimer: null,
    };
    contents.on("render-process-gone", () => {
      // The next show creates a fresh bar.
      if (entries.get(sessionId) === entry) dispose(sessionId);
    });
    entries.set(sessionId, entry);
    void options.load(view).catch(() => undefined);
    return entry;
  };

  const hide: AgentControlPresenter["hide"] = (sessionId, hideOptions) => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    const wasVisible = entry.state.visible;
    if (wasVisible) {
      entry.state = { ...entry.state, visible: false };
      send(entry);
      // Clicking Stop focused the bar; the user now controls the page.
      if (
        entry.view.webContents.isFocused() &&
        entry.above &&
        !entry.above.webContents.isDestroyed()
      ) {
        entry.above.webContents.focus();
      }
    }
    if (hideOptions?.immediate) {
      retire(sessionId, entry);
      return;
    }
    if (!wasVisible || entry.removeTimer || !entry.window) return;
    entry.removeTimer = setTimeout(() => {
      entry.removeTimer = null;
      if (!entry.state.visible) retire(sessionId, entry);
    }, fadeMs);
  };

  const show: AgentControlPresenter["show"] = (sessionId, presentation) => {
    const bounds = presentation.window.isDestroyed()
      ? null
      : agentControlOverlayBounds(presentation.bounds);
    if (!bounds) {
      hide(sessionId, { immediate: true });
      return;
    }
    const entry = entries.get(sessionId) ?? create(sessionId);
    clearTimers(entry);
    if (entry.window !== presentation.window) {
      unstack(entry);
      presentation.window.contentView.addChildView(entry.view);
      entry.window = presentation.window;
    } else if (presentation.raise || !entry.state.visible) {
      // Re-adding an existing child only reorders it to the top.
      presentation.window.contentView.addChildView(entry.view);
    }
    entry.above = presentation.above;
    entry.view.setBounds(bounds);
    if (
      !entry.state.visible ||
      entry.state.title !== presentation.title ||
      entry.state.detail !== presentation.detail
    ) {
      entry.state = {
        title: presentation.title,
        detail: presentation.detail,
        visible: true,
      };
      send(entry);
    }
  };

  return {
    show,
    hide,
    dispose,
    disposeAll() {
      for (const sessionId of [...entries.keys()]) dispose(sessionId);
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.ready, onReady);
      options.ipc.removeListener(AGENT_CONTROL_CHANNELS.stop, onStop);
    },
  };
}
