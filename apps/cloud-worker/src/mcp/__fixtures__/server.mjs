import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function server() {
  const mcp = new Server({ name: "process-fixture", version: "1" }, { capabilities: { tools: {} }, instructions: process.env.MCP_TEST_VALUE });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "inspect", description: process.env.MCP_TEST_VALUE, inputSchema: { type: "object" } }] }));
  mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: JSON.stringify({
    cwd: process.cwd(), args: process.argv.slice(2), value: process.env.MCP_TEST_VALUE, pid: process.pid,
  }) }] }));
  return mcp;
}
if (process.argv[2] === "http") {
  const sessions = new Map();
  createServer(async (req, res) => {
    const session = sessions.get(req.headers["mcp-session-id"]);
    if (session) return session.handleRequest(req, res);
    if (req.method !== "POST") { res.writeHead(400).end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
      onsessioninitialized: id => sessions.set(id, transport), onsessionclosed: id => sessions.delete(id) });
    await server().connect(transport); await transport.handleRequest(req, res);
  }).listen(Number(process.argv[3]), "127.0.0.1");
} else await server().connect(new StdioServerTransport());
