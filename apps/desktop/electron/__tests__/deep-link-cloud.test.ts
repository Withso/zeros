import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  channel: "stable",
  localDevelopment: false,
  navigate: vi.fn(),
  emit: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { setAsDefaultProtocolClient: vi.fn() },
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
import { handleUrl } from "../deep-link";

const org = "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35";
const ws = "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46";

beforeEach(() => {
  vi.clearAllMocks();
  state.channel = "stable";
  state.localDevelopment = false;
});

describe("cloud workspace links", () => {
  it.each(["stable", "alpha", "beta", "dev"])(
    "routes %s's link through the navigation intent, normalized",
    async (channel) => {
      state.channel = channel;
      const scheme = channel === "stable" ? "zeros" : `zeros-${channel}`;
      await handleUrl(`${scheme}://cloud-workspace/${org.toUpperCase()}/${ws}`);
      expect(state.navigate).toHaveBeenCalledExactlyOnceWith(
        `${scheme}://cloud-workspace/${org}/${ws}`,
      );
      expect(state.emit).not.toHaveBeenCalled();
      expect(state.spawn).not.toHaveBeenCalled();
    },
  );

  it("is not handled by a local development build, which has no account", async () => {
    state.channel = "dev";
    state.localDevelopment = true;
    await handleUrl(`zeros-dev://cloud-workspace/${org}/${ws}`);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.emit).not.toHaveBeenCalled();
  });

  it.each([
    `zeros-beta://cloud-workspace/${org}/${ws}`,
    `zeros://cloud-workspace/${org}`,
    `zeros://cloud-workspace/${org}/${ws}/`,
    `zeros://cloud-workspace/${org}/${ws}?wake=1`,
    `zeros://cloud-workspace/${org}/${ws}#x`,
    `zeros://user@cloud-workspace/${org}/${ws}`,
    `zeros://cloud-workspace:44/${org}/${ws}`,
    `zeros://cloud-workspace/${org}/not-a-uuid`,
    `zeros://cloud-workspace/${org}/${ws.replace(/-/g, "%2D")}`,
  ])("refuses a malformed or foreign link without forwarding it: %s", async (url) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleUrl(url);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.emit).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toContain(org);
    warn.mockRestore();
  });
});
