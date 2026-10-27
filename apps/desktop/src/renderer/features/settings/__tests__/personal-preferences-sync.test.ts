import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";

const mocks = vi.hoisted(() => ({
  op: vi.fn(),
  accept: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  workspaceOp: mocks.op,
}));
vi.mock("../../../platform/runtime", () => ({ isNativeRuntime: () => true }));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: mocks.error, dismiss: mocks.dismiss },
}));
vi.mock("../../../platform/personal-preferences", () => ({
  acceptPersonalPreferences: mocks.accept,
  legacyPersonalPreferences: () => ({}),
  pendingPreferences: () => new Map(),
  onPendingPreferences: () => () => {},
}));
import { startPersonalPreferencesSync } from "../personal-preferences-sync";

describe("personal preferences across reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const connected = (kind = "local") => ({
    status: "connected", executionIdentity: { kind },
    on: () => () => {}, onStatusChange: () => () => {},
  }) as unknown as RuntimeClient;
  it("silently retries a first failed read and needs no focus event to recover", async () => {
    vi.useFakeTimers();
    mocks.op.mockRejectedValueOnce(new Error("temporarily busy")).mockResolvedValue({});
    const stop = startPersonalPreferencesSync(connected());
    try {
      await vi.advanceTimersByTimeAsync(1_499);
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.accept).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.accept).toHaveBeenCalledOnce();
      expect(mocks.error).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { stop(); }
  });
  it("shows one persistent failure and dismisses it when a later refresh succeeds", async () => {
    vi.useFakeTimers();
    mocks.op.mockRejectedValue(new Error("read-only settings"));
    const stop = startPersonalPreferencesSync(connected());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ id: "personal-preferences-sync" }));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(mocks.error).toHaveBeenCalledOnce();
      mocks.op.mockResolvedValue({});
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.dismiss).toHaveBeenCalledWith("personal-preferences-sync");
      expect(vi.getTimerCount()).toBe(0);
    } finally { stop(); }
  });
  it("cancels retries on disposal and never syncs Local preferences through cloud", async () => {
    vi.useFakeTimers();
    mocks.op.mockRejectedValue(new Error("temporarily busy"));
    const stop = startPersonalPreferencesSync(connected());
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const stopCloud = startPersonalPreferencesSync(connected("cloud"));
    await vi.advanceTimersByTimeAsync(60_000);
    stopCloud();
    expect(mocks.op).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["resolve", "reject"] as const)(
    "refreshes after reconnect when the old connection's read ends with %s",
    async (outcome) => {
      let onDb!: (message: unknown) => void;
      let onStatus!: (status: string) => void;
      const bridge = {
        status: "connected",
        executionIdentity: { kind: "local" },
        on: (_: string, fn: typeof onDb) => {
          onDb = fn;
          return () => {};
        },
        onStatusChange: (fn: typeof onStatus) => {
          onStatus = fn;
          return () => {};
        },
      };
      const dark = { appearance: { mode: "dark", codeThemes: {} } },
        light = { appearance: { mode: "light", codeThemes: {} } };
      let release!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      mocks.op
        .mockResolvedValueOnce(dark)
        .mockImplementationOnce(
          () =>
            new Promise((resolve, fail) => {
              release = resolve;
              reject = fail;
            }),
        )
        .mockResolvedValue(light);
      const stop = startPersonalPreferencesSync(
        bridge as unknown as RuntimeClient,
      );
      try {
        await vi.waitFor(() => expect(mocks.accept).toHaveBeenCalledTimes(1));
        onDb({ kinds: ["settings"] });
        await vi.waitFor(() => expect(mocks.op).toHaveBeenCalledTimes(2));
        bridge.status = "disconnected";
        onStatus("disconnected");
        bridge.status = "connected";
        onStatus("connected");
        if (outcome === "resolve") release({ doc: { preferences: dark } });
        else reject(new Error("old connection closed"));
        await vi.waitFor(() => expect(mocks.op).toHaveBeenCalledTimes(3));
        await vi.waitFor(() =>
          expect(mocks.accept.mock.calls.map((call) => call[0])).toEqual([
            dark,
            light,
          ]),
        );
        expect(mocks.error).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});
