import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: native.invoke, useNativeRuntime: () => ({ ready: true }) }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe("device keep awake preference", () => {
  it("shares one native read and retains its snapshot across owner/Settings switches", async () => {
    const settings = await import("../keep-awake-settings");
    native.invoke.mockResolvedValue({ enabled: true, supported: true });
    await Promise.all([settings.loadKeepAwakePreferences(), settings.loadKeepAwakePreferences()]);
    const confirmed = settings.getKeepAwakeSettings();
    expect(confirmed.preferences).toEqual({ enabled: true, supported: true });
    await settings.loadKeepAwakePreferences();
    expect(settings.getKeepAwakeSettings()).toBe(confirmed);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("keep_awake_get");
  });

  it("does not let an old initial read replace a successfully saved preference", async () => {
    const settings = await import("../keep-awake-settings");
    let resolve!: (value: unknown) => void;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const loading = settings.loadKeepAwakePreferences();
    native.invoke.mockResolvedValueOnce({ enabled: true, supported: true });
    await settings.setKeepAwakeEnabled(true);
    resolve({ enabled: false, supported: true });
    await loading;
    expect(settings.getKeepAwakeSettings()).toMatchObject({ preferences: { enabled: true }, saving: false, error: null });
  });

  it("waits for native persistence before confirming the switch", async () => {
    const settings = await import("../keep-awake-settings");
    native.invoke.mockResolvedValueOnce({ enabled: false, supported: true });
    await settings.loadKeepAwakePreferences();
    let resolve!: (value: unknown) => void;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const saving = settings.setKeepAwakeEnabled(true);
    expect(settings.getKeepAwakeSettings()).toMatchObject({ preferences: { enabled: false }, saving: true });
    resolve({ enabled: true, supported: true });
    await saving;
    expect(settings.getKeepAwakeSettings()).toMatchObject({ preferences: { enabled: true }, saving: false });
    expect(native.invoke).toHaveBeenLastCalledWith("keep_awake_set", { enabled: true });
  });

  it("keeps the latest write when responses arrive out of order", async () => {
    const settings = await import("../keep-awake-settings");
    let resolve!: (value: unknown) => void;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const older = settings.setKeepAwakeEnabled(true);
    native.invoke.mockResolvedValueOnce({ enabled: false, supported: true });
    await settings.setKeepAwakeEnabled(false);
    resolve({ enabled: true, supported: true });
    await older;
    expect(settings.getKeepAwakeSettings()).toMatchObject({ preferences: { enabled: false }, saving: false });
  });

  it("retains the confirmed preference after a rejected write", async () => {
    const settings = await import("../keep-awake-settings");
    native.invoke.mockResolvedValueOnce({ enabled: true, supported: true });
    await settings.loadKeepAwakePreferences();
    native.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(settings.setKeepAwakeEnabled(false)).rejects.toThrow("disk full");
    expect(settings.getKeepAwakeSettings()).toMatchObject({ preferences: { enabled: true }, saving: false });
  });

  it("allows a failed initial read to be retried", async () => {
    const settings = await import("../keep-awake-settings");
    native.invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(settings.loadKeepAwakePreferences()).rejects.toThrow("IPC unavailable");
    expect(settings.getKeepAwakeSettings().error).toContain("Couldn't load");
    native.invoke.mockResolvedValueOnce({ enabled: false, supported: true });
    await settings.loadKeepAwakePreferences();
    expect(settings.getKeepAwakeSettings()).toEqual({ preferences: { enabled: false, supported: true }, saving: false, error: null });
  });
});
