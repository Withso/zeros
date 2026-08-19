import { describe, expect, it } from "vitest";

import { shouldUseHeadlessMcpAuth } from "../mcp-auth-flow";

describe("MCP OAuth transport fallback", () => {
  it("switches only when browser authority is unavailable on the engine", () => {
    expect(
      shouldUseHeadlessMcpAuth({ code: "REMOTE_OP_NOT_ALLOWED" }),
    ).toBe(true);
    expect(
      shouldUseHeadlessMcpAuth({ code: "SETTINGS_REMOTE_KEY_DENIED" }),
    ).toBe(true);
    expect(shouldUseHeadlessMcpAuth({ code: "MCP_GATEWAY_DOWN" })).toBe(false);
    expect(shouldUseHeadlessMcpAuth(new Error("authorization denied"))).toBe(
      false,
    );
  });
});
