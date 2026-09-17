import { describe, expect, it } from "vitest";
import { parseMcpJsonImport } from "../customize-model";
import {
  draftFromServer,
  serverFromDraft,
  transportOf,
  endpointSummary,
  draftError,
  newHeaderSecretFromDraft,
} from "../mcp-server-model";

describe("MCP SSE settings", () => {
  const server = {
    name: "reports",
    transport: "sse",
    url: "https://reports.example/sse",
  };

  it.each(["none", "header", "oauth"])(
    "edits SSE with %s authentication without losing fields",
    (auth) => {
      const saved = {
        ...server,
        auth,
        header_name: "Authorization",
        oauth_client_id: "public-client",
        disabled_tools: ["delete"],
        enabled: false,
      };
      const draft = draftFromServer(saved);
      expect(transportOf(saved)).toBe("sse");
      expect(endpointSummary(saved)).toBe(saved.url);
      expect(draft.transport).toBe("sse");
      expect(draft.auth).toBe(auth);
      expect(draftError(draft, new Set())).toBeNull();
      expect(serverFromDraft(draft, saved)).toMatchObject({
        ...server,
        disabled_tools: ["delete"],
        enabled: false,
      });
    },
  );

  it("stores a newly entered SSE header secret separately", () => {
    const draft = draftFromServer({
      ...server,
      auth: "header",
      header_name: "X-Api-Key",
    });
    draft.headerSecret = "test-only-key";
    expect(newHeaderSecretFromDraft(draft)).toEqual({
      url: server.url,
      headerName: "X-Api-Key",
      value: "test-only-key",
    });
    expect(JSON.stringify(serverFromDraft(draft, null))).not.toContain(
      "test-only-key",
    );
  });

  it("preserves explicit SSE imports and leaves untyped URLs as HTTP", () => {
    const result = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          reports: { type: "sse", url: server.url },
          ordinary: { url: server.url },
          invalid: { type: "websocket", url: server.url },
        },
      }),
    );
    expect(result.servers).toEqual([
      server,
      { name: "ordinary", transport: "http", url: server.url },
    ]);
    expect(result.warnings).toHaveLength(1);
  });
});
