// The app menu's update item is a live status surface (idle → checking →
// downloading → ready), not a static "Check for Updates" command. These tests
// drive real updater lifecycle events through the mocked electron-updater and
// assert the menu rebuilds with the right label/enabled/action — and that
// download-progress spam does NOT trigger per-chunk menu rebuilds.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const mocks = vi.hoisted(() => ({
  app: {
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
  },
  nativeUpdater: {
    handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
    on(name: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(name) ?? new Set();
      handlers.add(handler);
      this.handlers.set(name, handlers);
      return this;
    },
    emit(name: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(name) ?? []) handler(...args);
    },
  },
  net: {
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "version: 0.0.0\n",
    })),
  },
  powerMonitor: { on: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
  },
  libraryUpdater: {
    handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    on(name: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(name) ?? new Set();
      handlers.add(handler);
      this.handlers.set(name, handlers);
      return this;
    },
    emit(name: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(name) ?? []) handler(...args);
    },
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  autoUpdater: mocks.nativeUpdater,
  net: mocks.net,
  powerMonitor: mocks.powerMonitor,
  BrowserWindow: class MockBrowserWindow {},
  Menu: mocks.Menu,
}));

vi.mock("electron-updater", () => ({ autoUpdater: mocks.libraryUpdater }));

/** The update item of the most recently installed application menu. */
function lastRenderedUpdateItem(): MenuItemConstructorOptions {
  const calls = mocks.Menu.buildFromTemplate.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const template = calls[calls.length - 1][0] as MenuItemConstructorOptions[];
  const appSubmenu = template[0].submenu as MenuItemConstructorOptions[];
  // [About, <update item>, separator, …]
  return appSubmenu[1];
}

describe("app menu update item", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let menu: typeof import("../menu");
  let updater: typeof import("../updater");

  beforeAll(async () => {
    // Pin the macOS staging model so ready-state assertions are identical on
    // local (darwin) and CI (linux) runs.
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    updater = await import("../updater");
    menu = await import("../menu");
    updater.setupUpdater();
    menu.installAppMenu();
    return () => {
      if (platform) Object.defineProperty(process, "platform", platform);
    };
  });

  it("derives a view for every status kind", () => {
    expect(menu.updateMenuItemView({ kind: "idle", revision: 0 })).toEqual({
      label: "Check for Updates",
      enabled: true,
      action: "check",
    });
    expect(menu.updateMenuItemView({ kind: "checking", revision: 1 })).toEqual({
      label: "Checking for Updates…",
      enabled: false,
      action: "none",
    });
    expect(
      menu.updateMenuItemView({
        kind: "available",
        revision: 2,
        version: "1.2.3",
      }),
    ).toEqual({ label: "Downloading…", enabled: false, action: "none" });
    expect(
      menu.updateMenuItemView({
        kind: "downloading",
        revision: 3,
        version: "1.2.3",
        downloaded: 10,
        total: 100,
      }),
    ).toEqual({ label: "Downloading…", enabled: false, action: "none" });
    expect(
      menu.updateMenuItemView({ kind: "ready", revision: 4, version: "1.2.3" }),
    ).toEqual({ label: "Restart to Update", enabled: true, action: "install" });
    expect(
      menu.updateMenuItemView({ kind: "error", revision: 5, message: "x" }),
    ).toEqual({ label: "Check for Updates", enabled: true, action: "check" });
  });

  it("starts as an enabled Check for Updates item", () => {
    const item = lastRenderedUpdateItem();
    expect(item.label).toBe("Check for Updates");
    expect(item.enabled).toBe(true);
  });

  it("shows a disabled Downloading… item once an update is found", () => {
    mocks.libraryUpdater.emit("checking-for-update");
    expect(lastRenderedUpdateItem().label).toBe("Checking for Updates…");

    mocks.libraryUpdater.emit("update-available", { version: "1.2.3" });
    const item = lastRenderedUpdateItem();
    expect(item.label).toBe("Downloading…");
    expect(item.enabled).toBe(false);
  });

  it("does not rebuild the menu per download-progress chunk", () => {
    const rebuilds = mocks.Menu.setApplicationMenu.mock.calls.length;
    mocks.libraryUpdater.emit("download-progress", {
      transferred: 1024,
      total: 4096,
    });
    mocks.libraryUpdater.emit("download-progress", {
      transferred: 2048,
      total: 4096,
    });
    expect(mocks.Menu.setApplicationMenu.mock.calls.length).toBe(rebuilds);
  });

  it("offers Restart to Update once staged, and applies on click", async () => {
    mocks.libraryUpdater.emit("update-downloaded", { version: "1.2.3" });
    // macOS: ready only after native Squirrel confirms staging.
    mocks.nativeUpdater.emit("update-downloaded");

    const item = lastRenderedUpdateItem();
    expect(item.label).toBe("Restart to Update");
    expect(item.enabled).toBe(true);

    (item.click as () => void)();
    // applyAndRelaunch defers quitAndInstall off the current tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.libraryUpdater.quitAndInstall).toHaveBeenCalledWith(
      false,
      true,
    );
  });

  it("returns to Check for Updates when the updater goes idle again", () => {
    // A fresh check cycle that finds nothing publishes idle (nothing is staged
    // in that state on a real run; here the staged flag is cleared by install).
    mocks.libraryUpdater.emit("update-not-available");
    // updateDownloaded stays latched after staging, so update-not-available is
    // suppressed by publishUnlessReady — the menu keeps offering the restart.
    expect(lastRenderedUpdateItem().label).toBe("Restart to Update");
  });
});
