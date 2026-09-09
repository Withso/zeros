import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
const mocks = vi.hoisted(() => ({
  op: vi.fn(),
  models: vi.fn(),
  providers: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  workspaceOp: mocks.op,
}));
vi.mock("../../../platform/runtime", () => ({ isNativeRuntime: () => true }));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: mocks.error },
}));
vi.mock("../../agent/new-chat-defaults", () => ({
  hydrateModelsFromSettings: mocks.models,
  legacyModelPreferences: () => ({}),
}));
vi.mock("../provider-prefs", () => ({
  hydrateProviderPreferences: mocks.providers,
  legacyProviderPreferences: () => ({}),
}));

describe("agent settings synchronization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    });
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function setup() {
    let onDb!: (message: unknown) => void, onStatus!: (status: string) => void;
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
    const outbox = await import("../../../platform/agent-preferences");
    const { startAgentPreferencesSync } =
      await import("../agent-preferences-sync");
    const stop = startAgentPreferencesSync(bridge as unknown as RuntimeClient);
    return {
      stop,
      bridge,
      outbox,
      change: () => onDb({ kinds: ["settings"] }),
      reconnect: () => {
        bridge.status = "disconnected";
        onStatus("disconnected");
        bridge.status = "connected";
        onStatus("connected");
      },
    };
  }
  it("retries failed saves, retains newer pending edits, and treats file deletion as authoritative", async () => {
    mocks.op
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValueOnce({
        models: { default_plan_mode: true },
        providers: {},
      })
      .mockResolvedValue({ doc: {} });
    const { stop, outbox, change } = await setup();
    try {
      outbox.queueAgentPreferenceChanges({
        models: { default_plan_mode: true },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.pendingAgentPreferences().size).toBe(1);
      expect(mocks.error).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(outbox.pendingAgentPreferences().size).toBe(0);
      change();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.models).toHaveBeenLastCalledWith({}, true);
      expect(mocks.providers).toHaveBeenLastCalledWith({});
      expect(mocks.op).toHaveBeenLastCalledWith(
        expect.anything(),
        "settings.read",
        { layer: "user" },
      );
    } finally {
      stop();
    }
  });
  it.each(["resolve", "reject"])(
    "discards an old connection's %s while serializing a new edit",
    async (outcome) => {
      let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
      mocks.op
        .mockImplementationOnce(
          () =>
            new Promise((ok, fail) => {
              resolve = ok;
              reject = fail;
            }),
        )
        .mockResolvedValue({
          models: { default_plan_mode: false },
          providers: {},
        });
      const { stop, reconnect, outbox } = await setup();
      try {
        reconnect();
        outbox.queueAgentPreferenceChanges({
          models: { default_plan_mode: false },
        });
        expect(mocks.op).toHaveBeenCalledTimes(1);
        if (outcome === "resolve")
          resolve({ models: { default_plan_mode: true }, providers: {} });
        else reject(new Error("old connection closed"));
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.models).toHaveBeenCalledTimes(1);
        expect(mocks.models).toHaveBeenCalledWith(
          { default_plan_mode: false },
          true,
        );
        expect(outbox.pendingAgentPreferences().size).toBe(0);
        expect(mocks.error).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});
