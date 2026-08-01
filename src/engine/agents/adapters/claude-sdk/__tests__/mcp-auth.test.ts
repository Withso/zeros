import { describe, expect, it } from "vitest";

import { mcpServersForClaude } from "../adapter";

describe("Claude MCP bearer authentication", () => {
  it("uses Claude's env expansion in an authorization header", () => {
    const config = mcpServersForClaude([
      {
        name: "zeros-design",
        transport: "http",
        url: "http://127.0.0.1:41234/mcp?workspaceId=ws-design",
        headers: { "X-Trace": "safe" },
        bearerTokenEnvVar: "ZEROS_DESIGN_MCP_TOKEN",
      },
    ]);

    expect(config).toEqual({
      "zeros-design": {
        type: "http",
        url: "http://127.0.0.1:41234/mcp?workspaceId=ws-design",
        headers: {
          "X-Trace": "safe",
          Authorization: "Bearer ${ZEROS_DESIGN_MCP_TOKEN}",
        },
      },
    });
  });
});
