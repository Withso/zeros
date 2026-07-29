// Pins the DevTools policy.
//
// The regression this guards against is a real one that shipped: packaged
// builds registered `devtools-opened → closeDevTools()`, so ⌥⌘I in Alpha, Beta
// and Production opened DevTools and tore it down a frame later. It read as a
// flicker, it left every shipped build undebuggable, and NOTHING in the test
// suite or in scripts/check-electron-hardening.mjs noticed for as long as it
// existed. These tests are that missing alarm.
//
// electron/devtools.ts is importable here only because its `electron` import is
// type-only — the real module cannot load outside an Electron host, which is why
// updater-channel-feeds.test.ts has to parse source text instead. The
// force-close assertions below are deliberately source-text checks anyway: they
// must hold for electron/main.ts, which DOES import electron for real.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  SELF_XSS_CONSOLE_SCRIPT,
  devToolsAccelerator,
  shouldWarnOnDevToolsOpen,
  toggleDevTools,
} from "../devtools";
import { CHANNELS } from "../../src/engine/runtime";

/** Minimal BrowserWindow stand-in — only the surface toggleDevTools touches. */
function fakeWindow(opts: { devToolsOpen?: boolean; destroyed?: boolean } = {}) {
  let open = opts.devToolsOpen ?? false;
  const win = {
    isDestroyed: () => opts.destroyed ?? false,
    focus: vi.fn(),
    webContents: {
      isDevToolsOpened: () => open,
      openDevTools: vi.fn((o?: { mode?: string }) => {
        open = true;
        return o;
      }),
      closeDevTools: vi.fn(() => {
        open = false;
      }),
    },
  };
  return win as unknown as Parameters<typeof toggleDevTools>[0] & typeof win;
}

describe("devToolsAccelerator", () => {
  it("uses the Chromium-standard chord per platform", () => {
    expect(devToolsAccelerator("darwin")).toBe("Alt+Command+I");
    expect(devToolsAccelerator("win32")).toBe("Ctrl+Shift+I");
    expect(devToolsAccelerator("linux")).toBe("Ctrl+Shift+I");
  });
});

describe("toggleDevTools", () => {
  it("opens DETACHED — a docked panel steals width from a 3-column layout that already has hard per-column minimums", () => {
    const win = fakeWindow({ devToolsOpen: false });
    toggleDevTools(win);
    expect(win.webContents.openDevTools).toHaveBeenCalledWith({
      mode: "detach",
    });
    expect(win.webContents.closeDevTools).not.toHaveBeenCalled();
  });

  it("closes when already open, and pulls focus back to the app window", () => {
    const win = fakeWindow({ devToolsOpen: true });
    toggleDevTools(win);
    expect(win.webContents.closeDevTools).toHaveBeenCalled();
    expect(win.webContents.openDevTools).not.toHaveBeenCalled();
    // Closing a DETACHED DevTools window destroys the window that had focus;
    // without this the app appears to vanish behind whatever was underneath.
    expect(win.focus).toHaveBeenCalled();
  });

  it("round-trips: open → close → open", () => {
    const win = fakeWindow({ devToolsOpen: false });
    toggleDevTools(win);
    toggleDevTools(win);
    toggleDevTools(win);
    expect(win.webContents.openDevTools).toHaveBeenCalledTimes(2);
    expect(win.webContents.closeDevTools).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for null / destroyed windows", () => {
    expect(() => toggleDevTools(null)).not.toThrow();
    const dead = fakeWindow({ destroyed: true });
    toggleDevTools(dead);
    expect(dead.webContents.openDevTools).not.toHaveBeenCalled();
    expect(dead.webContents.closeDevTools).not.toHaveBeenCalled();
  });
});

describe("shouldWarnOnDevToolsOpen", () => {
  it("warns in packaged Production only", () => {
    expect(shouldWarnOnDevToolsOpen(true, "stable")).toBe(true);
  });

  it("stays quiet on the maintainer channels — a banner they see daily is a banner they stop reading", () => {
    expect(shouldWarnOnDevToolsOpen(true, "alpha")).toBe(false);
    expect(shouldWarnOnDevToolsOpen(true, "beta")).toBe(false);
    expect(shouldWarnOnDevToolsOpen(true, "dev")).toBe(false);
  });

  it("never warns unpackaged, on any channel", () => {
    for (const ch of CHANNELS) {
      expect(shouldWarnOnDevToolsOpen(false, ch)).toBe(false);
    }
  });
});

describe("SELF_XSS_CONSOLE_SCRIPT", () => {
  it("evaluates without throwing and writes to the console", () => {
    const log = vi.fn();
    // Same shape executeJavaScript gives it: a bare expression, no bindings
    // beyond globals. If this ever throws, a DevTools open throws with it.
    const run = new Function("console", `return ${SELF_XSS_CONSOLE_SCRIPT}`) as (
      c: unknown,
    ) => void;
    expect(() => run({ log })).not.toThrow();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toMatch(/scam/i);
  });

  it("survives a console that throws — the banner must never break the renderer", () => {
    const run = new Function("console", `return ${SELF_XSS_CONSOLE_SCRIPT}`) as (
      c: unknown,
    ) => void;
    const hostile = {
      log: () => {
        throw new Error("patched console blew up");
      },
    };
    expect(() => run(hostile)).not.toThrow();
  });
});

describe("no build force-closes DevTools", () => {
  const MAIN_SRC = readFileSync("electron/main.ts", "utf8");
  const DEVTOOLS_SRC = readFileSync("electron/devtools.ts", "utf8");

  it("main.ts never calls closeDevTools() — that call is what made ⌥⌘I flicker on every shipped channel", () => {
    expect(MAIN_SRC).not.toMatch(/closeDevTools\s*\(/);
  });

  it("no module reacts to `devtools-opened` by closing it again", () => {
    for (const src of [MAIN_SRC, DEVTOOLS_SRC]) {
      const handler = /devtools-opened[\s\S]{0,400}?\n\s{2}\}\)/.exec(src)?.[0];
      if (handler) expect(handler).not.toMatch(/closeDevTools/);
    }
  });

  it("webPreferences never disables devTools", () => {
    expect(MAIN_SRC).not.toMatch(/devTools\s*:\s*false/);
  });
});
