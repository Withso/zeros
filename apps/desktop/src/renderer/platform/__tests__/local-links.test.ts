import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  native: true,
}));
vi.mock("../runtime", () => ({
  nativeInvoke: state.invoke,
  nativeListen: state.listen,
  isNativeRuntime: () => state.native,
}));
vi.mock("../../config/release-channel", () => ({ CHANNEL: "beta" }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  state.native = true;
});

describe("Local link native boundary", () => {
  it("routes inline click intents through the same channel fence and retires them on unsubscribe", async () => {
    state.native = false;
    state.invoke.mockResolvedValue({ channel: "dev" });
    const { onLocalNavigation, openLocalLink } = await import("../local-links");
    const handler = vi.fn();
    const off = await onLocalNavigation(handler);
    openLocalLink("zeros-dev://chat/clicked");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledExactlyOnceWith({ scheme: "zeros-dev", kind: "chat", id: "clicked" }));
    openLocalLink("zeros-beta://chat/foreign");
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    openLocalLink("zeros-dev://chat/retired");
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state.listen).not.toHaveBeenCalled();
  });

  it("does not overwrite an inline click with an older pending native intent", async () => {
    state.listen.mockResolvedValue(vi.fn());
    let finish!: (value: unknown) => void;
    state.invoke.mockImplementation((name) => name === "app_info" ? Promise.resolve({ channel: "dev" }) : new Promise((resolve) => { finish = resolve; }));
    const { onLocalNavigation, openLocalLink } = await import("../local-links");
    const handler = vi.fn();
    const off = await onLocalNavigation(handler);
    openLocalLink("zeros-dev://chat/clicked");
    finish("zeros-dev://chat/old");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledExactlyOnceWith({ scheme: "zeros-dev", kind: "chat", id: "clicked" }));
    off();
  });

  it.each(["stable", "alpha", "beta", "dev"])(
    "copies main's authoritative %s channel",
    async (channel) => {
      state.invoke.mockResolvedValue({ channel });
      const { resolveLocalLinkScheme } = await import("../local-links");
      const expected = channel === "stable" ? "zeros" : `zeros-${channel}`;
      expect(await resolveLocalLinkScheme()).toBe(expected);
      expect(await resolveLocalLinkScheme()).toBe(expected);
      expect(state.invoke).toHaveBeenCalledExactlyOnceWith("app_info");
    },
  );

  it("falls back to the build channel when native info is unavailable", async () => {
    state.invoke.mockRejectedValue(new Error("older shell"));
    expect(
      await (await import("../local-links")).resolveLocalLinkScheme(),
    ).toBe("zeros-beta");
  });

  it("subscribes before consuming a pending link and rejects foreign or malformed events", async () => {
    let listener!: (value: unknown) => void;
    state.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return vi.fn();
    });
    state.invoke.mockImplementation(async (name) => {
      if (name === "app_info") return { channel: "beta" };
      expect(listener).toBeTypeOf("function");
      return "zeros-beta://chat/one";
    });
    const handler = vi.fn();
    const off = await (
      await import("../local-links")
    ).onLocalNavigation(handler);
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledWith({
        scheme: "zeros-beta",
        kind: "chat",
        id: "one",
      }),
    );
    handler.mockClear();
    listener("zeros://chat/one");
    listener("zeros-beta://chat/one?start=true");
    listener({ id: "one" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    off();
    expect(state.invoke).toHaveBeenLastCalledWith("local_navigation_ready", {
      ready: false,
    });
    listener("zeros-beta://chat/two");
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not replay a pending IPC reply over a newer live intent", async () => {
    let listener!: (value: unknown) => void;
    let finish!: (value: unknown) => void;
    state.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return vi.fn();
    });
    state.invoke.mockImplementation((name) =>
      name === "app_info"
        ? Promise.resolve({ channel: "stable" })
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const handler = vi.fn();
    await (await import("../local-links")).onLocalNavigation(handler);
    listener("zeros://chat/new");
    finish("zeros://chat/old");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0]?.[0].id).toBe("new");
  });

  it("does not let an older asynchronous mount suspend its replacement", async () => {
    const listeners: Array<(value: unknown) => void> = [];
    state.listen.mockImplementation(async (_name, callback) => {
      listeners.push(callback);
      return vi.fn();
    });
    state.invoke.mockImplementation(async (name) =>
      name === "app_info" ? { channel: "stable" } : null,
    );
    const { onLocalNavigation } = await import("../local-links");
    const oldHandler = vi.fn(), nextHandler = vi.fn();
    const first = onLocalNavigation(oldHandler);
    const second = onLocalNavigation(nextHandler);
    const [stopOld, stopNext] = await Promise.all([first, second]);
    stopOld();
    expect(state.invoke).not.toHaveBeenCalledWith("local_navigation_ready", {
      ready: false,
    });
    for (const listener of listeners) listener("zeros://chat/current");
    await vi.waitFor(() => expect(nextHandler).toHaveBeenCalledOnce());
    expect(oldHandler).not.toHaveBeenCalled();
    stopNext();
    expect(state.invoke).toHaveBeenLastCalledWith("local_navigation_ready", {
      ready: false,
    });
  });
});
