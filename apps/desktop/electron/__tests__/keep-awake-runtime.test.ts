import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandHandler } from "../ipc/router";

const native = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  powerEvents: new Map<string, () => void>(),
  appEvents: new Map<string, () => void>(),
  mainWindow: null as BrowserWindow | null,
  saved: "false",
  save: vi.fn(),
  emit: vi.fn(),
  readPower: vi.fn(),
  start: vi.fn(() => 12),
  stop: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    once: (event: string, listener: () => void) => native.appEvents.set(event, listener),
    off: (event: string) => native.appEvents.delete(event),
  },
  powerSaveBlocker: { start: native.start, stop: native.stop },
  powerMonitor: {
    on: (event: string, listener: () => void) => native.powerEvents.set(event, listener),
    off: (event: string) => native.powerEvents.delete(event),
  },
}));
vi.mock("../ipc/commands/app", () => ({
  getAppSetting: () => native.saved,
  setAppSetting: native.save,
}));
vi.mock("../ipc/router", () => ({
  setCommand: (name: string, handler: CommandHandler) => native.commands.set(name, handler),
}));
vi.mock("../ipc/events", () => ({ getMainWindow: () => native.mainWindow, emitEvent: native.emit }));
vi.mock("../mac-power-source", () => ({ readMacPowerSource: native.readPower }));

import { installKeepAwake } from "../keep-awake-runtime";

let runtime: ReturnType<typeof installKeepAwake>;
function createWindow() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  native.mainWindow = window as unknown as BrowserWindow;
  runtime.attachWindow(native.mainWindow);
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  const invoke = (name: string, args: Record<string, unknown> = {}) => native.commands.get(name)!(args, event);
  return { window, contents, invoke, event };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.clearAllMocks();
  native.saved = "false";
  native.commands.clear();
  native.powerEvents.clear();
  native.appEvents.clear();
  native.readPower.mockResolvedValue({ onBattery: false, percent: null });
  native.save.mockImplementation((_key, value) => { native.saved = value; });
  runtime = installKeepAwake();
});
afterEach(() => {
  runtime.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native keep awake boundary", () => {
  it("defaults off, persists the explicit switch and restores it in a new runtime", async () => {
    const first = createWindow();
    expect(first.invoke("keep_awake_get")).toEqual({ enabled: false, supported: true });
    first.invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.start).not.toHaveBeenCalled();
    expect(first.invoke("keep_awake_set", { enabled: true })).toEqual({ enabled: true, supported: true });
    expect(native.save).toHaveBeenCalledExactlyOnceWith("keepAwakeWhileAgentsRunning", "true");
    await vi.advanceTimersByTimeAsync(0);
    expect(native.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    runtime.dispose();
    runtime = installKeepAwake();
    const reopened = createWindow();
    expect(reopened.invoke("keep_awake_get")).toEqual({ enabled: true, supported: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.start).toHaveBeenCalledOnce(); // Activity itself was not persisted.
  });

  it("does not confirm a preference whose persistence failed", () => {
    const { invoke } = createWindow();
    native.save.mockImplementationOnce(() => { throw new Error("write failed"); });
    expect(() => invoke("keep_awake_set", { enabled: true })).toThrow("write failed");
    expect(invoke("keep_awake_get")).toEqual({ enabled: false, supported: true });
  });

  it("rejects subframes, foreign windows and malformed values before any mutation", () => {
    const { event, invoke } = createWindow();
    for (const name of ["keep_awake_get", "keep_awake_set", "keep_awake_activity"]) {
      for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) {
        expect(() => native.commands.get(name)!({ enabled: true, active: true }, bad as IpcMainInvokeEvent))
          .toThrow("requires the app window");
      }
    }
    for (const value of [undefined, null, "true", 1, {}, []]) {
      expect(() => invoke("keep_awake_set", { enabled: value })).toThrow("Invalid");
      expect(() => invoke("keep_awake_activity", { active: value })).toThrow("Invalid");
    }
    expect(native.save).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
  });

  it.each(["render-process-gone", "unresponsive", "reload", "closed"])("revokes activity on %s and fences in-flight power reads", async event => {
    const { invoke, contents, window } = createWindow();
    let resolve!: (value: unknown) => void;
    native.readPower.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    invoke("keep_awake_set", { enabled: true });
    invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    if (event === "reload") contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    else if (event === "closed") window.emit("closed");
    else contents.emit(event);
    resolve({ onBattery: false, percent: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves activity on hide, minimize, same-document and subframe navigation", async () => {
    const { invoke, contents, window } = createWindow();
    invoke("keep_awake_set", { enabled: true });
    invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    window.emit("hide");
    window.emit("minimize");
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(native.stop).not.toHaveBeenCalled();
    contents.emit("render-process-gone");
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(12);
  });

  it("drops old window listeners when the main window is replaced", async () => {
    const old = createWindow();
    old.invoke("keep_awake_set", { enabled: true });
    const next = createWindow();
    next.invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    old.window.emit("closed");
    old.contents.emit("render-process-gone");
    expect(native.stop).not.toHaveBeenCalled();
    expect(() => old.invoke("keep_awake_activity", { active: false })).toThrow("requires the app window");
  });

  it("rechecks on power transitions and requests fresh activity after resume", async () => {
    const { invoke } = createWindow();
    invoke("keep_awake_set", { enabled: true });
    invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    native.readPower.mockResolvedValue({ onBattery: true, percent: 2 });
    native.powerEvents.get("on-battery")!();
    expect(native.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    native.readPower.mockResolvedValue({ onBattery: false, percent: null });
    native.powerEvents.get("on-ac")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.start).toHaveBeenCalledTimes(2);
    native.powerEvents.get("suspend")!();
    expect(native.stop).toHaveBeenCalledTimes(2);
    native.emit.mockClear();
    native.powerEvents.get("resume")!();
    expect(native.emit).toHaveBeenCalledExactlyOnceWith("keep-awake-request-activity", null);
  });

  it("releases and unregisters every native listener on quit", async () => {
    const { invoke, contents } = createWindow();
    invoke("keep_awake_set", { enabled: true });
    invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    runtime.dispose();
    runtime.dispose();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.powerEvents.size).toBe(0);
    expect(native.appEvents.size).toBe(0);
    expect(contents.eventNames()).toEqual([]);
    expect(() => invoke("keep_awake_activity", { active: true })).toThrow("requires the app window");
  });

  it("retains sleep prevention and IPC while Quit waits for shutdown cleanup", async () => {
    const { invoke } = createWindow();
    invoke("keep_awake_set", { enabled: true });
    invoke("keep_awake_activity", { active: true });
    await vi.advanceTimersByTimeAsync(0);
    // Main prevents the first before-quit while recordings, attachments and
    // provider cleanup finish. The live window must retain its native service.
    native.appEvents.get("before-quit")?.();
    expect(native.stop).not.toHaveBeenCalled();
    expect(invoke("keep_awake_get")).toEqual({ enabled: true, supported: true });
    expect(() => invoke("keep_awake_activity", { active: true })).not.toThrow();
    native.appEvents.get("will-quit")?.();
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(12);
    expect(native.appEvents.size).toBe(0);
    expect(native.powerEvents.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes the macOS-only feature unavailable on other platforms", () => {
    runtime.dispose();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runtime = installKeepAwake();
    const { invoke } = createWindow();
    expect(invoke("keep_awake_get")).toEqual({ enabled: false, supported: false });
    expect(() => invoke("keep_awake_set", { enabled: true })).toThrow("available on macOS");
    invoke("keep_awake_activity", { active: true });
    expect(native.powerEvents.size).toBe(0);
    expect(native.start).not.toHaveBeenCalled();
  });
});
