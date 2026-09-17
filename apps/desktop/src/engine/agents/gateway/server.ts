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
import { isDeepStrictEqual } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  aggregateTools,
  type BackendToolSet,
  type ToolRoute,
  type McpToolLike,
} from "./aggregate";
import { OAuthVault, ZerosOAuthProvider } from "./oauth-provider";
import { canonicalResourceUri, parseAuthorizationCode } from "./oauth-url";
import { safeAuthFetch } from "./safe-fetch";
import { CatalogClient } from "./list-tools";
import { openExternalUrl } from "./open-url";
import type { GatewayBackend } from "../mcp-registry";

type BackendTransport = StreamableHTTPClientTransport | SSEClientTransport;

interface BackendCatalog {
  backend: GatewayBackend;
  client: Client;
  revision: number;
  signal: AbortSignal;
  tools: McpToolLike[];
  available: boolean;
  dirty: boolean;
  refreshing: boolean;
}

const GATEWAY_NAME = "zeros-gateway";
const GATEWAY_VERSION = "0.1.0";

/** OAuth discovery/token fetches share the SDK's fetch callback. Resource
 * headers belong only on the MCP endpoint or its same-origin SSE RPC POSTs. */
function isBackendMcpRequest(backend: GatewayBackend, input: string | URL | Request, init?: RequestInit): boolean {
  const resource = new URL(backend.url);
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== resource.origin) return false;
  if (url.pathname === resource.pathname && url.search === resource.search) return true;
  if (backend.transport !== "sse" || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return false;
  try {
    const message: unknown = JSON.parse(init.body);
    const isRpc = (value: unknown) => typeof value === "object" && value !== null && "jsonrpc" in value && value.jsonrpc === "2.0";
    return Array.isArray(message) ? message.length > 0 && message.every(isRpc) : isRpc(message);
  } catch { return false; }
}

function isUnauthorizedTransport(error: unknown): boolean {
  return error instanceof UnauthorizedError ||
    ((error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401) ||
    // The installed SSE SDK loses the status type on POST failures without an
    // OAuth provider. Match only its transport prefix, never tool-result text.
    (error instanceof Error && /^Error POSTing to endpoint \(HTTP 401\):/.test(error.message));
}

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
  private authFlight: {
    backend: GatewayBackend;
    provider: ZerosOAuthProvider;
    transport: BackendTransport;
    client: Client;
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
    callback: Promise<URLSearchParams>;
    resolve: (query: URLSearchParams) => void;
    reject: (error: Error) => void;
    headless: boolean;
  } | null = null;
  private connectionRevision = 0;
  private operationRevision = 0;
  private readonly connectionProviders = new Set<ZerosOAuthProvider>();
  /** Live agent-facing sessions (the gateway's own MCP server transports). */
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly readyServers = new Set<Server>();
  /** Backend MCP clients, keyed by backend name (the routing target). */
  private readonly backendClients = new Map<string, Client>();
  private readonly connectingClients = new Set<Client>();
  private backendCatalogs = new Map<string, BackendCatalog>();
  private connectionAbort: AbortController | null = null;
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
  private readonly catalogGeneration = randomUUID();
  private catalogVersion = 0;
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
    sensitiveHeaders?: readonly string[],
  ): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      // Defensive: the SDK passes (url, init), never a Request — but if it ever
      // does, re-extract the URL + method/headers so the guard still applies.
      const req = input as Request;
      return safeAuthFetch(
        req.url,
        { method: req.method, headers: req.headers, ...init },
        { allowLoopback: this.allowLoopback, sensitiveHeaders },
      );
    }
    return safeAuthFetch(input, init, { allowLoopback: this.allowLoopback, sensitiveHeaders });
  };

  /** Every backend path (including both sign-in flows) uses the declared
   * transport. The guarded fetch covers SSE GETs, POSTs, and OAuth discovery. */
  private backendTransport(
    backend: GatewayBackend,
    options: Pick<StreamableHTTPClientTransportOptions, "requestInit" | "authProvider">,
    signal?: AbortSignal,
  ): BackendTransport {
    const resourceHeaders = new Headers(backend.headers);
    new Headers(options.requestInit?.headers).forEach((value, name) => resourceHeaders.set(name, value));
    // The selected OAuth credential owns Authorization, including before login.
    if (options.authProvider) resourceHeaders.delete("authorization");
    const sensitiveHeaders = [...resourceHeaders.keys()];
    const config = {
      ...options,
      // requestInit is also inherited by the SDK's OAuth fetch wrapper. Inject
      // resource headers at the final MCP request boundary instead.
      requestInit: { ...options.requestInit, headers: undefined },
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        if (isBackendMcpRequest(backend, input, init)) {
          const headers = new Headers(resourceHeaders);
          const nativeHeaders = init?.headers ?? (typeof input === "object" && !(input instanceof URL) ? input.headers : undefined);
          new Headers(nativeHeaders).forEach((value, name) => headers.set(name, value));
          init = { ...init, headers };
        }
        return this.guardedFetch(input, signal ? { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : init, sensitiveHeaders);
      },
    };
    return backend.transport === "sse"
      ? new SSEClientTransport(new URL(backend.url), config)
      : new StreamableHTTPClientTransport(new URL(backend.url), config);
  }

  private async connectBackend(client: Client, transport: BackendTransport): Promise<void> {
    // The SDK's request timeout starts after transport.start(). An open SSE
    // stream with no endpoint event otherwise leaves startup waiting forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${transport instanceof SSEClientTransport ? "SSE" : "HTTP"} MCP connection timed out`)), 15_000);
        }),
      ]);
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build an OAuth provider for a backend, keyed by its canonical resource URI. */
  private providerFor(backend: GatewayBackend): ZerosOAuthProvider {
    return new ZerosOAuthProvider({
      vault: this.vault,
      resourceUri: canonicalResourceUri(backend.url),
      redirectUrl: this.callbackUrl,
      clientName: "Zeros",
      openBrowser: this.openBrowser,
      ...(backend.clientId ? { staticClientId: backend.clientId } : {}),
      ...(backend.scopes?.length ? { scope: [...new Set(backend.scopes)].sort().join(" ") } : {}),
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

  /** Changes only with a committed tool/schema change, including withdrawal.
   * The generation prevents a new listener on the same URL reusing an SDK cache. */
  get catalogRevision(): string {
    return `${this.catalogGeneration}:${this.catalogVersion}`;
  }

  /** Bind the local server + the OAuth loopback (idempotent) and connect to
   *  `backends`. */
  async start(backends: readonly GatewayBackend[]): Promise<void> {
    if (this.httpServer) return this.reload(backends);
    const operation = ++this.operationRevision;
    if (!this.callbackServer) await this.bindCallback();
    if (operation !== this.operationRevision) return;
    await this.connectBackends(backends);
    if (operation !== this.operationRevision) return;
    if (!this.httpServer) await this.bind();
  }

  /** Reconnect to a new backend set without dropping the agent-facing server,
   *  so live agent sessions keep their stable gateway endpoint. */
  async reload(backends: readonly GatewayBackend[]): Promise<void> {
    const operation = ++this.operationRevision;
    await this.cancelAuthorization();
    if (operation !== this.operationRevision) return;
    await this.disconnectBackends();
    if (operation !== this.operationRevision) return;
    await this.connectBackends(backends);
  }
  async reconnect(): Promise<void> { await this.reload(this.backendList); }

  async stop(): Promise<void> {
    this.operationRevision++;
    await this.cancelAuthorization();
    await this.disconnectBackends();
    for (const t of this.sessions.values()) {
      try {
        await t.close();
      } catch {
        /* best-effort */
      }
    }
    this.sessions.clear();
    this.readyServers.clear();
    this.aggregated = [];
    this.route = new Map();
    this.statuses = [];
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
    const revision = ++this.connectionRevision;
    this.connectionAbort?.abort();
    const abort = new AbortController();
    this.connectionAbort = abort;
    const catalogs = new Map<string, BackendCatalog>();
    const statuses: GatewayBackendStatus[] = [];
    for (const b of backends) {
      if (revision !== this.connectionRevision) return;
      let transport: BackendTransport | undefined;
      const client = new CatalogClient({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
      const catalog: BackendCatalog = { backend: b, client, revision, signal: abort.signal,
        tools: [], available: true, dirty: false, refreshing: false };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        catalog.dirty = true;
        // Before initial publication, remember the event and revalidate after
        // the whole connection generation has committed its first snapshot.
        void this.refreshBackendCatalog(catalog);
      });
      try {
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
          transport = this.backendTransport(b, {
            // non-secret plain headers (if any), with the brokered secret on top
            requestInit: {
              headers: { [header.name]: header.value },
            },
          }, abort.signal);
        } else {
          // PASSIVE OAuth connect: the provider is non-interactive, so a missing/
          // expired token yields UnauthorizedError (no browser) → "needs-auth". A
          // token in the vault (from a prior Sign-in) connects + refreshes.
          const provider = this.providerFor(b);
          this.connectionProviders.add(provider);
          transport = this.backendTransport(b, {
            authProvider: provider,
          }, abort.signal);
        }
        this.connectingClients.add(client);
        await this.connectBackend(client, transport);
        const { tools } = await client.listTools(undefined, { signal: abort.signal });
        if (revision !== this.connectionRevision) {
          this.connectingClients.delete(client);
          await client.close();
          return;
        }
        // Filter out the user's disabled tools (the Cursor 40-cap allowlist);
        // report ALL names for the UI so a disabled tool can be re-enabled.
        const allNames = tools.map((t) => t.name);
        catalog.tools = tools;
        catalogs.set(b.name, catalog);
        const enabled = tools.filter((t) => !b.disabledTools?.includes(t.name));
        statuses.push({
          name: b.name,
          url: b.url,
          state: "connected",
          toolCount: enabled.length,
          tools: allNames,
        });
      } catch (err) {
        this.connectingClients.delete(client);
        const detail = err instanceof Error ? err.message : String(err);
        // No "needs-auth" for header backends — there's no interactive sign-in.
        const needsAuth =
          b.auth !== "header" &&
          isUnauthorizedTransport(err);
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
          await client.close();
          await transport?.close();
        } catch {
          /* best-effort */
        }
      }
    }
    if (revision !== this.connectionRevision) return;
    // Requests see either the retired generation (disconnected) or this whole
    // replacement. Never route old tool metadata into a newly staged client.
    this.backendClients.clear();
    for (const catalog of catalogs.values()) {
      this.connectingClients.delete(catalog.client);
      this.backendClients.set(catalog.backend.name, catalog.client);
    }
    this.backendCatalogs = catalogs;
    this.statuses = statuses;
    this.publishCatalog();
    for (const catalog of catalogs.values()) {
      if (catalog.dirty) void this.refreshBackendCatalog(catalog);
    }
  }

  private catalogCurrent(catalog: BackendCatalog): boolean {
    return !catalog.signal.aborted && catalog.revision === this.connectionRevision &&
      this.backendCatalogs.get(catalog.backend.name) === catalog &&
      this.backendClients.get(catalog.backend.name) === catalog.client;
  }

  /** Commit metadata, routes and statuses before notifying a connected agent.
   * Reconnecting an unchanged set must not make every chat rediscover tools. */
  private publishCatalog(): void {
    const sets: BackendToolSet[] = [];
    for (const backend of this.backendList) {
      const catalog = this.backendCatalogs.get(backend.name);
      if (!catalog?.available) continue;
      const disabled = new Set(backend.disabledTools ?? []);
      sets.push({ server: backend.name, tools: catalog.tools.filter((tool) => !disabled.has(tool.name)) });
    }
    const aggregate = aggregateTools(sets);
    for (const warning of aggregate.warnings) console.warn(`[mcp-gateway] ${warning}`);
    const changed = !isDeepStrictEqual(this.aggregated, aggregate.tools);
    this.aggregated = aggregate.tools;
    this.route = aggregate.route;
    if (changed) {
      this.catalogVersion++;
      for (const server of this.readyServers) void server.sendToolListChanged().catch(() => {
        // A disconnected agent cannot prevent publication to the others.
      });
    }
  }

  /** One read per backend, coalescing notifications received while it is in
   * flight. A superseded read never publishes an intermediate stale catalog. */
  private async refreshBackendCatalog(catalog: BackendCatalog): Promise<void> {
    if (!this.catalogCurrent(catalog) || catalog.refreshing) return;
    catalog.refreshing = true;
    try {
      do {
        catalog.dirty = false;
        try {
          const { tools } = await this.runOnBackend(catalog.backend.name, () => {
            catalog.signal.throwIfAborted();
            return catalog.client.listTools(undefined, { signal: catalog.signal });
          });
          if (!this.catalogCurrent(catalog)) return;
          if (catalog.dirty) continue;
          catalog.tools = tools;
          catalog.available = true;
          const names = tools.map((tool) => tool.name);
          this.statuses = this.statuses.map((status) => status.name === catalog.backend.name ? {
            name: status.name, url: status.url, state: "connected",
            toolCount: names.filter((name) => !catalog.backend.disabledTools?.includes(name)).length,
            tools: names,
          } : status);
          this.publishCatalog();
        } catch (error) {
          if (!this.catalogCurrent(catalog)) return;
          const unauthorized = isUnauthorizedTransport(error);
          if (unauthorized) catalog.available = false;
          this.statuses = this.statuses.map((status) => status.name === catalog.backend.name ? {
            ...status,
            ...(unauthorized ? { state: catalog.backend.auth === "oauth" ? "needs-auth" as const : "error" as const, toolCount: 0 } : {}),
            detail: `Could not refresh tools: ${error instanceof Error ? error.message : String(error)}`,
          } : status);
          // Transient refresh failures retain the last confirmed snapshot;
          // revoked access withdraws tools until an authorized refresh succeeds.
          if (unauthorized) this.publishCatalog();
        }
      } while (catalog.dirty && this.catalogCurrent(catalog));
    } finally { catalog.refreshing = false; }
  }

  private startAuthorization(backendName: string, headless: boolean) {
    if (this.authFlight) throw new Error("Another MCP sign-in is already in progress.");
    const backend = this.backendList.find((b) => b.name === backendName);
    if (!backend || backend.auth !== "oauth") throw new Error("This server is not configured for OAuth.");
    const provider = this.providerFor(backend);
    provider.setInteractive(!headless);
    const abort = new AbortController();
    const transport = this.backendTransport(backend, { authProvider: provider }, abort.signal);
    const client = new Client({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
    let resolve!: (query: URLSearchParams) => void;
    let reject!: (error: Error) => void;
    const callback = new Promise<URLSearchParams>((yes, no) => { resolve = yes; reject = no; });
    // Cancellation can arrive during discovery, before the callback is awaited.
    void callback.catch(() => {});
    const flight = { backend, provider, transport, client, abort, callback, resolve, reject, headless,
      timer: setTimeout(() => { if (this.authFlight === flight) void this.cancelAuthorization(backendName); }, 5 * 60_000) };
    this.authFlight = flight;
    return flight;
  }

  /** Cancels both browser and paste-code flows, including an in-flight exchange.
   * A cancelled provider cannot save a late token response into the vault. */
  async cancelAuthorization(backendName?: string): Promise<void> {
    const flight = this.authFlight;
    if (!flight || (backendName && flight.backend.name !== backendName)) return;
    this.authFlight = null;
    clearTimeout(flight.timer);
    flight.provider.cancel();
    flight.abort.abort();
    flight.reject(new Error("MCP sign-in cancelled. Start sign-in again."));
    await flight.transport.close().catch(() => {});
    await flight.client.close().catch(() => {});
  }

  private assertFlight(flight: NonNullable<McpGateway["authFlight"]>): void {
    if (this.authFlight !== flight) throw new Error("MCP sign-in was cancelled. Start sign-in again.");
  }

  private async finishAuthorization(flight: NonNullable<McpGateway["authFlight"]>): Promise<GatewayBackendStatus> {
    this.assertFlight(flight);
    const operation = ++this.operationRevision;
    this.authFlight = null;
    clearTimeout(flight.timer);
    flight.provider.cancel();
    flight.abort.abort();
    await flight.client.close().catch(() => {});
    if (operation !== this.operationRevision) throw new Error("MCP configuration changed during sign-in. Reconnect the server.");
    await this.disconnectBackends();
    if (operation !== this.operationRevision) throw new Error("MCP configuration changed during sign-in. Reconnect the server.");
    await this.connectBackends(this.backendList);
    if (operation !== this.operationRevision) throw new Error("MCP configuration changed during sign-in. Reconnect the server.");
    return this.statuses.find((s) => s.name === flight.backend.name) ?? {
      name: flight.backend.name, url: flight.backend.url, state: "error", toolCount: 0,
      detail: "Sign-in finished but the server did not reconnect.",
    };
  }

  async authorize(backendName: string): Promise<GatewayBackendStatus> {
    const flight = this.startAuthorization(backendName, false);
    try {
      try { await this.connectBackend(flight.client, flight.transport); }
      catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        const query = await flight.callback;
        this.assertFlight(flight);
        if (query.get("error")) throw new Error("MCP authorization was denied.");
        const code = query.get("code");
        if (!code || query.get("state") !== flight.provider.expectedState) throw new Error("Invalid MCP authorization callback.");
        await flight.transport.finishAuth(code);
      }
      return await this.finishAuthorization(flight);
    } catch (error) {
      if (this.authFlight === flight) await this.cancelAuthorization(backendName);
      throw error;
    }
  }

  async disconnect(backendName: string): Promise<void> {
    const operation = ++this.operationRevision;
    await this.cancelAuthorization(backendName);
    if (operation !== this.operationRevision) return;
    const backend = this.backendList.find((b) => b.name === backendName);
    if (backend) this.vault.clear(canonicalResourceUri(backend.url));
    await this.disconnectBackends();
    if (operation !== this.operationRevision) return;
    await this.connectBackends(this.backendList);
  }

  async beginAuthorize(backendName: string): Promise<{ authorizationUrl: string }> {
    const flight = this.startAuthorization(backendName, true);
    try {
      try {
        await this.connectBackend(flight.client, flight.transport);
        throw new Error("This server is already authorized.");
      } catch (error) { if (!(error instanceof UnauthorizedError)) throw error; }
      this.assertFlight(flight);
      const authorizationUrl = flight.provider.authorizationUrl;
      if (!authorizationUrl) throw new Error("Could not obtain an authorization URL for this server.");
      return { authorizationUrl };
    } catch (error) {
      if (this.authFlight === flight) await this.cancelAuthorization(backendName);
      throw error;
    }
  }

  async completeAuthorize(backendName: string, pasted: string): Promise<GatewayBackendStatus> {
    const flight = this.authFlight;
    if (!flight || !flight.headless || flight.backend.name !== backendName) throw new Error("No pending sign-in for this server — start it again.");
    // Claim the submission before awaiting so duplicate clicks cannot redeem twice.
    flight.headless = false;
    try {
      const { code, state } = parseAuthorizationCode(pasted);
      if (state && state !== flight.provider.expectedState) throw new Error("Authorization state mismatch — start sign-in again.");
      await flight.transport.finishAuth(code);
      return await this.finishAuthorization(flight);
    } catch (error) {
      if (this.authFlight === flight) await this.cancelAuthorization(backendName);
      throw error;
    }
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
      const flight = this.authFlight;
      if (!flight || flight.headless || !flight.provider.expectedState || u.searchParams.get("state") !== flight.provider.expectedState) {
        res.writeHead(400).end("No matching sign-in. Return to Zeros and start again.");
        return;
      }
      flight.resolve(u.searchParams);
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem;text-align:center">' +
          "<h2>Return to Zeros</h2><p>Zeros will show the connection result. You can close this tab.</p></body>",
      );
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
    this.connectionRevision++;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    for (const provider of this.connectionProviders) provider.cancel();
    this.connectionProviders.clear();
    // Detach this generation before awaiting close. An old close must never
    // clear or close clients already published by a newer reconnect.
    const retired = [...new Set([...this.backendClients.values(), ...this.connectingClients])];
    this.backendClients.clear();
    this.connectingClients.clear();
    this.backendCatalogs.clear();
    this.backendLocks.clear();
    // Keep the confirmed catalog while replacement connections load. Publish
    // the complete new generation once, including removals and failures.
    for (const c of retired) {
      try {
        await c.close();
      } catch {
        /* best-effort */
      }
    }
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
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.aggregated as never,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const r = this.route.get(req.params.name);
      if (!r) throw new Error(`unknown tool: ${req.params.name}`);
      const client = this.backendClients.get(r.server);
      if (!client) throw new Error(`backend "${r.server}" is not connected`);
      try {
        return (await this.runOnBackend(r.server, () =>
          client.callTool({ name: r.tool, arguments: (req.params.arguments ?? {}) as Record<string, unknown> }),
        )) as never;
      } catch (error) {
        // A live token can be revoked after initial discovery. Retired clients
        // must not overwrite a newer authorized connection's status.
        if (this.backendClients.get(r.server) === client && isUnauthorizedTransport(error)) {
          const oauth = this.backendList.find((backend) => backend.name === r.server)?.auth === "oauth";
          this.statuses = this.statuses.map((status) => status.name === r.server
            ? { ...status, state: oauth ? "needs-auth" : "error", toolCount: 0,
              detail: oauth ? "Authorization expired or was revoked. Sign in to reconnect." : "API key was rejected. Edit the server to update its credentials." } : status);
          const catalog = this.backendCatalogs.get(r.server);
          if (catalog) { catalog.available = false; this.publishCatalog(); }
        }
        throw error;
      }
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
        const server = this.makeServer();
        const t: StreamableHTTPServerTransport =
          new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              this.sessions.set(id, t);
            },
          });
        t.onclose = () => {
          this.readyServers.delete(server);
          if (t.sessionId) this.sessions.delete(t.sessionId);
        };
        server.oninitialized = () => { this.readyServers.add(server); };
        await server.connect(t);
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
