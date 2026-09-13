import { describe, expect, it, vi } from "vitest";
import {
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizeCursorUsage,
  readSelectedProviderUsage,
} from "../provider-usage";
import type { ProviderAccountStore } from "../provider-account-store";

describe("provider usage projection", () => {
  it("retains zero usage, clamps exhaustion and normalizes resets", () => {
    expect(
      normalizeClaudeUsage({
        five_hour: { utilization: 0, resets_at: "2026-09-11T10:00:00Z" },
        seven_day: { utilization: 120, resets_at: null },
      }),
    ).toEqual({
      windows: [
        {
          id: "five-hour",
          usedPercent: 0,
          resetsAt: Date.parse("2026-09-11T10:00:00Z"),
        },
        { id: "weekly", usedPercent: 100 },
      ],
    });
  });
  it("does not invent windows when a plan omits them", () => {
    expect(
      normalizeClaudeUsage({ five_hour: null, seven_day: { utilization: "0" } })
        .windows,
    ).toEqual([]);
    expect(
      normalizeCodexUsage({
        primary: {
          usedPercent: 25,
          windowDurationMins: 10080,
          resetsAt: 1_800_000_000,
        },
        planType: "pro",
      }),
    ).toEqual({
      plan: "pro",
      windows: [{ id: "weekly", usedPercent: 25, resetsAt: 1_800_000_000_000 }],
    });
    expect(
      normalizeCodexUsage({
        primary: { usedPercent: 20, windowDurationMins: 60 },
      }).windows,
    ).toEqual([]);
  });
  it("keeps Cursor monthly pools separate and reads protobuf int64 dates", () => {
    expect(
      normalizeCursorUsage({
        billingCycleEnd: "1800000000000",
        planUsage: {
          autoSpend: 50,
          autoLimit: 200,
          apiSpend: 100,
          apiLimit: 200,
        },
      }).windows,
    ).toEqual([
      { id: "cursor", usedPercent: 25, resetsAt: 1_800_000_000_000 },
      { id: "third-party", usedPercent: 50, resetsAt: 1_800_000_000_000 },
    ]);
    expect(
      normalizeCursorUsage({ planUsage: { totalSpend: 10, limit: 100 } })
        .windows,
    ).toEqual([]);
    expect(
      normalizeCursorUsage({
        planUsage: { autoPercentUsed: 0, apiPercentUsed: 88 },
      }).windows,
    ).toEqual([
      { id: "cursor", usedPercent: 0 },
      { id: "third-party", usedPercent: 88 },
    ]);
  });
});

describe("selected account usage boundary", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const makeStore = (): ProviderAccountStore => ({
    version: 1,
    method: "account",
    activeId: id,
    accounts: [{ id, state: "connected", configDir: "/owned/account-a" }],
  });
  it("rejects a different CLI identity even though the saved store did not change", async () => {
    const store: ProviderAccountStore = {
      version: 1,
      method: "cli",
      initialized: true,
      accounts: [],
    };
    const identityA = JSON.stringify(["a@example.test", null]);
    const identityB = JSON.stringify(["b@example.test", null]);
    const request = {
      provider: "codex",
      action: "usage",
      method: "cli",
      identity: identityA,
    } as const;
    await expect(
      readSelectedProviderUsage(request, {
        readStore: () => store,
        readUsage: async () => ({ windows: [], identity: identityB }),
      }),
    ).rejects.toThrow("connection changed");
    await expect(
      readSelectedProviderUsage(request, {
        readStore: () => store,
        readUsage: async () => ({ windows: [], identity: identityA }),
      }),
    ).resolves.toMatchObject({ identity: identityA });
  });
  it("reads the selected isolated profile and rejects late cross-account results", async () => {
    let store = makeStore();
    let finish!: (value: { windows: [] }) => void;
    const readUsage = vi.fn(async (account) => {
      expect(account.configDir).toBe("/owned/account-a");
      return new Promise<{ windows: [] }>((resolve) => {
        finish = resolve;
      });
    });
    const pending = readSelectedProviderUsage(
      { provider: "claude", action: "usage", method: "account", accountId: id },
      { readStore: () => store, readUsage },
    );
    store = { ...store, activeId: undefined };
    finish({ windows: [] });
    await expect(pending).rejects.toThrow("connection changed");
  });
  it("rejects a renderer account/method mismatch without reading any credential", async () => {
    const readUsage = vi.fn();
    await expect(
      readSelectedProviderUsage(
        { provider: "codex", action: "usage", method: "cli" },
        { readStore: makeStore, readUsage },
      ),
    ).rejects.toThrow("connection changed");
    expect(readUsage).not.toHaveBeenCalled();
  });
  it("sanitizes provider failures and returns only normalized data", async () => {
    const request = {
      provider: "claude",
      action: "usage",
      method: "account",
      accountId: id,
    } as const;
    await expect(
      readSelectedProviderUsage(request, {
        readStore: makeStore,
        readUsage: async () => {
          throw new Error("secret fixture-token from /private/profile");
        },
      }),
    ).rejects.toThrow(/^Usage is unavailable right now\. Try refreshing\.$/);
    const result = await readSelectedProviderUsage(request, {
      readStore: makeStore,
      readUsage: async () => ({ windows: [] }),
    });
    expect(result).toMatchObject({
      provider: "claude",
      method: "account",
      accountId: id,
      windows: [],
    });
    expect(JSON.stringify(result)).not.toContain("configDir");
  });
});
