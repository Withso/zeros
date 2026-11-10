import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const serverId = "33333333-3333-4333-8333-333333333333";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(["codex", "cursor"] as const)("gives a %s execution the workspace tools beside the user's own MCP server, without review tools when review is off", async agentId => {
  const f = await repositoryFixture();
  await writeFile(join(f.root, "readme.txt"), "initial\nchanged by agent\n");
  const relay = new FakeRelay(), drivers: FakeDriver[] = [];
  const factory = () => { const driver = new FakeDriver(); drivers.push(driver); return driver; };
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => {},
    workspaceServices: { watch: false }, drivers: { codex: factory, cursor: factory } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: { ...config.agents, cursor: { apiKey: "fixture-cursor-key" } }, workspace: f.scope.workspace,
    mcpServers: [{ id: serverId, name: "fixture", transport: "http" as const, url: "https://mcp.example.test", auth: "none" as const }] });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  await relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId, chatId: "chat", cwd: f.scope.key }));
  await expect.poll(() => drivers[0]?.opened?.mcpServers).toBeDefined();
  const servers = drivers[0].opened!.mcpServers!;
  expect(Object.keys(servers).sort()).toEqual([`fixture_${serverId.replaceAll("-", "")}`, "zeros_workspace"]);
  const tools = servers.zeros_workspace;
  const client = new Client({ name: "fixture-agent", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: tools.headers } }));
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["GetTerminalOutput", "GetWorkspaceDiff"]);
  expect((await client.callTool({ name: "code_review_list", arguments: {} })).isError).toBe(true);
  const diff = await client.callTool({ name: "GetWorkspaceDiff", arguments: {} }) as { content: Array<{ text: string }> };
  expect(diff.content[0].text).toContain("+changed by agent");
  const terminal = await client.callTool({ name: "GetTerminalOutput", arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
  expect(terminal.isError).toBe(true); expect(terminal.content[0].text).toContain("TERMINAL_NOT_FOUND");
});

it("keeps the read-only tools working across Stop without reopening the native driver when review is off", async () => {
  const f = await repositoryFixture();
  await writeFile(join(f.root, "readme.txt"), "initial\nafter stop\n");
  const relay = new FakeRelay(), drivers: FakeDriver[] = [];
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => {},
    workspaceServices: { watch: false }, drivers: { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, workspace: f.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const created = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: f.scope.key });
  await relay.request(CLIENT_A, created);
  const sessionId = (relay.response(created.id) as unknown as { session: { sessionId: string } }).session.sessionId;
  const first = browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId, userMessageId: "user-1", prompt: [{ type: "text", text: "work" }] });
  await relay.request(CLIENT_A, first);
  await expect.poll(() => drivers[0]?.prompts.length).toBe(1);
  const tools = drivers[0].opened!.mcpServers!.zeros_workspace;
  await relay.request(CLIENT_A, browserFrame("AGENT_CANCEL", { agentId: "codex", sessionId }));
  await expect.poll(() => relay.response(first.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  const client = new Client({ name: "fixture-agent", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: tools.headers } }));
  const diff = await client.callTool({ name: "GetWorkspaceDiff", arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
  expect(diff.isError).toBeFalsy(); expect(diff.content[0].text).toContain("+after stop");
  const next = browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId, userMessageId: "user-2", prompt: [{ type: "text", text: "again" }] });
  await relay.request(CLIENT_A, next);
  await expect.poll(() => drivers[0].prompts.length).toBe(2);
  expect(drivers).toHaveLength(1);
  drivers[0].complete();
});

it("reads the setup output through GetTerminalOutput source setup, and says when there is none", async () => {
  const f = await repositoryFixture();
  const relay = new FakeRelay(), drivers: FakeDriver[] = [];
  let release!: () => void; const ran = new Promise<void>(resolve => { release = resolve; });
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => ({ createdBranch: true }),
    workspaceServices: { watch: false }, drivers: { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } },
    setupRunner: async (_file, _args, options) => { options.output(Buffer.from("installing\r\ninstalled 42 packages\n")); release(); return 0; } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, workspace: { ...f.scope.workspace, setup: "pnpm install" } });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  await ran;
  await relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: f.scope.key }));
  await expect.poll(() => drivers[0]?.opened?.mcpServers).toBeDefined();
  const tools = drivers[0].opened!.mcpServers!.zeros_workspace;
  const client = new Client({ name: "fixture-agent", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(tools.url), { requestInit: { headers: tools.headers } }));
  const read = async () => await client.callTool({ name: "GetTerminalOutput", arguments: { source: "setup" } }) as { isError?: boolean; content: Array<{ text: string }> };
  await expect.poll(async () => (await read()).content[0].text).toBe("installing\ninstalled 42 packages");
  const shells = await client.callTool({ name: "GetTerminalOutput", arguments: { source: "run_script" } }) as { isError?: boolean; content: Array<{ text: string }> };
  expect(shells.isError).toBe(true); expect(shells.content[0].text).toContain("no open terminal of that kind");
});
