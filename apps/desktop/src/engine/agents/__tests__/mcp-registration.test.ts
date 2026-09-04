import { describe, expect, it } from "vitest";

import { materializeMcpServerRegistration } from "../mcp-registration";

describe("materializeMcpServerRegistration", () => {
  it("resolves engine-owned HTTP headers from the exact session environment", () => {
    expect(
      materializeMcpServerRegistration(
        {
          name: "draft_api",
          transport: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: { "X-Protocol": "1" },
          headersFromEnv: {
            Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY",
          },
        },
        { ZEROS_DESIGN_AGENT_CAPABILITY: "opaque-secret" },
      ),
    ).toEqual({
      name: "draft_api",
      transport: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: { Authorization: "opaque-secret", "X-Protocol": "1" },
    });
  });

  it("fails closed when a referenced secret is missing", () => {
    expect(() =>
      materializeMcpServerRegistration(
        {
          name: "draft_api",
          transport: "http",
          url: "http://127.0.0.1:43123/mcp",
          headersFromEnv: { Authorization: "MISSING_SECRET" },
        },
        {},
      ),
    ).toThrow(/missing its required session credential/i);
  });
});
