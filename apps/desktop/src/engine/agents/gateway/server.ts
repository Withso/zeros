// ──────────────────────────────────────────────────────────
// MCP gateway — the in-engine aggregating server
// ──────────────────────────────────────────────────────────
//
// One localhost Streamable-HTTP MCP server that fronts many backend MCP servers.
// It is simultaneously an MCP SERVER (to the agents, on 127.0.0.1:<port>/mcp) and
// an MCP CLIENT (to each backend). On start it connects to every backend, lists
// its tools, and re-exposes the namespaced union (aggregate.ts); a `tools/call`
// for a namespaced name is routed to the owning backend's client.
//
// Runs IN THE ENGINE (bun) — verified: MCP Streamable HTTP is HTTP/1.1 (a
// node:http server inbound + fetch outbound), none of the node:http2 path that
// breaks bun (the reason the Cursor/PTY hosts are Node subprocesses). So no
// subprocess + fully type-checked.
//
// OAuth-protected backends use a per-backend OAuthClientProvider. A backend that
// still needs authorization is recorded as `needs-auth`; the gateway continues
// serving any other connected backends.
//
// SECURITY: bound to 127.0.0.1 only; it holds tokens and must never listen on a
// public interface. Backend URLs are guarded in oauth-url.ts before connection.
// ──────────────────────────────────────────────────────────

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  aggregateTools,
  type BackendToolSet,
  type ToolRoute,
} from "./aggregate";
import { OAuthVault, ZerosOAuthProvider } from "./oauth-provider";
import { canonicalResourceUri, parseAuthorizationCode } from "./oauth-url";
import { safeAuthFetch } from "./safe-fetch";
import { openExternalUrl } from "./open-url";
import type { GatewayBackend } from "../mcp-registry";

const GATEWAY_NAME = "zeros-gateway";
const GATEWAY_VERSION = "0.1.0";

/** Per-backend connection state, for the Settings UI status pill. */
export interface GatewayBackendStatus {
  name: string;
  url: string;
  state: "connected" | "needs-auth" | "error";
  /** Count of ENABLED tools (after the disabled-tools filter) — what agents see. */
  toolCount: number;
  /** ALL tool names the backend exposes (pre-filter), for the allowlist UI. */
  tools?: string[];
  detail?: string;
}

export class McpGateway {
  // Mutable: when constructed with port 0 (ephemeral), the OS-assigned port is
  // written back after listen() so `url`/`callbackUrl` report the real address.
  private port: number;
  private callbackPort: number;
  private readonly openBrowser: (url: string) => void;
  private readonly vault: OAuthVault;
  /** Permit loopback/private backend URLs (off by default — the SSRF guard blocks
   *  them). On only for a local-dev MCP backend or the gateway's own tests. */
  private readonly allowLoopback: boolean;
  private httpServer: http.Server | null = null;
  /** The loopback OAuth-redirect server (RFC 8252), bound on `callbackPort`. */
  private callbackServer: http.Server | null = null;
  /** The single in-flight interactive authorization, if any. */
  private pendingAuth: {
    backend: string;
    resolve: (query: URLSearchParams) => void;
    reject: (err: Error) => void;
  } | null = null;
  /** A headless (paste-code) sign-in in progress — the provider/transport are
   *  kept alive between beginAuthorize (return the URL) and completeAuthorize
   *  (finishAuth with the pasted code), because finishAuth needs the SAME
   *  provider (it holds the PKCE verifier). One at a time. */
  private pendingHeadless: {
    backend: string;
    provider: ZerosOAuthProvider;
    transport: StreamableHTTPClientTransport;
    client: Client;
  } | null = null;
  /** Live agent-facing sessions (the gateway's own MCP server transports). */
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  /** Backend MCP clients, keyed by backend name (the routing target). */
  private readonly backendClients = new Map<string, Client>();
  /** Per-backend call serialization (single-flight). The SDK refreshes tokens
   *  reactively on a 401 with NO single-flight, so two concurrent calls to one
   *  backend whose token just expired would trigger two parallel refreshes — a
   *  rotating-refresh authorization server invalidates the second. Serializing calls per
   *  backend coalesces that; agents call tools sequentially, so the cost is ~nil. */
  private readonly backendLocks = new Map<string, Promise<unknown>>();
  /** The current backend set (for authorize() lookup + reconnect). */
  private backendList: readonly GatewayBackend[] = [];
  /** namespaced tool name → { backend, original tool name }. */
  private route: ReadonlyMap<string, ToolRoute> = new Map();
  /** The aggregated, namespaced tool list served to agents. */
  private aggregated: { name: string }[] = [];
  private statuses: GatewayBackendStatus[] = [];

  constructor(opts: {
    port: number;
    /** Loopback port for the OAuth redirect (RFC 8252) — fixed + registered. */
    callbackPort: number;
    /** Open a URL in the system browser (defaults to the OS opener). */
    openBrowser?: (url: string) => void;
    /** Token vault (pass a persisted one; defaults to in-memory). */
    vault?: OAuthVault;
    /** Allow loopback/private backend URLs (local-dev backends + tests). */
    allowLoopback?: boolean;
  }) {
    this.port = opts.port;
    this.callbackPort = opts.callbackPort;
    this.openBrowser = opts.openBrowser ?? openExternalUrl;
    this.vault = opts.vault ?? new OAuthVault();
    this.allowLoopback = opts.allowLoopback ?? false;
  }

  /** The loopback callback URL the AS redirects to (the registered redirect_uri). */
  private get callbackUrl(): string {
    return `http://127.0.0.1:${this.callbackPort}/callback`;
  }

  /** SSRF guard for every fetch the SDK makes during a backend's OAuth flow — a
   *  malicious backend MUST NOT be able to point discovery/token requests at
   *  internal IPs, NOR escape the guard via an HTTP redirect or a DNS name that
   *  resolves to a private address. `safeAuthFetch` re-validates every hop +
   *  checks DNS resolution + follows redirects manually (safe-fetch.ts). Public
   *  HTTPS only; loopback/private addresses rejected (unless allowLoopback). */
  private readonly guardedFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      // Defensive: the SDK passes (url, init), never a Request — but if it ever
      // does, re-extract the URL + method/headers so the guard still applies.
      const req = input as Request;
      return safeAuthFetch(
        req.url,
        { method: req.method, headers: req.headers, ...init },
        { allowLoopback: this.allowLoopback },
      );
    }
    return safeAuthFetch(input, init, { allowLoopback: this.allowLoopback });
  };

  /** Build an OAuth provider for a backend, keyed by its canonical resource URI. */
  private providerFor(backend: GatewayBackend): ZerosOAuthProvider {
    return new ZerosOAuthProvider({
      vault: this.vault,
      resourceUri: canonicalResourceUri(backend.url),
      redirectUrl: this.callbackUrl,
      clientName: "Zeros",
      openBrowser: this.openBrowser,
      ...(backend.clientId ? { staticClientId: backend.clientId } : {}),
    });
  }

  /** The URL agents connect to. Injected into each agent as one http server. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }
  get running(): boolean {
    return this.httpServer !== null;
  }
  /** Per-backend status for the UI (connected / needs-auth / error + tool count). */
  getStatuses(): readonly GatewayBackendStatus[] {
    return this.statuses;
  }

  /** Bind the local server + the OAuth loopback (idempotent) and connect to
   *  `backends`. */
  async start(backends: readonly GatewayBackend[]): Promise<void> {
    if (!this.callbackServer) await this.bindCallback();
    await this.connectBackends(backends);
    if (!this.httpServer) await this.bind();
  }

  /** Reconnect to a new backend set without dropping the agent-facing server,
   *  so live agent sessions keep their stable gateway endpoint. */
  async reload(backends: readonly GatewayBackend[]): Promise<void> {
    await this.disconnectBackends();
    await this.connectBackends(backends);
  }

  async stop(): Promise<void> {
    if (this.pendingAuth) {
      this.pendingAuth.reject(new Error("gateway stopped"));
      this.pendingAuth = null;
    }
    if (this.pendingHeadless) {
      try {
        await this.pendingHeadless.transport.close();
      } catch {
        /* best-effort */
      }
      this.pendingHeadless = null;
    }
    await this.disconnectBackends();
    for (const t of this.sessions.values()) {
      try {
        await t.close();
      } catch {
        /* best-effort */
      }
    }
    this.sessions.clear();
    for (const srv of [this.httpServer, this.callbackServer]) {
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    this.httpServer = null;
    this.callbackServer = null;
  }

  // ── backends (the gateway as client) ─────────────────────

  private async connectBackends(
    backends: readonly GatewayBackend[],
  ): Promise<void> {
    this.backendList = backends;
    const sets: BackendToolSet[] = [];
    const statuses: GatewayBackendStatus[] = [];
    for (const b of backends) {
      let transport: StreamableHTTPClientTransport;
      if (b.auth === "header") {
        // Static-header backend: the gateway adds the secret header (held in the
        // vault, engine-only) so the agent connects to localhost with no secret.
        // No OAuth/browser; a missing header is just "error" (set it via Edit) —
        // there's no interactive sign-in to fall back to.
        const header = this.vault.getHeader(canonicalResourceUri(b.url));
        if (!header) {
          statuses.push({
            name: b.name,
            url: b.url,
            state: "error",
            toolCount: 0,
            detail: "API key not set — edit the server to add it",
          });
          continue;
        }
        transport = new StreamableHTTPClientTransport(new URL(b.url), {
          // non-secret plain headers (if any), with the brokered secret on top
          requestInit: {
            headers: { ...(b.headers ?? {}), [header.name]: header.value },
          },
          fetch: this.guardedFetch as never,
        });
      } else {
        // PASSIVE OAuth connect: the provider is non-interactive, so a missing/
        // expired token yields UnauthorizedError (no browser) → "needs-auth". A
        // token in the vault (from a prior Sign-in) connects + refreshes.
        const provider = this.providerFor(b);
        transport = new StreamableHTTPClientTransport(new URL(b.url), {
          authProvider: provider,
          fetch: this.guardedFetch as never,
        });
      }
      const client = new Client({
        name: GATEWAY_NAME,
        version: GATEWAY_VERSION,
      });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        this.backendClients.set(b.name, client);
        // Filter out the user's disabled tools (the Cursor 40-cap allowlist);
        // report ALL names for the UI so a disabled tool can be re-enabled.
        const allNames = tools.map((t) => t.name);
        const disabled = new Set(b.disabledTools ?? []);
        const enabled = tools.filter((t) => !disabled.has(t.name));
        sets.push({ server: b.name, tools: enabled });
        statuses.push({
          name: b.name,
          url: b.url,
          state: "connected",
          toolCount: enabled.length,
          tools: allNames,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // No "needs-auth" for header backends — there's no interactive sign-in.
        const needsAuth =
          b.auth !== "header" &&
          (err instanceof UnauthorizedError ||
            /\b401\b|unauthor/i.test(detail));
        statuses.push({
          name: b.name,
          url: b.url,
          state: needsAuth ? "needs-auth" : "error",
          toolCount: 0,
          detail,
        });
        console.warn(
          `[mcp-gateway] backend "${b.name}" ${needsAuth ? "needs auth" : "failed"}: ${detail}`,
        );
        try {
          await transport.close();
        } catch {
          /* best-effort */
        }
      }
    }
    const agg = aggregateTools(sets);
    for (const w of agg.warnings) console.warn(`[mcp-gateway] ${w}`);
    this.aggregated = agg.tools;
    this.route = agg.route;
    this.statuses = statuses;
  }

  /** Run the interactive OAuth flow for one backend: open the system browser,
   *  wait for the loopback redirect, validate state, finish the code exchange
   *  (token → vault), then reconnect all backends from the vault. One sign-in at
   *  a time. The browser only opens here (interactive provider). */
  async authorize(backendName: string): Promise<GatewayBackendStatus> {
    const backend = this.backendList.find((b) => b.name === backendName);
    if (!backend) throw new Error(`unknown gateway backend: ${backendName}`);
    if (this.pendingAuth)
      throw new Error("another MCP sign-in is already in progress");

    const provider = this.providerFor(backend);
    provider.setInteractive(true);
    const transport = new StreamableHTTPClientTransport(new URL(backend.url), {
      authProvider: provider,
      fetch: this.guardedFetch as never,
    });
    const client = new Client({ name: GATEWAY_NAME, version: GATEWAY_VERSION });

    // Arm the loopback BEFORE connecting (the redirect can arrive fast).
    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      this.pendingAuth = { backend: backendName, resolve, reject };
    });
    const timer = setTimeout(
      () =>
        this.pendingAuth?.reject(
          new Error("sign-in timed out (no browser redirect within 5 min)"),
        ),
      5 * 60_000,
    );

    try {
      try {
        await client.connect(transport); // already-valid token? → done, no browser
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
        // The browser was opened by redirectToAuthorization. Await the redirect.
        const query = await callback;
        const oauthError = query.get("error");
        if (oauthError) throw new Error(`authorization denied: ${oauthError}`);
        const code = query.get("code");
        if (!code) throw new Error("authorization callback had no code");
        if (query.get("state") !== provider.expectedState) {
          throw new Error(
            "authorization state mismatch — refusing (possible CSRF)",
          );
        }
        await transport.finishAuth(code); // exchange → vault (saveTokens)
      }
    } finally {
      clearTimeout(timer);
      this.pendingAuth = null;
      provider.setInteractive(false);
      try {
        await client.close();
      } catch {
        /* best-effort — connectBackends rebuilds from the vault below */
      }
    }

    // The token is now in the vault → reconnect every backend from it.
    await this.disconnectBackends();
    await this.connectBackends(this.backendList);
    return (
      this.statuses.find((s) => s.name === backendName) ?? {
        name: backendName,
        url: backend.url,
        state: "error",
        toolCount: 0,
        detail: "sign-in finished but the backend did not reconnect",
      }
    );
  }

  /** Forget a backend's tokens (Disconnect) and reconnect (→ needs-auth). */
  async disconnect(backendName: string): Promise<void> {
    const backend = this.backendList.find((b) => b.name === backendName);
    if (backend) this.vault.clear(canonicalResourceUri(backend.url));
    await this.disconnectBackends();
    await this.connectBackends(this.backendList);
  }

  /** Headless sign-in, step 1: get the authorization URL WITHOUT opening a
   *  browser (no-browser / remote environments). Keeps the provider + transport
   *  alive for completeAuthorize — finishAuth needs the SAME provider (it holds
   *  the PKCE verifier). */
  async beginAuthorize(
    backendName: string,
  ): Promise<{ authorizationUrl: string }> {
    const backend = this.backendList.find((b) => b.name === backendName);
    if (!backend) throw new Error(`unknown gateway backend: ${backendName}`);
    if (this.pendingHeadless) {
      try {
        await this.pendingHeadless.transport.close();
      } catch {
        /* best-effort */
      }
      this.pendingHeadless = null;
    }
    const provider = this.providerFor(backend);
    provider.setInteractive(false); // capture the URL, don't open a browser here
    const transport = new StreamableHTTPClientTransport(new URL(backend.url), {
      authProvider: provider,
      fetch: this.guardedFetch as never,
    });
    const client = new Client({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
    try {
      await client.connect(transport); // already authorized? then no URL is needed
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
      throw new Error("this server is already authorized");
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        try {
          await client.close();
        } catch {
          /* best-effort */
        }
        throw err;
      }
    }
    const url = provider.authorizationUrl;
    if (!url) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
      throw new Error("could not obtain an authorization URL for this server");
    }
    this.pendingHeadless = {
      backend: backendName,
      provider,
      transport,
      client,
    };
    return { authorizationUrl: url };
  }

  /** Headless sign-in, step 2: finish with the code (or the full redirect URL)
   *  the user pasted; validate state when present; then reconnect all backends. */
  async completeAuthorize(
    backendName: string,
    pasted: string,
  ): Promise<GatewayBackendStatus> {
    const pending = this.pendingHeadless;
    if (!pending || pending.backend !== backendName) {
      throw new Error("no pending sign-in for this server — start it again");
    }
    this.pendingHeadless = null;
    try {
      const { code, state } = parseAuthorizationCode(pasted);
      if (state && state !== pending.provider.expectedState) {
        throw new Error(
          "authorization state mismatch — refusing (possible CSRF)",
        );
      }
      await pending.transport.finishAuth(code); // exchange → vault (saveTokens)
    } finally {
      try {
        await pending.client.close();
      } catch {
        /* best-effort — connectBackends rebuilds from the vault below */
      }
    }
    await this.disconnectBackends();
    await this.connectBackends(this.backendList);
    const url = this.backendList.find((b) => b.name === backendName)?.url ?? "";
    return (
      this.statuses.find((s) => s.name === backendName) ?? {
        name: backendName,
        url,
        state: "error",
        toolCount: 0,
        detail: "sign-in finished but the backend did not reconnect",
      }
    );
  }

  // ── OAuth loopback redirect (RFC 8252) ───────────────────

  private async bindCallback(): Promise<void> {
    const server = http.createServer((req, res) =>
      this.handleCallback(req, res),
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      server.once("error", onError);
      server.listen(this.callbackPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    this.callbackPort = (server.address() as AddressInfo).port; // resolve an ephemeral (0) port
    this.callbackServer = server;
  }

  private handleCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    try {
      const u = new URL(
        req.url ?? "/",
        `http://127.0.0.1:${this.callbackPort}`,
      );
      if (u.pathname !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem;text-align:center">' +
          "<h2>Signed in</h2><p>You can close this tab and return to Zeros.</p></body>",
      );
      this.pendingAuth?.resolve(u.searchParams);
    } catch {
      try {
        res.statusCode = 500;
        res.end();
      } catch {
        /* response already gone */
      }
    }
  }

  private async disconnectBackends(): Promise<void> {
    for (const c of this.backendClients.values()) {
      try {
        await c.close();
      } catch {
        /* best-effort */
      }
    }
    this.backendClients.clear();
    this.backendLocks.clear();
    this.route = new Map();
    this.aggregated = [];
  }

  /** Run `fn` after any in-flight call to the same backend completes. The
   *  single-flight lock chain swallows results so one failure never poisons
   *  the queue; the caller still gets `fn`'s real result/rejection. */
  private runOnBackend<T>(server: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.backendLocks.get(server) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn whether the previous call resolved or threw
    this.backendLocks.set(
      server,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // ── agent-facing server ──────────────────────────────────

  private makeServer(): Server {
    const server = new Server(
      { name: GATEWAY_NAME, version: GATEWAY_VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.aggregated as never,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const r = this.route.get(req.params.name);
      if (!r) throw new Error(`unknown tool: ${req.params.name}`);
      const client = this.backendClients.get(r.server);
      if (!client) throw new Error(`backend "${r.server}" is not connected`);
      return (await this.runOnBackend(r.server, () =>
        client.callTool({
          name: r.tool,
          arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
        }),
      )) as never;
    });
    return server;
  }

  private async bind(): Promise<void> {
    const httpServer = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      httpServer.once("error", onError);
      httpServer.listen(this.port, "127.0.0.1", () => {
        httpServer.removeListener("error", onError);
        resolve();
      });
    });
    this.port = (httpServer.address() as AddressInfo).port; // resolve an ephemeral (0) port
    this.httpServer = httpServer;
  }

  /** DNS-rebinding / cross-origin guard for the agent-facing endpoint. The
   *  gateway holds every brokered token and proxies tool calls with no auth, so
   *  the localhost bind is the only barrier — and a browser page that rebinds
   *  its domain to 127.0.0.1 would defeat it. The agents reach us over loopback
   *  with a loopback `Host` and NO `Origin`; a rebinding page still carries its
   *  own domain in Host/Origin. So: require an exact loopback Host, and reject
   *  any Origin that isn't our own loopback. (The node SDK transport has no
   *  built-in rebind guard — only the web-standard variant does — so we add it.)
   */
  private isAllowedRequest(req: http.IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const allowedHosts = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
    ]);
    if (!allowedHosts.has(host)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const o = origin.toLowerCase();
      if (
        o !== `http://127.0.0.1:${this.port}` &&
        o !== `http://localhost:${this.port}`
      )
        return false;
    }
    return true;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (!this.isAllowedRequest(req)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const sid = req.headers["mcp-session-id"];
      let transport: StreamableHTTPServerTransport | undefined =
        typeof sid === "string" ? this.sessions.get(sid) : undefined;
      if (!transport) {
        const t: StreamableHTTPServerTransport =
          new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              this.sessions.set(id, t);
            },
          });
        t.onclose = () => {
          if (t.sessionId) this.sessions.delete(t.sessionId);
        };
        await this.makeServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(
        `[mcp-gateway] request error:`,
        err instanceof Error ? err.message : err,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  }
}
