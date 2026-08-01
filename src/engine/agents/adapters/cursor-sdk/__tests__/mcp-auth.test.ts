import { describe, expect, it } from "vitest";

import { mcpServersForCursor } from "../adapter";

describe("Cursor MCP bearer authentication", () => {
  it("resolves the authorization header in memory from the child environment", () => {
    const config = mcpServersForCursor(
      [
        {
          name: "zeros-design",
          transport: "http",
          url: "http://127.0.0.1:41234/mcp?workspaceId=ws-design",
          bearerTokenEnvVar: "ZEROS_DESIGN_MCP_TOKEN",
        },
      ],
      { ZEROS_DESIGN_MCP_TOKEN: "super-secret" },
    );

    expect(config).toEqual({
      "zeros-design": {
        url: "http://127.0.0.1:41234/mcp?workspaceId=ws-design",
        headers: { Authorization: "Bearer super-secret" },
      },
    });
  });
});
