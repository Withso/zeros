import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
      text: async () => "version: 1.2.3\n",
    })),
  },
  powerMonitor: { on: vi.fn() },
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
}));

vi.mock("electron-updater", () => ({ autoUpdater: mocks.libraryUpdater }));

describe("macOS updater staging boundary", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let updater: typeof import("../../../updater");

  beforeAll(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    updater = await import("../../../updater");
    updater.setupUpdater();
  });

  afterAll(() => {
    if (platform) Object.defineProperty(process, "platform", platform);
  });

  it("uses the clean quit lifecycle for an ordinary relaunch", () => {
    updater.processRelaunch({} as never, {} as never);
    expect(mocks.app.relaunch).toHaveBeenCalledOnce();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });

  it("does not publish ready for electron-updater's early zip event", () => {
    mocks.libraryUpdater.emit("update-available", { version: "1.2.3" });
    mocks.libraryUpdater.emit("update-downloaded", { version: "1.2.3" });

    expect(updater.updaterStatus({} as never, {} as never)).toMatchObject({
      kind: "available",
      version: "1.2.3",
    });
  });

  it("publishes ready only after native Squirrel confirms staging", () => {
    mocks.nativeUpdater.emit("update-downloaded");

    expect(updater.updaterStatus({} as never, {} as never)).toMatchObject({
      kind: "ready",
      version: "1.2.3",
    });
  });

  it("parses feed versions and compares stable/beta SemVer", () => {
    expect(updater.parseFeedVersion("version: '1.2.3-beta.12'\n")).toBe(
      "1.2.3-beta.12",
    );
    expect(updater.isVersionNewer("1.2.3-beta.12", "1.2.3-beta.11")).toBe(true);
    expect(updater.isVersionNewer("1.2.3", "1.2.3-beta.12")).toBe(true);
    expect(updater.isVersionNewer("1.2.2", "1.2.3")).toBe(false);
  });

  it("does not re-enter Squirrel for a manual check after staging", async () => {
    const checks = mocks.libraryUpdater.checkForUpdates.mock.calls.length;

    await updater.updaterCheck({} as never, {} as never);

    expect(mocks.libraryUpdater.checkForUpdates).toHaveBeenCalledTimes(checks);
  });

  it("preflights staged updates and skips the same feed version", async () => {
    const focusHandler = mocks.app.on.mock.calls.find(
      ([event]) => event === "browser-window-focus",
    )?.[1] as (() => void) | undefined;
    expect(focusHandler).toBeTypeOf("function");
    const checks = mocks.libraryUpdater.checkForUpdates.mock.calls.length;

    focusHandler?.();
    await vi.waitFor(() => expect(mocks.net.fetch).toHaveBeenCalled());

    expect(mocks.libraryUpdater.checkForUpdates).toHaveBeenCalledTimes(checks);
  });

  it("replaces a staged build when the feed advances", async () => {
    const focusHandler = mocks.app.on.mock.calls.find(
      ([event]) => event === "browser-window-focus",
    )?.[1] as (() => void) | undefined;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    mocks.net.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "version: 1.2.4\n",
    });
    mocks.libraryUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: "1.2.4" },
    } as never);
    const checks = mocks.libraryUpdater.checkForUpdates.mock.calls.length;

    try {
      focusHandler?.();
      await vi.waitFor(() =>
        expect(mocks.libraryUpdater.checkForUpdates).toHaveBeenCalledTimes(
          checks + 1,
        ),
      );
    } finally {
      clock.mockRestore();
    }

    mocks.libraryUpdater.emit("update-available", { version: "1.2.4" });
    mocks.libraryUpdater.emit("update-downloaded", { version: "1.2.4" });
    mocks.nativeUpdater.emit("update-downloaded");
    expect(updater.updaterStatus({} as never, {} as never)).toMatchObject({
      kind: "ready",
      version: "1.2.4",
    });
  });
});
