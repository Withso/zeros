import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { McpGateway } from "./gateway";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const privateDetail = "PRIVATE_MCP_DIAGNOSTIC_MUST_NOT_LEAVE_WORKER";
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "failure-fixture", version: "1" },
} };

it.each([
  { reason: "sign-in-required", error: { code: "mcp_auth_required", status: 409 } },
  { reason: "sign-in-refused", error: { status: 403 } },
  { reason: "server-error", error: { status: 503 } },
  { reason: "unreachable", error: { code: "ECONNREFUSED" } },
])("keeps $reason and the exact server/execution without exposing upstream diagnostics", async ({ reason, error }) => {
  const serverId = randomUUID(), executionId = randomUUID(), onFailure = vi.fn();
  const gateway = new McpGateway({ workspaceRoot: process.cwd(), onFailure,
    authorization: async () => { throw Object.assign(new Error(privateDetail), error); } });
  cleanups.push(() => gateway.dispose());
  await gateway.configure([{ id: serverId, name: "fixture", transport: "http", url: "https://mcp.example.test", auth: "oauth" }]);
  const [entry] = Object.values(await gateway.providers(executionId));
  const response = await fetch(entry.url, { method: "POST", headers: { ...entry.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(initialize) });
  const text = await response.text();
  expect(response.status).toBe(502);
  expect(text).not.toContain(privateDetail);
  expect(() => JSON.parse(text)).not.toThrow();
  expect(JSON.parse(text)).toMatchObject({ jsonrpc: "2.0", id: initialize.id, error: { data: { cloud: { source: "mcp", serverId, reason } } } });
  expect(onFailure).toHaveBeenCalledExactlyOnceWith(executionId, { source: "mcp", serverId, reason });
});

it("preserves a mid-call server error through the real MCP client and scoped failure observer", async () => {
  const transports = new Set<StreamableHTTPServerTransport>();
  const remote = createServer(async (req, res) => {
    const existing = [...transports].find(transport => transport.sessionId === req.headers["mcp-session-id"]);
    if (existing) { await existing.handleRequest(req, res); return; }
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async () => { throw new McpError(-32603, privateDetail); });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    transports.add(transport); await server.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const transport of transports) await transport.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); });
  const serverId = randomUUID(), executionId = randomUUID(), onFailure = vi.fn();
  const gateway = new McpGateway({ workspaceRoot: process.cwd(), onFailure });
  cleanups.push(() => gateway.dispose());
  await gateway.configure([{ id: serverId, name: "fixture", transport: "http", url: `http://127.0.0.1:${(remote.address() as { port: number }).port}/mcp` }]);
  const [entry] = Object.values(await gateway.providers(executionId));
  const client = new Client({ name: "fixture-agent", version: "1" }); cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
  const failure = await client.callTool({ name: "fixture" }).catch(error => error);
  expect(failure).toBeInstanceOf(McpError);
  expect(failure).toMatchObject({ data: { cloud: { source: "mcp", serverId, reason: "server-error" } } });
  expect(failure.message).not.toContain(privateDetail);
  expect(onFailure).toHaveBeenCalledExactlyOnceWith(executionId, { source: "mcp", serverId, reason: "server-error" });
});

it("keeps a POST-only MCP server usable when its optional GET stream returns 405", async () => {
  const transports = new Set<StreamableHTTPServerTransport>();
  const remote = createServer(async (req, res) => {
    const existing = [...transports].find(transport => transport.sessionId === req.headers["mcp-session-id"]);
    if (existing) { await existing.handleRequest(req, res); return; }
    const server = new Server({ name: "post-only", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "Connected" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    transports.add(transport); await server.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const transport of transports) await transport.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); });
  const onFailure = vi.fn(); let gets = 0;
  const gateway = new McpGateway({ workspaceRoot: process.cwd(), onFailure, fetch: async (input, init) => {
    if (init?.method === "GET") { gets++; return new Response(null, { status: 405 }); }
    return fetch(input, init);
  } });
  cleanups.push(() => gateway.dispose());
  await gateway.configure([{ id: randomUUID(), name: "post-only", transport: "http", url: `http://127.0.0.1:${(remote.address() as { port: number }).port}/mcp` }]);
  const [entry] = Object.values(await gateway.providers(randomUUID()));
  const client = new Client({ name: "fixture-agent", version: "1" }); cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
  await expect.poll(() => gets).toBe(1);
  await expect(client.callTool({ name: "fixture" })).resolves.toMatchObject({ content: [{ text: "Connected" }] });
  expect(onFailure).not.toHaveBeenCalled();
});
