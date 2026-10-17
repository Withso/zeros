import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock("../secret-store", () => ({
  getSecret: (key: string) => secrets.get(key) ?? null,
  readSecretValues: (keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, secrets.get(key) ?? null])),
  hasSecret: (key: string) => secrets.has(key),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("../provider-profile-directory", () => ({
  providerProfileDirectory: (provider: string, id: string) =>
    `/profiles/${provider}/${id}`,
}));
import { readProviderCredentialsForEngine } from "../provider-credentials";

beforeEach(() => secrets.clear());

describe("native provider selection projection", () => {
  it("keeps Cursor API authentication available after an empty subscription probe", () => {
    secrets.set("cursor-api-key", "fixture-key");
    secrets.set(
      "provider-accounts-cursor",
      JSON.stringify({
        version: 1,
        initialized: true,
        method: "account",
        accounts: [],
      }),
    );
    expect(readProviderCredentialsForEngine()).toMatchObject({
      cursor: { apiKey: "fixture-key" },
      accountProfiles: { cursor: null },
    });
  });

  it.each(["claude", "codex", "cursor"] as const)(
    "projects an explicitly selected %s method even in a fresh checkout",
    (provider) => {
      secrets.set(
        `provider-accounts-${provider}`,
        JSON.stringify({
          version: 1,
          initialized: true,
          methodSelected: true,
          method: "apiKey",
          accounts: [],
        }),
      );
      expect(readProviderCredentialsForEngine()).toMatchObject({
        authMethods: { [provider]: "apiKey" },
      });
    },
  );

  it("keeps an explicitly selected disconnected account closed", () => {
    secrets.set("cursor-api-key", "fixture-key");
    secrets.set(
      "provider-accounts-cursor",
      JSON.stringify({
        version: 1,
        initialized: true,
        methodSelected: true,
        method: "account",
        accounts: [],
      }),
    );
    expect(
      readProviderCredentialsForEngine().accountProfiles?.cursor?.state,
    ).toBe("disconnected");
  });
});
