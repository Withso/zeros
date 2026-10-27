import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const webContents = { mainFrame: {} };
  return {
    window: { webContents } as { webContents: typeof webContents } | null,
    webContents,
    probe: vi.fn(),
    openExternal: vi.fn(),
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => "/Users/test" },
  shell: {
    openExternal: native.openExternal,
  },
}));
vi.mock("../../events", () => ({ getMainWindow: () => native.window }));
vi.mock("../../../full-disk-access", async (original) => ({
  ...(await original<typeof import("../../../full-disk-access")>()),
  probeFullDiskAccess: native.probe,
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const event = {
  sender: native.webContents,
  senderFrame: native.webContents.mainFrame,
} as unknown as IpcMainInvokeEvent;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.webContents.mainFrame = event.senderFrame!;
  native.window = { webContents: native.webContents };
  native.probe.mockResolvedValue("denied");
  native.openExternal.mockResolvedValue(undefined);
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

describe("Full Disk Access native commands", () => {
  it("returns only effective status without filesystem paths or app identity", async () => {
    const { fullDiskAccessStatus } = await import("../full-disk-access");
    expect(await fullDiskAccessStatus({}, event)).toEqual({
      status: "denied",
    });
    expect(native.probe).toHaveBeenCalledExactlyOnceWith({
      platform: "darwin",
      home: "/Users/test",
    });
  });

  it("coalesces pending probes but checks again for grant and revocation", async () => {
    const { fullDiskAccessStatus } = await import("../full-disk-access");
    let resolve!: (status: string) => void;
    native.probe.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = fullDiskAccessStatus({}, event);
    const second = fullDiskAccessStatus({}, event);
    expect(native.probe).toHaveBeenCalledTimes(1);
    resolve("available");
    expect(await first).toEqual(await second);
    expect(await fullDiskAccessStatus({}, event)).toMatchObject({
      status: "denied",
    });
    expect(native.probe).toHaveBeenCalledTimes(2);
  });

  it.each(["denied", "unknown", "available"])(
    "attempts protected access before opening Settings when the result is %s",
    async (status) => {
      const { fullDiskAccessOpenSettings } =
        await import("../full-disk-access");
      let resolve!: (status: string) => void;
      native.probe.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const opening = fullDiskAccessOpenSettings({}, event);
      expect(native.probe).toHaveBeenCalledExactlyOnceWith({
        platform: "darwin",
        home: "/Users/test",
      });
      expect(native.openExternal).not.toHaveBeenCalled();
      resolve(status);
      await opening;
      expect(native.openExternal).toHaveBeenCalledExactlyOnceWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
    },
  );

  it("shares a pending status probe with the Settings action", async () => {
    const { fullDiskAccessStatus, fullDiskAccessOpenSettings } =
      await import("../full-disk-access");
    let resolve!: (status: string) => void;
    native.probe.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const reading = fullDiskAccessStatus({}, event);
    const opening = fullDiskAccessOpenSettings({}, event);
    expect(native.probe).toHaveBeenCalledTimes(1);
    expect(native.openExternal).not.toHaveBeenCalled();
    resolve("denied");
    await Promise.all([reading, opening]);
    expect(native.openExternal).toHaveBeenCalledOnce();
  });

  it.each(["closed", "replaced", "navigated"])(
    "does not open Settings if the app window is %s during its probe",
    async (change) => {
      const { fullDiskAccessOpenSettings } =
        await import("../full-disk-access");
      let resolve!: (status: string) => void;
      native.probe.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const opening = fullDiskAccessOpenSettings({}, event);
      expect(native.probe).toHaveBeenCalledOnce();
      const rejection = expect(opening).rejects.toThrow(
        "require the app window",
      );
      if (change === "closed") native.window = null;
      else if (change === "replaced")
        native.window = { webContents: { mainFrame: {} } };
      else native.webContents.mainFrame = {};
      resolve("denied");
      await rejection;
      expect(native.openExternal).not.toHaveBeenCalled();
    },
  );

  it("rejects workspace/cloud targets, paths, URLs, and grant writes", async () => {
    const commands = await import("../full-disk-access");
    for (const args of [
      { path: "/private" },
      { url: "file:///private" },
      { status: "available" },
      { cwd: "cloud://org/workspace" },
      { organizationId: "other" },
    ]) {
      for (const command of Object.values(commands)) {
        await expect(
          Promise.resolve().then(() => command(args, event)),
        ).rejects.toThrow("do not accept arguments");
      }
    }
    expect(native.probe).not.toHaveBeenCalled();
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("rejects subframes, other windows and a missing app window before any work", async () => {
    const commands = await import("../full-disk-access");
    for (const untrusted of [
      { ...event, senderFrame: {} },
      { ...event, sender: {} },
      { ...event, senderFrame: null },
    ]) {
      for (const command of Object.values(commands)) {
        await expect(
          Promise.resolve().then(() =>
            command({}, untrusted as IpcMainInvokeEvent),
          ),
        ).rejects.toThrow("require the app window");
      }
    }
    native.window = null;
    await expect(commands.fullDiskAccessStatus({}, event)).rejects.toThrow(
      "require the app window",
    );
    expect(native.probe).not.toHaveBeenCalled();
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("rechecks window ownership after an in-flight probe", async () => {
    const { fullDiskAccessStatus } = await import("../full-disk-access");
    let resolve!: (status: string) => void;
    native.probe.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const read = fullDiskAccessStatus({}, event);
    native.window = null;
    resolve("available");
    await expect(read).rejects.toThrow("require the app window");
  });

  it("does not launch macOS settings on other platforms", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    const commands = await import("../full-disk-access");
    native.probe.mockResolvedValue("unsupported");
    expect(await commands.fullDiskAccessStatus({}, event)).toEqual({
      status: "unsupported",
    });
    await expect(
      commands.fullDiskAccessOpenSettings({}, event),
    ).rejects.toThrow("requires macOS");
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("returns actionable System Settings errors without native details", async () => {
    const { fullDiskAccessOpenSettings } = await import("../full-disk-access");
    native.openExternal.mockRejectedValueOnce(
      new Error("private native detail"),
    );
    await expect(fullDiskAccessOpenSettings({}, event)).rejects.toThrow(
      "Open Privacy & Security > Full Disk Access manually.",
    );
  });
});
