import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

function windowStub() {
  const win = new EventEmitter();
  const webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  return Object.assign(win, { webContents, isDestroyed: () => false });
}

beforeEach(() => vi.resetModules());

describe("Local navigation intent delivery", () => {
  it("asks the normal window owner to reopen/focus, after retaining the intent", async () => {
    const events = await import("../ipc/events");
    const win = windowStub();
    const open = vi.fn(() =>
      events.setMainWindow(win as unknown as BrowserWindow),
    );
    events.setLocalNavigationWindowOpener(open);
    events.emitLocalNavigation("zeros://chat/reopened");
    expect(open).toHaveBeenCalledOnce();
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(events.takePendingLocalNavigation()).toBe("zeros://chat/reopened");
  });
  it("holds a cold-start link until the renderer has installed its listener", async () => {
    const events = await import("../ipc/events");
    events.emitLocalNavigation("zeros://chat/one");
    const win = windowStub();
    events.setMainWindow(win as unknown as BrowserWindow);
    win.webContents.emit("did-finish-load");
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(events.takePendingLocalNavigation()).toBe("zeros://chat/one");
    expect(events.takePendingLocalNavigation()).toBeNull();
    events.emitLocalNavigation("zeros://workspace/ws_two");
    expect(win.webContents.send).toHaveBeenCalledWith("zeros:event", {
      name: "local-navigation",
      payload: "zeros://workspace/ws_two",
    });
  });

  it("keeps only the latest navigation while all windows are closed", async () => {
    const events = await import("../ipc/events");
    const old = windowStub();
    events.setMainWindow(old as unknown as BrowserWindow);
    events.takePendingLocalNavigation();
    old.emit("closed");
    events.emitLocalNavigation("zeros://chat/old");
    events.emitLocalNavigation("zeros://chat/new");
    events.emitEvent("agent-progress", { state: "stale" });
    const next = windowStub();
    events.setMainWindow(next as unknown as BrowserWindow);
    expect(next.webContents.send).not.toHaveBeenCalled();
    expect(events.takePendingLocalNavigation()).toBe("zeros://chat/new");
    expect(next.webContents.send).not.toHaveBeenCalled();
  });

  it("buffers again across a renderer document reload, but not a subframe navigation", async () => {
    const events = await import("../ipc/events");
    const win = windowStub();
    events.setMainWindow(win as unknown as BrowserWindow);
    events.takePendingLocalNavigation();
    win.webContents.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    events.emitLocalNavigation("zeros://chat/live");
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    win.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    events.emitLocalNavigation("zeros://chat/reload");
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(events.takePendingLocalNavigation()).toBe("zeros://chat/reload");
  });

  it("retains links while the renderer's authenticated shell is unmounted", async () => {
    const events = await import("../ipc/events");
    const win = windowStub();
    events.setMainWindow(win as unknown as BrowserWindow);
    events.takePendingLocalNavigation();
    events.suspendLocalNavigation();
    events.emitLocalNavigation("zeros://chat/after-sign-in");
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(events.takePendingLocalNavigation()).toBe(
      "zeros://chat/after-sign-in",
    );
  });
});
