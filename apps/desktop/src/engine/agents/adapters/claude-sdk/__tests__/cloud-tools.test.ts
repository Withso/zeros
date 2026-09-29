import { describe, expect, it, vi } from "vitest";
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
import { cloudClaudeTools } from "../cloud-tools";

describe("Claude native cloud tools", () => {
  it("retains the native preset and adds only admitted product capabilities", () => {
    const call = vi.fn();
    const options = cloudClaudeTools({ tools: { call }, lease: { assertLive: vi.fn() }, productServers: [
      { name: "design-draft", transport: "http", url: "http://127.0.0.1:8000/mcp", headers: { Authorization: "Bearer synthetic-product" } },
    ] } as unknown as CloudProviderExecution);
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(Object.keys(options.mcpServers!)).toEqual(["design-draft"]);
    expect(options).not.toHaveProperty("plugins");
    expect(options).not.toHaveProperty("hooks");
    expect(options).not.toHaveProperty("agents");
    expect(call).not.toHaveBeenCalled();
  });

  it("fails before offering native tools after authority is retired", () => {
    expect(() => cloudClaudeTools({ lease: { assertLive: () => { throw new Error("retired"); } }, productServers: [] } as unknown as CloudProviderExecution))
      .toThrow("retired");
  });
});
