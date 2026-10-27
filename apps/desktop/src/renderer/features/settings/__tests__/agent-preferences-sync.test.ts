import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../../../platform/bridge/ws-client";
import { classifyRpcError } from "../../../platform/bridge/failure";
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
    vi.restoreAllMocks();
  });
  async function setup(status: "connected" | "connecting" = "connected") {
    const bridge = new RuntimeClient();
    const internals = bridge as unknown as {
      isOpen(): boolean;
      setStatus(status: string): void;
      handleIncoming(message: unknown): void;
    };
    vi.spyOn(internals, "isOpen").mockImplementation(
      () => bridge.status === "connected",
    );
    internals.setStatus(status);
    const outbox = await import("../../../platform/agent-preferences");
    const { startAgentPreferencesSync } =
      await import("../agent-preferences-sync");
    const stopSync = startAgentPreferencesSync(bridge);
    return {
      stopSync,
      stop: () => {
        stopSync();
        bridge.dispose();
      },
      bridge,
      outbox,
      change: () =>
        internals.handleIncoming({ type: "DB_CHANGED", kinds: ["settings"] }),
      connect: () => internals.setStatus("connected"),
      disconnect: () => internals.setStatus("disconnected"),
      reconnect: () => {
        internals.setStatus("disconnected");
        internals.setStatus("connected");
      },
    };
  }
  it.each(["startup", "reconnect"])(
    "waits silently for local %s and acknowledges settings before releasing session setup",
    async (phase) => {
      let acknowledge!: (doc: Record<string, unknown>) => void;
      mocks.op.mockResolvedValue({});
      const { stop, outbox, connect, disconnect } = await setup(
        phase === "startup" ? "connecting" : "connected",
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        if (phase === "reconnect") disconnect();
        mocks.op
          .mockClear()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                acknowledge = resolve;
              }),
          )
          .mockResolvedValue({
            doc: { providers: { codex: { auth: "cli" } } },
          });
        outbox.queueAgentPreferenceChanges({
          providers: { codex: { auth: "cli" } },
        });
        const settled = vi.fn();
        const flushing = outbox.flushAgentPreferences().then(
          () => settled("saved"),
          (error: Error) => settled(error.message),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settled).not.toHaveBeenCalled();
        expect(mocks.op).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
        expect(outbox.pendingAgentPreferences().size).toBe(1);

        connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.op).toHaveBeenCalledOnce();
        expect(mocks.op).toHaveBeenCalledWith(
          expect.anything(),
          "settings.syncAgentPreferences",
          expect.objectContaining({
            changes: [{ path: ["providers", "codex", "auth"], value: "cli" }],
          }),
        );
        expect(settled).not.toHaveBeenCalled();
        acknowledge({ providers: { codex: { auth: "cli" } } });
        await flushing;
        expect(settled).toHaveBeenCalledExactlyOnceWith("saved");
        expect(outbox.pendingAgentPreferences().size).toBe(0);
        expect(mocks.error).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );

  it("retires a startup waiter with its synchronizer and preserves pending settings", async () => {
    const { stop, stopSync, outbox, connect } = await setup("connecting");
    try {
      outbox.queueAgentPreferenceChanges({
        models: { default_plan_mode: true },
      });
      const settled = vi.fn();
      const flushing = outbox.flushAgentPreferences().then(
        () => settled("saved"),
        (error: Error) => settled(error.message),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      stopSync();
      await flushing;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/aborted/i),
      );
      expect(vi.getTimerCount()).toBe(0);
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.op).not.toHaveBeenCalled();
      expect(outbox.pendingAgentPreferences().size).toBe(1);
      expect(mocks.error).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("keeps an unedited startup quiet when the connection drops as readiness settles", async () => {
    mocks.op.mockImplementation(async (_bridge, op) =>
      op === "settings.read" ? { doc: {} } : {},
    );
    const { stop, outbox, connect, disconnect } = await setup("connecting");
    try {
      const settled = vi.fn();
      const flushing = outbox.flushAgentPreferences().then(
        () => settled("saved"),
        (error: Error) => settled(error.message),
      );
      connect();
      disconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      expect(mocks.models).not.toHaveBeenCalled();
      connect();
      await flushing;
      expect(settled).toHaveBeenCalledExactlyOnceWith("saved");
      expect(mocks.error).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("bounds a prolonged local readiness wait and keeps it recoverable", async () => {
    const { stop, outbox } = await setup("connecting");
    try {
      const settled = vi.fn();
      const flushing = outbox
        .flushAgentPreferences()
        .catch((error: unknown) => {
          settled(classifyRpcError(error));
        });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushing;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: "transport-closed",
          message: expect.stringMatching(/local engine.*reconnecting/i),
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.error).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("still rejects a genuine settings save failure after the engine connects", async () => {
    const failure = new Error("Settings file is read-only");
    mocks.op.mockRejectedValue(failure);
    const { stop, outbox, connect } = await setup("connecting");
    try {
      outbox.queueAgentPreferenceChanges({
        models: { default_plan_mode: true },
      });
      const flushing = outbox.flushAgentPreferences();
      const rejected = expect(flushing).rejects.toBe(failure);
      connect();
      await rejected;
      expect(outbox.pendingAgentPreferences().size).toBe(1);
      expect(mocks.error).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
  it("does not let a cloud synchronizer replace or wait on the Local flush", async () => {
    const outbox = await import("../../../platform/agent-preferences");
    const { startAgentPreferencesSync } =
      await import("../agent-preferences-sync");
    const localFlush = vi.fn(async () => {});
    const stopLocal = outbox.registerAgentPreferencesFlush(localFlush);
    const cloud = new RuntimeClient();
    vi.spyOn(cloud, "executionIdentity", "get").mockReturnValue({
      kind: "cloud",
      organizationId: "organization",
      workspaceId: "workspace",
      generation: 1,
      authorityEpoch: 1,
      engineInstanceId: "engine",
    });
    const wait = vi.spyOn(cloud, "waitUntilReady");
    const stopCloud = startAgentPreferencesSync(cloud);
    try {
      await outbox.flushAgentPreferences();
      stopCloud();
      await outbox.flushAgentPreferences();
      expect(localFlush).toHaveBeenCalledTimes(2);
      expect(mocks.op).not.toHaveBeenCalled();
      expect(wait).not.toHaveBeenCalled();
    } finally {
      stopCloud();
      stopLocal();
      cloud.dispose();
    }
  });
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
