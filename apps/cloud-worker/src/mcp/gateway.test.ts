import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpGateway } from "./gateway";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function upstream() {
  const transports = new Set<StreamableHTTPServerTransport>();
  const requests: string[] = [];
  let required = "Bearer fixture-first";
  const server = createServer(async (req, res) => {
    requests.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== required) { res.writeHead(401).end(); return; }
    const session = req.headers["mcp-session-id"];
    const existing = [...transports].find(t => t.sessionId === session);
    if (existing) { await existing.handleRequest(req, res); return; }
    if (req.method !== "POST") { res.writeHead(400).end(); return; }
    const mcp = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["allowed", "blocked"].map(name => ({ name, inputSchema: { type: "object" as const } })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: "text", text: request.params.name }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    transports.add(transport); await mcp.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const t of transports) await t.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, requests, require: (value: string) => { required = value; } };
}

describe("worker MCP gateway", () => {
  it("lazily initializes real MCP, filters disabled tools and refreshes on request only", async () => {
    const remote = await upstream(), id = randomUUID();
    const authorization = vi.fn(async (_id: string, force?: boolean) => ({ headers: { Authorization: force ? "Bearer fixture-second" : "Bearer fixture-first" }, expiresAt: Date.now() + 300_000 }));
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), authorization });
    cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id, name: "fixture", transport: "http", url: remote.url, auth: "oauth", disabled_tools: ["blocked"] }]);
    const [entry] = Object.values(await gateway.providers());
    expect(authorization).not.toHaveBeenCalled(); expect(remote.requests).toEqual([]);
    const client = new Client({ name: "fixture-agent", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["allowed"]);
    await expect(client.callTool({ name: "blocked" })).rejects.toThrow("disabled");
    expect(authorization).toHaveBeenCalledTimes(1);
    remote.require("Bearer fixture-second");
    expect(await client.callTool({ name: "allowed" })).toMatchObject({ content: [{ text: "allowed" }] });
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(authorization.mock.calls[1]?.[1]).toBe(true);
    const count = remote.requests.length;
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(300_001); vi.useRealTimers();
    expect(remote.requests).toHaveLength(count); expect(authorization).toHaveBeenCalledTimes(2);
    await gateway.configure([]);
    expect((await fetch(entry.url, { method: "POST", headers: entry.headers, body: "{}" })).status).toBe(404);
  });

  it("withdraws cached OAuth authorization on a sign-in revision without idle work or changing the capability", async () => {
    const remote = await upstream(); let token = "Bearer fixture-first";
    const authorization = vi.fn(async (_id: string, _force?: boolean) => ({ headers: { Authorization: token }, expiresAt: Date.now() + 300_000 }));
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), authorization }); cleanups.push(() => gateway.dispose());
    const servers = [{ id: randomUUID(), name: "identity", transport: "http" as const, url: remote.url, auth: "oauth" as const }];
    await gateway.configure(servers, "1");
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    await client.listTools(); const sent = remote.requests.length;
    token = "Bearer fixture-second"; remote.require(token);
    await gateway.configure(servers, "2");
    expect(Object.values(await gateway.providers())[0]).toEqual(entry);
    expect(authorization).toHaveBeenCalledOnce(); expect(remote.requests).toHaveLength(sent);
    await client.listTools();
    expect(remote.requests.slice(sent).every(value => value === token)).toBe(true);
    expect(authorization).toHaveBeenCalledTimes(2); expect(authorization.mock.calls[1]?.[1]).toBe(false);
  });

  it("rejects browser origins, wrong credentials and redirects without leaking upstream headers", async () => {
    const fetched: string[] = [], id = randomUUID();
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), fetch: async input => {
      fetched.push(new Request(input).url);
      return new Response(null, { status: 307, headers: { Location: "https://other.example.test/mcp" } });
    } });
    cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id, name: "fixture", transport: "http", url: "https://fixture.example.test/mcp", headers: { "X-Api-Key": "fixture-header" } }]);
    const [entry] = Object.values(await gateway.providers());
    expect((await fetch(entry.url, { headers: { Origin: "https://other.example.test", ...entry.headers } })).status).toBe(403);
    expect((await fetch(entry.url)).status).toBe(401);
    const client = new Client({ name: "fixture-agent", version: "1" });
    cleanups.push(() => client.close());
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }))).rejects.toThrow();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every(url => url === "https://fixture.example.test/mcp")).toBe(true);
  });

  it("validates a complete replacement before withdrawing the current capabilities", async () => {
    const gateway = new McpGateway({ workspaceRoot: process.cwd() }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "original", transport: "http", url: "https://fixture.example.test/mcp" }]);
    const before = await gateway.providers();
    await expect(gateway.configure([{ id: randomUUID(), name: "invalid", transport: "stdio", command: "node", listen_url: "https://public.example.test/mcp" }])).rejects.toThrow();
    expect(JSON.stringify(await gateway.providers()) === JSON.stringify(before)).toBe(true);
  });

  it("refuses an oversized upstream JSON response before native initialization", async () => {
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json() as { id?: number; method: string };
      if (body.method !== "initialize") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {},
        serverInfo: { name: "oversized", version: "1" }, instructions: "x".repeat(4 * 1024 * 1024) } });
    } });
    cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "oversized", transport: "http", url: "https://fixture.example.test/mcp" }]);
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" });
    cleanups.push(() => client.close());
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }))).rejects.toThrow();
  });

  it.each(["stdio", "http"])("launches %s with literal arguments, resolves cwd, seals outputs, and reaps the owned child", async mode => {
    const root = await mkdtemp(join(tmpdir(), "mcp-process-")); await mkdir(join(root, "nested"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const args = [fileURLToPath(new URL("./__fixtures__/server.mjs", import.meta.url)), ...(mode === "http" ? ["http", String(port)] : []), "literal ; $(no-shell)"];
    const gateway = new McpGateway({ workspaceRoot: root }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "child", transport: "stdio", command: process.execPath, args, cwd: "nested", env: { MCP_TEST_VALUE: "fixture-process-secret" },
      ...(mode === "http" ? { listen_url: `http://127.0.0.1:${port}/mcp` } : {}) }]);
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    expect((await client.listTools()).tools[0]?.description).toBe("[redacted]");
    const result = await client.callTool({ name: "inspect" }), content = result.content as Array<{ text: string }>;
    const child = JSON.parse(content[0].text);
    expect(child).toMatchObject({ cwd: join(root, "nested"), value: "[redacted]" });
    expect(child.args.at(-1)).toBe("literal ; $(no-shell)");
    process.kill(child.pid, 0);
    await gateway.configure([]);
    await vi.waitFor(() => expect(() => process.kill(child.pid, 0)).toThrow(), { timeout: 3000 });
  });

  it("redacts repeated values in one pass without expanding its own replacement", async () => {
    const gateway = new McpGateway({ workspaceRoot: process.cwd() }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "redaction", transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./__fixtures__/server.mjs", import.meta.url))], env: { MCP_TEST_VALUE: "redacted", SAME_VALUE: "redacted" } }]);
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    expect((await client.listTools()).tools[0]?.description).toBe("[redacted]");
  });

  it("preserves protocol names, types and schemas when a short secret occurs in their spelling", async () => {
    const gateway = new McpGateway({ workspaceRoot: process.cwd() }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "protocol", transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./__fixtures__/server.mjs", import.meta.url))], env: { MCP_TEST_VALUE: "e" } }]);
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    expect((await client.listTools()).tools[0]).toMatchObject({ name: "inspect", description: "[redacted]", inputSchema: { type: "object" } });
    expect(await client.callTool({ name: "inspect" })).toMatchObject({ content: [{ type: "text" }] });
    expect(client.getInstructions()).toBe("[redacted]");
  });

  it("consumes legacy SSE through the same native HTTP capability and closes its stream on removal", async () => {
    const sessions = new Set<SSEServerTransport>(); let closed = false;
    const http = createServer(async (req, res) => {
      if (req.headers.authorization !== "fixture-sse-key") { res.writeHead(401).end(); return; }
      if (req.method === "GET") {
        const transport = new SSEServerTransport("/message", res), server = new Server({ name: "legacy", version: "1" }, { capabilities: { tools: {} } });
        sessions.add(transport); req.once("close", () => { closed = true; });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "legacy", inputSchema: { type: "object" as const } }] }));
        await server.connect(transport);
      } else {
        const sessionId = new URL(req.url!, "http://localhost").searchParams.get("sessionId");
        const transport = [...sessions].find(value => value.sessionId === sessionId);
        if (transport) await transport.handlePostMessage(req, res); else res.writeHead(404).end();
      }
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { for (const session of sessions) await session.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
    const gateway = new McpGateway({ workspaceRoot: process.cwd() }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "legacy", transport: "sse", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/sse`, headers: { Authorization: "fixture-sse-key" } }]);
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["legacy"]);
    await gateway.configure([]); await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("does not dispatch upstream after removal during authorization", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), fetcher = vi.fn<typeof fetch>();
    const authorization = vi.fn(async () => { await held; return { headers: { Authorization: "must-not-forward" } }; });
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), authorization, fetch: fetcher }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "held", transport: "http", url: "https://fixture.example.test/mcp", auth: "oauth" }]);
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" }); cleanups.push(() => client.close());
    const connecting = client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } })).then(() => true, () => false);
    await vi.waitFor(() => expect(authorization).toHaveBeenCalledOnce());
    try { await gateway.configure([]); } finally { release(); }
    expect(await connecting).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a shared credential request alive when its first HTTP session is cancelled", async () => {
    const remote = await upstream(), first = new AbortController();
    let release!: () => void;
    const authorization = vi.fn((_id: string, _force?: boolean, signal?: AbortSignal) => new Promise<{ headers: Record<string, string> }>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(new Error("Fixture credential request cancelled")); };
      release = () => { signal?.removeEventListener("abort", abort); resolve({ headers: { Authorization: "Bearer fixture-first" } }); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    }));
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), authorization }); cleanups.push(() => gateway.dispose());
    await gateway.configure([{ id: randomUUID(), name: "shared", transport: "http", url: remote.url, auth: "oauth" }]);
    const [entry] = Object.values(await gateway.providers());
    // Observe the real join without releasing either HTTP initialization early.
    const reads = vi.spyOn(gateway as unknown as { authorization: (...args: unknown[]) => Promise<unknown> }, "authorization");
    const initialize = (signal?: AbortSignal) => fetch(entry.url, {
      method: "POST", signal,
      headers: { ...entry.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture-agent", version: "1" },
      } }),
    });
    const cancelled = initialize(first.signal).then(response => { void response.body?.cancel(); return true; }, () => false);
    try {
      await vi.waitFor(() => expect(authorization).toHaveBeenCalledOnce());
      const survivor = initialize();
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
      first.abort(); expect(await cancelled).toBe(false);
      await vi.waitFor(() => expect((gateway as unknown as { pending: Set<unknown> }).pending.size).toBeLessThan(2));
      release();
      const response = await survivor;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"name":"shared"');
      expect(authorization).toHaveBeenCalledOnce();
    } finally { first.abort(); release?.(); reads.mockRestore(); }
  });

  it("fences a held OAuth read when a new sign-in revision arrives", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), fetcher = vi.fn<typeof fetch>();
    const authorization = vi.fn(async () => { await held; return { headers: { Authorization: "stale-fixture-token" } }; });
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), authorization, fetch: fetcher }); cleanups.push(() => gateway.dispose());
    const servers = [{ id: randomUUID(), name: "held", transport: "http" as const, url: "https://fixture.example.test/mcp", auth: "oauth" as const }];
    await gateway.configure(servers, "1");
    const [entry] = Object.values(await gateway.providers()), client = new Client({ name: "test-agent", version: "1" }); cleanups.push(() => client.close());
    const connecting = client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } })).then(() => true, () => false);
    await vi.waitFor(() => expect(authorization).toHaveBeenCalledOnce());
    try { await gateway.configure(servers, "2"); } finally { release(); }
    expect(await connecting).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });

  it("forces renewal after a 401 even when a simultaneous ordinary credential read is held", async () => {
    const remote = await upstream();
    const deferred = () => {
      let resolve!: () => void, done = false;
      return { promise: new Promise<void>(complete => { resolve = complete; }), get done() { return done; }, resolve: () => { done = true; resolve(); } };
    };
    const callSent = deferred(), release401 = deferred(), cancelled401 = deferred(), ordinaryRead = deferred(), releaseRead = deferred(), retrySent = deferred();
    let reads = 0, firstCall = true, offset = 0, retryAuthorized = false;
    const systemNow = Date.now.bind(Date), clock = vi.spyOn(Date, "now").mockImplementation(() => systemNow() + offset);
    const authorization = vi.fn(async (_id: string, force?: boolean) => {
      if (!force && reads++ > 0) { ordinaryRead.resolve(); await releaseRead.promise; }
      return { headers: { Authorization: force ? "Bearer fixture-second" : "Bearer fixture-first" }, expiresAt: Date.now() + 300_000 };
    });
    const gateway = new McpGateway({ workspaceRoot: process.cwd(), authorization, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && (await request.clone().json() as { method?: string }).method === "tools/call") {
        if (firstCall) {
          firstCall = false; callSent.resolve(); await release401.promise;
          return new Response(new ReadableStream({ cancel: () => cancelled401.resolve() }), { status: 401 });
        }
        retryAuthorized = request.headers.get("authorization") === "Bearer fixture-second"; retrySent.resolve();
      }
      return fetch(request);
    } });
    cleanups.push(() => gateway.dispose());
    try {
      await gateway.configure([{ id: randomUUID(), name: "racing", transport: "http", url: remote.url, auth: "oauth" }]);
      const [entry] = Object.values(await gateway.providers());
      const a = new Client({ name: "a", version: "1" }), b = new Client({ name: "b", version: "1" });
      cleanups.push(() => a.close(), () => b.close());
      const transport = () => new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } });
      await a.connect(transport()); await a.listTools();
      const call = a.callTool({ name: "allowed" }).then(() => true, () => false);
      await vi.waitFor(() => expect(callSent.done).toBe(true)); offset += 300_001;
      const connecting = b.connect(transport()).then(() => true, () => false);
      await vi.waitFor(() => expect(ordinaryRead.done).toBe(true));
      remote.require("Bearer fixture-second"); release401.resolve();
      await vi.waitFor(() => expect(cancelled401.done).toBe(true));
      // Drain the 401 continuation while the ordinary CP read is still held.
      await new Promise<void>(resolve => setImmediate(resolve)); releaseRead.resolve();
      await vi.waitFor(() => expect(retrySent.done).toBe(true)); expect(retryAuthorized).toBe(true);
      expect(await call).toBe(true); expect(await connecting).toBe(true);
      expect(authorization.mock.calls.some(([, force]) => force)).toBe(true);
    } finally { release401.resolve(); releaseRead.resolve(); clock.mockRestore(); }
  });
});
