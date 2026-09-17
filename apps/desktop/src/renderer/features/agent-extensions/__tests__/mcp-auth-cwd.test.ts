import { describe, expect, it } from "vitest";
import { draftFromServer, serverFromDraft } from "../mcp-server-model";
import { parseMcpJsonImport } from "../customize-model";

describe("MCP settings configuration fidelity", () => {
  it("preserves and removes the optional local working directory", () => {
    const server = {
      name: "local",
      transport: "stdio",
      command: "node",
      cwd: "tools/mcp",
    };
    const draft = draftFromServer(server);
    expect(draft.cwd).toBe("tools/mcp");
    expect(serverFromDraft({ ...draft, cwd: "" }, server)).not.toHaveProperty(
      "cwd",
    );
  });
  it("imports native OAuth scopes and local cwd instead of silently dropping them", () => {
    const parsed = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "sse",
            url: "https://mcp.example.test/events",
            auth: { CLIENT_ID: "public", scopes: ["read", "write"] },
          },
          local: { command: "node", cwd: "tools/mcp" },
        },
      }),
    );
    expect(parsed.servers[0]).toMatchObject({
      auth: "oauth",
      oauth_client_id: "public",
      oauth_scopes: ["read", "write"],
    });
    expect(parsed.servers[1]).toHaveProperty("cwd", "tools/mcp");
  });
});
