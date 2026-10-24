import { describe, expect, it, vi } from "vitest";
import { OrganizationMcpRuntime, type McpWorkspaceIdentity } from "../organization-runtime";
import type { RuntimeMcpServer } from "@zeros/protocol/cloud-v2-relay";
import type { GatewayBackend } from "../../mcp-registry";

const one = "0fab8b12-b6da-4cc8-b7b5-316af03225a0", two = "bdf387ea-d119-40f4-bcf3-34ef29879038";
function setup(servers: RuntimeMcpServer[]) {
  let workspace: McpWorkspaceIdentity = { organizationId: one, placement: "local", repoRoot: "/repo", path: "/worktree" };
  let generation = 0;
  let backends: GatewayBackend[] = [];
  const host = {
    get generation() { return generation; },
    isCurrent: (epoch: number, account: string) => epoch === generation && account === "account",
    resolve: vi.fn(async () => ({ accountId: "account", servers })),
    authorize: vi.fn(async () => ({ accountId: "account", headers: { Authorization: "only-this-user" } })),
  };
  const removeGateway = vi.fn(async () => {});
  const runtime = new OrganizationMcpRuntime({ host, workspace: () => workspace,
    repository: async () => "example/repo", removeGateway,
    gateway: async (_key, values) => { backends = values; return "http://127.0.0.1:1234/mcp"; },
  });
  return { runtime, host, removeGateway, backends: () => backends,
    switchAccount: () => generation++, setWorkspace: (value: McpWorkspaceIdentity) => { workspace = value; } };
}
describe("organisation MCP admission on Local", () => {
  it("delivers only organisation definitions and opaque per-server env aliases", async () => {
    const { runtime, host } = setup([
      { id: one, name: "one", transport: "stdio", command: "node", env: { TOKEN: "first" } },
      { id: two, name: "two", transport: "stdio", command: "node", env: { TOKEN: "second" } },
    ]);
    const env: Record<string, string> = {};
    const servers = await runtime.resolve("workspace", env);
    expect(host.resolve).toHaveBeenCalledWith(expect.objectContaining({ organizationId: one, repository: "example/repo" }), expect.any(AbortSignal));
    expect(servers).toHaveLength(2);
    expect(JSON.stringify(servers)).not.toContain("first");
    expect(JSON.stringify(servers)).not.toContain("second");
    expect(Object.values(env).sort()).toEqual(["first", "second"]);
    expect(Object.keys(env)).toHaveLength(2);
    await runtime.reset();
  });
  it("never resolves cloud or Personal workspaces through Local org delivery", async () => {
    const fixture = setup([]);
    fixture.setWorkspace({ repoRoot: "/repo", path: "/repo", placement: "local" });
    await expect(fixture.runtime.resolve("workspace", {})).rejects.toThrow(/Local organisation/);
    fixture.setWorkspace({ organizationId: one, repoRoot: "/repo", path: "/repo", placement: "cloud" });
    await expect(fixture.runtime.resolve("workspace", {})).rejects.toThrow(/Local organisation/);
    expect(fixture.host.resolve).not.toHaveBeenCalled();
  });
  it("fetches authorization only on request and fences account changes", async () => {
    const fixture = setup([{ id: one, name: "remote", transport: "http", url: "https://example.test/mcp", auth: "oauth" }]);
    const servers = await fixture.runtime.resolve("workspace", {});
    expect(servers).toEqual([{ name: "zeros-gateway", transport: "http", url: "http://127.0.0.1:1234/mcp" }]);
    expect(fixture.host.authorize).not.toHaveBeenCalled();
    await expect(fixture.backends()[0]!.authorization!(false)).resolves.toEqual({ Authorization: "only-this-user" });
    fixture.switchAccount();
    await expect(fixture.backends()[0]!.authorization!(false)).rejects.toThrow(/account or workspace/);
    expect(fixture.host.authorize).toHaveBeenCalledTimes(1);
    await fixture.runtime.reset();
  });
  it("rejects a late credential after workspace reassignment", async () => {
    const fixture = setup([{ id: one, name: "remote", transport: "http", url: "https://example.test/mcp", auth: "header" }]);
    await fixture.runtime.resolve("workspace", {});
    let resolve!: (value: { accountId: string; headers: { Authorization: string } }) => void;
    fixture.host.authorize.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const pending = fixture.backends()[0]!.authorization!(false);
    fixture.setWorkspace({ organizationId: two, repoRoot: "/repo", path: "/worktree", placement: "local" });
    resolve({ accountId: "account", headers: { Authorization: "late" } });
    await expect(pending).rejects.toThrow(/account or workspace/);
    await fixture.runtime.reset();
    expect(fixture.removeGateway).toHaveBeenCalledWith("organization:workspace");
  });
});
