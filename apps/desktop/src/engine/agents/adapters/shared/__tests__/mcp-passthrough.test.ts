import { describe, expect, it } from "vitest";
import { nativeMcpPassthroughEnabled } from "../mcp-passthrough";

describe("native extension loading", () => {
  it("uses provider-native loading by default without requiring a diagnostic flag", () => {
    expect(nativeMcpPassthroughEnabled({})).toBe(true);
  });

  it("retains the explicit legacy opt-out without treating it as an enable override", () => {
    expect(
      nativeMcpPassthroughEnabled({ ZEROS_NATIVE_MCP_PASSTHROUGH: "0" }),
    ).toBe(false);
    expect(
      nativeMcpPassthroughEnabled({ ZEROS_NATIVE_MCP_PASSTHROUGH: "1" }),
    ).toBe(true);
  });

  it("does not widen a Design actor's scoped tool grant", () => {
    expect(
      nativeMcpPassthroughEnabled({}, { status: { actor: "design-agent" } }),
    ).toBe(false);
    expect(
      nativeMcpPassthroughEnabled(
        { ZEROS_NATIVE_MCP_PASSTHROUGH: "1" },
        { status: { actor: "design-agent" } },
      ),
    ).toBe(false);
  });

  it("retains scoped loading for legacy boundaries without a Code ownership snapshot", () => {
    expect(nativeMcpPassthroughEnabled({}, {})).toBe(false);
    expect(
      nativeMcpPassthroughEnabled({}, { status: { actor: "agent-code" } }),
    ).toBe(true);
  });
});
