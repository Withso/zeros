import { describe, expect, it } from "vitest";

import { GITHUB_APP_PARKED_ACCOUNT, selectGithubAppConnection } from "../github-app-accounts";
import { GITHUB_APP_ACCOUNT } from "../github-credential-store";

function connection(owner: string | undefined, token: string) {
  return JSON.stringify({
    method: "github-app",
    accessToken: token,
    refreshToken: `refresh-${token}`,
    gitHost: "github.com",
    gitHttpUsername: "x-access-token",
    expiresAtMs: Date.now() + 3_600_000,
    ...(owner ? { ownerSub: owner } : {}),
  });
}

function memoryStore(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    update(accounts: readonly string[], update: (current: Record<string, string | null>) => Record<string, string | null>) {
      const next = update(Object.fromEntries(accounts.map((account) => [account, values.get(account) ?? null])));
      for (const account of accounts) {
        const value = next[account] ?? null;
        if (value === null) values.delete(account);
        else values.set(account, value);
      }
    },
    inUse: () => {
      const raw = values.get(GITHUB_APP_ACCOUNT);
      return raw ? (JSON.parse(raw) as { accessToken: string }).accessToken : null;
    },
  };
}

describe("per-account GitHub App connections", () => {
  it("parks the previous account's connection and brings each one back on switch", () => {
    const store = memoryStore({ [GITHUB_APP_ACCOUNT]: connection("account-a", "token-a") });
    expect(selectGithubAppConnection(store, "account-b")).toBe(true);
    expect(store.inUse()).toBeNull();

    // Account B connects GitHub; A's connection is still parked.
    store.values.set(GITHUB_APP_ACCOUNT, connection("account-b", "token-b"));
    expect(selectGithubAppConnection(store, "account-a")).toBe(true);
    expect(store.inUse()).toBe("token-a");
    expect(selectGithubAppConnection(store, "account-b")).toBe(true);
    expect(store.inUse()).toBe("token-b");
    expect(selectGithubAppConnection(store, "account-b")).toBe(false);
    expect(store.values.get(GITHUB_APP_PARKED_ACCOUNT)).toContain("token-a");
  });

  it("leaves a connection without a recorded owner, and does nothing when signed out", () => {
    const store = memoryStore({ [GITHUB_APP_ACCOUNT]: connection(undefined, "legacy") });
    expect(selectGithubAppConnection(store, "account-b")).toBe(false);
    expect(store.inUse()).toBe("legacy");
    expect(selectGithubAppConnection(memoryStore({ [GITHUB_APP_ACCOUNT]: connection("account-a", "token-a") }), null)).toBe(false);
  });
});
