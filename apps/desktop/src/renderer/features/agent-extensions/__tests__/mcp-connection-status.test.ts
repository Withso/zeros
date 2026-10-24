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

  it("retains a confirmed tool catalog through failed exact-key refreshes but never through a different endpoint", () => {
    rememberMcpConnection("tools-owner", server, { status: "connected", stages: [], toolCount: 2, tools: ["read", "write"] });
    rememberMcpConnection("tools-owner", server, { status: "failed", stages: [] });
    expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("tools-owner", server)).data)
      .toMatchObject({ status: "failed", tools: ["read", "write"] });
    expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("tools-owner", { ...server, url: "https://other.test/mcp" })).data).toBeUndefined();
    rememberMcpConnection("tools-owner", server, { status: "connected", stages: [], toolCount: 0, tools: [] });
    expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("tools-owner", server)).data?.tools).toEqual([]);
    rememberMcpConnection("tools-owner", server);
    expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("tools-owner", server)).data?.tools).toBeUndefined();
  });

  it("keeps the connection identity when only tool permissions change", () => {
    expect(mcpConnectionKey("tools-policy", { ...server, disabled_tools: ["write"] })).toBe(mcpConnectionKey("tools-policy", server));
  });

  it("bounds retained catalog memory while preserving the active and newest snapshots", () => {
    mcpConnectionCache.clear();
    const activeKey = mcpConnectionKey("tools-active", server);
    const unsubscribe = mcpConnectionCache.subscribe(activeKey, () => {});
    const remember = (owner: string) => rememberMcpConnection(owner, server, { status: "connected", stages: [],
      tools: Array.from({ length: 1024 }, (_, index) => `${owner}_${index}_${"x".repeat(128)}`),
    });
    try {
      remember("tools-active");
      for (let index = 0; index < 24; index++) remember(`tools-budget-${index}`);
      expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("tools-budget-0", server)).data).toBeUndefined();
      expect(mcpConnectionCache.getSnapshot(activeKey).data?.tools).toHaveLength(1024);
      expect(mcpConnectionCache.getSnapshot(mcpConnectionKey("tools-budget-23", server)).data?.tools).toHaveLength(1024);
    } finally { unsubscribe(); mcpConnectionCache.clear(); }
  });
});
