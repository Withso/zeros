import { describe, expect, it } from "vitest";
import { parseMcpConfiguration } from "../mcp-configuration-import";

describe("MCP configuration import", () => {
  it("imports JSON into editable values without dropping credentials", () => {
    const result = parseMcpConfiguration(JSON.stringify({ mcpServers: { docs: {
      url: "https://docs.example.test/mcp", headers: { Authorization: "fixture-key" },
    } } }));
    expect(result.error).toBeNull();
    expect(result.servers).toEqual([{ name: "docs", transport: "http", url: "https://docs.example.test/mcp", headers: { Authorization: "fixture-key" } }]);
  });
  it("imports Codex TOML commands, literal arguments, cwd and variables", () => {
    const result = parseMcpConfiguration('[mcp_servers.tools]\ncommand = "node"\nargs = ["  spaced  ", ""]\ncwd = "tools"\n[mcp_servers.tools.env]\nTOKEN = "fixture"');
    expect(result.error).toBeNull();
    expect(result.servers[0]).toMatchObject({ name: "tools", transport: "stdio", args: ["  spaced  ", ""], cwd: "tools", env: { TOKEN: "fixture" } });
  });
  it("accepts annotated Codex TOML and preserves HTTP variables used by headers", () => {
    const result = parseMcpConfiguration('# MCP configuration\nmodel = "example"\n[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n[mcp_servers.docs.env]\nREGION = "west"\n[mcp_servers.docs.http_headers]\nX-Region = "${REGION}"');
    expect(result.error).toBeNull();
    expect(result.servers).toEqual([{ name: "docs", transport: "http", url: "https://docs.example.test/mcp", env: { REGION: "west" }, headers: { "X-Region": "${REGION}" } }]);
  });
  it("retains HTTP variables from JSON configuration", () => {
    const result = parseMcpConfiguration(JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.test/mcp", env: { REGION: "west" }, headers: { "X-Region": "${REGION}" } } } }));
    expect(result.servers[0]?.env).toEqual({ REGION: "west" });
  });
  it("parses URLs and quoted command arguments without shell execution", () => {
    expect(parseMcpConfiguration("https://docs.example.test/mcp").servers[0]).toMatchObject({ transport: "http", url: "https://docs.example.test/mcp" });
    expect(parseMcpConfiguration("TOKEN='fixture value' npx -y package --label \"two words\" ''").servers[0]).toMatchObject({
      command: "npx", args: ["-y", "package", "--label", "two words", ""], env: { TOKEN: "fixture value" },
    });
  });
  it("rejects compound shell commands, expansions, malformed quotes and oversized input", () => {
    for (const text of ["npx one && npx two", "node one | node two", "node $(whoami)", "node `whoami`", 'node "unfinished', "node one\nnode two", "a".repeat(262145)]) {
      expect(parseMcpConfiguration(text).error).toBeTruthy();
    }
  });
  it("does not reinterpret legacy SSE or unknown explicit transports", () => {
    for (const type of ["sse", "websocket"]) {
      const result = parseMcpConfiguration(JSON.stringify({ mcpServers: { legacy: { type, url: "https://example.test/sse" } } }));
      expect(result.servers).toEqual([]);
      expect(result.error).toBeTruthy();
    }
  });
  it("keeps multiple candidates for explicit selection, without saving any", () => {
    const result = parseMcpConfiguration('{"mcpServers":{"one":{"command":"one"},"two":{"command":"two"}}}');
    expect(result.servers.map(server => server.name)).toEqual(["one", "two"]);
  });
  it("returns safe parse errors that never include pasted secrets", () => {
    for (const text of ['{"TOKEN":"private-test-value",', '[mcp_servers.x]\ntoken = "private-test-value']) {
      const result = parseMcpConfiguration(text);
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain("private-test-value");
    }
  });
  it("refuses environment references that cannot be resolved without the source machine", () => {
    const result = parseMcpConfiguration('[mcp_servers.remote]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "SOURCE_TOKEN"');
    expect(result.error).toMatch(/environment/i);
  });
});
