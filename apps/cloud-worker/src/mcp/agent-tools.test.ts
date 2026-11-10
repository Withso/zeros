import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodeReviewAgentToolsCore } from "@zeros/protocol/code-review";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentTools, WORKSPACE_TOOL_INSTRUCTIONS } from "./agent-tools";
import { WorkspaceToolsMcp, type WorkspaceToolGrant } from "./workspace-tools";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function connect(grant: WorkspaceToolGrant) {
  const registration = grant.servers.zeros_workspace;
  const client = new Client({ name: "agent-tools-fixture", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }));
  return client;
}
function fixture(review: boolean) {
  const mcp = new WorkspaceToolsMcp(); cleanups.push(() => mcp.dispose());
  const run = vi.fn(() => ({ workspaceId: "workspace", threads: [] }));
  const core = new CodeReviewAgentToolsCore({ workspaceId: "workspace", workspacePath: "/fixture", assertCurrent: () => {} }, run,
    { id: "agent:codex:chat", name: "Codex", kind: "agent", provider: "codex" });
  const output = vi.fn(async (input: { terminalId?: string; maxLines: number }) => input.terminalId === "gone" ? undefined
    : { terminalId: input.terminalId ?? "recent", lines: ["$ pnpm test", "ok"], truncated: false });
  const diff = vi.fn(async (input: { stat?: boolean; file?: string }) => ({ text: input.stat ? "M a.txt +1 -0\n" : "+changed\n", truncated: false }));
  const tools = new WorkspaceAgentTools({ assertCurrent: () => {}, terminalOutput: output, diff, ...(review ? { review: core } : {}) });
  return { mcp, tools, run, output, diff };
}
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

describe("zeros_workspace agent tools", () => {
  it("offers terminal output and the workspace diff without code review, and neither lists nor runs review tools", async () => {
    const f = fixture(false), client = await connect(await f.mcp.admit(randomUUID(), f.tools));
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["GetTerminalOutput", "GetWorkspaceDiff"]);
    expect(client.getInstructions()).toBe(WORKSPACE_TOOL_INSTRUCTIONS);
    expect(WORKSPACE_TOOL_INSTRUCTIONS).toContain("zeros cloud");
    const review = await client.callTool({ name: "code_review_list", arguments: {} });
    expect(review.isError).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
    expect(text(await client.callTool({ name: "GetTerminalOutput", arguments: {} }))).toBe("$ pnpm test\nok");
    expect(f.output).toHaveBeenLastCalledWith({ maxLines: 1000 });
    await client.callTool({ name: "GetTerminalOutput", arguments: { terminalId: "t1", maxLines: 5 } });
    expect(f.output).toHaveBeenLastCalledWith({ terminalId: "t1", maxLines: 5 });
    expect(text(await client.callTool({ name: "GetWorkspaceDiff", arguments: { stat: true } }))).toBe("M a.txt +1 -0\n");
    expect(f.diff).toHaveBeenLastCalledWith({ stat: true });
  });

  it("keeps review tools beside the new tools when review is enabled", async () => {
    const f = fixture(true), client = await connect(await f.mcp.admit(randomUUID(), f.tools));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["GetTerminalOutput", "GetWorkspaceDiff", "code_review_list", "code_review_create"]));
    expect((await client.callTool({ name: "code_review_list", arguments: {} })).isError).toBeFalsy();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("validates bounds, reports a missing terminal and marks truncated output", async () => {
    const f = fixture(false), client = await connect(await f.mcp.admit(randomUUID(), f.tools));
    for (const args of [{ maxLines: 0 }, { maxLines: 2001 }, { maxLines: 1.5 }, { terminalId: "" }, { extra: true }])
      expect((await client.callTool({ name: "GetTerminalOutput", arguments: args })).isError).toBe(true);
    expect((await client.callTool({ name: "GetWorkspaceDiff", arguments: { file: 1 } })).isError).toBe(true);
    const gone = await client.callTool({ name: "GetTerminalOutput", arguments: { terminalId: "gone" } });
    expect(gone.isError).toBe(true); expect(text(gone)).toContain("TERMINAL_NOT_FOUND");
    f.diff.mockResolvedValueOnce({ text: "+partial\n", truncated: true });
    expect(text(await client.callTool({ name: "GetWorkspaceDiff", arguments: {} }))).toContain("[Output truncated");
  });

  it("withdraws only the review tools when review is withdrawn, and retires a review-only grant whole", async () => {
    const withReview = fixture(true), mcp = new WorkspaceToolsMcp(); cleanups.push(() => mcp.dispose());
    const legacy = new CodeReviewAgentToolsCore({ workspaceId: "workspace", workspacePath: "/fixture", assertCurrent: () => {} }, withReview.run,
      { id: "agent:codex:chat", name: "Codex", kind: "agent", provider: "codex" });
    const reviewing = await mcp.admit(randomUUID(), withReview.tools), reviewOnly = await mcp.admit(randomUUID(), legacy);
    const client = await connect(reviewing);
    expect((await client.listTools()).tools.length).toBeGreaterThan(2);
    mcp.revokeReview();
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["GetTerminalOutput", "GetWorkspaceDiff"]);
    expect((await client.callTool({ name: "code_review_list", arguments: {} })).isError).toBe(true);
    expect(text(await client.callTool({ name: "GetWorkspaceDiff", arguments: {} }))).toBe("+changed\n");
    const retired = await fetch(reviewOnly.servers.zeros_workspace.url, { method: "POST", headers: { ...reviewOnly.servers.zeros_workspace.headers, "Content-Type": "application/json" }, body: "{}" });
    expect(retired.status).toBe(404);
  });

  it("fences the whole grant while a suspended review part is present, and serves the new tools once it is withdrawn", async () => {
    let enabled = true;
    const core = new CodeReviewAgentToolsCore({ workspaceId: "workspace", workspacePath: "/fixture", assertCurrent: () => { if (!enabled) throw new Error("Review suspended"); } },
      () => ({ threads: [] }), { id: "agent:codex:chat", name: "Codex", kind: "agent", provider: "codex" });
    const tools = new WorkspaceAgentTools({ assertCurrent: () => {}, review: core,
      terminalOutput: async () => ({ terminalId: "t", lines: ["ok"], truncated: false }), diff: async () => ({ text: "", truncated: false }) });
    enabled = false;
    expect(() => tools.listTools()).toThrow();
    await expect(tools.callTool("GetTerminalOutput", {}, new AbortController().signal)).rejects.toThrow();
    tools.withdrawReview();
    expect(tools.listTools().map(tool => tool.name)).toEqual(["GetTerminalOutput", "GetWorkspaceDiff"]);
    expect(text(await tools.callTool("GetTerminalOutput", {}, new AbortController().signal))).toBe("ok");
    await expect(tools.callTool("code_review_list", {}, new AbortController().signal)).rejects.toThrow();
  });
});
