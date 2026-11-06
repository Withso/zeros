import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { on: vi.fn(), quit: vi.fn(), relaunch: vi.fn() },
  updater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  },
  guard: { kill: vi.fn(), once: vi.fn() },
  startUpdateRelaunchGuard: vi.fn(),
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
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn() }));
vi.mock("../relaunch-guard", () => ({
  startUpdateRelaunchGuard: mocks.startUpdateRelaunchGuard,
}));

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe("update restart relaunch guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.nativeHandlers.clear();
    mocks.updater.on.mockImplementation(
      (name: string, handler: (...args: unknown[]) => void) => {
        mocks.handlers.set(name, handler);
      },
    );
    mocks.startUpdateRelaunchGuard.mockReturnValue(mocks.guard);
  });

  async function stagedUpdater() {
    const updater = await import("../updater");
    updater.setupUpdater();
    mocks.handlers.get("update-available")!({ version: "1.2.4" });
    mocks.handlers.get("update-downloaded")!({ version: "1.2.4" });
    mocks.nativeHandlers.get("update-downloaded")?.();
    expect(updater.getUpdaterStatus()).toMatchObject({ kind: "ready" });
    return updater;
  }

  it("arms the guard before Squirrel quits to install and relaunch", async () => {
    const updater = await stagedUpdater();

    expect(updater.installStagedUpdate()).toBe(true);
    await nextTick();

    expect(mocks.startUpdateRelaunchGuard).toHaveBeenCalledTimes(1);
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(
      mocks.startUpdateRelaunchGuard.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.updater.quitAndInstall.mock.invocationCallOrder[0]);
  });

  it("keeps one guard across repeated restart requests", async () => {
    const updater = await stagedUpdater();

    updater.installStagedUpdate();
    updater.installStagedUpdate();
    await nextTick();

    expect(mocks.startUpdateRelaunchGuard).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier request's guard when a repeated install throws", async () => {
    const updater = await stagedUpdater();
    updater.installStagedUpdate();
    await nextTick();
    mocks.updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("install failed");
    });

    updater.installStagedUpdate();
    await nextTick();

    expect(mocks.startUpdateRelaunchGuard).toHaveBeenCalledTimes(1);
    expect(mocks.guard.kill).not.toHaveBeenCalled();
  });

  it("stops the guard when the install cannot start", async () => {
    const updater = await stagedUpdater();
    mocks.updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("install failed");
    });

    updater.installStagedUpdate();
    await nextTick();

    expect(mocks.guard.kill).toHaveBeenCalledTimes(1);
    expect(updater.getUpdaterStatus()).toMatchObject({
      kind: "error",
      message: "install failed",
    });
  });
});
