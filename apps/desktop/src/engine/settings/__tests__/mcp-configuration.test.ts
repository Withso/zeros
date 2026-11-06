import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitMcpCredentials, mcpDeleteInputSchema, mcpSaveInputSchema, opMcpDeleteServer, opMcpSaveServer, replaceMcpServer } from "../mcp-configuration";
import { opSettingsRead, opSettingsWrite } from "../ops";
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

describe("MCP edits of servers saved in settings.toml", () => {
  let directory: string;
  let vault: OAuthVault;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "zeros-mcp-edit-"));
    vi.stubEnv("ZEROS_USER_SETTINGS_DIR", directory);
    vault = new OAuthVault();
    writeFileSync(path.join(directory, "settings.toml"), [
      "[[mcp.servers]]", 'name = "remote"', 'transport = "http"', 'url = "https://fixture.invalid/mcp"', 'auth = "oauth"',
      'oauth_client_mode = "auto"', 'oauth_scopes = ["read"]', 'credential_id = "0b5f1c43-5a8e-4c43-9a55-61f1f0a0e7d2"', "",
      "[[mcp.servers]]", 'name = "files"', 'transport = "stdio"', 'command = "npx"', 'args = ["-y", "fixture-server"]',
      "reviewed_at = 2026-01-02T03:04:05Z", "[mcp.servers.env]", 'LOG_LEVEL = "info"', "",
    ].join("\n"));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
  // The editor holds the JSON copy that settings.read sent over the bridge.
  const read = () => (JSON.parse(JSON.stringify(opSettingsRead("user").doc)) as { mcp: { servers: Record<string, unknown>[] } }).mcp.servers;
  const commit = (server: Parameters<typeof commitMcpCredentials>[1], changes: Parameters<typeof commitMcpCredentials>[2], root: string | undefined, write: Parameters<typeof commitMcpCredentials>[4], previous: Record<string, unknown> | null) =>
    commitMcpCredentials(vault, server, changes, root, write, previous);
  const save = (previous: Record<string, unknown>, server: Record<string, unknown>) =>
    opMcpSaveServer(mcpSaveInputSchema.parse(JSON.parse(JSON.stringify({ layer: "user", previous, server }))), commit);

  it("saves an unchanged edit of every saved server", async () => {
    const before = read();
    for (const server of before) await save(server, server);
    expect(read()).toEqual(before);
  });

  it("toggles, changes tool policy and removes saved servers", async () => {
    const [remote, files] = read();
    await save(remote, { ...remote, disabled_tools: ["delete"] });
    await save(files, { ...files, enabled: false });
    const [tooled, disabled] = read();
    expect(tooled.disabled_tools).toEqual(["delete"]);
    expect(disabled.enabled).toBe(false);
    await opMcpDeleteServer(mcpDeleteInputSchema.parse(JSON.parse(JSON.stringify({ layer: "user", previous: disabled }))), commit);
    expect(read().map(row => row.name)).toEqual(["remote"]);
  });

  it("still refuses a server that changed in the file after it was read", async () => {
    const [remote, files] = read();
    opSettingsWrite("user", { mcp: { servers: [remote, { ...files, command: "other" }] } });
    await expect(save(files, { ...files, args: [] })).rejects.toThrow(/changed while you were editing/);
  });
});

describe("MCP adds and removes in settings.toml", () => {
  let directory: string;
  const file = () => path.join(directory, "settings.toml");
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "zeros-mcp-tidy-"));
    vi.stubEnv("ZEROS_USER_SETTINGS_DIR", directory);
    writeFileSync(file(), "# my settings\npreferences_version = 1\n");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
  const servers = () => (JSON.parse(JSON.stringify(opSettingsRead("user").doc)) as { mcp: { servers: Record<string, unknown>[] } }).mcp.servers;
  const add = (server: Record<string, unknown>) => opMcpSaveServer(mcpSaveInputSchema.parse({ layer: "user", previous: null, server }));
  const remove = (previous: Record<string, unknown>) => opMcpDeleteServer(mcpDeleteInputSchema.parse({ layer: "user", previous }));

  it("keeps settings.toml the same size across add and remove cycles", async () => {
    const sizes: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const name of ["one", "two", "three"]) await add({ name, transport: "http", url: `https://${name}.example.test/mcp` });
      for (const server of servers()) await remove(server);
      sizes.push(readFileSync(file(), "utf8").length);
    }
    const text = readFileSync(file(), "utf8");
    expect(text).toMatch(/^servers = \[\]$/m);
    expect(text).toContain("# my settings");
    expect(new Set(sizes).size).toBe(1);
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
