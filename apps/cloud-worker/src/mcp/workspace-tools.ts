import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, InitializeRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodeReviewError } from "@zeros/protocol/code-review";
import type { AgentToolSet } from "./agent-tools";
import type { DriverMcpServers } from "./gateway";
import { McpRuntimeActivity } from "./runtime-activity";

export interface WorkspaceToolAdmission {
  agentId: string;
  conversationId: string;
  executionId: string;
  /** Review authority: retired by Stop and by review configuration changes. */
  assertCurrent(): void;
  /** Read-only tools: retired only with the native execution itself. */
  assertExecutionCurrent(): void;
}
export interface WorkspaceToolGrant {
  servers: DriverMcpServers;
  /** Whether this grant was admitted with review tools, whose writes Stop must fence. */
  review: boolean;
  revoke(): void;
  dispose(): Promise<void>;
}
export type WorkspaceToolFactory = (input: WorkspaceToolAdmission) => Promise<WorkspaceToolGrant | undefined>;
interface Session { server: Server; transport: StreamableHTTPServerTransport }
interface Entry {
  id: string; credential: string; tools: AgentToolSet; controller: AbortController;
  sessions: Map<string, Session>; pending: Set<Session>; requests: Set<ServerResponse>; flights: Set<Promise<void>>; closing?: Promise<void>;
}
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Product grants are distinct from user-configured upstream MCP. Each grant
 * belongs to one native execution and is withdrawn before shutdown waits. */
export class WorkspaceToolsMcp {
  private origin?: string;
  private listening?: Promise<void>;
  private disposed = false;
  private disposing?: Promise<void>;
  private readonly drains = new Set<Promise<void>>();
  private readonly entries = new Map<string, Entry>();
  private readonly activity: McpRuntimeActivity;
  get runtimeBusy(): boolean {
    return this.activity.busy || this.drains.size > 0 || [...this.entries.values()].some(entry => entry.pending.size > 0);
  }
  private readonly http = createServer((req, res) => { void this.serve(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(400); res.end("Workspace tool request could not complete.");
  }); });

  constructor(admission?: () => Promise<() => void>) {
    this.activity = new McpRuntimeActivity(admission);
    this.http.requestTimeout = 30_000; this.http.headersTimeout = 10_000;
    this.http.keepAliveTimeout = 5_000; this.http.maxRequestsPerSocket = 200;
    this.http.maxConnections = 256;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.activity.http(req, res, () => this.handle(req, res));
  }

  async admit(id: string, tools: AgentToolSet): Promise<WorkspaceToolGrant> {
    tools.assertCurrent();
    if (this.disposed || !/^[a-f0-9-]{36}$/.test(id) || this.entries.has(id) || this.entries.size >= 64)
      throw new Error("Workspace tools are unavailable.");
    const entry: Entry = { id, tools, credential: randomBytes(32).toString("base64url"), controller: new AbortController(), sessions: new Map(), pending: new Set(), requests: new Set(), flights: new Set() };
    this.entries.set(id, entry);
    try {
      if (!this.listening) {
        const listening = new Promise<void>((resolve, reject) => {
          this.http.once("error", reject);
          this.http.listen(0, "127.0.0.1", () => {
            this.http.off("error", reject);
            this.origin = `http://127.0.0.1:${(this.http.address() as { port: number }).port}`;
            resolve();
          });
        }).catch(error => { if (this.listening === listening) this.listening = undefined; throw error; });
        this.listening = listening;
      }
      await this.listening;
      this.assertCurrent(entry);
      return {
        servers: { zeros_workspace: { type: "http", url: `${this.origin}/mcp/${id}`, headers: { Authorization: `Bearer ${entry.credential}` } } },
        review: tools.includesReview !== false,
        revoke: () => { void this.close(entry); },
        dispose: () => this.close(entry),
      };
    } catch (error) { await this.close(entry); throw error; }
  }

  private assertCurrent(entry: Entry): void {
    if (this.disposed || entry.controller.signal.aborted || this.entries.get(entry.id) !== entry)
      throw new Error("Workspace tools have been retired.");
    entry.tools.assertCurrent();
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    if (!req.headers["content-type"]?.includes("application/json")) throw new Error("Invalid tool request.");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) throw new Error("Tool request exceeds the limit.");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    if (this.disposed) { res.writeHead(503).end(); return; }
    if (req.headers.origin || `http://${req.headers.host}` !== this.origin) { res.writeHead(403).end(); return; }
    const id = /^\/mcp\/([a-f0-9-]{36})$/.exec(req.url ?? "")?.[1], entry = id ? this.entries.get(id) : undefined;
    if (!entry) { res.writeHead(404).end(); return; }
    if (!equal(req.headers.authorization ?? "", `Bearer ${entry.credential}`)) { res.writeHead(401).end(); return; }
    if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) { res.writeHead(405).end(); return; }
    if (entry.requests.size >= 32) { res.writeHead(429).end(); return; }
    entry.requests.add(res); res.once("close", () => entry.requests.delete(res));
    const flight = this.dispatch(entry, req, res);
    entry.flights.add(flight);
    try { await flight; } finally { entry.flights.delete(flight); }
  }

  private async dispatch(entry: Entry, req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.assertCurrent(entry);
    const body = req.method === "POST" ? await this.body(req) : undefined;
    this.assertCurrent(entry);
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      const session = typeof sessionId === "string" ? entry.sessions.get(sessionId) : undefined;
      if (!session) { res.writeHead(404).end(); return; }
      await session.transport.handleRequest(req, res, body); return;
    }
    if (req.method !== "POST" || !InitializeRequestSchema.safeParse(body).success) { res.writeHead(400).end(); return; }
    if (entry.sessions.size + entry.pending.size >= 8) { res.writeHead(503).end(); return; }
    const server = new Server({ name: "zeros-workspace", version: "1" }, { capabilities: { tools: {} }, ...(entry.tools.instructions ? { instructions: entry.tools.instructions } : {}) });
    server.setRequestHandler(ListToolsRequestSchema, () => { this.assertCurrent(entry); return { tools: entry.tools.listTools() }; });
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.call(entry, async () => {
      this.assertCurrent(entry);
      try {
        const result = await entry.tools.callTool(request.params.name, request.params.arguments ?? {}, AbortSignal.any([extra.signal, entry.controller.signal]));
        this.assertCurrent(entry);
        return result;
      } catch (error) {
        this.assertCurrent(entry);
        return { isError: true, content: [{ type: "text", text: JSON.stringify(error instanceof CodeReviewError
          ? { code: error.code, message: error.message } : { code: "CODE_REVIEW_UNAVAILABLE", message: "The workspace review request could not complete." }) }] };
      }
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
      onsessioninitialized: key => { entry.pending.delete(session); entry.sessions.set(key, session); },
      onsessionclosed: key => { entry.sessions.delete(key); void server.close().catch(() => {}); },
    });
    this.activity.track(transport);
    const session: Session = { server, transport }; entry.pending.add(session);
    try {
      await server.connect(transport);
      this.assertCurrent(entry);
      await transport.handleRequest(req, res, body);
      this.assertCurrent(entry);
      if (!transport.sessionId) { entry.pending.delete(session); await server.close(); }
    } catch (error) { entry.pending.delete(session); if (transport.sessionId) entry.sessions.delete(transport.sessionId); await server.close().catch(() => {}); throw error; }
  }

  private async call<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    return this.activity.run(async () => {
      const task = Promise.resolve().then(action), flight = task.then(() => {}, () => {});
      entry.flights.add(flight);
      try { return await task; } finally { entry.flights.delete(flight); }
    });
  }

  private close(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.controller.abort();
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    for (const res of entry.requests) res.destroy();
    entry.requests.clear();
    const sessions = [...entry.sessions.values(), ...entry.pending]; entry.sessions.clear(); entry.pending.clear();
    entry.closing = Promise.allSettled([...entry.flights, ...sessions.map(session => session.server.close())]).then(() => {});
    this.drains.add(entry.closing);
    void entry.closing.then(() => this.drains.delete(entry.closing!));
    return entry.closing;
  }

  revoke(): void { for (const entry of this.entries.values()) void this.close(entry); }
  /** Review withdrawal keeps each execution's terminal and diff tools; a set
   * that is only review tools is retired whole, as before. */
  revokeReview(): void {
    for (const entry of this.entries.values()) {
      if (entry.tools.withdrawReview) entry.tools.withdrawReview();
      else void this.close(entry);
    }
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.revoke();
    return this.disposing = (async () => {
      await Promise.all([...this.drains]);
      await this.listening?.catch(() => {});
      this.http.closeAllConnections();
      if (this.http.listening) await new Promise<void>(resolve => this.http.close(() => resolve()));
    })();
  }
}
