import { describe, expect, it } from "vitest";
import { McpOAuthProvider, clientMetadataDocument } from "./oauth-provider.js";

describe("organization MCP OAuth provider", () => {
  const config = { name: "tool", transport: "http" as const, url: "https://example.test/mcp", auth: "oauth" as const };
  const options = { config, callback: "https://api.example.test/mcp/oauth/callback", identity: "https://api.example.test/.well-known/mcp-client.json", state: "csrf-fixture" };
  it("publishes validated desktop loopback callbacks and rejects URL rewriting", () => {
    const document = clientMetadataDocument("https://api.example.test", "http://127.0.0.1:4000/callback");
    expect(document.redirect_uris).toEqual(["http://127.0.0.1:4000/callback"]);
    expect(document.client_id).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A4000%2Fcallback");
    for (const redirect of ["http://localhost:4000/callback", "http://127.example.test:4/callback", "http://127.0.0.1:4000/callback?x=1", "https://elsewhere.test/callback", "http://user@127.0.0.1:4000/callback"])
      expect(() => clientMetadataDocument("https://api.example.test", redirect)).toThrow();
  });
  it("uses metadata for auto, forces dynamic registration, and supplies an own secret without putting it in metadata", () => {
    expect(new McpOAuthProvider(options).clientMetadataUrl).toBe(options.identity);
    expect(new McpOAuthProvider({ ...options, config: { ...config, oauth_client_mode: "dynamic" } }).clientMetadataUrl).toBeUndefined();
    const custom = new McpOAuthProvider({ ...options, config: { ...config, oauth_client_mode: "custom", oauth_client_id: "registered" }, clientSecret: "fixture-secret" });
    expect(custom.clientInformation()).toMatchObject({ client_id: "registered", client_secret: "fixture-secret" });
    expect(JSON.stringify(custom.clientMetadata)).not.toContain("fixture-secret");
  });
  it("requires issuer equality and PKCE S256 before code or refresh delivery", () => {
    const provider = new McpOAuthProvider(options);
    for (const authorizationServerMetadata of [{ issuer: "https://other.test", code_challenge_methods_supported: ["S256"] }, { issuer: "https://issuer.test", code_challenge_methods_supported: ["plain"] }])
      expect(() => provider.saveDiscoveryState({ authorizationServerUrl: "https://issuer.test", authorizationServerMetadata } as never)).toThrow();
    provider.saveDiscoveryState({ authorizationServerUrl: "https://issuer.test", authorizationServerMetadata: { issuer: "https://issuer.test", code_challenge_methods_supported: ["S256"] } } as never);
    expect(provider.discoveryState()?.authorizationServerUrl).toBe("https://issuer.test");
  });

  it("never reuses a published client identity in explicit dynamic or custom mode", () => {
    const material = { client: { client_id: options.identity }, tokens: { access_token: "old-fixture-token", token_type: "Bearer" } };
    const dynamic = new McpOAuthProvider({ ...options, config: { ...config, oauth_client_mode: "dynamic" }, material });
    expect(dynamic.clientInformation()).toBeUndefined();
    expect(dynamic.tokens()).toBeUndefined();
    const custom = new McpOAuthProvider({ ...options, config: { ...config, oauth_client_mode: "custom", oauth_client_id: "own-client" }, material });
    expect(custom.clientInformation()?.client_id).toBe("own-client");
    expect(custom.tokens()).toBeUndefined();
    dynamic.saveClientInformation({ client_id: "registered-dynamically" });
    expect(new McpOAuthProvider({ ...options, config: { ...config, oauth_client_mode: "dynamic" }, material: dynamic.material }).clientInformation()?.client_id).toBe("registered-dynamically");
  });
});
