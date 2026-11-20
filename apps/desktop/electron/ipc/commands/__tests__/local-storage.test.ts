import fs from "node:fs";
import fsPromises from "node:fs/promises";
import childProcess from "node:child_process";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const webContents = { mainFrame: {} };
  const defaultSession = {
    clearCache: vi.fn(async () => {}),
    clearCodeCaches: vi.fn(async () => {}),
    clearStorageData: vi.fn(async () => {}),
    clearData: vi.fn(async () => {}),
    clearShaderCache: vi.fn(async () => {}),
    clearHostResolverCache: vi.fn(async () => {}),
    clearAuthCache: vi.fn(async () => {}),
  };
  return {
    window: { webContents } as { webContents: typeof webContents } | null,
    webContents,
    defaultSession,
    showItemInFolder: vi.fn(),
    emit: vi.fn(),
    service: {
      measure: vi.fn(async () => ({ revision: 1 })),
      cancel: vi.fn(),
      clearCache: vi.fn(async (clear: () => Promise<void>) => {
        await clear();
        return { freedBytes: 1, report: { revision: 2 } };
      }),
      reveal: vi.fn(async (): Promise<string | null> => "/Users/test/zeros/workspaces"),
      report: vi.fn(),
    },
    create: vi.fn(),
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => "/Users/test", getName: () => "Zeros", isPackaged: false, once: vi.fn() },
  session: { defaultSession: native.defaultSession },
  shell: { showItemInFolder: native.showItemInFolder },
}));
vi.mock("../../events", () => ({ getMainWindow: () => native.window, emitEvent: native.emit }));
vi.mock("../../../secret-store", () => ({ secretsFilePath: () => "/Users/test/secrets.json" }));
vi.mock("../../../local-storage/service", () => ({
  createLocalStorageService: (...args: unknown[]) => {
    native.create(...args);
    return native.service;
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const event = {
  sender: native.webContents,
  senderFrame: native.webContents.mainFrame,
} as unknown as IpcMainInvokeEvent;

beforeEach(async () => {
  vi.clearAllMocks();
  native.window = { webContents: native.webContents };
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  (await import("../local-storage"))._resetLocalStorageForTests();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("Local Storage commands", () => {
  it("does no storage work until a command arrives", async () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    const readdir = vi.spyOn(fsPromises, "readdir");
    await import("../local-storage");
    expect(native.create).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it("measures and shares the service across requests", async () => {
    const { localStorageMeasure } = await import("../local-storage");
    expect(await localStorageMeasure({}, event)).toEqual({ revision: 1 });
    await localStorageMeasure({}, event);
    expect(native.create).toHaveBeenCalledTimes(1);
    expect(native.service.measure).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an unknown id", { category: "everything" }],
    ["a path", { category: "/Users/test/Library" }],
    ["a relative path", { category: "../cache" }],
    ["a non-clearable id", { category: "workspaces" }],
    ["the updates folder", { category: "updates" }],
    ["logs", { category: "logs" }],
    ["an extra path argument", { category: "cache", path: "/tmp" }],
    ["a non-string id", { category: ["cache"] }],
    ["no id", {}],
  ])("refuses to clear %s", async (_label, args) => {
    const { localStorageClearCache } = await import("../local-storage");
    expect(() => localStorageClearCache(args, event)).toThrow();
    expect(native.service.clearCache).not.toHaveBeenCalled();
    expect(native.defaultSession.clearCache).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown id", { category: "secrets" }],
    ["a path", { category: "/etc" }],
    ["a cache row (no Reveal)", { category: "cache" }],
    ["the updates row (managed)", { category: "updates" }],
    ["an extra path argument", { category: "logs", path: "/" }],
  ])("refuses to reveal %s", async (_label, args) => {
    const { localStorageReveal } = await import("../local-storage");
    await expect(localStorageReveal(args, event)).rejects.toThrow();
    expect(native.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals the location main resolves for an allowed id", async () => {
    const { localStorageReveal } = await import("../local-storage");
    await localStorageReveal({ category: "workspaces" }, event);
    expect(native.service.reveal).toHaveBeenCalledWith("workspaces");
    expect(native.showItemInFolder).toHaveBeenCalledExactlyOnceWith("/Users/test/zeros/workspaces");
  });

  it("refuses to reveal a location that does not exist", async () => {
    native.service.reveal.mockResolvedValueOnce(null);
    const { localStorageReveal } = await import("../local-storage");
    await expect(localStorageReveal({ category: "logs" }, event)).rejects.toThrow("does not exist");
    expect(native.showItemInFolder).not.toHaveBeenCalled();
  });

  it("refuses arguments on measure and cancel", async () => {
    const { localStorageMeasure, localStorageCancel } = await import("../local-storage");
    expect(() => localStorageMeasure({ path: "/" }, event)).toThrow();
    expect(() => localStorageCancel({ category: "cache" }, event)).toThrow();
    expect(native.service.measure).not.toHaveBeenCalled();
  });

  it("answers only the app window's main frame", async () => {
    const { localStorageMeasure, localStorageClearCache } = await import("../local-storage");
    const frame = { sender: native.webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    const other = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    expect(() => localStorageMeasure({}, frame)).toThrow();
    expect(() => localStorageClearCache({ category: "cache" }, other)).toThrow();
    native.window = null;
    expect(() => localStorageMeasure({}, event)).toThrow();
    expect(native.service.measure).not.toHaveBeenCalled();
  });

  it("is unavailable off macOS rather than reporting zeros", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const { localStorageMeasure } = await import("../local-storage");
    expect(() => localStorageMeasure({}, event)).toThrow("macOS");
  });

  it("cancel is a no-op before anything was measured", async () => {
    const { localStorageCancel } = await import("../local-storage");
    expect(localStorageCancel({}, event)).toBeNull();
    expect(native.create).not.toHaveBeenCalled();
  });

  it("clears only through Electron's HTTP and code cache APIs, never by path", async () => {
    const rm = vi.spyOn(fs, "rmSync");
    const rmAsync = vi.spyOn(fsPromises, "rm");
    const unlink = vi.spyOn(fsPromises, "unlink");
    const { localStorageClearCache } = await import("../local-storage");
    expect(await localStorageClearCache({ category: "cache" }, event)).toEqual({ freedBytes: 1, report: { revision: 2 } });
    expect(native.defaultSession.clearCache).toHaveBeenCalledOnce();
    expect(native.defaultSession.clearCodeCaches).toHaveBeenCalledExactlyOnceWith({});
    for (const other of [
      native.defaultSession.clearStorageData,
      native.defaultSession.clearData,
      native.defaultSession.clearShaderCache,
      native.defaultSession.clearHostResolverCache,
      native.defaultSession.clearAuthCache,
    ])
      expect(other).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(rmAsync).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});
