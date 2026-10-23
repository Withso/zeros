import { describe, expect, it } from "vitest";
import { mcpConnectionCache, mcpConnectionKey, rememberMcpConnection } from "../mcp-connection-status";
describe("saved MCP verification", () => {
  const server = { name: "example", transport: "http", url: "https://example.test/mcp" };
  it("never crosses an account, org, runtime or project key", () => {
    rememberMcpConnection("local:project-a", server, { status: "connected", stages: [], toolCount: 2 });
    for (const owner of ["local:project-b", "cloud:account-a:org-a", "cloud:account-b:org-a"]) {
      expect(mcpConnectionCache.getSnapshot(mcpConnectionKey(owner, server)).data).toBeUndefined();
    }
    expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("local:project-a", server)).data?.status).toBe("connected");
  });
  it("invalidates changed connection details but ignores JSON key order and enabled toggles", () => {
    const key = mcpConnectionKey("owner", server);
    expect(mcpConnectionKey("owner", { url: server.url, name: server.name, transport: server.transport, enabled: false })).toBe(key);
    expect(mcpConnectionKey("owner", { ...server, url: "https://changed.test/mcp" })).not.toBe(key);
    rememberMcpConnection("owner", server, { status: "connected", stages: [] });
    rememberMcpConnection("owner", server);
    expect(mcpConnectionCache.getSnapshot(key).data?.status).toBe("failed");
  });
  it("does not reuse a cloud verification after a shared secret revision or definition changes", () => {
    const identity = { id: "first-definition", revision: 1 };
    rememberMcpConnection("cloud-revisions", server, { status: "connected", stages: [] }, identity);
    expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("cloud-revisions", server, identity)).data?.status).toBe("connected");
    for (const changed of [{ ...identity, revision: 2 }, { ...identity, id: "second-definition" }]) {
      expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("cloud-revisions", server, changed)).data).toBeUndefined();
    }
  });
});
