import { describe, expect, it } from "vitest";
import { mcpConnectionView } from "../mcp-connection-view";

describe("MCP connection recovery", () => {
  const http = { name: "tools", transport: "http", url: "https://example.test/mcp" };
  it("offers a next step even without a gateway status", () => {
    expect(mcpConnectionView(http)).toMatchObject({ label: "Needs connection", action: "check" });
    expect(mcpConnectionView({ ...http, auth: "oauth" })).toMatchObject({ action: "connect" });
    expect(mcpConnectionView(http, { status: "needs-auth", stages: [] })).toMatchObject({ label: "Sign-in required", action: "connect" });
  });
  it("does not tell disabled or on-demand process servers to sign in", () => {
    expect(mcpConnectionView({ ...http, enabled: false }, { status: "connected", stages: [] })).toMatchObject({ label: "Disabled" });
    expect(mcpConnectionView({ ...http, enabled: false }).action).toBeUndefined();
    expect(mcpConnectionView({ name: "process", transport: "stdio", command: "node" })).toMatchObject({ label: "Starts with agent" });
    expect(mcpConnectionView({ transport: "stdio" }).action).toBeUndefined();
  });
  it.each(["http", "sse"])("keeps rejected %s API keys out of the OAuth flow", transport => {
    expect(mcpConnectionView({ ...http, transport, auth: "header" }, { status: "needs-auth", stages: [] }))
      .toMatchObject({ label: "Check API key", action: "check", tone: "error" });
  });
  it("reports the failed stage and lets a fresh failed check supersede old authentication", () => {
    expect(mcpConnectionView({ ...http, auth: "oauth" }, { status: "failed", stages: [{ stage: "tools", status: "failed" }] }, "connected"))
      .toMatchObject({ label: "Connection failed", hint: "The server connected, but its tools could not be loaded. Try again.", action: "check" });
  });
  it("distinguishes zero tools from a missing inventory", () => {
    expect(mcpConnectionView(http, { status: "connected", stages: [], toolCount: 0 }).hint).toBe("0 tools available.");
    expect(mcpConnectionView(http, { status: "connected", stages: [], toolCount: 1 }).hint).toBe("1 tool available.");
  });
});
