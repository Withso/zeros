import { describe, expect, it } from "vitest";

import {
  decodeCustomizeScope,
  encodeCustomizeScope,
  parseMcpJsonImport,
} from "../customize-model";

describe("customize scope encoding", () => {
  it("round-trips both scopes", () => {
    expect(encodeCustomizeScope({ kind: "user" })).toBe("user");
    expect(encodeCustomizeScope({ kind: "repo", projectId: "p1" })).toBe(
      "repo:p1",
    );
    const ids = new Set(["p1"]);
    expect(decodeCustomizeScope("user", ids)).toEqual({ kind: "user" });
    expect(decodeCustomizeScope("repo:p1", ids)).toEqual({
      kind: "repo",
      projectId: "p1",
    });
  });

  it("falls back to user for a removed/stale repo, garbage, or non-strings", () => {
    const ids = new Set(["p1"]);
    expect(decodeCustomizeScope("repo:gone", ids)).toEqual({ kind: "user" });
    expect(decodeCustomizeScope("repo:", ids)).toEqual({ kind: "user" });
    expect(decodeCustomizeScope("nonsense", ids)).toEqual({ kind: "user" });
    expect(decodeCustomizeScope(undefined, ids)).toEqual({ kind: "user" });
    expect(decodeCustomizeScope(42, ids)).toEqual({ kind: "user" });
  });
});

describe("parseMcpJsonImport", () => {
  it('parses the {"mcpServers": {...}} shape (Cursor/Claude docs)', () => {
    const r = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
          example: { url: "https://mcp.example.com/mcp" },
        },
      }),
    );
    expect(r.error).toBeNull();
    expect(r.servers).toEqual([
      {
        name: "context7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
      { name: "example", transport: "http", url: "https://mcp.example.com/mcp" },
    ]);
  });

  it("parses a bare name→config map and a single-server object", () => {
    const bare = parseMcpJsonImport(
      JSON.stringify({ gh: { command: "gh-mcp", env: { LOG: "debug" } } }),
    );
    expect(bare.servers).toEqual([
      { name: "gh", transport: "stdio", command: "gh-mcp", env: { LOG: "debug" } },
    ]);
    const single = parseMcpJsonImport(
      JSON.stringify({ name: "lin", url: "https://l/mcp", headers: { A: "b" } }),
    );
    expect(single.servers).toEqual([
      { name: "lin", transport: "http", url: "https://l/mcp", headers: { A: "b" } },
    ]);
  });

  it("a single-server object without a name still parses (the form keeps the typed name)", () => {
    const r = parseMcpJsonImport(JSON.stringify({ command: "npx", args: ["x"] }));
    expect(r.servers).toEqual([
      { name: "", transport: "stdio", command: "npx", args: ["x"] },
    ]);
  });

  it("parses serverUrl as the URL alias in a single-server object", () => {
    const r = parseMcpJsonImport(
      JSON.stringify({
        name: "remote",
        serverUrl: "https://remote.example/mcp",
      }),
    );
    expect(r.servers).toEqual([
      {
        name: "remote",
        transport: "http",
        url: "https://remote.example/mcp",
      },
    ]);
  });

  it("skips useless entries with a warning, never silently", () => {
    const r = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: { ok: { command: "npx" }, broken: { note: "no target" }, junk: 7 },
      }),
    );
    expect(r.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(r.warnings).toHaveLength(2);
    expect(r.error).toBeNull();
  });

  it("drops non-string args/env values instead of importing garbage", () => {
    const r = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: { x: { command: "npx", args: ["-y", 7], env: { A: "1", B: 2 } } },
      }),
    );
    expect(r.servers).toEqual([
      { name: "x", transport: "stdio", command: "npx", args: ["-y"], env: { A: "1" } },
    ]);
  });

  it("clear errors for non-JSON, non-objects, and empty objects", () => {
    expect(parseMcpJsonImport("not json").error).toBe("Not valid JSON.");
    expect(parseMcpJsonImport('"str"').error).toMatch(/JSON object/);
    expect(parseMcpJsonImport("{}").error).toMatch(/No servers found/);
  });
});
