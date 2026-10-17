import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  channel: "stable",
  localDevelopment: false,
  navigate: vi.fn(),
  emit: vi.fn(),
  spawn: vi.fn(),
  register: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { setAsDefaultProtocolClient: state.register },
  shell: {},
}));
vi.mock("../runtime-mode", () => ({
  get IS_LOCAL_DEVELOPMENT() {
    return state.localDevelopment;
  },
}));
vi.mock("../ipc/events", () => ({
  emitEvent: state.emit,
  emitLocalNavigation: state.navigate,
}));
vi.mock("../sidecar", () => ({ spawnEngine: state.spawn }));
vi.mock("../../src/engine/runtime", () => ({
  channel: () => state.channel,
  schemeForChannel: (channel: string) =>
    channel === "stable" ? "zeros" : `zeros-${channel}`,
}));
import { handleUrl, registerProtocol } from "../deep-link";

beforeEach(() => {
  vi.clearAllMocks();
  state.channel = "stable";
  state.localDevelopment = false;
});

describe("Local chat/workspace links", () => {
  it("registers the dev scheme for Local navigation in a development build", () => {
    state.channel = "dev";
    state.localDevelopment = true;
    registerProtocol();
    expect(state.register).toHaveBeenCalledWith("zeros-dev");
  });
  it.each(["stable", "alpha", "beta", "dev"])(
    "routes only %s's links as navigation",
    async (channel) => {
      state.channel = channel;
      state.localDevelopment = channel === "dev";
      const scheme = channel === "stable" ? "zeros" : `zeros-${channel}`;
      for (const path of [
        "chat/chat_one",
        "workspace/ws_two",
        "workspace/folder%3Aproj_123",
      ]) {
        await handleUrl(`${scheme}://${path}`);
        expect(state.navigate).toHaveBeenLastCalledWith(`${scheme}://${path}`);
      }
      expect(state.spawn).not.toHaveBeenCalled();
      expect(state.emit).not.toHaveBeenCalled();
    },
  );

  it.each([
    "zeros-beta://chat/one",
    "zeros://chat/one?start=true",
    "zeros://chat/one#message",
    "zeros://chat/one/two",
    "zeros://user@chat/one",
    "zeros://chat:44/one",
    "zeros://workspace/folder%3A%2Ftmp",
    "zeros://workspace/",
    "zeros://chat/%ZZ",
  ])("refuses malformed or foreign navigation: %s", async (url) => {
    await handleUrl(url);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("never logs a raw malformed URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleUrl("not a URL with private content");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private content");
    warn.mockRestore();
  });
});
