// A full disk aborts Squirrel's staging extraction (ditto → ENOSPC) on every
// retry until the user frees space. That failure used to be absorbed into
// `idle` like ordinary offline noise, leaving installs stranded on old builds
// with zero signal (field incident, 2026-08-06). These tests pin the split:
// disk-full publishes an actionable `error`; transient failures stay `idle`.

import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
  },
  nativeUpdater: { on: vi.fn() },
  net: {
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "version: 0.0.0\n",
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

describe("disk-full staging failures", () => {
  let updater: typeof import("../updater");

  beforeAll(async () => {
    updater = await import("../updater");
    updater.setupUpdater();
  });

  it("classifies ENOSPC codes and Squirrel's ditto message as disk-full", () => {
    expect(
      updater.isDiskFullError(
        new Error(
          "ditto: /Users/u/Library/Caches/com.zeros.alpha.ShipIt/update.x/" +
            "Zeros Alpha.app/Contents/Resources/claude: No space left on device",
        ),
      ),
    ).toBe(true);
    expect(
      updater.isDiskFullError(
        Object.assign(new Error("write failed"), { code: "ENOSPC" }),
      ),
    ).toBe(true);
    expect(
      updater.isDiskFullError(new Error("net::ERR_INTERNET_DISCONNECTED")),
    ).toBe(false);
    expect(updater.isDiskFullError(undefined)).toBe(false);
    expect(updater.isDiskFullError("No space left on device")).toBe(false);
  });

  it("publishes an actionable error status when staging runs out of disk", () => {
    mocks.libraryUpdater.emit(
      "error",
      new Error(
        "ditto: /Users/u/Library/Caches/com.zeros.alpha.ShipIt/update.x/" +
          "Zeros Alpha.app/Contents/Resources/claude: No space left on device",
      ),
    );

    const status = updater.updaterStatus({} as never, {} as never) as {
      kind: string;
      message?: string;
    };
    expect(status.kind).toBe("error");
    expect(status.message).toContain("disk space");
  });

  it("still absorbs ordinary background failures into idle", () => {
    mocks.libraryUpdater.emit(
      "error",
      new Error("net::ERR_INTERNET_DISCONNECTED"),
    );

    expect(updater.updaterStatus({} as never, {} as never)).toMatchObject({
      kind: "idle",
    });
  });

  it("never downgrades an already-staged ready state to error", () => {
    mocks.libraryUpdater.emit("update-available", { version: "9.9.9" });
    mocks.libraryUpdater.emit("update-downloaded", { version: "9.9.9" });
    if (process.platform === "darwin") {
      // macOS defers ready until native Squirrel confirms staging.
      const nativeHandler = mocks.nativeUpdater.on.mock.calls.find(
        ([event]) => event === "update-downloaded",
      )?.[1] as (() => void) | undefined;
      nativeHandler?.();
    }
    expect(updater.updaterStatus({} as never, {} as never)).toMatchObject({
      kind: "ready",
    });

    mocks.libraryUpdater.emit(
      "error",
      new Error("something: No space left on device"),
    );
    expect(updater.updaterStatus({} as never, {} as never)).toMatchObject({
      kind: "ready",
    });
  });
});
