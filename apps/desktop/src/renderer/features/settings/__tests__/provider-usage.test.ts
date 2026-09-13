import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: invoke }));
import {
  providerUsageCache,
  providerUsageKey,
  readProviderUsage,
  usageResetLabel,
} from "../provider-usage";

afterEach(() => {
  providerUsageCache.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("account-scoped usage cache", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const value = (accountId: string) => ({
    provider: "claude",
    method: "account",
    accountId,
    windows: [],
    fetchedAt: 1,
  });
  it("deduplicates exact-key reads and cannot paint account A under B", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const a = providerUsageKey("claude", "account", first, 1);
    const b = providerUsageKey("claude", "account", second, 2);
    const pending = providerUsageCache.load(a, () => readProviderUsage(a));
    const shared = providerUsageCache.load(a, () => readProviderUsage(a));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(providerUsageCache.getSnapshot(b).data).toBeUndefined();
    finish(value(first));
    await Promise.all([pending, shared]);
    expect(providerUsageCache.getSnapshot(a).data?.accountId).toBe(first);
    expect(providerUsageCache.getSnapshot(b).data).toBeUndefined();
    expect(providerUsageKey("claude", "account", first, 2)).not.toBe(a);
    expect(
      providerUsageKey("claude", "cli", undefined, 1, "a@example.test"),
    ).not.toBe(
      providerUsageKey("claude", "cli", undefined, 1, "b@example.test"),
    );
    expect(providerUsageKey("claude", "cli", first, 1)).toBe(
      providerUsageKey("claude", "cli", second, 1),
    );
  });
  it("rejects mismatched native identity and retains only the last exact-key snapshot on failure", async () => {
    const key = providerUsageKey("claude", "account", first, 1);
    invoke.mockResolvedValue(value(first));
    await providerUsageCache.load(key, () => readProviderUsage(key));
    invoke.mockResolvedValue(value(second));
    await expect(
      providerUsageCache.load(key, () => readProviderUsage(key), {
        force: true,
      }),
    ).rejects.toThrow("different connection");
    expect(providerUsageCache.getSnapshot(key).data?.accountId).toBe(first);
  });
  it("bounds a lost native response", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(() => new Promise(() => {}));
    const work = readProviderUsage(
      providerUsageKey("claude", "account", first, 99),
    );
    const result = expect(work).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25_001);
    await result;
  });
  it("backs off failed automatic reads while allowing an explicit refresh", async () => {
    vi.useFakeTimers();
    const key = providerUsageKey("claude", "account", first, 55);
    invoke.mockRejectedValue(new Error("Usage unavailable"));
    await expect(readProviderUsage(key)).rejects.toThrow("Usage unavailable");
    await expect(readProviderUsage(key)).rejects.toThrow("Usage unavailable");
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(readProviderUsage(key, true)).rejects.toThrow(
      "Usage unavailable",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    invoke.mockResolvedValue(value(first));
    await expect(readProviderUsage(key)).resolves.toMatchObject({
      accountId: first,
    });
  });

  it("formats reset times without asserting that a stale window already reset", () => {
    expect(usageResetLabel(3_600_000, 0)).toBe("Resets in 1h");
    expect(usageResetLabel(5 * 3_600_000, 0)).toBe("Resets in 5h");
    expect(usageResetLabel(25 * 3_600_000, 0)).toBe("Resets in 1d 1h");
    expect(usageResetLabel(10, 20)).toBe("Reset pending");
    expect(usageResetLabel(undefined)).toBe("Reset time unavailable");
  });
});
