import { afterEach, describe, expect, it } from "vitest";
import {
  providerCredential,
  seedProviderCredentials,
} from "../provider-credentials";
const empty = {
  claude: null,
  codex: null,
  cursor: null,
  cursorSubscription: null,
};
afterEach(() => seedProviderCredentials(empty));
describe("private provider credential projection", () => {
  it("selects subscription and pasted keys independently and fails closed on expiry", () => {
    seedProviderCredentials({
      ...empty,
      cursor: { apiKey: "manual" },
      cursorSubscription: { apiKey: "subscription", expiresAtMs: 2_000 },
    });
    expect(providerCredential("cursor", "subscription", 1_000)?.apiKey).toBe(
      "subscription",
    );
    expect(providerCredential("cursor", "api-key", 1_000)?.apiKey).toBe(
      "manual",
    );
    expect(providerCredential("cursor", "subscription", 2_000)).toBeNull();
    seedProviderCredentials(empty);
    expect(providerCredential("cursor", "api-key")).toBeNull();
  });
  it("validates the private message and only adopts Claude/Codex API keys in API-key mode", () => {
    expect(seedProviderCredentials({ bad: "payload" })).toBe(false);
    expect(
      seedProviderCredentials({ ...empty, codex: { apiKey: "test-key" } }),
    ).toBe(true);
    expect(providerCredential("codex", "cli")).toBeNull();
    expect(providerCredential("codex", "api-key")?.apiKey).toBe("test-key");
  });
});
