// ──────────────────────────────────────────────────────────
// IPC commands: window chrome (drag + zoom via JS, not CSS drag region)
// ──────────────────────────────────────────────────────────
//
// Background: macOS Electron's `-webkit-app-region: drag` swallows
// every click/mousedown/mouseup on the renderer. That means a header
// that's both a drag handle and a popover trigger can't
// have single-click-outside dismissal — the OS hit-tests the drag
// region first and the renderer never sees the press
// (electron/electron#1354, status:wontfix). These commands remove the
// CSS drag region and implement drag through explicit IPC instead.
//
// Flow per drag:
//   1. Renderer's mousedown handler sees a press on a drag-eligible
//      element → calls window_drag_start.
//   2. Main snapshots the current cursor screen position + window
//      position and starts a ~60Hz timer that calls window.setPosition
//      every tick, keeping the window glued to (cursor − initial offset).
//      Using `electron.screen.getCursorScreenPoint()` means we don't
//      need DOM mousemove events — the window follows even when the
//      cursor leaves the renderer.
//   3. Renderer's document-level mouseup → calls window_drag_end which
//      clears the timer. The drag self-terminates if the window is
//      destroyed mid-drag.
//
// Double-click is handled with a separate command (window_zoom_toggle)
// that flips maximize/unmaximize. We honour the OS preference by
// reading the value the user set in System Preferences ›
// Desktop & Dock → "Double-click a window's title bar to" — `app`'s
// `accessibility-support-enabled` is unrelated; the actual key is
// AppleActionOnDoubleClick on macOS and is checked by Electron's
// maximize/minimize impl when called via the OS event, but we route
// through `BrowserWindow.maximize/unmaximize/minimize` based on a
// userDefaults read so the renderer's dblclick matches title-bar
// dblclick behaviour exactly.

import {
  app,
  BrowserWindow,
  nativeTheme,
  screen,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import type { CommandHandler } from "../router";

// Drag state is per-window (only one drag at a time per window). The
// map keys by webContents.id so multiple windows never trample each
// other's drag timers.
interface DragState {
  timer: NodeJS.Timeout;
  /** Hard upper-bound on drag duration. If the renderer somehow fails
   *  to send `window_drag_end` (process hang, GPU stall, browser
   *  bug, missed cross-display pointerup that even setPointerCapture
   *  didn't catch), this timeout fires and force-clears the drag so
   *  the window stops following the cursor. */
  watchdog: NodeJS.Timeout;
  startCursorX: number;
  startCursorY: number;
  startWindowX: number;
  startWindowY: number;
}
const drags = new Map<number, DragState>();

/** No real drag should run longer than this. 60 s is comfortably
 *  above any plausible user interaction (a fast cross-display drag
 *  takes ~1 s; a slow deliberate one ~5 s). */
const MAX_DRAG_MS = 60_000;

function clearDragFor(webContentsId: number): void {
  const existing = drags.get(webContentsId);
  if (!existing) return;
  clearInterval(existing.timer);
  clearTimeout(existing.watchdog);
  drags.delete(webContentsId);
}

function windowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/** Begin a JS-driven window drag. Idempotent — re-calling clears any
 *  prior drag for the same window and starts fresh.
 *
 *  Behaviour: translate window position by cursor delta. Same applies
 *  to maximized (zoomed) windows — the window keeps its current size
 *  and just moves; it does NOT restore to a smaller frame mid-drag.
 *  On macOS `[NSWindow setFrameOrigin:]` works on a zoomed window
 *  without any animation, so this is a no-op for the poller below.
 *
 *  True fullscreen (green-button) is rejected — `[NSWindow isMovable]`
 *  is NO in that state at the OS level and any setPosition call would
 *  be silently dropped. */
export const windowDragStart: CommandHandler = async (_args, event) => {
  const win = windowFromEvent(event);
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) return;

  clearDragFor(event.sender.id);

  const cursor = screen.getCursorScreenPoint();
  const [winX, winY] = win.getPosition();

  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearDragFor(event.sender.id);
      return;
    }
    const state = drags.get(event.sender.id);
    if (!state) return;
    const now = screen.getCursorScreenPoint();
    const dx = now.x - state.startCursorX;
    const dy = now.y - state.startCursorY;
    win.setPosition(
      Math.round(state.startWindowX + dx),
      Math.round(state.startWindowY + dy),
    );
  }, 16);

  const watchdog = setTimeout(() => {
    clearDragFor(event.sender.id);
  }, MAX_DRAG_MS);

  drags.set(event.sender.id, {
    timer,
    watchdog,
    startCursorX: cursor.x,
    startCursorY: cursor.y,
    startWindowX: winX,
    startWindowY: winY,
  });
};

/** Stop any in-progress drag for the calling window. Safe to call
 *  even when no drag is active. */
export const windowDragEnd: CommandHandler = async (_args, event) => {
  clearDragFor(event.sender.id);
};

/** Mirror the native title-bar double-click. Honours the macOS
 *  AppleActionOnDoubleClick preference so the user gets exactly the
 *  behaviour they expect from a real title bar. Falls back to
 *  maximize-toggle on non-darwin or when the pref read fails. */
export const windowZoomToggle: CommandHandler = async (_args, event) => {
  const win = windowFromEvent(event);
  if (!win || win.isDestroyed()) return;

  let action: "Maximize" | "Minimize" | "None" = "Maximize";
  if (process.platform === "darwin") {
    try {
      const pref = systemPreferences.getUserDefault(
        "AppleActionOnDoubleClick",
        "string",
      );
      if (pref === "Minimize" || pref === "None" || pref === "Maximize") {
        action = pref;
      }
    } catch {
      /* fall back to Maximize */
    }
  }

  if (action === "None") return;
  if (action === "Minimize") {
    win.minimize();
    return;
  }
  // Maximize action — toggle.
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
};

// ── Theme-aware native window background ──────────────────
//
// The BrowserWindow's backgroundColor paints before first render and
// during resize. It must track the app theme (near-black for dark,
// white for light) or light-theme users get a dark flash at launch.
// The renderer resolves --bg1 after every theme flip and reports it
// here; we update the live window AND persist the hex so the NEXT
// launch creates its window with the right pre-paint color.

const WINDOW_BG_FILE = "window-background.json";
/** Matches the dark theme's --bg1 (#0E0C0C); used until a renderer
 *  reports a theme, and as the fallback when the persisted file is
 *  missing/corrupt. */
export const DEFAULT_WINDOW_BACKGROUND = "#0e0c0c";

function windowBgPath(): string {
  return path.join(app.getPath("userData"), WINDOW_BG_FILE);
}

/** Read the persisted background for createWindow. Sync by design —
 *  it runs once on the create path, before the window exists. */
export function readPersistedWindowBackground(): string {
  try {
    const raw = fs.readFileSync(windowBgPath(), "utf8");
    const parsed = JSON.parse(raw) as { backgroundColor?: unknown };
    const color = parsed?.backgroundColor;
    if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
      return color;
    }
  } catch {
    /* first run / corrupt file — fall through */
  }
  return DEFAULT_WINDOW_BACKGROUND;
}

/** `window_set_background` — renderer reports the resolved --bg1 hex
 *  after applying a theme. Strictly validated (it's written to disk
 *  and handed to setBackgroundColor). */
export const windowSetBackground: CommandHandler = async (args, event) => {
  const color = (args as { color?: unknown } | undefined)?.color;
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return;

  const win = windowFromEvent(event);
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(color);
  }
  try {
    fs.writeFileSync(
      windowBgPath(),
      JSON.stringify({ backgroundColor: color }),
      "utf8",
    );
  } catch {
    /* persistence is best-effort — live window is already updated */
  }
};

// ── Durable appearance mode + native-chrome theming ────────
//
// The renderer's theme prefs live in localStorage, which main.ts relocates
// under ~/Library/Caches (sessionData) — macOS may purge that, silently
// resetting a light-theme user to dark. The MODE is therefore mirrored here
// into userData (same durability class as window-background.json):
//   • createWindow passes it to the preload via additionalArguments, the
//     preload exposes it to the page, and both the index.html pre-paint
//     stamp and the appearance store fall back to it when localStorage is
//     empty — so even a purged cache restores the right theme with no flash.
//   • The same report drives `nativeTheme.themeSource`, so native chrome
//     (context menus, dialogs) follows the APP theme instead of the OS.
//
// themeSource gets the MODE ("system" | "light" | "dark"), NEVER the
// resolved variant: in system mode it must stay "system" or the renderer's
// matchMedia(prefers-color-scheme) — which the store uses to resolve the
// variant and follow live OS flips — would be pinned by our own override.

const APPEARANCE_FILE = "appearance.json";
const APPEARANCE_MODES = new Set(["system", "light", "dark"] as const);
export type AppearanceMode = "system" | "light" | "dark";

function appearancePath(): string {
  return path.join(app.getPath("userData"), APPEARANCE_FILE);
}

/** Read the persisted appearance mode. Sync by design — it runs on the
 *  createWindow path (additionalArguments) before any renderer exists.
 *  Null = never reported (fresh install) — callers leave defaults alone. */
export function readPersistedAppearanceMode(): AppearanceMode | null {
  try {
    const raw = fs.readFileSync(appearancePath(), "utf8");
    const mode = (JSON.parse(raw) as { mode?: unknown })?.mode;
    if (typeof mode === "string" && APPEARANCE_MODES.has(mode as AppearanceMode)) {
      return mode as AppearanceMode;
    }
  } catch {
    /* first run / corrupt file — fall through */
  }
  return null;
}

/** `appearance_set_mode` — renderer reports the theme MODE after every
 *  apply (module load, settings change, cross-window sync). Persists it
 *  and syncs nativeTheme so native menus/dialogs match the app. */
export const appearanceSetMode: CommandHandler = async (args) => {
  const mode = (args as { mode?: unknown } | undefined)?.mode;
  if (typeof mode !== "string" || !APPEARANCE_MODES.has(mode as AppearanceMode)) {
    return;
  }
  if (nativeTheme.themeSource !== mode) {
    nativeTheme.themeSource = mode as AppearanceMode;
  }
  try {
    fs.writeFileSync(appearancePath(), JSON.stringify({ mode }), "utf8");
  } catch {
    /* persistence is best-effort — nativeTheme is already updated */
  }
};
