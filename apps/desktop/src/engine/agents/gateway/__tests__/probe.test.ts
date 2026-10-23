import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthVault } from "../oauth-provider";
import { probeMcpServer } from "../probe";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function remote(holdDelete = false) {
  const sessions = new Set<StreamableHTTPServerTransport>();
  const methods: string[] = [];
  const http = createServer(async (request, response) => {
    methods.push(request.method!);
    if (holdDelete && request.method === "DELETE") return;
    const existing = [...sessions].find(session => session.sessionId === request.headers["mcp-session-id"]);
    if (existing) { await existing.handleRequest(request, response); return; }
    if (request.method !== "POST") { response.writeHead(400).end(); return; }
    const server = new Server({ name: "probe-fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "fixture", inputSchema: { type: "object" as const } }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    sessions.add(transport);
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const session of sessions) await session.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  return { methods, config: { name: "fixture", transport: "http", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp` } };
}

describe("native MCP connection checks", () => {
  it("terminates the initialized remote session after reading its tools", async () => {
    const server = await remote();
    const vault = new OAuthVault();
    expect(await probeMcpServer(server.config, {}, vault)).toMatchObject({ status: "connected", toolCount: 1 });
    expect(server.methods).toContain("DELETE");
    expect(vault.snapshot()).toEqual({});
  });

  it.each(["cancellation", "deadline"])("bounds remote session cleanup by the probe's %s", async reason => {
    const server = await remote(true), cancel = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = probeMcpServer(server.config, {}, new OAuthVault(), undefined, cancel.signal);
    try {
      await vi.waitFor(() => expect(server.methods).toContain("DELETE"));
      if (reason === "cancellation") cancel.abort();
      else await vi.advanceTimersByTimeAsync(12_001);
      expect(await pending).toMatchObject({ status: "connected", toolCount: 1 });
    } finally { cancel.abort(); await pending; }
  });
});
