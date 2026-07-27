import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanNativeMcpConfigs } from "../mcp-scan";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "zeros-mcp-scan-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const p = path.join(home, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const bySource = (out: ReturnType<typeof scanNativeMcpConfigs>, source: string) =>
  out.find((s) => s.source === source)!;

describe("scanNativeMcpConfigs", () => {
  it("returns an entry per known home source; all absent when home is empty", () => {
    const out = scanNativeMcpConfigs(home);
    expect(out.map((s) => s.source).sort()).toEqual([
      "claude",
      "claude-desktop",
      "codex",
      "cursor",
      "factory",
    ]);
    expect(out.every((s) => !s.exists && s.servers.length === 0)).toBe(true);
  });

  it("scans per-repo .cursor/mcp.json + .mcp.json for given repo roots (only existing ones)", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "zeros-mcp-repo-"));
    mkdirSync(path.join(repo, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(repo, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { proj: { command: "p-cmd" } } }),
    );
    try {
      const out = scanNativeMcpConfigs(home, [repo]);
      const cursorProj = out.find((s) => s.source === `cursor-project:${repo}`)!;
      expect(cursorProj.exists).toBe(true);
      expect(cursorProj.servers).toEqual([{ name: "proj", transport: "stdio", command: "p-cmd" }]);
      // .mcp.json wasn't created → not surfaced
      expect(out.some((s) => s.source === `project:${repo}`)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("parses Cursor mcp.json (stdio + http)", () => {
    write(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          fabric: { url: "https://mcp.api.fabric.so/mcp" },
          fs: { command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/tmp" } },
        },
      }),
    );
    const cursor = bySource(scanNativeMcpConfigs(home), "cursor");
    expect(cursor.exists).toBe(true);
    expect(cursor.servers).toEqual([
      { name: "fabric", transport: "http", url: "https://mcp.api.fabric.so/mcp" },
      { name: "fs", transport: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/tmp" } },
    ]);
  });

  it("parses Codex config.toml (stdio with env, http with http_headers)", () => {
    write(
      ".codex/config.toml",
      [
        "[mcp_servers.ctx7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        "[mcp_servers.ctx7.env]",
        'LOG = "debug"',
        "",
        "[mcp_servers.tracker]",
        'url = "https://mcp.tracker.example/mcp"',
        "[mcp_servers.tracker.http_headers]",
        'Authorization = "Bearer x"',
        "",
      ].join("\n"),
    );
    const codex = bySource(scanNativeMcpConfigs(home), "codex");
    expect(codex.servers).toEqual([
      { name: "ctx7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { LOG: "debug" } },
      { name: "tracker", transport: "http", url: "https://mcp.tracker.example/mcp", headers: { Authorization: "Bearer x" } },
    ]);
  });

  it("parses Claude ~/.claude.json and Factory ~/.factory/mcp.json (mcpServers map)", () => {
    write(".claude.json", JSON.stringify({ mcpServers: { a: { command: "a-cmd" } }, projects: {} }));
    write(".factory/mcp.json", JSON.stringify({ mcpServers: { "Fabric-MCP": { url: "https://mcp.api.fabric.so/mcp" } } }));
    const out = scanNativeMcpConfigs(home);
    expect(bySource(out, "claude").servers).toEqual([{ name: "a", transport: "stdio", command: "a-cmd" }]);
    expect(bySource(out, "factory").servers).toEqual([
      { name: "Fabric-MCP", transport: "http", url: "https://mcp.api.fabric.so/mcp" },
    ]);
  });

  it("surfaces Claude Code project-scoped servers (projects['<path>'].mcpServers), top-level wins", () => {
    write(
      ".claude.json",
      JSON.stringify({
        mcpServers: { top: { command: "top-cmd" } },
        projects: {
          "/Users/x/repoA": { mcpServers: { local: { url: "https://local/mcp" }, top: { command: "shadowed" } } },
          "/Users/x/repoB": { mcpServers: { another: { command: "b-cmd" } } },
        },
      }),
    );
    const servers = bySource(scanNativeMcpConfigs(home), "claude").servers;
    expect(servers).toContainEqual({ name: "top", transport: "stdio", command: "top-cmd" });
    expect(servers).toContainEqual({ name: "local", transport: "http", url: "https://local/mcp" });
    expect(servers).toContainEqual({ name: "another", transport: "stdio", command: "b-cmd" });
    // top-level "top" wins over the project-scoped "shadowed" (dedup by name).
    expect(servers.filter((s) => s.name === "top")).toHaveLength(1);
    expect(servers.find((s) => s.name === "top")).toMatchObject({ command: "top-cmd" });
  });

  it("drops a server with neither command nor url; tolerates a missing mcpServers key", () => {
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: { bad: { foo: "bar" }, ok: { command: "x" } } }));
    write(".factory/mcp.json", JSON.stringify({ somethingElse: true }));
    const out = scanNativeMcpConfigs(home);
    expect(bySource(out, "cursor").servers).toEqual([{ name: "ok", transport: "stdio", command: "x" }]);
    expect(bySource(out, "factory").servers).toEqual([]);
  });

  it("warns (never throws) on malformed JSON / TOML", () => {
    write(".cursor/mcp.json", "{ not json");
    write(".codex/config.toml", "this is [not toml");
    const out = scanNativeMcpConfigs(home);
    expect(bySource(out, "cursor").exists).toBe(true);
    expect(bySource(out, "cursor").warning).toMatch(/parse/i);
    expect(bySource(out, "codex").warning).toMatch(/parse/i);
  });
});
