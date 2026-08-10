// Window-state persistence — reopen the window the way it was closed.
// Covers the pure sanitize/visibility math, the read/write roundtrip,
// and the lifecycle wiring (debounced geometry saves, immediate
// state-flip saves, the final save on close).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

import {
  attachWindowStatePersistence,
  boundsVisibleOnAnyDisplay,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MIN_VISIBLE_OVERLAP_PX,
  readPersistedWindowState,
  sanitizeWindowState,
  WINDOW_STATE_FILE,
  writePersistedWindowState,
  type PersistedWindowState,
} from "../../../window-state";

const BOUNDS = { x: 40, y: 60, width: 1600, height: 1000 };

describe("sanitizeWindowState", () => {
  it("reserves the 360px conversation floor in the live window minimum", () => {
    expect(MAIN_WINDOW_MIN_WIDTH).toBe(840);
  });

  it("passes through a valid state", () => {
    expect(
      sanitizeWindowState({ bounds: BOUNDS, maximized: true, fullScreen: false }),
    ).toEqual({ bounds: BOUNDS, maximized: true, fullScreen: false });
  });

  it("degrades garbage to safe defaults", () => {
    for (const raw of [null, 42, "nope", [], {}]) {
      expect(sanitizeWindowState(raw)).toEqual({
        bounds: null,
        maximized: false,
        fullScreen: false,
      });
    }
  });

  it("drops malformed bounds without losing the state flags", () => {
    expect(
      sanitizeWindowState({
        bounds: { x: 0, y: 0, width: Number.NaN, height: 900 },
        maximized: true,
      }),
    ).toEqual({ bounds: null, maximized: true, fullScreen: false });
  });

  it("clamps a too-small persisted size up to the window minimums", () => {
    const state = sanitizeWindowState({
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(state.bounds).toEqual({
      x: 0,
      y: 0,
      width: MAIN_WINDOW_MIN_WIDTH,
      height: MAIN_WINDOW_MIN_HEIGHT,
    });
  });

  it("coerces non-boolean flags to false", () => {
    expect(sanitizeWindowState({ maximized: 1, fullScreen: "yes" })).toEqual({
      bounds: null,
      maximized: false,
      fullScreen: false,
    });
  });
});

describe("read/write roundtrip", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zeros-window-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on a fresh install (no file)", () => {
    expect(readPersistedWindowState(dir)).toBeNull();
  });

  it("returns null on a corrupt file", () => {
    writeFileSync(path.join(dir, WINDOW_STATE_FILE), "{not json", "utf8");
    expect(readPersistedWindowState(dir)).toBeNull();
  });

  it("roundtrips a written state", () => {
    const state: PersistedWindowState = {
      bounds: BOUNDS,
      maximized: false,
      fullScreen: true,
    };
    writePersistedWindowState(dir, state);
    expect(readPersistedWindowState(dir)).toEqual(state);
  });

  it("swallows write failures (missing directory)", () => {
    expect(() =>
      writePersistedWindowState(path.join(dir, "does-not-exist"), {
        bounds: null,
        maximized: true,
        fullScreen: false,
      }),
    ).not.toThrow();
  });
});

describe("boundsVisibleOnAnyDisplay", () => {
  const laptop = { x: 0, y: 0, width: 1512, height: 944 };
  const external = { x: 1512, y: 0, width: 2560, height: 1415 };

  it("accepts bounds inside a display", () => {
    expect(boundsVisibleOnAnyDisplay(BOUNDS, [laptop])).toBe(true);
  });

  it("accepts bounds on a secondary display", () => {
    expect(
      boundsVisibleOnAnyDisplay(
        { x: 2000, y: 100, width: 1600, height: 1000 },
        [laptop, external],
      ),
    ).toBe(true);
  });

  it("rejects bounds on a detached display", () => {
    expect(
      boundsVisibleOnAnyDisplay(
        { x: 2000, y: 100, width: 1600, height: 1000 },
        [laptop],
      ),
    ).toBe(false);
  });

  it("rejects a sliver overlap below the visibility floor", () => {
    // Window hangs off the left edge with only 50px visible.
    expect(
      boundsVisibleOnAnyDisplay(
        {
          x: -(1600 - MIN_VISIBLE_OVERLAP_PX + 50),
          y: 100,
          width: 1600,
          height: 1000,
        },
        [laptop],
      ),
    ).toBe(false);
  });

  it("rejects everything when no displays are known", () => {
    expect(boundsVisibleOnAnyDisplay(BOUNDS, [])).toBe(false);
  });
});

// A minimal BrowserWindow stand-in: the real one is an EventEmitter with
// geometry getters. attachWindowStatePersistence only uses this surface.
function fakeWindow() {
  const win = new EventEmitter() as EventEmitter & {
    getNormalBounds: () => typeof BOUNDS;
    isMaximized: () => boolean;
    isFullScreen: () => boolean;
    isDestroyed: () => boolean;
    maximized: boolean;
    fullScreen: boolean;
    destroyed: boolean;
  };
  win.maximized = false;
  win.fullScreen = false;
  win.destroyed = false;
  win.getNormalBounds = () => BOUNDS;
  win.isMaximized = () => win.maximized;
  win.isFullScreen = () => win.fullScreen;
  win.isDestroyed = () => win.destroyed;
  return win;
}

describe("attachWindowStatePersistence", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zeros-window-state-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const readFile = () =>
    JSON.parse(
      readFileSync(path.join(dir, WINDOW_STATE_FILE), "utf8"),
    ) as PersistedWindowState;

  it("saves state-flip events immediately", () => {
    const win = fakeWindow();
    attachWindowStatePersistence(win as unknown as BrowserWindow, dir);
    win.maximized = true;
    win.emit("maximize");
    expect(readFile()).toEqual({
      bounds: BOUNDS,
      maximized: true,
      fullScreen: false,
    });
    win.maximized = false;
    win.fullScreen = true;
    win.emit("enter-full-screen");
    expect(readFile().fullScreen).toBe(true);
  });

  it("debounces resize/move churn into one write", () => {
    const win = fakeWindow();
    attachWindowStatePersistence(win as unknown as BrowserWindow, dir);
    win.emit("resize");
    win.emit("move");
    win.emit("resize");
    expect(readPersistedWindowState(dir)).toBeNull();
    vi.runAllTimers();
    expect(readFile().bounds).toEqual(BOUNDS);
  });

  it("saves on close, superseding a pending debounce", () => {
    const win = fakeWindow();
    attachWindowStatePersistence(win as unknown as BrowserWindow, dir);
    win.emit("resize");
    win.maximized = true;
    win.emit("close");
    expect(readFile().maximized).toBe(true);
    // The debounce timer was cleared — nothing rewrites after close.
    win.maximized = false;
    vi.runAllTimers();
    expect(readFile().maximized).toBe(true);
  });

  it("never touches a destroyed window", () => {
    const win = fakeWindow();
    attachWindowStatePersistence(win as unknown as BrowserWindow, dir);
    win.emit("resize");
    win.destroyed = true;
    win.emit("closed");
    vi.runAllTimers();
    expect(readPersistedWindowState(dir)).toBeNull();
  });
});
