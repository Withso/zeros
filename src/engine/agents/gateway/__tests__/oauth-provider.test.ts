import { describe, it, expect, vi } from "vitest";

import { OAuthVault, ZerosOAuthProvider } from "../oauth-provider";

const tokens = (over = {}) => ({ access_token: "at", token_type: "Bearer", ...over });

describe("OAuthVault", () => {
  it("stores tokens + client info keyed by resource URI, isolated per key", () => {
    const v = new OAuthVault();
    v.setTokens("https://a/mcp", tokens({ access_token: "a-tok" }));
    v.setTokens("https://b/mcp", tokens({ access_token: "b-tok" }));
    expect(v.getTokens("https://a/mcp")?.access_token).toBe("a-tok");
    expect(v.getTokens("https://b/mcp")?.access_token).toBe("b-tok");
    expect(v.getTokens("https://c/mcp")).toBeUndefined();
    expect(v.hasTokens("https://a/mcp")).toBe(true);
  });

  it("fires onChange on writes (for the durable-store hook) but not on reads", () => {
    const onChange = vi.fn();
    const v = new OAuthVault(onChange);
    v.getTokens("https://a/mcp");
    expect(onChange).not.toHaveBeenCalled();
    v.setTokens("https://a/mcp", tokens());
    v.setClient("https://a/mcp", { client_id: "c1", redirect_uris: ["http://127.0.0.1/cb"] });
    v.clear("https://a/mcp");
    expect(onChange).toHaveBeenCalledTimes(3);
    v.clear("https://gone/mcp"); // nothing deleted → no change
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("snapshot + restore round-trip (the safeStorage persistence path)", () => {
    const v = new OAuthVault();
    v.setTokens("https://a/mcp", tokens({ refresh_token: "r1" }));
    v.setClient("https://a/mcp", { client_id: "c1", redirect_uris: ["http://127.0.0.1/cb"] });
    const snap = v.snapshot();
    const v2 = new OAuthVault();
    v2.restore(snap);
    expect(v2.getTokens("https://a/mcp")?.refresh_token).toBe("r1");
    expect(v2.getClient("https://a/mcp")?.client_id).toBe("c1");
    v2.restore(null); // tolerates empty
    expect(v2.getTokens("https://a/mcp")).toBeUndefined();
  });
});

describe("ZerosOAuthProvider", () => {
  const make = (over: Partial<Parameters<typeof makeDeps>[0]> = {}) => {
    const vault = new OAuthVault();
    const openBrowser = vi.fn();
    const provider = new ZerosOAuthProvider(makeDeps({ vault, openBrowser, ...over }));
    return { vault, openBrowser, provider };
  };
  function makeDeps(o: {
    vault: OAuthVault;
    openBrowser: (u: string) => void;
    resourceUri?: string;
    redirectUrl?: string;
    scope?: string;
    staticClientId?: string;
  }) {
    return {
      vault: o.vault,
      resourceUri: o.resourceUri ?? "https://fabric/mcp",
      redirectUrl: o.redirectUrl ?? "http://127.0.0.1:24302/callback",
      clientName: "Zeros",
      openBrowser: o.openBrowser,
      scope: o.scope,
      staticClientId: o.staticClientId,
    };
  }

  it("clientMetadata is a public PKCE client with the loopback redirect", () => {
    const { provider } = make();
    const m = provider.clientMetadata;
    expect(m.redirect_uris).toEqual(["http://127.0.0.1:24302/callback"]);
    expect(m.token_endpoint_auth_method).toBe("none");
    expect(m.grant_types).toContain("authorization_code");
    expect(m.grant_types).toContain("refresh_token");
    expect("scope" in m).toBe(false); // omitted when not configured
    expect(make({ scope: "a b" }).provider.clientMetadata.scope).toBe("a b");
  });

  it("state() generates a fresh value + remembers it for CSRF validation", async () => {
    const { provider } = make();
    expect(provider.expectedState).toBeNull();
    const s1 = await provider.state();
    expect(s1.length).toBeGreaterThan(20);
    expect(provider.expectedState).toBe(s1);
    const s2 = await provider.state();
    expect(s2).not.toBe(s1);
  });

  it("tokens()/saveTokens delegate to the vault under the resource URI", () => {
    const { provider, vault } = make();
    expect(provider.tokens()).toBeUndefined();
    provider.saveTokens(tokens({ access_token: "fresh" }));
    expect(provider.tokens()?.access_token).toBe("fresh");
    expect(vault.getTokens("https://fabric/mcp")?.access_token).toBe("fresh"); // keyed by resource URI
  });

  it("clientInformation: vault registration > static client id > undefined", () => {
    const none = make();
    expect(none.provider.clientInformation()).toBeUndefined();

    const stat = make({ staticClientId: "preconfigured" });
    expect(stat.provider.clientInformation()).toEqual({ client_id: "preconfigured" });

    const reg = make();
    reg.provider.saveClientInformation({ client_id: "dcr-id", redirect_uris: ["http://127.0.0.1:24302/callback"] });
    expect(reg.provider.clientInformation()?.client_id).toBe("dcr-id"); // DCR result wins
  });

  it("invalidates a registration for an old callback port without losing tokens", () => {
    const migrated = make({
      redirectUrl: "http://127.0.0.1:24212/callback",
    });
    migrated.vault.setTokens(
      "https://fabric/mcp",
      tokens({ refresh_token: "keep-me" }),
    );
    migrated.vault.setClient("https://fabric/mcp", {
      client_id: "old-beta-registration",
      redirect_uris: ["http://127.0.0.1:24202/callback"],
    });

    // No static client: undefined asks the SDK to perform DCR again with the
    // provider's new clientMetadata.redirect_uris.
    expect(migrated.provider.clientInformation()).toBeUndefined();
    expect(migrated.vault.getClient("https://fabric/mcp")).toBeUndefined();
    expect(migrated.vault.getTokens("https://fabric/mcp")?.refresh_token).toBe(
      "keep-me",
    );
  });

  it("redirectToAuthorization opens the browser ONLY in interactive mode (no boot-spam)", () => {
    const { provider, openBrowser } = make();
    const url = new URL("https://auth.example.com/authorize?x=1");
    provider.redirectToAuthorization(url); // passive (boot): no-op
    expect(openBrowser).not.toHaveBeenCalled();
    provider.setInteractive(true);
    provider.redirectToAuthorization(url); // user clicked Sign in
    expect(openBrowser).toHaveBeenCalledWith("https://auth.example.com/authorize?x=1");
  });

  it("codeVerifier throws before one is saved, returns it after", () => {
    const { provider } = make();
    expect(() => provider.codeVerifier()).toThrow(/verifier/i);
    provider.saveCodeVerifier("v-123");
    expect(provider.codeVerifier()).toBe("v-123");
  });

  it("saveTokens persists the WHOLE tokens object so a rotated refresh_token wins (§9)", () => {
    const { provider, vault } = make();
    provider.saveTokens(tokens({ access_token: "a1", refresh_token: "r1" }));
    provider.saveTokens(tokens({ access_token: "a2", refresh_token: "r2" }));
    // not merge-preserved — the AS-rotated refresh token replaces the old one
    expect(vault.getTokens("https://fabric/mcp")?.refresh_token).toBe("r2");
    expect(vault.getTokens("https://fabric/mcp")?.access_token).toBe("a2");
  });

  it("saveDiscoveryState enforces issuer binding (mix-up guard, §10)", () => {
    const { provider } = make();
    // A conformant AS advertises S256 (PKCE) AND a matching issuer → accepted.
    expect(() =>
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          code_challenge_methods_supported: ["S256"],
        },
      } as never),
    ).not.toThrow();
    expect(() =>
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://evil.example.com",
          code_challenge_methods_supported: ["S256"],
        },
      } as never),
    ).toThrow(/issuer/i);
    // No metadata at all → nothing to validate (the SDK handles it downstream).
    expect(() =>
      provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.com" } as never),
    ).not.toThrow();
  });

  it("saveDiscoveryState refuses a PKCE downgrade (no S256 advertised)", () => {
    const { provider } = make();
    // Metadata present but omitting code_challenge_methods_supported → refuse.
    expect(() =>
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: { issuer: "https://auth.example.com" },
      } as never),
    ).toThrow(/PKCE|S256/i);
    // Advertised methods that exclude S256 → refuse.
    expect(() =>
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          code_challenge_methods_supported: ["plain"],
        },
      } as never),
    ).toThrow(/PKCE|S256/i);
  });
});
