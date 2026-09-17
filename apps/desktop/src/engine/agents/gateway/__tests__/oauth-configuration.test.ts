import { describe, expect, it } from "vitest";
import { OAuthVault, ZerosOAuthProvider } from "../oauth-provider";

const resourceUri = "https://mcp.example.test/mcp";
function provider(vault: OAuthVault, staticClientId?: string, scope?: string) {
  return new ZerosOAuthProvider({
    vault,
    resourceUri,
    staticClientId,
    scope,
    redirectUrl: "http://127.0.0.1:1234/callback",
    clientName: "Zeros",
    openBrowser() {},
  });
}

describe("MCP OAuth configuration ownership", () => {
  it("keeps a client secret in the vault, binds it to its client, and survives encrypted-store restore", () => {
    const vault = new OAuthVault();
    vault.setOAuthSecret(resourceUri, "client", "fixture-client-secret");
    const p = provider(vault, "client");
    expect(p.clientInformation()).toEqual({
      client_id: "client",
      client_secret: "fixture-client-secret",
    });
    expect(p.clientMetadata).not.toHaveProperty("client_secret");
    const restored = new OAuthVault();
    restored.restore(vault.snapshot());
    expect(
      provider(restored, "client").clientInformation()?.client_secret,
    ).toBe("fixture-client-secret");
    expect(provider(restored, "other").clientInformation()).not.toHaveProperty(
      "client_secret",
    );
    vault.setOAuthSecret(resourceUri, "client", "");
    expect(provider(vault, "client").clientInformation()).not.toHaveProperty(
      "client_secret",
    );
  });
  it("does not persist a late token after cancellation", () => {
    const vault = new OAuthVault();
    const p = provider(vault);
    p.cancel();
    expect(() =>
      p.saveTokens({ access_token: "late", token_type: "Bearer" }),
    ).toThrow(/cancel/i);
    expect(vault.getTokens(resourceUri)).toBeUndefined();
  });
  it("uses an explicit client instead of a prior dynamic registration and invalidates its tokens", () => {
    const vault = new OAuthVault();
    const old = provider(vault);
    old.saveClientInformation({
      client_id: "dynamic",
      redirect_uris: [old.redirectUrl],
    });
    old.saveTokens({ access_token: "old", token_type: "Bearer" });
    const next = provider(vault, "configured", "read");
    expect(next.clientInformation()?.client_id).toBe("configured");
    expect(next.tokens()).toBeUndefined();
    expect(() =>
      old.saveTokens({ access_token: "late", token_type: "Bearer" }),
    ).toThrow();
  });

  it("retains credentials for equivalent scopes across reconnect and vault restore", () => {
    const vault = new OAuthVault();
    provider(vault, "client", "write read").saveTokens({
      access_token: "saved",
      token_type: "Bearer",
    });
    const restored = new OAuthVault();
    restored.restore(vault.snapshot());
    expect(
      provider(restored, "client", "read write read").tokens()?.access_token,
    ).toBe("saved");
    expect(provider(restored, "client", "read").tokens()).toBeUndefined();
  });

  it("implements SDK invalidation for expired grants without losing a registered client", () => {
    const vault = new OAuthVault();
    const p = provider(vault, "client");
    p.saveTokens({
      access_token: "expired",
      refresh_token: "revoked",
      token_type: "Bearer",
    });
    p.invalidateCredentials("tokens");
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()?.client_id).toBe("client");
  });
});
