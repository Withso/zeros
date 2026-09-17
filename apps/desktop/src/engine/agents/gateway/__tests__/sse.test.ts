import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpGateway } from "../server";
import { OAuthVault } from "../oauth-provider";
import { canonicalResourceUri } from "../oauth-url";
import type { GatewayBackend } from "../../mcp-registry";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sseBackend(oauth = false, tokenAuthMethod = "none", kind: "http" | "sse" = "sse", requireVersion = false) {
  const sessions = new Map<string, SSEServerTransport>();
  const httpSessions = new Map<string, StreamableHTTPServerTransport>();
  const resourcePath = kind === "http" ? "/mcp" : "/events";
  const requests: Array<{
    method?: string;
    path: string;
    authorization?: string;
    version?: string;
  }> = [];
  let failure = 0;
  let holdEndpoint = false;
  let acceptedToken = "fixture";
  let tokenNumber = 0;
  let revoked = false;
  let holdToken = false;
  const tokenRequests: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, "http://localhost");
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      requests.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.authorization,
        version: req.headers["x-version"] as string | undefined,
      });
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              resource: `${origin}${resourcePath}`,
              authorization_servers: [origin],
            }),
          );
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: [tokenAuthMethod],
            }),
          );
        return;
      }
      if (url.pathname === "/token") {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        if (holdToken) return;
        if (revoked && params.get("grant_type") === "refresh_token") {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenNumber++;
        acceptedToken = tokenNumber === 1 ? "fixture" : `fixture-${tokenNumber}`;
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({ access_token: acceptedToken, refresh_token: `refresh-${tokenNumber}`, token_type: "Bearer" }),
          );
        return;
      }
      if (requireVersion && req.headers["x-version"] !== "1") {
        res.writeHead(400).end("Missing resource version header");
        return;
      }
      if (oauth && req.headers.authorization !== `Bearer ${acceptedToken}`) {
        res
          .writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          })
          .end();
        return;
      }
      if (failure) {
        res.writeHead(failure).end("Backend unavailable");
        return;
      }
      if (holdEndpoint) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": waiting\n\n");
        return;
      }
      if (kind === "http" && url.pathname === resourcePath) {
        const sessionId = req.headers["mcp-session-id"];
        let transport = typeof sessionId === "string" ? httpSessions.get(sessionId) : undefined;
        if (!transport) {
          const next = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => { httpSessions.set(id, next); },
          });
          const mcp = new Server({ name: "http-fixture", version: "1" }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "search", inputSchema: { type: "object" } }] }));
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "HTTP result" }] }));
          await mcp.connect(next);
          transport = next;
        }
        await transport.handleRequest(req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const transport = new SSEServerTransport("/messages", res);
        sessions.set(transport.sessionId, transport);
        res.on("close", () => sessions.delete(transport.sessionId));
        const mcp = new Server(
          { name: "sse-fixture", version: "1" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "search", inputSchema: { type: "object" } }],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => ({
          content: [{ type: "text", text: "SSE result" }],
        }));
        await mcp.connect(transport);
      } else if (req.method === "POST" && url.pathname === "/messages") {
        const transport = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (transport) await transport.handlePostMessage(req, res);
        else res.writeHead(404).end();
      } else res.writeHead(405).end();
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await Promise.all([...sessions.values()].map((session) => session.close()));
    await Promise.all([...httpSessions.values()].map((session) => session.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${resourcePath}`,
    requests,
    tokenRequests,
    holdToken: () => { holdToken = true; },
    expire: (revoke = false) => { acceptedToken = "expired"; revoked = revoke; },
    fail: (status: number) => {
      failure = status;
    },
    hold: () => {
      holdEndpoint = true;
    },
  };
}

function gateway(vault: OAuthVault, openBrowser?: (url: string) => void) {
  const gw = new McpGateway({
    port: 0,
    callbackPort: 0,
    allowLoopback: true,
    vault,
    openBrowser,
  });
  cleanups.push(() => gw.stop());
  return gw;
}

describe("MCP gateway explicit SSE", () => {
  it.each(["http", "sse"] as const)("keeps %s OAuth resource headers through sign-in, renewal and resume without sending them to OAuth endpoints", async (transport) => {
    const backend = await sseBackend(true, "none", transport, true);
    const vault = new OAuthVault();
    const gw = gateway(vault);
    const servers: GatewayBackend[] = [{ name: "reports", transport, url: backend.url, auth: "oauth", clientId: "public-client", source: "user",
      headers: { "X-Version": "1", authorization: "stale-configured-token" } }];
    await gw.start(servers);
    expect(gw.getStatuses()[0]?.state).toBe("needs-auth");
    const agent = new Client({ name: "agent", version: "1" });
    cleanups.push(() => agent.close());
    const changed = vi.fn(async () => (await agent.listTools()).tools.map((tool) => tool.name));
    agent.setNotificationHandler(ToolListChangedNotificationSchema, async () => { await changed(); });
    await agent.connect(new StreamableHTTPClientTransport(new URL(gw.url)));
    expect((await agent.listTools()).tools).toEqual([]);
    await gw.beginAuthorize("reports");
    await gw.completeAuthorize("reports", "fixture-code");
    expect(gw.getStatuses()[0]?.state).toBe("connected");
    await vi.waitFor(() => expect(changed).toHaveResolvedWith(["reports__search"]));
    await expect(agent.callTool({ name: "reports__search" })).resolves.toMatchObject({ content: [{ type: "text" }] });
    backend.expire();
    await gw.reconnect();
    expect(gw.getStatuses()[0]?.state).toBe("connected");
    const restored = new OAuthVault();
    restored.restore(vault.snapshot());
    const resumed = gateway(restored);
    await resumed.start(servers);
    expect(resumed.getStatuses()[0]?.state).toBe("connected");
    const resource = backend.requests.filter((r) => ["/events", "/messages", "/mcp"].includes(r.path));
    expect(resource.length).toBeGreaterThan(4);
    expect(resource.every((r) => r.version === "1")).toBe(true);
    expect(resource.some((r) => r.authorization === "Bearer fixture-2")).toBe(true);
    expect(resource.some((r) => r.authorization?.includes("stale-configured-token"))).toBe(false);
    const oauthRequests = backend.requests.filter((r) => r.path.startsWith("/.well-known/") || r.path === "/token");
    expect(oauthRequests.length).toBeGreaterThan(0);
    expect(oauthRequests.every((r) => !r.version && !r.authorization)).toBe(true);
  });

  it.each(["client_secret_basic", "client_secret_post"])("uses a vaulted secret for %s token exchange", async (method) => {
    const backend = await sseBackend(true, method);
    const vault = new OAuthVault();
    vault.setOAuthSecret(canonicalResourceUri(backend.url), "registered", "fixture-secret");
    const gw = gateway(vault);
    await gw.start([{ name: "reports", transport: "sse", url: backend.url, auth: "oauth", clientId: "registered", source: "user" }]);
    const { authorizationUrl } = await gw.beginAuthorize("reports");
    expect(authorizationUrl).not.toContain("fixture-secret");
    await gw.completeAuthorize("reports", "fixture-code");
    if (method === "client_secret_basic") expect(backend.requests.find((r) => r.path === "/token")?.authorization).toBe(`Basic ${Buffer.from("registered:fixture-secret").toString("base64")}`);
    else expect(backend.tokenRequests[0]?.get("client_secret")).toBe("fixture-secret");
    expect(gw.getStatuses()[0]?.state).toBe("connected");
  });
  it.each(["sse", "http"] as const)("requests configured scopes and renews %s credentials across reconnect, then recovers a revoked grant", async (transport) => {
    const backend = await sseBackend(true, "none", transport);
    const vault = new OAuthVault();
    const gw = gateway(vault);
    const servers: GatewayBackend[] = [{ name: "reports", transport, url: backend.url, auth: "oauth", clientId: "public-client", scopes: ["read", "write"], source: "user" }];
    await gw.start(servers);
    const { authorizationUrl } = await gw.beginAuthorize("reports");
    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("read write");
    await gw.completeAuthorize("reports", "fixture-code");
    backend.expire();
    await gw.reload(servers);
    expect(gw.getStatuses()[0]?.state).toBe("connected");
    expect(backend.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(vault.getTokens(canonicalResourceUri(backend.url))?.refresh_token).toBe("refresh-2");
    const restored = new OAuthVault();
    restored.restore(vault.snapshot());
    const resumed = gateway(restored);
    await resumed.start(servers);
    expect(resumed.getStatuses()[0]?.state).toBe("connected");
    backend.expire(true);
    await resumed.reload(servers);
    expect(resumed.getStatuses()[0]?.state).toBe("needs-auth");
    expect(restored.getTokens(canonicalResourceUri(backend.url))).toBeUndefined();
    await resumed.beginAuthorize("reports");
    await resumed.completeAuthorize("reports", "new-consent-code");
    expect(resumed.getStatuses()[0]?.state).toBe("connected");
  });

  it("aborts cancellation during a token exchange and keeps the vault empty", async () => {
    const backend = await sseBackend(true);
    const vault = new OAuthVault();
    const gw = gateway(vault);
    await gw.start([{ name: "reports", transport: "sse", url: backend.url, auth: "oauth", clientId: "public-client", source: "user" }]);
    await gw.beginAuthorize("reports");
    backend.holdToken();
    const exchange = gw.completeAuthorize("reports", "fixture-code").then(() => "completed", () => "cancelled");
    await vi.waitFor(() => expect(backend.tokenRequests).toHaveLength(1));
    await gw.cancelAuthorization("reports");
    expect(await exchange).toBe("cancelled");
    expect(vault.getTokens(canonicalResourceUri(backend.url))).toBeUndefined();
  });

  it("cancels paste-code sign-in when settings are reloaded", async () => {
    const backend = await sseBackend(true);
    const gw = gateway(new OAuthVault());
    const servers: GatewayBackend[] = [{ name: "reports", transport: "sse", url: backend.url, auth: "oauth", clientId: "public-client", source: "user" }];
    await gw.start(servers);
    await gw.beginAuthorize("reports");
    await gw.reload(servers);
    await expect(gw.completeAuthorize("reports", "late-code")).rejects.toThrow(/no pending|cancel/i);
    expect(backend.tokenRequests).toHaveLength(0);
  });
  it("retains the latest settings when an older reconnect finishes closing late", async () => {
    const backend = await sseBackend();
    const vault = new OAuthVault();
    vault.setHeader(canonicalResourceUri(backend.url), { name: "Authorization", value: "Bearer fixture" });
    const gw = gateway(vault);
    const initial: GatewayBackend = { name: "original", transport: "sse", url: backend.url, auth: "header", source: "user" };
    await gw.start([initial]);
    let release!: () => void;
    let blocked = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const close = Client.prototype.close;
    const spy = vi.spyOn(Client.prototype, "close").mockImplementation(async function (this: Client) {
      if (!blocked) { blocked = true; await gate; }
      await close.call(this);
    });
    try {
      const older = gw.reload([{ ...initial, name: "older" }]);
      await vi.waitFor(() => expect(blocked).toBe(true));
      await gw.reload([{ ...initial, name: "latest" }]);
      release();
      await older;
      expect(gw.getStatuses().map((status) => status.name)).toEqual(["latest"]);
      const agent = new Client({ name: "agent", version: "1" });
      cleanups.push(() => agent.close());
      await agent.connect(new StreamableHTTPClientTransport(new URL(gw.url)));
      expect((await agent.listTools()).tools[0]?.name).toBe("latest__search");
    } finally { release(); spy.mockRestore(); }
  });
  it("reports revoked access from a live tool call as requiring sign-in", async () => {
    const backend = await sseBackend(true);
    const gw = gateway(new OAuthVault());
    await gw.start([{ name: "reports", transport: "sse", url: backend.url, auth: "oauth", clientId: "public-client", source: "user" }]);
    await gw.beginAuthorize("reports");
    await gw.completeAuthorize("reports", "fixture-code");
    const agent = new Client({ name: "agent", version: "1" });
    await agent.connect(new StreamableHTTPClientTransport(new URL(gw.url)));
    cleanups.push(() => agent.close());
    const tools = await agent.listTools();
    backend.expire(true);
    await agent.callTool({ name: tools.tools[0]!.name, arguments: {} }).catch(() => {});
    expect(gw.getStatuses()[0]?.state).toBe("needs-auth");
  });

  it("keeps a revoked static header as a configuration error, without offering OAuth", async () => {
    const backend = await sseBackend(true);
    const vault = new OAuthVault();
    vault.setHeader(canonicalResourceUri(backend.url), { name: "Authorization", value: "Bearer fixture" });
    const gw = gateway(vault);
    await gw.start([{ name: "reports", transport: "sse", url: backend.url, auth: "header", source: "user" }]);
    const agent = new Client({ name: "agent", version: "1" });
    await agent.connect(new StreamableHTTPClientTransport(new URL(gw.url)));
    cleanups.push(() => agent.close());
    const tools = await agent.listTools();
    backend.expire(true);
    await agent.callTool({ name: tools.tools[0]!.name, arguments: {} }).catch(() => {});
    expect(gw.getStatuses()[0]).toMatchObject({ state: "error", detail: expect.stringMatching(/API key/i) });
  });

  it("cancels a browser sign-in without accepting a late callback", async () => {
    const backend = await sseBackend(true);
    let authorization = "";
    const gw = gateway(new OAuthVault(), (url) => { authorization = url; });
    await gw.start([{ name: "reports", transport: "sse", url: backend.url, auth: "oauth", clientId: "public-client", source: "user" }]);
    const pending = gw.authorize("reports").catch((error) => error as Error);
    await vi.waitFor(() => expect(authorization).not.toBe(""));
    await gw.cancelAuthorization("reports");
    expect(await pending).toMatchObject({ message: expect.stringMatching(/cancel/i) });
    const auth = new URL(authorization);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "late");
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    expect((await fetch(callback)).status).toBe(400);
    expect(backend.tokenRequests).toHaveLength(0);
  });

  it("bounds SSE startup when the stream never supplies its endpoint", async () => {
    const backend = await sseBackend();
    backend.hold();
    const vault = new OAuthVault();
    vault.setTokens(canonicalResourceUri(backend.url), {
      access_token: "fixture",
      token_type: "Bearer",
    });
    const gw = gateway(vault);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = gw.start([
      {
        name: "reports",
        transport: "sse",
        url: backend.url,
        auth: "oauth",
        source: "user",
      },
    ]);
    await vi.waitFor(() => expect(backend.requests.length).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(15_000);
    await started;
    expect(gw.getStatuses()).toMatchObject([
      { state: "error", detail: expect.stringMatching(/timed out/i) },
    ]);
  }, 1_500);

  it.each(["headless", "browser"])(
    "keeps SSE throughout %s OAuth authorization and reconnect",
    async (mode) => {
      const backend = await sseBackend(true, "none", "sse", true);
      const vault = new OAuthVault();
      const callbacks: Promise<unknown>[] = [];
      const gw = gateway(vault, (url) => {
        const auth = new URL(url);
        const callback = new URL(auth.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", auth.searchParams.get("state")!);
        callbacks.push(fetch(callback));
      });
      await gw.start([
        {
          name: "reports",
          transport: "sse",
          url: backend.url,
          auth: "oauth",
          clientId: "public-client",
          headers: { "X-Version": "1" },
          source: "user",
        },
      ]);
      expect(gw.getStatuses()).toMatchObject([{ state: "needs-auth" }]);
      expect(callbacks).toHaveLength(0);
      if (mode === "headless") {
        const { authorizationUrl } = await gw.beginAuthorize("reports");
        const auth = new URL(authorizationUrl);
        expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
        await expect(
          gw.completeAuthorize(
            "reports",
            `http://localhost/callback?code=fixture-code&state=${auth.searchParams.get("state")}`,
          ),
        ).resolves.toMatchObject({ state: "connected" });
      } else {
        await expect(gw.authorize("reports")).resolves.toMatchObject({
          state: "connected",
        });
        await Promise.all(callbacks);
      }
      expect(backend.tokenRequests).toHaveLength(1);
      expect(backend.tokenRequests[0]!.get("code_verifier")).toBeTruthy();
      expect(backend.tokenRequests[0]!.get("code")).toBe("fixture-code");
      expect(
        backend.requests.some(
          (request) => request.method === "POST" && request.path === "/events",
        ),
      ).toBe(false);
      expect(
        vault.getTokens(canonicalResourceUri(backend.url))?.access_token,
      ).toBe("fixture");
    },
  );

  it("isolates an invalid SSE URL from healthy backends", async () => {
    const backend = await sseBackend();
    const vault = new OAuthVault();
    vault.setTokens(canonicalResourceUri(backend.url), {
      access_token: "fixture",
      token_type: "Bearer",
    });
    const gw = gateway(vault);
    await gw.start([
      {
        name: "invalid",
        transport: "sse",
        url: "invalid url",
        auth: "oauth",
        source: "user",
      },
      {
        name: "reports",
        transport: "sse",
        url: backend.url,
        auth: "oauth",
        source: "user",
      },
    ]);
    expect(gw.getStatuses()).toMatchObject([
      { name: "invalid", state: "error" },
      { name: "reports", state: "connected" },
    ]);
  });

  it.each(["header", "oauth"] as const)(
    "uses SSE for %s credentials, tool calls and reconnect",
    async (auth) => {
      const backend = await sseBackend();
      const vault = new OAuthVault();
      const resource = canonicalResourceUri(backend.url);
      if (auth === "header")
        vault.setHeader(resource, {
          name: "Authorization",
          value: "Bearer fixture",
        });
      else
        vault.setTokens(resource, {
          access_token: "fixture",
          token_type: "Bearer",
        });
      const gw = gateway(vault);
      const definition: GatewayBackend = {
        name: "reports",
        transport: "sse",
        url: backend.url,
        auth,
        source: "user",
        headers: { "X-Version": "1", authorization: "stale-configured-token" },
      };
      await gw.start([definition]);
      expect(gw.getStatuses()).toMatchObject([
        { state: "connected", toolCount: 1 },
      ]);
      const url = gw.url;
      const agent = new Client({ name: "fixture-agent", version: "1" });
      cleanups.push(() => agent.close());
      await agent.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await agent.listTools()).tools.map((tool) => tool.name)).toEqual([
        "reports__search",
      ]);
      expect(
        await agent.callTool({ name: "reports__search", arguments: {} }),
      ).toMatchObject({ content: [{ text: "SSE result" }] });
      await gw.reload([definition]);
      expect(gw.url).toBe(url);
      expect(gw.getStatuses()).toMatchObject([{ state: "connected" }]);
      expect(
        await agent.callTool({ name: "reports__search", arguments: {} }),
      ).toMatchObject({ content: [{ text: "SSE result" }] });
      expect(
        backend.requests.filter(
          (req) => req.method === "GET" && req.path === "/events",
        ),
      ).toHaveLength(2);
      expect(
        backend.requests.every((req) => req.authorization === "Bearer fixture"),
      ).toBe(true);
      expect(backend.requests.every((req) => req.version === "1")).toBe(true);
      expect(
        backend.requests.some(
          (req) => req.method === "POST" && req.path === "/events",
        ),
      ).toBe(false);
      expect(JSON.stringify(gw.getStatuses())).not.toContain("Bearer fixture");
    },
  );

  it("keeps a failed OAuth transport as a connection error and retries the same SSE endpoint", async () => {
    const backend = await sseBackend();
    backend.fail(503);
    const vault = new OAuthVault();
    vault.setTokens(canonicalResourceUri(backend.url), {
      access_token: "fixture",
      token_type: "Bearer",
    });
    const gw = gateway(vault);
    const definition: GatewayBackend = {
      name: "reports",
      transport: "sse",
      url: backend.url,
      auth: "oauth",
      source: "user",
    };
    await gw.start([definition]);
    expect(gw.getStatuses()).toMatchObject([{ state: "error", toolCount: 0 }]);
    const url = gw.url;
    backend.fail(0);
    await gw.reload([definition]);
    expect(gw.url).toBe(url);
    expect(gw.getStatuses()).toMatchObject([
      { state: "connected", toolCount: 1 },
    ]);
    expect(backend.requests[0]).toMatchObject({
      method: "GET",
      path: "/events",
    });
  });

  it("requires a saved header without sending an unauthenticated SSE request", async () => {
    const backend = await sseBackend();
    const gw = gateway(new OAuthVault());
    await gw.start([
      {
        name: "reports",
        transport: "sse",
        url: backend.url,
        auth: "header",
        source: "user",
      },
    ]);
    expect(gw.getStatuses()).toMatchObject([
      { state: "error", detail: expect.stringContaining("API key not set") },
    ]);
    expect(backend.requests).toEqual([]);
  });
});
