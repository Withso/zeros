// ──────────────────────────────────────────────────────────
// Window state — persist size/position/maximized/fullscreen
// ──────────────────────────────────────────────────────────
//
// The main window reopens the way it was closed: a user who maximized
// (or macOS-fullscreened) the window gets it back maximized on the
// next launch instead of the fixed 1600×1000 default. Fresh installs
// have no state file and keep the default, OS-centered window.
//
// Same durability class and shape as window-background.json /
// appearance.json (a tiny JSON file in userData, best-effort writes,
// strict validation on read). Kept free of `electron` runtime imports
// — everything is parameterized by dir / displays — so the logic is
// unit-testable like migrate-identity.ts; main.ts owns the wiring.

import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

export const WINDOW_STATE_FILE = "window-state.json";

/** Must match the BrowserWindow `minWidth`/`minHeight` in main.ts —
 *  a persisted size below the floor (corrupt file, old build) would
 *  otherwise fight the live window's own minimum. */
export const MAIN_WINDOW_MIN_WIDTH = 800;
export const MAIN_WINDOW_MIN_HEIGHT = 700;

/** A restored position must overlap some display's work area by at
 *  least this much in both axes, or it's dropped (monitor unplugged
 *  since last run) and the OS centers the default window instead. */
export const MIN_VISIBLE_OVERLAP_PX = 100;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PersistedWindowState {
  /** The window's NORMAL bounds (getNormalBounds) — what unmaximize /
   *  leave-fullscreen returns to. Null when never captured validly. */
  bounds: WindowBounds | null;
  maximized: boolean;
  fullScreen: boolean;
}

function windowStatePath(userDataDir: string): string {
  return path.join(userDataDir, WINDOW_STATE_FILE);
}

function sanitizeBounds(raw: unknown): WindowBounds | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const nums = [b.x, b.y, b.width, b.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  return {
    x: Math.round(b.x as number),
    y: Math.round(b.y as number),
    width: Math.max(Math.round(b.width as number), MAIN_WINDOW_MIN_WIDTH),
    height: Math.max(Math.round(b.height as number), MAIN_WINDOW_MIN_HEIGHT),
  };
}

/** Validate a parsed state file into a safe shape. Never throws;
 *  anything malformed degrades field-by-field (bad bounds don't stop a
 *  valid maximized flag from restoring). */
export function sanitizeWindowState(raw: unknown): PersistedWindowState {
  const obj =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    bounds: sanitizeBounds(obj.bounds),
    maximized: obj.maximized === true,
    fullScreen: obj.fullScreen === true,
  };
}

/** Read the persisted state for createMainWindow. Sync by design — it
 *  runs once on the create path, before the window exists. Null =
 *  fresh install (or unreadable file): keep the built-in defaults. */
export function readPersistedWindowState(
  userDataDir: string,
): PersistedWindowState | null {
  try {
    const raw = fs.readFileSync(windowStatePath(userDataDir), "utf8");
    return sanitizeWindowState(JSON.parse(raw));
  } catch {
    /* first run / corrupt file — fall through */
  }
  return null;
}

/** Best-effort write; the live window is the source of truth. */
export function writePersistedWindowState(
  userDataDir: string,
  state: PersistedWindowState,
): void {
  try {
    fs.writeFileSync(
      windowStatePath(userDataDir),
      JSON.stringify(state),
      "utf8",
    );
  } catch {
    /* persistence is best-effort */
  }
}

/** True when the bounds meaningfully overlap ANY display work area —
 *  guards against restoring onto a monitor that's no longer attached. */
export function boundsVisibleOnAnyDisplay(
  bounds: WindowBounds,
  workAreas: readonly WindowBounds[],
): boolean {
  return workAreas.some((area) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y);
    return (
      overlapX >= MIN_VISIBLE_OVERLAP_PX && overlapY >= MIN_VISIBLE_OVERLAP_PX
    );
  });
}

/** Keep the state file current for the window's whole life. Geometry
 *  churn (resize/move) is debounced; the discrete state flips
 *  (maximize/fullscreen) and the final `close` save immediately, so
 *  the flag that decides how the NEXT launch opens is never stale even
 *  if the debounce timer dies with the process. */
export function attachWindowStatePersistence(
  win: BrowserWindow,
  userDataDir: string,
  debounceMs = 500,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const save = () => {
    clearTimer();
    if (win.isDestroyed()) return;
    writePersistedWindowState(userDataDir, {
      // getNormalBounds: the un-maximized/un-fullscreened rect, valid
      // to capture in any state — it's what a later unmaximize shows.
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    });
  };
  const saveDebounced = () => {
    clearTimer();
    timer = setTimeout(save, debounceMs);
  };

  win.on("resize", saveDebounced);
  win.on("move", saveDebounced);
  win.on("maximize", save);
  win.on("unmaximize", save);
  win.on("enter-full-screen", save);
  win.on("leave-full-screen", save);
  // `close` fires before destruction (getBounds still works); `closed`
  // only clears a straggling timer so nothing touches a dead window.
  win.on("close", save);
  win.on("closed", clearTimer);
}
