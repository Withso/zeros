import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  packaged: true,
  appHandlers: new Map<string, () => void>(),
  powerHandlers: new Map<string, () => void>(),
  updateHandlers: new Map<string, (...args: unknown[]) => void>(),
  nativeHandlers: new Map<string, () => void>(),
  check: vi.fn<() => Promise<unknown>>(),
  fetch: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { on: (event: string, handler: () => void) => fixture.appHandlers.set(event, handler) },
  powerMonitor: { on: (event: string, handler: () => void) => fixture.powerHandlers.set(event, handler) },
  autoUpdater: { on: (event: string, handler: () => void) => fixture.nativeHandlers.set(event, handler) },
  net: { fetch: fixture.fetch },
}));
vi.mock("electron-updater", () => ({ autoUpdater: {
  checkForUpdates: fixture.check,
  on: (event: string, handler: (...args: unknown[]) => void) => fixture.updateHandlers.set(event, handler),
  setFeedURL: vi.fn(),
} }));
vi.mock("../runtime-mode", () => ({ get IS_PACKAGED() { return fixture.packaged; } }));
vi.mock("../../src/engine/runtime", () => ({ channel: () => "stable" }));
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn() }));
vi.mock("../client-upgrade-signal", () => ({ onClientUpgrade: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  fixture.packaged = true;
  fixture.appHandlers.clear(); fixture.powerHandlers.clear();
  fixture.updateHandlers.clear(); fixture.nativeHandlers.clear();
  fixture.check.mockReset().mockResolvedValue({ isUpdateAvailable: false });
  fixture.fetch.mockReset().mockResolvedValue({ ok: true, text: async () => "version: 1.2.3\n" });
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
});

const settle = () => vi.advanceTimersByTimeAsync(0);
const focus = () => fixture.appHandlers.get("browser-window-focus")?.();
const resume = () => fixture.powerHandlers.get("resume")?.();
async function setup() {
  const updater = await import("../updater");
  updater.setupUpdater();
  await settle();
  return updater;
}
function stage() {
  fixture.updateHandlers.get("update-available")?.({ version: "1.2.3" });
  fixture.updateHandlers.get("update-downloaded")?.({ version: "1.2.3" });
  fixture.nativeHandlers.get("update-downloaded")?.();
}

describe("automatic update check cadence", () => {
  it("collapses focus/resume checks throughout a synthetic fifteen-minute session", async () => {
    await setup();
    for (let minute = 0; minute < 15; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      focus(); resume(); await settle();
    }
    console.info("Updater synthetic fifteen-minute focus/resume session", { checks: fixture.check.mock.calls.length });
    expect(fixture.check).toHaveBeenCalledTimes(4);
  });

  it("allows manual checks immediately and schedules the next check from that success", async () => {
    const updater = await setup();
    await vi.advanceTimersByTimeAsync(60_000);
    await updater.updaterCheck({}, {} as never);
    expect(fixture.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299_999);
    focus(); resume(); await settle();
    expect(fixture.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.check).toHaveBeenCalledTimes(3);
  });

  it("uses completion time after a slow check and admits the next genuinely due check", async () => {
    let complete!: (value: unknown) => void;
    fixture.check.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await setup();
    await vi.advanceTimersByTimeAsync(120_000);
    focus(); resume();
    expect(fixture.check).toHaveBeenCalledTimes(1);
    complete({ isUpdateAvailable: false }); await settle();
    await vi.advanceTimersByTimeAsync(299_999);
    focus(); resume(); await settle();
    expect(fixture.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.check).toHaveBeenCalledTimes(2);
  });

  it("retains the one-minute opportunistic retry after a failed check", async () => {
    fixture.check.mockRejectedValueOnce(new Error("net::ERR_NETWORK_CHANGED"));
    await setup();
    await vi.advanceTimersByTimeAsync(59_999);
    focus(); await settle();
    expect(fixture.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    resume(); await settle();
    expect(fixture.check).toHaveBeenCalledTimes(2);
  });

  it("checks a newly required version without waiting for the automatic throttle", async () => {
    const updater = await setup();
    updater.requireClientUpgrade({ minimumVersion: "1.2.4", latestVersion: "1.2.4" });
    await settle();
    expect(fixture.check).toHaveBeenCalledTimes(2);
  });

  it("throttles successful staged metadata reads without disturbing the staged installer", async () => {
    await setup(); stage(); focus(); await settle();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    for (let minute = 0; minute < 4; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      focus(); resume(); await settle();
    }
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });

  it("retries failed staged metadata on focus and bypasses throttling for a new requirement", async () => {
    const updater = await setup(); stage();
    fixture.fetch.mockRejectedValueOnce(new Error("offline"));
    focus(); await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    focus(); await settle();
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    updater.requireClientUpgrade({ minimumVersion: "1.2.4", latestVersion: "1.2.4" });
    await settle();
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not create checks or timers for an unpackaged app", async () => {
    fixture.packaged = false;
    await setup();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fixture.check).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
