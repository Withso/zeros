import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  flush: vi.fn(),
  prefs: vi.fn(),
}));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: deps.invoke,
  nativeListen: deps.listen,
  isElectron: () => true,
}));
vi.mock("../../../platform/agent-preferences", () => ({
  flushAgentPreferences: deps.flush,
}));
vi.mock("../provider-prefs", () => ({
  getProviderPrefs: () => ({ authMethod: "apiKey" }),
  setProviderPrefs: deps.prefs,
}));
vi.mock("../../../platform/provider-auth-state", () => ({
  providerAuthChanged: vi.fn(),
}));
vi.mock("../../agent/agents-cache", () => ({ invalidateAgentsCache: vi.fn() }));

describe("shared subscription connection state", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves waiting and cancels the native attempt when completion events are lost", async () => {
    vi.useFakeTimers();
    deps.listen.mockResolvedValue(() => {});
    const pending = {
      provider: "claude",
      state: "connecting",
      revision: 1,
      attemptId: "00000000-0000-4000-8000-000000000003",
    };
    deps.invoke.mockResolvedValue(pending);
    const service = await import("../subscription-connection");
    const run = service.connectSubscription("claude");
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 30_000);
    const result = await run;
    expect(result.state).not.toBe("connecting");
    expect(result.error).toMatch(/timed out/i);
    expect(
      service.subscriptionCache.getSnapshot("claude").data?.state,
    ).not.toBe("connecting");
    expect(deps.invoke).toHaveBeenCalledWith("provider_subscription", {
      provider: "claude",
      action: "cancel",
      attemptId: pending.attemptId,
    });
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    deps.flush.mockResolvedValue(undefined);
  });
  it.each(["status", "submit-code"])(
    "bounds a lost %s response",
    async (action) => {
      vi.useFakeTimers();
      deps.listen.mockResolvedValue(() => {});
      deps.invoke.mockImplementation(() => new Promise(() => {}));
      const service = await import("../subscription-connection");
      let error: unknown;
      const work = (
        action === "status"
          ? service.readSubscription("claude")
          : service.submitSubscriptionCode(
              "00000000-0000-4000-8000-000000000006",
              "fixture-code",
            )
      ).catch((caught) => {
        error = caught;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(error).toBeInstanceOf(Error);
      await work;
    },
  );
  it("bounds cancel even when the native response is lost", async () => {
    vi.useFakeTimers();
    deps.listen.mockResolvedValue(() => {});
    const pending = {
      provider: "codex",
      state: "connecting",
      revision: 1,
      attemptId: "00000000-0000-4000-8000-000000000004",
    };
    deps.invoke.mockImplementation((_command, args) =>
      args.action === "cancel"
        ? new Promise(() => {})
        : Promise.resolve(pending),
    );
    const service = await import("../subscription-connection");
    const run = service.connectSubscription("codex");
    await vi.advanceTimersByTimeAsync(1);
    let settled = false;
    const cancel = service.cancelSubscription("codex").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);
    expect(service.subscriptionCache.getSnapshot("codex").data?.state).toBe(
      "disconnected",
    );
    await cancel;
    await run;
  });

  it("starts Add account after a cancelled attempt finishes publishing", async () => {
    deps.listen.mockResolvedValue(() => {});
    const service = await import("../subscription-connection");
    let connects = 0;
    deps.invoke.mockImplementation(async (_command, args) => {
      if (args.action === "connect") {
        connects++;
        return {
          provider: "claude",
          state: "connecting",
          revision: connects * 2,
          attemptId: `00000000-0000-4000-8000-00000000000${connects}`,
        };
      }
      return {
        provider: "claude",
        state: "connected",
        revision: connects * 2 + 1,
        attemptId: `00000000-0000-4000-8000-00000000000${connects}`,
      };
    });
    const first = service.connectSubscription("claude");
    await vi.waitFor(() =>
      expect(
        service.subscriptionCache.getSnapshot("claude").data?.attemptId,
      ).toBeTruthy(),
    );
    let restarted: Promise<unknown> | undefined;
    const off = service.subscriptionCache.subscribe("claude", () => {
      if (
        service.subscriptionCache.getSnapshot("claude").data?.state ===
          "connected" &&
        !restarted
      )
        restarted = service.connectSubscription("claude");
    });
    await service.cancelSubscription("claude");
    await first;
    off();
    await vi.waitFor(() => expect(connects).toBe(2));
    await service.cancelSubscription("claude");
    await restarted;
  });

  it("bounds opening and ignores a retired attempt's late connecting status", async () => {
    vi.useFakeTimers();
    let emit!: (value: unknown) => void;
    deps.listen.mockImplementation(async (_name, listener) => {
      emit = listener;
      return () => {};
    });
    const pending = {
      provider: "claude",
      state: "connecting",
      revision: 2,
      attemptId: "00000000-0000-4000-8000-000000000005",
    };
    let acknowledge!: (value: unknown) => void;
    deps.invoke.mockImplementation((_command, args) =>
      args.action === "connect"
        ? new Promise((resolve) => {
            acknowledge = resolve;
          })
        : Promise.resolve({
            provider: "claude",
            state: "disconnected",
            revision: 1,
          }),
    );
    const service = await import("../subscription-connection");
    const run = service.connectSubscription("claude");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await run).error).toMatch(/timed out/i);
    acknowledge(pending);
    await vi.advanceTimersByTimeAsync(1);
    emit(pending);
    expect(service.subscriptionCache.getSnapshot("claude").data?.state).toBe(
      "disconnected",
    );
  });
  it("opens native sign-in once for repeated chat/settings clicks, including Cursor", async () => {
    let emit!: (value: unknown) => void;
    deps.listen.mockImplementation(async (_name, listener) => {
      emit = listener;
      return () => {};
    });
    deps.invoke.mockResolvedValue({
      provider: "cursor",
      state: "connecting",
      revision: 1,
      attemptId: "00000000-0000-4000-8000-000000000001",
    });
    const service = await import("../subscription-connection");
    const first = service.connectSubscription("cursor");
    expect(service.connectSubscription("cursor")).toBe(first);
    await vi.waitFor(() => expect(deps.invoke).toHaveBeenCalledOnce());
    expect(deps.invoke).toHaveBeenCalledWith("provider_subscription", {
      action: "connect",
      provider: "cursor",
    });
    emit({
      provider: "cursor",
      state: "connected",
      revision: 2,
      attemptId: "00000000-0000-4000-8000-000000000001",
      email: "user@example.test",
    });
    expect((await first).state).toBe("connected");
    expect(deps.prefs).toHaveBeenCalledWith("cursor", { authMethod: "cli" });
  });

  it("keeps exact provider state and ignores a stale status response after connection", async () => {
    let emit!: (value: unknown) => void;
    deps.listen.mockImplementation(async (_name, listener) => {
      emit = listener;
      return () => {};
    });
    let resolve!: (value: unknown) => void;
    deps.invoke.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const service = await import("../subscription-connection");
    const read = service.readSubscription("claude");
    await vi.waitFor(() => expect(deps.invoke).toHaveBeenCalledOnce());
    emit({ provider: "claude", state: "connected", revision: 3 });
    emit({ provider: "codex", state: "disconnected", revision: 9 });
    resolve({ provider: "claude", state: "disconnected", revision: 1 });
    expect(await read).toMatchObject({
      provider: "claude",
      state: "connected",
      revision: 3,
    });
    expect(service.subscriptionCache.getSnapshot("codex").data?.state).toBe(
      "disconnected",
    );
  });

  it("rejoins an existing native attempt after the renderer has reloaded", async () => {
    let emit!: (value: unknown) => void;
    deps.listen.mockImplementation(async (_name, listener) => {
      emit = listener;
      return () => {};
    });
    const pending = {
      provider: "codex",
      state: "connecting",
      revision: 4,
      attemptId: "00000000-0000-4000-8000-000000000002",
    };
    deps.invoke.mockResolvedValue(pending);
    const service = await import("../subscription-connection");
    await service.readSubscription("codex");
    const run = service.connectSubscription("codex");
    await vi.waitFor(() => expect(deps.invoke).toHaveBeenCalledTimes(2));
    emit({ ...pending, state: "connected", revision: 5 });
    expect(await run).toMatchObject({
      state: "connected",
      attemptId: pending.attemptId,
    });
  });

  it("cancels during preference persistence without opening a browser", async () => {
    deps.listen.mockResolvedValue(() => {});
    let flush!: () => void;
    deps.flush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          flush = resolve;
        }),
    );
    deps.invoke.mockResolvedValue({
      provider: "claude",
      state: "disconnected",
      revision: 1,
    });
    const service = await import("../subscription-connection");
    const run = service.connectSubscription("claude");
    await vi.waitFor(() => expect(deps.flush).toHaveBeenCalledOnce());
    const cancel = service.cancelSubscription("claude");
    flush();
    await cancel;
    expect((await run).error).toContain("canceled");
    expect(
      deps.invoke.mock.calls.some(([, args]) => args.action === "connect"),
    ).toBe(false);
  });
});
