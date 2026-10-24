import { describe, expect, it, vi } from "vitest";
import { commitMcpCredentials, replaceMcpServer } from "../mcp-configuration";
import { OAuthVault } from "../../agents/gateway/oauth-provider";
import { mcpCredentialKey } from "../../agents/gateway/credential-key";

describe("MCP edit identity", () => {
  const a = { name: "one", transport: "stdio", command: "one" };
  const b = { name: "two", transport: "stdio", command: "two" };
  it("edits the intended row after another row was inserted or removed", () => {
    expect(replaceMcpServer([b, a], a, { ...a, command: "updated" })).toEqual([b, { ...a, command: "updated" }]);
    expect(replaceMcpServer([a], a, { ...a, command: "updated" })).toEqual([{ ...a, command: "updated" }]);
  });
  it("refuses deleted or concurrently edited entries and same-name creates", () => {
    expect(() => replaceMcpServer([b], a, a)).toThrow(/changed/);
    expect(() => replaceMcpServer([{ ...a, enabled: false }], a, a)).toThrow(/changed/);
    expect(() => replaceMcpServer([a], null, a)).toThrow(/name/);
  });
  it("preserves unknown rows and fields and never mutates inputs", () => {
    const rows = ["future", { ...b, future_field: true }, a];
    expect(replaceMcpServer(rows, a, { ...a, command: "new" }).slice(0, 2)).toEqual(rows.slice(0, 2));
    expect(rows[2]).toBe(a);
  });
});

describe("MCP credential transaction", () => {
  const server = { name: "test", transport: "stdio" as const, command: "test", credential_id: "e94d93bb-9f44-4127-ac75-2d9fcbf52aac", env: { TOKEN: "${zeros.secret}" } };
  const key = mcpCredentialKey(server.credential_id, undefined, "/project");
  const oauth = { name: "oauth", transport: "http" as const, url: "https://example.test/mcp", auth: "oauth" as const, oauth_client_mode: "auto" as const, credential_id: server.credential_id };
  const oauthKey = mcpCredentialKey(oauth.credential_id, oauth.url, "/project");
  const writeResult = { path: "/settings", doc: {}, layer: "repo-local" as const, warnings: [] };
  it("retains a valid automatic sign-in when saving without a custom client secret", async () => {
    const vault = new OAuthVault();
    const tokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer" };
    vault.setTokens(oauthKey, tokens);
    await commitMcpCredentials(vault, oauth, { oauthClientSecret: null }, "/project", () => writeResult, oauth);
    expect(vault.getTokens(oauthKey)).toEqual(tokens);
  });
  it("serializes same-server token rotation with a pending encrypted settings save", async () => {
    const vault = new OAuthVault();
    vault.setTokens(oauthKey, { access_token: "old-fixture", token_type: "Bearer" });
    const events: string[] = [];
    let persisted!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { persisted = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const save = commitMcpCredentials(vault, oauth, {}, "/project", () => { events.push("write"); return writeResult; }, oauth,
      async () => { events.push("persist"); persisted(); await held; });
    await entered;
    const rotated = { access_token: "rotated-fixture", refresh_token: "rotated-refresh", token_type: "Bearer" };
    const refresh = vault.exclusive(oauthKey, async () => { events.push("refresh"); vault.setTokens(oauthKey, rotated); });
    // Let the already-enqueued refresh enter if the save failed to claim its
    // credential lock; then acknowledge the held encrypted write.
    await Promise.resolve();
    release();
    await Promise.all([save, refresh]);
    expect(events).toEqual(["persist", "write", "refresh"]);
    expect(vault.getTokens(oauthKey)).toEqual(rotated);
  });
  it("does not write settings or publish credentials when durable storage refuses the save", async () => {
    const vault = new OAuthVault();
    const write = vi.fn(() => ({ path: "/settings", doc: {}, layer: "user" as const, warnings: [] }));
    const persist = vi.fn(async () => { throw new Error("secure store unavailable"); });
    await expect(Promise.resolve().then(() => commitMcpCredentials(vault, server, { env: { TOKEN: "new-value" } }, "/project", write, null, persist))).rejects.toThrow(/secure store/);
    expect(write).not.toHaveBeenCalled();
    expect(vault.readEntry(key)).toBeUndefined();
  });
  it("restores the exact previous credentials when settings cannot be written", async () => {
    const vault = new OAuthVault();
    const saved = { env: { TOKEN: "old-value" }, headers: { Authorization: "old-header" } };
    vault.replaceEntry(key, saved);
    await expect(commitMcpCredentials(vault, server, { env: { TOKEN: "new-value" } }, "/project", () => { throw new Error("disk full"); }, server)).rejects.toThrow("disk full");
    expect(vault.readEntry(key)).toEqual(saved);
  });
  it("never changes another project or entry with the same variable name", async () => {
    const vault = new OAuthVault();
    const otherKey = mcpCredentialKey(server.credential_id, undefined, "/other");
    vault.replaceEntry(otherKey, { env: { TOKEN: "other-value" } });
    await expect(commitMcpCredentials(vault, server, {}, "/project", () => { throw new Error("must not write"); }, null)).rejects.toThrow(/Enter a value/);
    expect(vault.readEntry(otherKey)?.env?.TOKEN).toBe("other-value");
    expect(vault.readEntry(key)).toBeUndefined();
  });
});
