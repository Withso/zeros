import { describe, expect, it, vi } from "vitest";
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
import { cloudClaudeTools } from "../cloud-tools";

describe("Claude native cloud tools", () => {
  it("keeps no-chrome and strict admitted MCP in the final cloud override",()=>{
    const options=cloudClaudeTools({lease:{assertLive:vi.fn()},productServers:[]} as unknown as CloudProviderExecution);
    expect(options.extraArgs).toEqual({"no-chrome":null,"thinking-display":"summarized"});
    expect(options.strictMcpConfig).toBe(true);
  });
  it("preserves engine instructions when adding the cloud native preset",()=>{
    const options=cloudClaudeTools({lease:{assertLive:vi.fn()},productServers:[]} as unknown as CloudProviderExecution,"Engine sentinel");
    expect(options.systemPrompt).toMatchObject({type:"preset",preset:"claude_code",append:"Engine sentinel"});
  });
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
