import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, storage } = vi.hoisted(() => ({
  invoke: vi.fn(),
  storage: new Map<string, unknown>(),
}));
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: invoke }));
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) => storage.get(key) ?? fallback,
  setSetting: (key: string, value: unknown) => {
    storage.set(key, structuredClone(value));
    return true;
  },
}));
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const identity = JSON.stringify(["user@example.test", null]);
const snapshot = (accountId = first) => ({
  provider: "claude",
  method: "account",
  accountId,
  identity,
  windows: [{ id: "weekly", usedPercent: 25, resetsAt: Date.now() + 60_000 }],
  fetchedAt: Date.now() - 60_000,
});
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  storage.clear();
});

describe("persisted provider usage", () => {
  it("never persists quota from a different CLI account under the requested identity", async () => {
    const usage = await import("../provider-usage");
    const key = usage.providerUsageKey("codex", "cli", undefined, 1, identity);
    invoke.mockResolvedValue({
      provider: "codex",
      method: "cli",
      windows: [],
      fetchedAt: Date.now(),
      identity: JSON.stringify(["other@example.test", null]),
    });
    await expect(usage.readProviderUsage(key)).rejects.toThrow(
      "different connection",
    );
    expect(storage.size).toBe(0);
    invoke.mockResolvedValue({
      provider: "codex",
      method: "cli",
      windows: [],
      fetchedAt: Date.now(),
      identity,
    });
    await usage.readProviderUsage(key, true);
    expect(invoke).toHaveBeenLastCalledWith("provider_subscription", {
      provider: "codex",
      action: "usage",
      method: "cli",
      identity,
    });
    vi.resetModules();
    const restarted = await import("../provider-usage");
    expect(restarted.providerUsageCache.getSnapshot(key).data).toMatchObject({
      identity,
    });
  });
  it("restores the same account on restart even when its transient auth revision changes", async () => {
    const usage = await import("../provider-usage");
    const data = snapshot();
    invoke.mockResolvedValue(data);
    await usage.readProviderUsage(
      usage.providerUsageKey("claude", "account", first, 9, identity),
    );
    vi.resetModules();
    const restarted = await import("../provider-usage");
    const key = restarted.providerUsageKey(
      "claude",
      "account",
      first,
      0,
      identity,
    );
    expect(restarted.providerUsageCache.getSnapshot(key)).toMatchObject({
      data,
      loading: false,
      updatedAt: data.fetchedAt,
    });
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey("claude", "account", second, 0, identity),
      ).data,
    ).toBeUndefined();
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey(
          "claude",
          "account",
          first,
          0,
          "different@example.test",
        ),
      ).data,
    ).toBeUndefined();
    expect(invoke).toHaveBeenCalledOnce();
    expect(restarted.PROVIDER_USAGE_MAX_AGE_MS).toBe(30 * 60_000);
  });

  it("keeps the saved snapshot after an offline refresh and prunes disconnected accounts", async () => {
    const usage = await import("../provider-usage");
    const key = usage.providerUsageKey("claude", "account", first, 1, identity);
    const data = snapshot();
    invoke.mockResolvedValue(data);
    await usage.providerUsageCache.load(key, () =>
      usage.readProviderUsage(key),
    );
    invoke.mockRejectedValue(new Error("offline"));
    await expect(
      usage.providerUsageCache.load(
        key,
        () => usage.readProviderUsage(key, true),
        { force: true },
      ),
    ).rejects.toThrow("offline");
    expect(usage.providerUsageCache.getSnapshot(key).data).toEqual(data);
    usage.pruneProviderUsageAccounts("claude", [second]);
    vi.resetModules();
    const restarted = await import("../provider-usage");
    expect(restarted.providerUsageCache.getSnapshot(key).data).toBeUndefined();
  });

  it("does not restore malformed, future-dated, expired, or mismatched entries", async () => {
    const usage = await import("../provider-usage");
    const key = usage.providerUsageKey("claude", "account", first, 1, identity);
    invoke.mockResolvedValue(snapshot());
    await usage.readProviderUsage(key);
    const stored = [...storage.entries()][0];
    expect(stored).toBeDefined();
    const [storageKey, entries] = stored as [
      string,
      { owner: string; data: ReturnType<typeof snapshot> }[],
    ];
    for (const data of [
      { ...snapshot(), windows: [{ id: "weekly", usedPercent: "bad" }] },
      { ...snapshot(), fetchedAt: Date.now() + 3_600_000 },
      { ...snapshot(), fetchedAt: 1 },
      snapshot(second),
    ]) {
      storage.set(storageKey, [{ ...entries[0], data }]);
      vi.resetModules();
      const restarted = await import("../provider-usage");
      expect(
        restarted.providerUsageCache.getSnapshot(key).data,
      ).toBeUndefined();
    }
  });

  it("bounds durable account snapshots and keeps the most recent ones", async () => {
    const usage = await import("../provider-usage");
    for (let index = 1; index <= 35; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      invoke.mockResolvedValue({ ...snapshot(id), fetchedAt: Date.now() });
      await usage.readProviderUsage(
        usage.providerUsageKey("claude", "account", id, index, identity),
      );
    }
    const entries = [...storage.values()][0] as unknown[];
    expect(entries).toHaveLength(32);
    vi.resetModules();
    const restarted = await import("../provider-usage");
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey("claude", "account", first, 0, identity),
      ).data,
    ).toBeUndefined();
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey(
          "claude",
          "account",
          "00000000-0000-4000-8000-000000000035",
          0,
          identity,
        ),
      ).data,
    ).toBeDefined();
  });

  it("rejects a pending result after its account has been removed", async () => {
    const usage = await import("../provider-usage");
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const key = usage.providerUsageKey("claude", "account", first, 1, identity);
    const pending = usage.readProviderUsage(key);
    usage.pruneProviderUsageAccounts("claude", []);
    finish(snapshot());
    await expect(pending).rejects.toThrow("disconnected");
    vi.resetModules();
    const restarted = await import("../provider-usage");
    expect(restarted.providerUsageCache.getSnapshot(key).data).toBeUndefined();
  });

  it("restores CLI usage only for its confirmed identity", async () => {
    const usage = await import("../provider-usage");
    const { accountId: _accountId, ...data } = snapshot();
    invoke.mockResolvedValue({ ...data, method: "cli" });
    await usage.readProviderUsage(
      usage.providerUsageKey("claude", "cli", undefined, 1, identity),
    );
    await expect(
      usage.readProviderUsage(
        usage.providerUsageKey("claude", "cli", undefined, 2, "[null,null]"),
      ),
    ).rejects.toThrow("different connection");
    vi.resetModules();
    const restarted = await import("../provider-usage");
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey("claude", "cli", undefined, 0, identity),
      ).data,
    ).toBeDefined();
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey(
          "claude",
          "cli",
          undefined,
          0,
          "[null,null]",
        ),
      ).data,
    ).toBeUndefined();
    expect(
      restarted.providerUsageCache.getSnapshot(
        restarted.providerUsageKey(
          "claude",
          "cli",
          undefined,
          0,
          "second@example.test",
        ),
      ).data,
    ).toBeUndefined();
  });

  it("discards legacy CLI snapshots whose quota identity was never verified", async () => {
    const usage = await import("../provider-usage");
    const key = usage.providerUsageKey("claude", "cli", undefined, 1, identity);
    const { accountId: _id, identity: _identity, ...data } = snapshot();
    storage.set("provider-usage-v1", [
      {
        owner: JSON.stringify(["claude", "cli", null, identity]),
        data: { ...data, method: "cli" },
      },
    ]);
    vi.resetModules();
    const restarted = await import("../provider-usage");
    expect(restarted.providerUsageCache.getSnapshot(key).data).toBeUndefined();
  });
});
