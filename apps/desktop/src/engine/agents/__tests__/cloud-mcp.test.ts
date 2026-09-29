import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCloudRepositoryMcp } from "../cloud-mcp";
import { executionMcpServers, type CloudProviderExecution } from "../cloud-provider-execution";
import { cloudClaudeTools } from "../adapters/claude-sdk/cloud-tools";
import { cloudCursorRequest } from "../adapters/cursor-sdk/host/cloud-policy";
import { cloudCodexRequest } from "../adapters/codex/cloud-policy";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "cloud-mcp-")); roots.push(root); return root; }
const servers = [{ name: "repo-tool", transport: "stdio" as const, command: "node", args: ["tool.mjs"], env: { EXAMPLE: "test-only" } },
  { name: "remote-tool", transport: "http" as const, url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer test-only" } }];
const execution = () => ({ lease: { assertLive: vi.fn(), admission: { model: "model" } },
  coordinator: { environment: () => ({ CURSOR_API_KEY: "test-only" }) }, productServers: [{ name: "design-draft", transport: "http", url: "http://127.0.0.1:8000/mcp" }],
  userServers: structuredClone(servers) }) as unknown as CloudProviderExecution;

describe("cloud repository and admitted MCP", () => {
  it("composes product and admitted user servers without mutable registry replacement", () => {
    const context = execution();
    const result = executionMcpServers(context, [{ name: "injected", transport: "stdio", command: "false" }])!;
    expect(result.map(s => s.name)).toEqual(["design-draft", "repo-tool", "remote-tool"]);
    result[1]!.name = "changed";
    expect(executionMcpServers(context, [])![1]!.name).toBe("repo-tool");
  });
  it("Claude and Cursor receive the admitted stdio and authenticated remote snapshot", () => {
    const claude = cloudClaudeTools(execution());
    expect(claude.mcpServers).toMatchObject({ "repo-tool": { command: "node" }, "remote-tool": { headers: servers[1]!.headers }, "design-draft": {} });
    const cursor = cloudCursorRequest(execution(), "agent.create", { mcpServers: { injected: {} }, local: { settingSources: ["team"] } });
    expect(cursor).toMatchObject({ mcpServers: { "repo-tool": { command: "node" }, "remote-tool": { headers: servers[1]!.headers } }, local: { settingSources: [] } });
  });
  it("Codex cannot disable or replace admitted names through thread configuration", () => {
    const result = cloudCodexRequest(execution(), "env", "thread/start", { config: { "mcp_servers.repo-tool.enabled": false, mcp_servers: { "repo-tool": { enabled: false, command: "injected" } } } }) as { config: Record<string, unknown> };
    expect(result.config["mcp_servers.repo-tool.enabled"]).not.toBe(false);
    expect(result.config.mcp_servers).toMatchObject({ "repo-tool": { command: "node", enabled: true } });
  });
  it.runIf(process.platform === "linux")("reads only repository JSON and TOML with deterministic precedence", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".codex")); await mkdir(path.join(root, ".cursor"));
    await writeFile(path.join(root, ".codex/config.toml"), '[mcp_servers.codex]\ncommand="node"\nargs=["one.mjs"]\n');
    await writeFile(path.join(root, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "cursor" } } }));
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "repo" } } }));
    expect(await readCloudRepositoryMcp(root)).toMatchObject([{ name: "codex", command: "node" }, { name: "shared", command: "repo" }]);
  });
  it.runIf(process.platform === "linux")("rejects escaping symlinks, reserved product names, OAuth, and implicit environment imports", async () => {
    const root = await fixture(), outside = await fixture();
    await writeFile(path.join(outside, "config"), '{}'); await symlink(path.join(outside, "config"), path.join(root, ".mcp.json"));
    await expect(readCloudRepositoryMcp(root)).rejects.toThrow(/repository MCP/);
    await rm(path.join(root, ".mcp.json"));
    for (const config of [{ "design-draft": { command: "false" } }, { remote: { url: "https://example.test/mcp", oauth: {} } }, { secret: { command: "node", env: { TOKEN: "${env:HOME_TOKEN}" } } }]) {
      await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: config }));
      await expect(readCloudRepositoryMcp(root)).rejects.toThrow();
    }
  });
});
