import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactDocForRemote, redactResolvedForRemote } from "../ops";
import type { RawSettingsDoc } from "../schema";

describe("redactDocForRemote — MCP secret masking for relay clients", () => {
  it("masks every value in an MCP server's headers and env", () => {
    const doc = {
      mcp: {
        servers: [
          {
            name: "tracker",
            transport: "http",
            url: "https://mcp.tracker.example/mcp",
            // auth:"none" → the gateway is bypassed, so this Authorization is the
            // ONLY credential and must never reach a paired remote in cleartext.
            headers: { Authorization: "Bearer sk-secret-123", "X-Org": "acme" },
          },
          {
            name: "ctx7",
            transport: "stdio",
            command: "npx",
            env: { API_KEY: "super-secret", DEBUG: "1" },
          },
        ],
      },
    } as unknown as RawSettingsDoc;

    const out = redactDocForRemote(doc) as unknown as {
      mcp: { servers: Array<{ headers?: Record<string, string>; env?: Record<string, string> }> };
    };
    expect(out.mcp.servers[0]!.headers).toEqual({
      Authorization: REDACTED_SENTINEL,
      "X-Org": REDACTED_SENTINEL,
    });
    expect(out.mcp.servers[1]!.env).toEqual({
      API_KEY: REDACTED_SENTINEL,
      DEBUG: REDACTED_SENTINEL,
    });
    // Names + coordinates stay visible (the UI still shows which server exists).
    expect(out.mcp.servers[0]!).toMatchObject({ name: "tracker", url: "https://mcp.tracker.example/mcp" });
  });

  it("does not mutate the input doc", () => {
    const doc = {
      mcp: { servers: [{ name: "x", transport: "http", url: "https://x", headers: { Authorization: "Bearer y" } }] },
    } as unknown as RawSettingsDoc;
    redactDocForRemote(doc);
    expect((doc as never as { mcp: { servers: Array<{ headers: Record<string, string> }> } }).mcp.servers[0]!.headers.Authorization).toBe(
      "Bearer y",
    );
  });

  it("redactResolvedForRemote masks the effective doc's MCP secrets too", () => {
    const resolved = {
      effective: {
        mcp: { servers: [{ name: "s", transport: "http", url: "https://s", headers: { Authorization: "Bearer z" } }] },
      },
      sources: {},
      warnings: [],
    } as never;
    const out = redactResolvedForRemote(resolved) as unknown as {
      effective: { mcp: { servers: Array<{ headers: Record<string, string> }> } };
    };
    expect(out.effective.mcp.servers[0]!.headers.Authorization).toBe(REDACTED_SENTINEL);
  });

  it("leaves a doc with no mcp table untouched", () => {
    const doc = { git: { remote: "origin" } } as unknown as RawSettingsDoc;
    expect(redactDocForRemote(doc)).toEqual(doc);
  });
});
