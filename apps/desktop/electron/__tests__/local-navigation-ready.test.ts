import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const harness = vi.hoisted(() => ({
  window: null as { webContents: unknown } | null,
  take: vi.fn(),
  suspend: vi.fn(),
}));
vi.mock("electron", () => ({ app: {} }));
vi.mock("../runtime-mode", () => ({
  IS_DEV: false,
  IS_LOCAL_DEVELOPMENT: false,
}));
vi.mock("../sidecar", () => ({}));
vi.mock("../ipc/events", () => ({
  getMainWindow: () => harness.window,
  takePendingLocalNavigation: harness.take,
  suspendLocalNavigation: harness.suspend,
}));
import { localNavigationReady } from "../ipc/commands/app";

beforeEach(() => {
  vi.clearAllMocks();
  harness.window = null;
});

describe("Local navigation subscription IPC", () => {
  it("stops direct delivery when the same document removes its listener", () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    harness.window = { webContents };
    expect(
      localNavigationReady({ ready: false }, {
        sender: webContents,
        senderFrame: mainFrame,
      } as IpcMainInvokeEvent),
    ).toBeNull();
    expect(harness.suspend).toHaveBeenCalledOnce();
    expect(harness.take).not.toHaveBeenCalled();
  });
  it("allows only the main app document to consume the pending intent", () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    harness.window = { webContents };
    harness.take.mockReturnValue("zeros://chat/example");
    expect(
      localNavigationReady({}, {
        sender: webContents,
        senderFrame: mainFrame,
      } as IpcMainInvokeEvent),
    ).toBe("zeros://chat/example");
    expect(harness.take).toHaveBeenCalledOnce();
  });

  it.each(["no window", "other web contents", "subframe"])(
    "rejects %s without consuming",
    (scenario) => {
      const mainFrame = {};
      const webContents = { mainFrame };
      if (scenario !== "no window") harness.window = { webContents };
      const event = {
        sender: scenario === "other web contents" ? {} : webContents,
        senderFrame: scenario === "subframe" ? {} : mainFrame,
      } as IpcMainInvokeEvent;
      expect(() => localNavigationReady({}, event)).toThrow("app window");
      expect(harness.take).not.toHaveBeenCalled();
    },
  );
});
