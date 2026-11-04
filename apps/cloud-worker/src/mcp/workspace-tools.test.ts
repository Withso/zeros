import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CodeReviewAgentToolsCore } from "@zeros/protocol/code-review";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceToolsMcp, type WorkspaceToolGrant } from "./workspace-tools";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const mcp = new WorkspaceToolsMcp(), run = vi.fn(() => ({ workspaceId: "workspace", threads: [] }));
  cleanups.push(() => mcp.dispose());
  let current = true;
  const tools = new CodeReviewAgentToolsCore({ workspaceId: "workspace", workspacePath: "/fixture", assertCurrent: () => { if (!current) throw new Error("Retired execution"); } }, run,
    { id: "agent:codex:chat", name: "Codex", kind: "agent", provider: "codex" });
  return { mcp, tools, run, retire: () => { current = false; } };
}
async function connect(grant: WorkspaceToolGrant) {
  const registration = grant.servers.zeros_workspace;
  const client = new Client({ name: "review-tools-fixture", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }));
  return client;
}
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

describe("per-execution workspace MCP grants", () => {
  it("joins previously revoked session drains, including concurrent disposal", async () => {
    const f = fixture(), grant = await f.mcp.admit(randomUUID(), f.tools);
    await connect(grant);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), close = Server.prototype.close;
    const closing = vi.spyOn(Server.prototype, "close").mockImplementationOnce(async function (this: Server) { await held; await close.call(this); });
    grant.revoke();
    expect(closing).toHaveBeenCalledOnce();
    let settled = 0;
    const a = f.mcp.dispose().then(() => settled++), b = f.mcp.dispose().then(() => settled++);
    try { await pause(); await pause(); expect(settled).toBe(0); }
    finally { release(); await Promise.all([a, b]); }
    expect(settled).toBe(2);
  });

  it("waits for an initializing MCP request to unwind after revocation", async () => {
    const f = fixture(), grant = await f.mcp.admit(randomUUID(), f.tools), original = Server.prototype.connect;
    let entered = false, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(Server.prototype, "connect").mockImplementationOnce(async function (this: Server, ...args) {
      await original.apply(this, args); entered = true; await held;
    });
    const opening = connect(grant).then(() => true, () => false);
    await expect.poll(() => entered).toBe(true);
    grant.revoke(); let finished = false;
    const disposing = f.mcp.dispose().then(() => { finished = true; });
    try { await pause(); await pause(); expect(finished).toBe(false); }
    finally { release(); await Promise.all([opening, disposing]); }
    expect(await opening).toBe(false);
  });

  it("rejects missing authentication, foreign browser origins and cross-grant sessions", async () => {
    const f = fixture(), first = await f.mcp.admit(randomUUID(), f.tools), second = await f.mcp.admit(randomUUID(), f.tools);
    const a = first.servers.zeros_workspace, b = second.servers.zeros_workspace;
    expect(new URL(a.url).hostname).toBe("127.0.0.1");
    expect((await fetch(a.url)).status).toBe(401);
    expect((await fetch(a.url, { headers: { ...a.headers, Origin: "https://example.invalid" } })).status).toBe(403);
    const transport = new StreamableHTTPClientTransport(new URL(a.url), { requestInit: { headers: a.headers } });
    const client = new Client({ name: "session-fixture", version: "1" });
    cleanups.push(() => client.close()); await client.connect(transport);
    expect((await fetch(b.url, { method: "POST", headers: { ...b.headers, "content-type": "application/json", "mcp-session-id": transport.sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }) })).status).toBe(404);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("never dispatches a held HTTP body after its grant is revoked", async () => {
    const f = fixture(), grant = await f.mcp.admit(randomUUID(), f.tools), registration = grant.servers.zeros_workspace;
    const transport = new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } });
    const client = new Client({ name: "held-fixture", version: "1" });
    cleanups.push(() => client.close()); await client.connect(transport);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "code_review_create", arguments: {} } });
    const request = httpRequest(registration.url, { method: "POST", headers: { ...registration.headers,
      "content-type": "application/json", "content-length": Buffer.byteLength(body), "mcp-session-id": transport.sessionId! } });
    const ended = new Promise<void>(resolve => { request.on("error", () => resolve()); request.on("response", res => { res.resume(); res.on("end", resolve); }); });
    cleanups.push(() => { request.destroy(); });
    request.write(body.slice(0, 5));
    await pause(); grant.revoke(); request.end(body.slice(5));
    await ended; await grant.dispose();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rechecks execution authority and forbids selecting another actor or workspace", async () => {
    const f = fixture(), grant = await f.mcp.admit(randomUUID(), f.tools), client = await connect(grant);
    expect((await client.callTool({ name: "code_review_list", arguments: { workspaceId: "foreign" } })).isError).toBe(true);
    expect((await client.callTool({ name: "code_review_list", arguments: { actor: "human" } })).isError).toBe(true);
    f.retire(); await expect(client.listTools()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("bounds native sessions and outstanding grants", async () => {
    const f = fixture(), first = await f.mcp.admit(randomUUID(), f.tools);
    for (let i = 0; i < 8; i++) await connect(first);
    await expect(connect(first)).rejects.toThrow();
    for (let i = 1; i < 64; i++) await f.mcp.admit(randomUUID(), f.tools);
    await expect(f.mcp.admit(randomUUID(), f.tools)).rejects.toThrow(/unavailable/);
    first.revoke(); await expect(f.mcp.admit(randomUUID(), f.tools)).resolves.toBeDefined();
  });
});
