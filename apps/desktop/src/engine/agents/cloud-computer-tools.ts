import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CLOUD_COMPUTER_TOOLS_SERVER,
  CloudComputerToolArgumentsSchemas,
  CloudComputerToolConflictSchema,
  CloudComputerToolRequestSchema,
} from "@zeros/protocol/cloud-computer-tools";
import type { CloudAgentLease } from "./cloud-agent-lease";
import type { McpServerRegistration } from "./types";

const descriptions = {
  ListComputers: "List this admin workspace's organization computer and capabilities.",
  GetComputerConfiguration: "Read computer scripts, repositories, revision and environment names. Saved environment values are never returned.",
  CreateComputerConfiguration: "Save the install script and explicitly start or replace a build. Refresh and review on conflict; preserve repositories and environment references.",
  GetComputerBuildStatus: "Read a build's state and last 200 redacted log lines; pass the cursor as after when polling.",
  UpdateRepositorySetupScript: "Replace a selected repository's cloud setup script without rebuilding the computer.",
};
const tools = Object.entries(CloudComputerToolArgumentsSchemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: z.toJSONSchema(schema, { target: "draft-7" }),
}));
function finish(response: http.ServerResponse, status: number) {
  if (!response.headersSent) {
    response.statusCode = status;
    response.setHeader("Cache-Control", "no-store");
  }
  if (!response.writableEnded) response.end();
}
const failure = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** An engine-owned loopback capability, created after CP admission and owned
 * by exactly one execution lease. It never enters the global MCP registry. */
export class CloudComputerMcpServer {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly initializing = new Set<StreamableHTTPServerTransport>();
  private httpServer: http.Server | null = null;
  private port = 0;
  private stopped = false;
  private activeRequests = 0;
  private activeTools = 0;
  private constructor(private readonly lease: CloudAgentLease) {}

  static async start(lease: CloudAgentLease): Promise<CloudComputerMcpServer> {
    if (lease.computerToolsVersion !== 1) throw new Error("Cloud Computer tools require an admitted admin workspace.");
    lease.assertLive();
    const owner = new CloudComputerMcpServer(lease);
    const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5000, maxHeaderSize: 16_384 },
      (request, response) => { void owner.handle(request, response); });
    server.maxConnections = 32;
    owner.httpServer = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
      });
      owner.port = (server.address() as AddressInfo).port;
      lease.assertLive();
      return owner;
    } catch (error) { await owner.stopAndProve(); throw error; }
  }

  get registration(): Extract<McpServerRegistration, { transport: "http" }> {
    this.assertLive();
    return { name: CLOUD_COMPUTER_TOOLS_SERVER, transport: "http", url: `http://127.0.0.1:${this.port}/mcp`,
      headers: { Authorization: `Bearer ${this.token}` } };
  }
  private assertLive() {
    if (this.stopped) throw new Error("Cloud Computer tools are retired.");
    this.lease.assertLive();
  }
  async stopAndProve(): Promise<void> {
    this.stopped = true;
    const server = this.httpServer;
    this.httpServer = null;
    const transports = [...this.sessions.values(), ...this.initializing];
    this.sessions.clear(); this.initializing.clear();
    await Promise.allSettled(transports.map(transport => transport.close()));
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  private makeServer(sessionId: string): Server {
    const server = new Server({ name: CLOUD_COMPUTER_TOOLS_SERVER, version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => { this.assertLive(); return { tools: tools as never }; });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = CloudComputerToolRequestSchema.safeParse({ name: request.params.name, arguments: request.params.arguments ?? {} });
      if (!tool.success) return failure("Invalid Cloud Computer tool arguments.");
      if (this.activeTools >= 8) return failure("Cloud Computer tools are busy; wait for an active request to finish.");
      this.activeTools++;
      try {
        this.assertLive();
        // The native MCP session + JSON-RPC call ID distinguishes identical
        // calls and is stable on transport replay. Never use prompt or args.
        const toolCallId = JSON.stringify([sessionId, extra.requestId]);
        const result = await this.lease.computerTool(toolCallId, tool.data, extra.signal);
        this.assertLive();
        const conflict = CloudComputerToolConflictSchema.safeParse(result).success;
        return { ...(conflict ? { isError: true } : {}), structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch { return failure("Cloud Computer tool authority is unavailable. Refresh the workspace before retrying."); }
      finally { this.activeTools--; }
    });
    return server;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let created: StreamableHTTPServerTransport | undefined;
    try {
      const host = request.headers.host;
      const origin = request.headers.origin;
      const expected = Buffer.from(`Bearer ${this.token}`), received = Buffer.from(request.headers.authorization ?? "");
      if (request.url !== "/mcp" || (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) ||
        (origin !== undefined && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) ||
        expected.length !== received.length || !timingSafeEqual(expected, received)) {
        request.resume(); finish(response, origin ? 403 : 401); return;
      }
      this.assertLive();
      const sessionId = request.headers["mcp-session-id"];
      if (Array.isArray(sessionId)) { request.resume(); finish(response, 400); return; }
      let transport = sessionId ? this.sessions.get(sessionId) : undefined;
      if (sessionId && !transport) { request.resume(); finish(response, 404); return; }
      if (!transport && request.method !== "POST") { request.resume(); finish(response, 400); return; }
      if (this.activeRequests >= 16) { request.resume(); finish(response, 429); return; }
      let body: unknown;
      if (request.method === "POST") {
        this.activeRequests++;
        try {
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 131_072) { request.resume(); finish(response, 413); return; }
            chunks.push(Buffer.from(chunk));
          }
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch { finish(response, 400); return; }
        finally { this.activeRequests--; }
      }
      this.assertLive();
      if (!transport) {
        if (this.sessions.size + this.initializing.size >= 8) { finish(response, 429); return; }
        const id = randomUUID();
        const next: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => id, enableJsonResponse: true,
          onsessioninitialized: () => { this.assertLive(); this.initializing.delete(next); this.sessions.set(id, next); },
        });
        created = next; this.initializing.add(next);
        await this.makeServer(id).connect(next);
        next.onclose = () => { this.initializing.delete(next); this.sessions.delete(id); };
        transport = next;
      }
      response.setHeader("Cache-Control", "no-store");
      await transport.handleRequest(request, response, body);
    } catch { request.resume(); finish(response, this.stopped || this.lease.signal.aborted ? 401 : 503); }
    finally {
      if (created && (!created.sessionId || !this.sessions.has(created.sessionId))) {
        this.initializing.delete(created); await created.close().catch(() => {});
      }
    }
  }
}
