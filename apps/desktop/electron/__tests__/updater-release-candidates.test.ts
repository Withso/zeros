import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  channel: "stable",
  persisted: false as boolean,
  written: [] as boolean[],
  appHandlers: new Map<string, () => void>(),
  updateHandlers: new Map<string, (...args: unknown[]) => void>(),
  nativeHandlers: new Map<string, () => void>(),
  check: vi.fn<() => Promise<unknown>>(),
  setFeedURL: vi.fn(),
  feeds: {} as Record<string, string | null>,
}));
vi.mock("electron", () => ({
  app: { on: (event: string, handler: () => void) => fixture.appHandlers.set(event, handler) },
  powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 0 },
  autoUpdater: { on: (event: string, handler: () => void) => fixture.nativeHandlers.set(event, handler) },
  net: { fetch: vi.fn(async (url: string) => {
    const version = Object.entries(fixture.feeds).find(([suffix]) => url.endsWith(suffix))?.[1];
    return version === null || version === undefined ? { ok: false, status: 404, text: async () => "" } : { ok: true, text: async () => `version: ${version}\n` };
  }) },
}));
vi.mock("electron-updater", () => ({ autoUpdater: {
  checkForUpdates: fixture.check, setFeedURL: fixture.setFeedURL,
  on: (event: string, handler: (...args: unknown[]) => void) => fixture.updateHandlers.set(event, handler),
} }));
vi.mock("../release-candidates", async importOriginal => ({
  ...(await importOriginal<typeof import("../release-candidates")>()),
  readReleaseCandidatesEnabled: () => fixture.persisted,
  writeReleaseCandidatesEnabled: (enabled: boolean) => { fixture.written.push(enabled); },
}));
vi.mock("../runtime-mode", () => ({ IS_PACKAGED: true }));
vi.mock("../../src/engine/runtime", () => ({ channel: () => fixture.channel }));
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn() }));
vi.mock("../client-upgrade-signal", () => ({ onClientUpgrade: vi.fn() }));

const RC = "/download/rc/rc-mac.yml", LATEST = "/latest/download/latest-mac.yml";
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  Object.assign(fixture, { channel: "stable", persisted: false, written: [], feeds: { [RC]: "0.1.31", [LATEST]: "0.1.30" } });
  fixture.appHandlers.clear(); fixture.updateHandlers.clear(); fixture.nativeHandlers.clear();
  fixture.check.mockReset().mockResolvedValue({ isUpdateAvailable: false });
  fixture.setFeedURL.mockReset();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const settle = () => vi.advanceTimersByTimeAsync(0);
async function setup() {
  const updater = await import("../updater");
  updater.setupUpdater(); await settle();
  return updater;
}
const feeds = () => fixture.setFeedURL.mock.calls.map(([feed]) => (feed as { channel: string }).channel);

describe("release candidates on the stable channel", () => {
  it("leaves an app that never opted in on its baked feed", async () => {
    await setup();
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.setFeedURL).not.toHaveBeenCalled();
  });

  it("follows rc from the launch check when the persisted opt-in is on and rc is newer", async () => {
    fixture.persisted = true;
    await setup();
    expect(fixture.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      provider: "generic", url: "https://github.com/Withso/zeros/releases/download/rc?static=1", channel: "rc" });
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(fixture.check.mock.invocationCallOrder[0]!);
  });

  it.each<[string | null, string]>([["0.1.30", "the same version"], ["0.1.29", "older"], [null, "missing"]])("stays on Latest when rc is %s (%s)", async (rc) => {
    fixture.persisted = true; fixture.feeds[RC] = rc;
    await setup();
    expect(feeds()).toEqual(["latest"]);
    expect(fixture.check).toHaveBeenCalledOnce();
  });

  it("switches at once when the renderer opts in, and back to Latest when it opts out", async () => {
    const updater = await setup();
    expect(await updater.updaterReleaseCandidates({ enabled: true }, undefined as never)).toEqual({ applied: true, enabled: true });
    await settle();
    expect(feeds()).toEqual(["rc"]); expect(fixture.written).toEqual([true]); expect(fixture.check).toHaveBeenCalledTimes(2);
    expect(await updater.updaterReleaseCandidates({ enabled: false }, undefined as never)).toEqual({ applied: true, enabled: false });
    await settle();
    expect(feeds()).toEqual(["rc", "latest"]); expect(fixture.written).toEqual([true, false]);
  });

  it("repeats nothing for an unchanged choice and refuses a malformed one", async () => {
    fixture.persisted = true;
    const updater = await setup();
    fixture.check.mockClear();
    expect(await updater.updaterReleaseCandidates({ enabled: true }, undefined as never)).toEqual({ applied: true, enabled: true });
    expect(fixture.written).toEqual([]); expect(fixture.check).not.toHaveBeenCalled();
    expect(() => updater.updaterReleaseCandidates({ enabled: "yes" }, undefined as never)).toThrow(/Invalid/);
  });

  it("replaces a staged Latest build when a newer candidate appears", async () => {
    fixture.persisted = true; fixture.feeds[RC] = null;
    await setup();
    fixture.updateHandlers.get("update-available")?.({ version: "0.1.30" });
    fixture.updateHandlers.get("update-downloaded")?.({ version: "0.1.30" });
    fixture.nativeHandlers.get("update-downloaded")?.();
    fixture.feeds[RC] = "0.1.31"; fixture.check.mockClear();
    // A staged build is replaced at most once an hour.
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(feeds()).toEqual(["latest", "rc"]);
    expect(fixture.check).toHaveBeenCalledOnce();
  });

  it.each(["alpha", "beta"])("ignores the choice on %s, which has its own feed", async channel => {
    fixture.channel = channel;
    const updater = await setup();
    fixture.setFeedURL.mockClear();
    expect(await updater.updaterReleaseCandidates({ enabled: true }, undefined as never)).toEqual({ applied: false });
    expect(fixture.written).toEqual([]); expect(fixture.setFeedURL).not.toHaveBeenCalled();
  });
});
