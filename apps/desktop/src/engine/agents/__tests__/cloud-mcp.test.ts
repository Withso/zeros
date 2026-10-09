import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCloudRepositoryMcp, type CloudRepositoryMcpNotice } from "../cloud-mcp";
import { executionMcpServers, type CloudProviderExecution } from "../cloud-provider-execution";
import { cloudClaudeTools } from "../adapters/claude-sdk/cloud-tools";
import { cloudCursorRequest } from "../adapters/cursor-sdk/host/cloud-policy";
import { cloudCodexRequest } from "../adapters/codex/cloud-policy";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "cloud-mcp-")); roots.push(root); return root; }
const servers = [{ name: "repo-tool", transport: "stdio" as const, command: "node", args: ["tool.mjs"], env: { EXAMPLE: "test-only" } },
  { name: "remote-tool", transport: "http" as const, url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer test-only" } }];
const execution = () => ({ cwd:"/srv/zeros/workspace", lease: { assertLive: vi.fn(), admission: { model: "model" } },
  coordinator: { environment: () => ({ CURSOR_API_KEY: "test-only" }) }, productServers: [{ name: "design-draft", transport: "http", url: "http://127.0.0.1:8000/mcp" }],
  userServers: structuredClone(servers) }) as unknown as CloudProviderExecution;

describe("cloud repository and admitted MCP", () => {
  it.runIf(process.platform==="linux")("does not fail optional repository loading when a nonfatal notice sink fails",async()=>{
    const root=await fixture();await writeFile(path.join(root,".mcp.json"),'{"mcpServers":{"good":{"command":"node"},"bad":{"oauth":true}}}');
    await expect(readCloudRepositoryMcp(root,"claude",()=>{throw new Error("unavailable notice transport");})).resolves.toEqual([{name:"good",transport:"stdio",command:"node"}]);
  });
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
  it.runIf(process.platform === "linux")("reads only the requesting provider's repository configuration", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".codex")); await mkdir(path.join(root, ".cursor"));
    await writeFile(path.join(root, ".codex/config.toml"), '[mcp_servers.codex]\ncommand="node"\nargs=["one.mjs"]\n');
    await writeFile(path.join(root, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "cursor" } } }));
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "repo" } } }));
    expect(await readCloudRepositoryMcp(root, "codex")).toMatchObject([{ name: "codex", command: "node" }]);
    expect(await readCloudRepositoryMcp(root, "cursor")).toMatchObject([{ name: "shared", command: "cursor" }]);
    expect(await readCloudRepositoryMcp(root, "claude")).toMatchObject([{ name: "shared", command: "repo" }]);
  });
  it.runIf(process.platform === "linux")("accepts the exact Alpha repository 0canvas server", async () => {
    const root = await fixture(), notice = vi.fn();
    await writeFile(path.join(root, ".mcp.json"), '{"mcpServers":{"0canvas":{"type":"http","url":"http://localhost:24193/mcp"}}}');
    expect(await readCloudRepositoryMcp(root, "claude", notice)).toEqual([{ name: "0canvas", transport: "http", url: "http://localhost:24193/mcp" }]);
    expect(notice).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === "linux")("excludes unsafe optional files without aborting the turn", async () => {
    const root = await fixture(), outside = await fixture();
    const notice = vi.fn();
    await writeFile(path.join(outside, "config"), '{}'); await symlink(path.join(outside, "config"), path.join(root, ".mcp.json"));
    expect(await readCloudRepositoryMcp(root, "claude", notice)).toEqual([]);
    expect(notice).toHaveBeenLastCalledWith({ excluded: 1, omitted: 0, diagnostics: [{ file: ".mcp.json", reason: "unsafe_file" }] });
    await rm(path.join(root, ".mcp.json"));
    for (const source of ['{"mcpServers":', 'x'.repeat(64 * 1024 + 1), '{"mcpServers":[]}']) {
      await writeFile(path.join(root, ".mcp.json"), source);
      expect(await readCloudRepositoryMcp(root, "claude", notice)).toEqual([]);
      expect(notice.mock.lastCall![0].diagnostics[0].file).toBe(".mcp.json");
    }
  });
  it.runIf(process.platform==="linux")("excludes malformed UTF-8 optional configuration without reflecting file bytes",async()=>{
    const root=await fixture(),notice=vi.fn();
    await writeFile(path.join(root,".mcp.json"),Buffer.concat([Buffer.from('{"mcpServers":{"server":{"command":"node'),Buffer.from([0xff]),Buffer.from('"}}}') ]));
    expect(await readCloudRepositoryMcp(root,"claude",notice)).toEqual([]);
    expect(notice).toHaveBeenCalledWith({excluded:1,omitted:0,diagnostics:[{file:".mcp.json",reason:"file_malformed"}]});
  });
  it.runIf(process.platform === "linux")("retains valid siblings and exposes only closed, redacted, bounded diagnostics", async () => {
    const root = await fixture(), notices: CloudRepositoryMcpNotice[] = [];
    const invalid = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`invalid${i}`, { command: "secret-command", env: { TOKEN: "${env:secret}" } }]));
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      "0canvas": { type: "http", url: "http://localhost:24193/mcp" },
      "design-draft": { command: "secret-command" },
      "https://secret-user:secret-password@example.test": { command: "secret-command" },
      authRemote: { url: "https://example.test/mcp", oauth: { token: "secret-token" } },
      url: { url: "https://secret-user:secret-password@example.test/mcp" },
      cwd: { command: "node", cwd: "../../outside" },
      disabled: { command: "ignored", disabled: true },
      good: { command: "node", args: ["tool.mjs"], cwd: "tools" }, ...invalid,
    } }));
    const accepted = await readCloudRepositoryMcp(root, "claude", notice => notices.push(notice));
    expect(accepted).toEqual([{ name: "0canvas", transport: "http", url: "http://localhost:24193/mcp" },
      { name: "good", transport: "stdio", command: "node", args: ["tool.mjs"], cwd: "/srv/zeros/workspace/tools" }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ excluded: 45, omitted: 29 });
    expect(notices[0]!.diagnostics).toHaveLength(16);
    expect(JSON.stringify(notices)).not.toMatch(/secret|outside|https:|command|token|password/);
    expect(Buffer.byteLength(JSON.stringify(notices[0]))).toBeLessThan(4096);
    expect(notices[0]!.diagnostics).toContainEqual({ file: ".mcp.json", server: "authRemote", reason: "unsupported_auth" });
  });
  it.runIf(process.platform === "linux")("bounds accepted servers while keeping a deterministic admitted set", async () => {
    const root = await fixture(), notice = vi.fn();
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`tool${String(i).padStart(2, "0")}`, { command: "node" }])) }));
    expect((await readCloudRepositoryMcp(root, "claude", notice)).map(server => server.name)).toEqual(Array.from({ length: 32 }, (_, i) => `tool${String(i).padStart(2, "0")}`));
    expect(notice).toHaveBeenCalledWith({ excluded: 8, omitted: 0, diagnostics: Array.from({ length: 8 }, (_, i) => ({ file: ".mcp.json", server: `tool${i + 32}`, reason: "server_limit" })) });
  });
  it.runIf(process.platform === "linux")("does not read malformed or oversized unrelated provider files", async () => {
    const root = await fixture(), notice = vi.fn();
    await mkdir(path.join(root, ".codex")); await mkdir(path.join(root, ".cursor"));
    await writeFile(path.join(root, ".codex/config.toml"), "malformed = [");
    await writeFile(path.join(root, ".cursor/mcp.json"), "x".repeat(70 * 1024));
    await writeFile(path.join(root, ".mcp.json"), '{"mcpServers":{"0canvas":{"type":"http","url":"http://localhost:24193/mcp"}}}');
    expect(await readCloudRepositoryMcp(root, "claude", notice)).toHaveLength(1);
    expect(notice).not.toHaveBeenCalled();
  });
});
