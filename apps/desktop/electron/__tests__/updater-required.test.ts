import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { on: vi.fn(), quit: vi.fn(), relaunch: vi.fn() },
  updater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  },
  emitEvent: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  nativeHandlers: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  app: mocks.app,
  autoUpdater: {
    on: (name: string, handler: (...args: unknown[]) => void) =>
      mocks.nativeHandlers.set(name, handler),
  },
  net: { fetch: vi.fn() },
  powerMonitor: { on: vi.fn() },
}));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.updater }));
vi.mock("../ipc/events", () => ({ emitEvent: mocks.emitEvent }));

describe("main-process required update latch", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.nativeHandlers.clear();
    mocks.updater.on.mockImplementation(
      (name: string, handler: (...args: unknown[]) => void) => {
        mocks.handlers.set(name, handler);
      },
    );
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (platform) Object.defineProperty(process, "platform", platform);
  });

  async function stageUpdate() {
    const updater = await import("../updater");
    updater.setupUpdater();
    updater.requireClientUpgrade({
      minimumVersion: "1.2.3",
      latestVersion: "1.2.4",
    });
    mocks.handlers.get("update-available")!({ version: "1.2.4" });
    mocks.handlers.get("update-downloaded")!({ version: "1.2.4" });
    expect(updater.getUpdaterStatus().kind).not.toBe("ready");
    mocks.nativeHandlers.get("update-downloaded")!();
    return updater;
  }
  it("retains the required upgrade in the monotonic snapshot across window recreation", async () => {
    const updater = await import("../updater");
    const required = { minimumVersion: "1.2.3", latestVersion: "1.2.4" };
    updater.requireClientUpgrade(required);
    expect(updater.getUpdaterStatus()).toMatchObject({
      kind: "idle",
      required,
      revision: 1,
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith(
      "updater-status",
      expect.objectContaining({ required }),
    );
    updater.requireClientUpgrade(required);
    expect(updater.getUpdaterStatus().revision).toBe(1);
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it("rejects untrusted metadata at the IPC boundary", async () => {
    const updater = await import("../updater");
    expect(() =>
      updater.requireClientUpgrade({
        minimumVersion: "<unsafe>",
        latestVersion: "1.2.4",
      }),
    ).toThrow("Invalid required update");
    expect(updater.getUpdaterStatus().revision).toBe(0);
  });
  it("never arms install-on-download for a forced upgrade before native staging", async () => {
    const updater = await import("../updater");
    updater.requireClientUpgrade({
      minimumVersion: "1.2.3",
      latestVersion: "1.2.4",
    });
    await expect(
      updater.updaterInstall({ requireReady: true }, {} as never),
    ).rejects.toThrow("staged");
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it("keeps the requirement through downloading and native staging without restarting on completion", async () => {
    const updater = await stageUpdate();
    expect(updater.getUpdaterStatus()).toMatchObject({
      kind: "ready",
      version: "1.2.4",
      required: { minimumVersion: "1.2.3", latestVersion: "1.2.4" },
    });
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it("rejects stale staged versions from both the update IPC and app menu", async () => {
    const updater = await stageUpdate();
    updater.requireClientUpgrade({
      minimumVersion: "1.2.5",
      latestVersion: "1.2.5",
    });
    await expect(
      updater.updaterInstall({ requireReady: true }, {} as never),
    ).rejects.toThrow(/compatible update.*staged/i);
    expect(updater.installStagedUpdate()).toBe(false);
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it("allows an explicit retry after a staged install failure", async () => {
    const updater = await stageUpdate();
    mocks.updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("synthetic install failure");
    });
    await updater.updaterInstall({ requireReady: true }, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.getUpdaterStatus().kind).toBe("error");
    await updater.updaterCheck({}, {} as never);
    expect(updater.getUpdaterStatus().kind).toBe("ready");
  });
});
