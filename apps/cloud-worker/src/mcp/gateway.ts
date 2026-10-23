import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InitializeRequestSchema, ListToolsResultSchema, McpError, ResultSchema, type Notification, type Request, type Result } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RuntimeMcpServerSchema, type RuntimeMcpServer } from "@zeros/protocol/cloud-v2-relay";
import { McpHttpLauncher, resolveMcpCwd } from "./launcher";
import { limitMcpResponse, MAX_MCP_RESPONSE_BYTES } from "./response-limit";

export interface McpAuthorization { headers: Record<string, string>; expiresAt?: number }
export type McpAuthorizationRequest = (id: string, force?: boolean, signal?: AbortSignal) => Promise<McpAuthorization>;
/** Native providers receive only a worker-local capability, never upstream
 * OAuth refresh tokens, API headers or environment secrets. */
export type DriverMcpServers = Record<string, { type: "http"; url: string; headers: Record<string, string> }>;
interface Options { workspaceRoot: string; authorization?: McpAuthorizationRequest; fetch?: FetchLike }
interface Entry {
  config: RuntimeMcpServer; signature: string; credential: string; controller: AbortController;
  authorizationEpoch: number;
  launcher?: McpHttpLauncher; authorization?: McpAuthorization; authorizing?: { force: boolean; controller: AbortController; promise: Promise<McpAuthorization> };
  redactor?: { authorization?: McpAuthorization; pattern: RegExp | null };
  sessions: Set<Session>;
}
interface Session {
  entry: Entry; client: Client<Request, Notification, Result>; server?: Server<Request, Notification, Result>;
  transport?: StreamableHTTPServerTransport; controller: AbortController; closed?: Promise<void>;
}
const failed = () => new McpError(-32603, "MCP request could not complete. Check the server connection.");
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const protocolFields = new Set(["type", "name", "method", "id", "role", "uri", "uriTemplate", "mimeType", "cursor", "nextCursor"]);
const opaqueFields = new Set(["inputSchema", "outputSchema", "data", "blob"]);
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Shared worker boundary for STDIO, launched HTTP and legacy SSE. Connections
 * are lazy and bounded. No OAuth, health or reconnect timer runs while idle. */
export class McpGateway {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Set<Session>();
  private origin?: string;
  private listening?: Promise<void>;
  private authorizationRevision?: string;
  private disposed = false;
  private readonly http = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end("MCP request failed."); }); });

  constructor(private readonly options: Options) {
    this.http.requestTimeout = 30_000; this.http.headersTimeout = 10_000;
    this.http.keepAliveTimeout = 5_000; this.http.maxRequestsPerSocket = 200;
  }

  async configure(servers: readonly RuntimeMcpServer[], authorizationRevision?: string): Promise<void> {
    if (this.disposed) return;
    if (servers.length > 128 || new Set(servers.map(server => server.id)).size !== servers.length) throw new Error("Invalid MCP configuration.");
    const parsed = servers.map(server => RuntimeMcpServerSchema.parse(server));
    const next = new Map<string, Entry>();
    for (const config of parsed) {
      const signature = JSON.stringify(config), previous = this.entries.get(config.id);
      if (previous?.signature === signature) { next.set(config.id, previous); continue; }
      if (config.transport !== "stdio") {
        const url = new URL(config.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid MCP endpoint.");
        new Headers(config.headers);
      }
      next.set(config.id, { config, signature, credential: randomBytes(32).toString("base64url"), controller: new AbortController(), authorizationEpoch: 0, sessions: new Set(),
        ...(config.transport === "stdio" && config.listen_url ? { launcher: new McpHttpLauncher({ ...config, workspaceRoot: this.options.workspaceRoot, listenUrl: config.listen_url }) } : {}) });
    }
    // Constructors validate launch/endpoints without starting anything. Only a
    // complete valid replacement can withdraw existing connections/secrets.
    if (authorizationRevision !== this.authorizationRevision) {
      for (const entry of next.values()) {
        entry.authorizing?.controller.abort();
        entry.authorizationEpoch++; entry.authorization = undefined; entry.authorizing = undefined; entry.redactor = undefined;
      }
      this.authorizationRevision = authorizationRevision;
    }
    const removed = [...this.entries.values()].filter(entry => next.get(entry.config.id) !== entry);
    for (const entry of removed) entry.controller.abort();
    this.entries.clear(); for (const [id, entry] of next) this.entries.set(id, entry);
    await Promise.all(removed.map(entry => this.closeEntry(entry)));
  }

  async providers(): Promise<DriverMcpServers> {
    if (this.disposed) throw new Error("MCP gateway is closed.");
    if (!this.entries.size) return {};
    this.listening ??= new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", () => {
        this.http.off("error", reject);
        this.origin = `http://127.0.0.1:${(this.http.address() as { port: number }).port}`;
        resolve();
      });
    });
    await this.listening;
    if (this.disposed) throw new Error("MCP gateway is closed.");
    return Object.fromEntries([...this.entries.values()].map(entry => [
      `${entry.config.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0,80)}_${entry.config.id.replaceAll("-", "")}`,
      { type: "http" as const, url: `${this.origin}/mcp/${entry.config.id}`, headers: { Authorization: `Bearer ${entry.credential}` } },
    ]));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    if (this.disposed) { res.writeHead(503).end(); return; }
    if (req.headers.origin || `http://${req.headers.host}` !== this.origin) { res.writeHead(403).end(); return; }
    const id = /^\/mcp\/([a-f0-9-]{36})$/.exec(req.url ?? "")?.[1], entry = id ? this.entries.get(id) : undefined;
    if (!entry) { res.writeHead(404).end(); return; }
    if (!equal(req.headers.authorization ?? "", `Bearer ${entry.credential}`)) { res.writeHead(401).end(); return; }
    if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) { res.writeHead(405).end(); return; }
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      const session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
      if (!session || session.entry !== entry || session.closed) { res.writeHead(404).end(); return; }
      await session.transport!.handleRequest(req, res, req.method === "POST" ? await this.body(req) : undefined);
      return;
    }
    if (req.method !== "POST") { res.writeHead(400).end(); return; }
    const body = await this.body(req), initialize = InitializeRequestSchema.safeParse(body);
    if (!initialize.success) { res.writeHead(400).end(); return; }
    if (this.sessions.size + this.pending.size >= 256 || entry.sessions.size >= 16) { res.writeHead(503).end(); return; }
    const session: Session = { entry, controller: new AbortController(), client: new Client({ name: "zeros-worker", version: "1.0.0" }, { capabilities: initialize.data.params.capabilities }) };
    this.pending.add(session); entry.sessions.add(session);
    const deadline = setTimeout(() => session.controller.abort(), 20_000); deadline.unref();
    const abort = () => { if (!res.writableEnded) session.controller.abort(); };
    res.once("close", abort);
    try {
      const signal = AbortSignal.any([entry.controller.signal, session.controller.signal, AbortSignal.timeout(20_000)]);
      await entry.launcher?.ensureRunning(signal);
      signal.throwIfAborted();
      const config = entry.config;
      const upstream = config.transport === "stdio" && !entry.launcher ? new StdioClientTransport({ command: config.command, args: config.args,
        env: config.env, cwd: resolveMcpCwd(config.cwd, this.options.workspaceRoot), stderr: "ignore", maxBufferSize: MAX_MCP_RESPONSE_BYTES })
        : config.transport === "sse" ? new SSEClientTransport(new URL(config.url), { fetch: this.fetch(entry, session) })
        : new StreamableHTTPClientTransport(new URL(entry.launcher?.endpoint ?? (config.transport !== "stdio" ? config.url : "")), {
          fetch: this.fetch(entry, session), reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
        });
      await session.client.connect(upstream, { signal, timeout: 20_000 });
      signal.throwIfAborted();
      const server = new Server<Request, Notification, Result>({ name: config.name, version: "1.0.0" }, {
        capabilities: session.client.getServerCapabilities() ?? {}, instructions: this.redact(entry, { instructions: session.client.getInstructions() }).instructions,
      });
      session.server = server;
      const disabled = new Set(config.transport === "stdio" ? [] : config.disabled_tools ?? []);
      server.fallbackRequestHandler = async (request, extra) => {
        if (request.method === "tools/call" && disabled.has(String(request.params?.name))) throw new McpError(-32602, "This MCP tool is disabled.");
        try {
          const result = await session.client.request(request, ResultSchema, { signal: extra.signal, timeout: 120_000, maxTotalTimeout: 120_000 });
          if (request.method === "tools/list") {
            const list = ListToolsResultSchema.parse(result);
            return this.redact(entry, { ...list, tools: list.tools.filter(tool => !disabled.has(tool.name)) });
          }
          return this.redact(entry, result);
        } catch { throw failed(); }
      };
      session.client.fallbackRequestHandler = async (request, extra) => {
        try { return await server.request(request, ResultSchema, { signal: extra.signal, timeout: 120_000 }); }
        catch { throw failed(); }
      };
      server.fallbackNotificationHandler = notification => session.client.notification(notification).catch(() => {});
      session.client.fallbackNotificationHandler = notification => server.notification(this.redact(entry, notification)).catch(() => {});
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: sessionId => { this.pending.delete(session); this.sessions.set(sessionId, session); },
        onsessionclosed: () => { void this.closeSession(session); },
      });
      session.transport = transport;
      session.client.onclose = () => { void this.closeSession(session); };
      // In particular, stop legacy EventSource's automatic reconnect loop.
      session.client.onerror = () => { void this.closeSession(session); };
      server.onclose = () => { void this.closeSession(session); };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      if (!transport.sessionId) await this.closeSession(session);
    } catch {
      await this.closeSession(session);
      if (!res.headersSent) res.writeHead(502);
      res.end("MCP connection failed. Check the server connection.");
    } finally { clearTimeout(deadline); res.off("close", abort); }
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    if (!req.headers["content-type"]?.includes("application/json")) throw failed();
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk); if (size > 1024 * 1024) throw failed();
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async authorization(entry: Entry, force: boolean, signal: AbortSignal): Promise<McpAuthorization> {
    signal.throwIfAborted();
    const active = entry.authorizing;
    if (active) {
      if (force && !active.force) { await untilAborted(active.promise, signal); return this.authorization(entry, true, signal); }
      return untilAborted(active.promise, signal);
    }
    if (!force && entry.authorization && (entry.authorization.expiresAt ?? 0) > Date.now() + 30_000) return entry.authorization;
    const authorize = this.options.authorization;
    if (!authorize) throw failed();
    // Credential work belongs to the entry. A caller may leave while another
    // live session still needs the same read or rotating-token renewal.
    const epoch = entry.authorizationEpoch, controller = new AbortController();
    const sharedSignal = AbortSignal.any([entry.controller.signal, controller.signal]);
    const deadline = setTimeout(() => controller.abort(), 30_000); deadline.unref();
    const flight = untilAborted(Promise.resolve().then(() => {
      sharedSignal.throwIfAborted();
      return authorize(entry.config.id, force, sharedSignal);
    }), sharedSignal).then(value => {
      sharedSignal.throwIfAborted();
      if (entry.authorizationEpoch !== epoch) throw failed();
      if (Object.keys(value.headers).length > 128 || Object.entries(value.headers).some(([key, val]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof val !== "string" || /[\r\n\0]/.test(val) || val.length > 16384)) throw failed();
      return entry.authorization = { headers: value.headers, expiresAt: Math.min(value.expiresAt ?? Date.now() + 300_000, Date.now() + 300_000) };
    }).finally(() => { clearTimeout(deadline); if (entry.authorizing?.promise === flight) entry.authorizing = undefined; });
    entry.authorizing = { force, controller, promise: flight };
    return untilAborted(flight, signal);
  }

  private fetch(entry: Entry, session: Session): FetchLike {
    return async (input, init) => {
      const request = new Request(input, init), config = entry.config;
      const endpoint = new URL(entry.launcher?.endpoint ?? (config.transport !== "stdio" ? config.url : ""));
      if (new URL(request.url).origin !== endpoint.origin) throw failed();
      const signal = AbortSignal.any([request.signal, entry.controller.signal, session.controller.signal]);
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
      const oauth = config.transport !== "stdio" && config.auth === "oauth";
      let authorization = oauth ? await this.authorization(entry, false, signal) : undefined;
      const send = async () => {
        signal.throwIfAborted();
        if (oauth && entry.authorization !== authorization) throw failed();
        const headers = new Headers(request.headers);
        for (const [name, value] of Object.entries(authorization?.headers ?? (config.transport !== "stdio" ? config.headers ?? {} : {}))) headers.set(name, value);
        const response = await (this.options.fetch ?? fetch)(request.url, { method: request.method, ...(body === undefined ? {} : { body }), headers, redirect: "manual", signal });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw failed(); }
        return limitMcpResponse(response, signal);
      };
      let response = await send();
      if (oauth && response.status === 401) {
        await response.body?.cancel();
        authorization = entry.authorization !== authorization ? await this.authorization(entry, false, signal) : await this.authorization(entry, true, signal);
        response = await send();
      }
      return response;
    };
  }

  private redact<T>(entry: Entry, value: T): T {
    if (!entry.redactor || entry.redactor.authorization !== entry.authorization) {
      const config = entry.config;
      const secrets = [...new Set([...Object.values(config.transport === "stdio" ? config.env ?? {} : config.headers ?? {}), ...Object.values(entry.authorization?.headers ?? {})]
        .flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]).filter(Boolean))].sort((a,b) => b.length - a.length);
      entry.redactor = { authorization: entry.authorization,
        pattern: secrets.length ? new RegExp(secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null };
    }
    const pattern = entry.redactor.pattern;
    // Protocol identifiers, schemas and binary payloads must remain usable.
    // Redaction is for returned content, not a sandbox for a trusted server.
    const opaque = new WeakSet<object>();
    const json = JSON.stringify(value, function (this: object, key, field) {
      if (opaque.has(this) || opaqueFields.has(key)) {
        if (field && typeof field === "object") opaque.add(field);
        return field;
      }
      if (protocolFields.has(key)) return field;
      if (typeof field !== "string" || !pattern) return field;
      let bytes = Buffer.byteLength(field);
      return field.replace(pattern, match => {
        bytes += 10 - Buffer.byteLength(match);
        if (bytes > MAX_MCP_RESPONSE_BYTES) throw failed();
        return "[redacted]";
      });
    });
    if (Buffer.byteLength(json) > MAX_MCP_RESPONSE_BYTES) throw failed();
    return JSON.parse(json) as T;
  }

  private closeSession(session: Session): Promise<void> {
    if (session.closed) return session.closed;
    session.controller.abort(); this.pending.delete(session); session.entry.sessions.delete(session);
    if (session.transport?.sessionId) this.sessions.delete(session.transport.sessionId);
    return session.closed = Promise.resolve().then(async () => { await Promise.allSettled([session.server?.close(), session.client.close()]); });
  }
  private async closeEntry(entry: Entry): Promise<void> {
    entry.controller.abort();
    await Promise.all([...entry.sessions].map(session => this.closeSession(session)));
    await entry.launcher?.dispose();
    entry.authorization = undefined;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.entries.values()].map(entry => this.closeEntry(entry)));
    this.entries.clear();
    await this.listening?.catch(() => {});
    this.http.closeAllConnections();
    if (this.http.listening) await new Promise<void>(resolve => this.http.close(() => resolve()));
  }
}
