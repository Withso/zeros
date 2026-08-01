import { describe, expect, it } from "vitest";
import { buildMcpServerOverrides } from "../app-server";
import type { McpServerRegistration } from "../../../types";

describe("buildMcpServerOverrides — Codex -c MCP config", () => {
  it("emits url + http_headers for an http server (no `type` field)", () => {
    const args = buildMcpServerOverrides([
      { name: "tracker", transport: "http", url: "https://mcp.tracker.example/mcp", headers: { "X-Org": "acme" } },
    ]);
    expect(args).toEqual([
      "-c",
      'mcp_servers.tracker.url="https://mcp.tracker.example/mcp"',
      "-c",
      'mcp_servers.tracker.http_headers={ "X-Org" = "acme" }',
    ]);
    expect(args.join(" ")).not.toContain(".type=");
  });

  it("emits command/args/env for a stdio server", () => {
    const args = buildMcpServerOverrides([
      { name: "ctx7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { DEBUG: "1" } },
    ]);
    expect(args).toContain('mcp_servers.ctx7.command="npx"');
    expect(args).toContain('mcp_servers.ctx7.args=["-y", "@upstash/context7-mcp"]');
    expect(args).toContain('mcp_servers.ctx7.env={ "DEBUG" = "1" }');
  });

  it("skips a server whose name isn't TOML-key-safe (no injection)", () => {
    expect(buildMcpServerOverrides([{ name: "a.b evil", transport: "http", url: "https://x" } as McpServerRegistration])).toEqual([]);
  });

  it("escapes control characters in values → valid TOML (no raw CR/NUL breaking the parse)", () => {
    const args = buildMcpServerOverrides([
      { name: "x", transport: "http", url: "https://x", headers: { K: "a\r\nb\tc\x00d\x08e" } },
    ]);
    const joined = args.join(" ");
    // No raw control characters survive into the emitted -c string.
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\r]/.test(joined)).toBe(false);
    expect(joined).toContain("\\r");
    expect(joined).toContain("\\n");
    expect(joined).toContain("\\t");
    expect(joined).toContain("\\u0000");
    expect(joined).toContain("\\b");
  });

  it("escapes quotes + backslashes in a value", () => {
    const args = buildMcpServerOverrides([
      { name: "x", transport: "http", url: 'https://x/?q="a"\\b' },
    ]);
    expect(args.join(" ")).toContain('\\"a\\"\\\\b');
  });
});
