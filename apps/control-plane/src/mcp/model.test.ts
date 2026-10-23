import { describe, expect, it } from "vitest";
import { McpConfigSchema, mergeMcpSecrets, materializeMcp, selectMcpEntries, SECRET_REF, newOAuthBinding, sameOAuthIdentity } from "./model.js";

describe("organization MCP configuration", () => {
  it("seals every new variable/header and retains only explicit same-row references", () => {
    const config = McpConfigSchema.parse({ name: "tool", transport: "http", url: "https://tools.example.test/mcp", auth: "header",
      env: { KEY: "fixture-value" }, headers: { Authorization: "Bearer fixture-token", "X-Context": "fixture-context" } });
    const saved = mergeMcpSecrets(config, {}, {});
    expect(JSON.stringify(saved.config)).not.toContain("fixture-");
    expect(saved.config.headers).toEqual({ Authorization: SECRET_REF, "X-Context": SECRET_REF });
    expect(materializeMcp(saved.config, saved.secrets)).toMatchObject({ headers: config.headers });
    expect(mergeMcpSecrets(saved.config, {}, saved.secrets).secrets).toEqual(saved.secrets);
    expect(() => mergeMcpSecrets(saved.config, { headers: { Authorization: null } }, saved.secrets)).toThrow();
    expect(() => mergeMcpSecrets(saved.config, {}, {})).toThrow();
  });

  it("requires loopback HTTP for a launched endpoint, preserving legacy SSE", () => {
    for (const listen_url of ["http://127.0.0.1:8123/mcp", "http://localhost:8123/mcp", "http://[::1]:8123/mcp"])
      expect(McpConfigSchema.safeParse({ name: "local", transport: "stdio", command: "server", listen_url }).success).toBe(true);
    for (const listen_url of ["https://example.test/mcp", "http://127.example.test:8/mcp", "http://169.254.169.254/mcp", "http://user@127.0.0.1:8/mcp"])
      expect(McpConfigSchema.safeParse({ name: "local", transport: "stdio", command: "server", listen_url }).success).toBe(false);
    expect(McpConfigSchema.safeParse({ name: "old", transport: "sse", url: "https://example.test/sse" }).success).toBe(true);
  });

  it("uses private/project precedence and disabled shadows without leaking another repository", () => {
    const base = { id: "id", ownerUserId: null, repository: null, config: { name: "tool", transport: "stdio" as const, command: "shared" } };
    const selected = selectMcpEntries([
      base,
      { ...base, id: "project", repository: "org/one", config: { ...base.config, command: "project" } },
      { ...base, id: "private", ownerUserId: "me", config: { ...base.config, command: "mine" } },
      { ...base, id: "foreign", ownerUserId: "other", config: { ...base.config, name: "other" } },
      { ...base, id: "foreign-repo", repository: "org/two", config: { ...base.config, name: "other-repo" } },
    ], "me", "org/one");
    expect(selected.map(row => row.id)).toEqual(["private"]);
    expect(selectMcpEntries([base, { ...base, id: "disabled", ownerUserId: "me", config: { ...base.config, enabled: false } }], "me", "org/one")).toEqual([]);
  });

  it("compares the complete canonical OAuth identity without treating tool policy or names as credentials", () => {
    const config = McpConfigSchema.parse({ name: "a", transport: "http", auth: "oauth", url: "https://example.test/mcp",
      oauth_client_id: "https://client.example.test/metadata.json", oauth_scopes: ["b", "a"] });
    const identity = { config, secrets: { oauthClientSecret: "fixture-secret" } };
    for (const next of [{ ...config, oauth_scopes: ["a", "b", "a"] }, { ...config, oauth_client_mode: "custom" },
      { ...config, name: "renamed", enabled: false, credential_id: "different", disabled_tools: ["hidden"], env: { KEY: SECRET_REF }, headers: { "X-Context": SECRET_REF } }])
      expect(sameOAuthIdentity(identity, { config: McpConfigSchema.parse(next), secrets: { ...identity.secrets, env: { KEY: "fixture-env" }, headers: { "X-Context": "fixture-header" } } })).toBe(true);
    for (const next of [{ ...config, url: "https://example.test/other" }, { ...config, transport: "sse" }, { ...config, auth: "none" },
      ...["auto", "metadata", "dynamic"].map(oauth_client_mode => ({ ...config, oauth_client_mode })),
      { ...config, oauth_client_id: "other" }, { ...config, oauth_scopes: ["write"] }, { name: "a", transport: "stdio", command: "server" }])
      expect(sameOAuthIdentity(identity, { config: McpConfigSchema.parse(next), secrets: identity.secrets })).toBe(false);
    for (const oauthClientSecret of ["fixture-secreu", "short", "", undefined])
      expect(sameOAuthIdentity(identity, { config, secrets: { oauthClientSecret } })).toBe(false);
  });

  it("creates independent 32-byte opaque markers without identity or server-key input", () => {
    const bindings = Array.from({ length: 16 }, () => newOAuthBinding());
    for (const binding of bindings) expect(binding).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it("preserves normalized defaults and absent-secret identity semantics", () => {
    const config = McpConfigSchema.parse({ name: "a", transport: "http", url: "https://example.test/mcp" });
    expect(sameOAuthIdentity({ config, secrets: {} }, { config: McpConfigSchema.parse({ ...config, auth: "none", oauth_client_mode: "auto", oauth_scopes: [] }),
      secrets: { oauthClientSecret: "" } })).toBe(true);
    const oauth = McpConfigSchema.parse({ ...config, auth: "oauth" });
    expect(sameOAuthIdentity({ config: oauth, secrets: {} }, { config: McpConfigSchema.parse({ ...oauth, oauth_client_mode: "auto", oauth_scopes: [] }), secrets: {} })).toBe(true);
    expect(sameOAuthIdentity({ config, secrets: {} }, { config: oauth, secrets: {} })).toBe(false);
  });
});
