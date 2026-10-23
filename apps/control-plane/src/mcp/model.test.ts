import { describe, expect, it } from "vitest";
import { McpConfigSchema, mergeMcpSecrets, materializeMcp, selectMcpEntries, SECRET_REF, oauthBinding } from "./model.js";

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

  it("binds OAuth to resource, client strategy, scopes and client secret", () => {
    const config = McpConfigSchema.parse({ name: "a", transport: "http", auth: "oauth", url: "https://example.test/mcp", oauth_client_id: "client", oauth_scopes: ["b", "a"] });
    expect(oauthBinding(config, {})).toBe(oauthBinding({ ...config, oauth_scopes: ["a", "b", "a"] }, {}));
    expect(oauthBinding(config, {})).toBe(oauthBinding({ ...config, oauth_client_mode: "custom" }, {}));
    for (const next of [{ ...config, url: "https://example.test/other" }, { ...config, oauth_client_mode: "dynamic" as const }, { ...config, oauth_client_id: "other" }])
      expect(oauthBinding(config, {})).not.toBe(oauthBinding(next, {}));
    expect(oauthBinding(config, {})).not.toBe(oauthBinding(config, { oauthClientSecret: "secret" }));
  });
});
