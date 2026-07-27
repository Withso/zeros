import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { McpGateway } from "../server";
import { OAuthVault } from "../oauth-provider";
import { canonicalResourceUri } from "../oauth-url";
import type { GatewayBackend } from "../../mcp-registry";

// ── helpers ──────────────────────────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Raw HTTP POST so we can set a forbidden header (Host) that fetch won't. */
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface FakeBackend {
  url: string;
  authHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** A minimal real MCP backend over Streamable-HTTP (mirrors the gateway's own
 *  agent-facing server) that records the Authorization header it received. */
async function makeFakeBackend(toolNames: string[]): Promise<FakeBackend> {
  const authHeaders: (string | undefined)[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const mkServer = () => {
    const s = new Server({ name: "fake-backend", version: "1.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolNames.map((n) => ({ name: n, description: n, inputSchema: { type: "object" } })),
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: "text", text: `called ${req.params.name}` }],
    }));
    return s;
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      authHeaders.push(req.headers["authorization"] as string | undefined);
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (!transport) {
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, t);
          },
        });
        await mkServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authHeaders,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function connectAgentClient(gatewayUrl: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(gatewayUrl)));
  return client;
}

// ── tests ────────────────────────────────────────────────

describe("McpGateway (networking)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  it("binds, connects a header backend, and fronts its namespaced tools to an agent (with the brokered header)", async () => {
    const backend = await makeFakeBackend(["search", "fetch"]);
    cleanups.push(backend.close);

    const vault = new OAuthVault();
    vault.setHeader(canonicalResourceUri(backend.url), { name: "Authorization", value: "Bearer test-123" });
    const gw = new McpGateway({
      port: await freePort(),
      callbackPort: await freePort(),
      vault,
      allowLoopback: true,
    });
    cleanups.push(() => gw.stop());
    const def: GatewayBackend = {
      name: "fake",
      url: backend.url,
      auth: "header",
      headerName: "Authorization",
      source: "user",
    };
    await gw.start([def]);

    expect(gw.running).toBe(true);
    const status = gw.getStatuses().find((s) => s.name === "fake")!;
    expect(status.state).toBe("connected");
    expect(status.toolCount).toBe(2);
    expect(status.tools?.sort()).toEqual(["fetch", "search"]);
    // the gateway sent the brokered header to the backend (never the agent)
    expect(backend.authHeaders.some((h) => h === "Bearer test-123")).toBe(true);

    const agent = await connectAgentClient(gw.url);
    cleanups.push(() => agent.close());
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fake__fetch", "fake__search"]); // namespaced

    const result = (await agent.callTool({ name: "fake__search", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(result.content[0]!.text).toBe("called search"); // routed back to the original name
  });

  it("blocks cross-origin / non-loopback requests (DNS-rebinding guard)", async () => {
    const vault = new OAuthVault();
    const port = await freePort();
    const gw = new McpGateway({ port, callbackPort: await freePort(), vault, allowLoopback: true });
    cleanups.push(() => gw.stop());
    await gw.start([]); // bind the agent-facing server (no backends needed)
    expect(gw.running).toBe(true);

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    // A rebinding browser keeps its OWN domain in the Host header → blocked.
    const badHost = await rawPost(port, "/mcp", { Host: "evil.example.com", "content-type": "application/json" }, body);
    expect(badHost.status).toBe(403);

    // A foreign Origin (even with a loopback Host) → blocked.
    const badOrigin = await rawPost(
      port,
      "/mcp",
      { Host: `127.0.0.1:${port}`, Origin: "https://evil.example.com", "content-type": "application/json" },
      body,
    );
    expect(badOrigin.status).toBe(403);

    // A normal loopback request (what an agent sends) is NOT blocked by the guard.
    const good = await rawPost(
      port,
      "/mcp",
      { Host: `127.0.0.1:${port}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    );
    expect(good.status).not.toBe(403);
  });

  it("respects the disabled-tools allowlist (filters the aggregated set)", async () => {
    const backend = await makeFakeBackend(["a", "b", "c"]);
    cleanups.push(backend.close);
    const vault = new OAuthVault();
    vault.setHeader(canonicalResourceUri(backend.url), { name: "Authorization", value: "x" });
    const gw = new McpGateway({ port: await freePort(), callbackPort: await freePort(), vault, allowLoopback: true });
    cleanups.push(() => gw.stop());
    await gw.start([
      { name: "be", url: backend.url, auth: "header", headerName: "Authorization", disabledTools: ["b"], source: "user" },
    ]);
    const status = gw.getStatuses().find((s) => s.name === "be")!;
    expect(status.toolCount).toBe(2); // a + c (b filtered)
    expect(status.tools?.sort()).toEqual(["a", "b", "c"]); // full list still reported for the UI

    const agent = await connectAgentClient(gw.url);
    cleanups.push(() => agent.close());
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["be__a", "be__c"]); // b not exposed
  });

  it("isolates a failing backend — the healthy one still serves", async () => {
    const good = await makeFakeBackend(["ok"]);
    cleanups.push(good.close);
    const deadPort = await freePort(); // nothing listening → connection refused
    const vault = new OAuthVault();
    vault.setHeader(canonicalResourceUri(good.url), { name: "Authorization", value: "x" });
    vault.setHeader(canonicalResourceUri(`http://127.0.0.1:${deadPort}/mcp`), { name: "Authorization", value: "x" });
    const gw = new McpGateway({ port: await freePort(), callbackPort: await freePort(), vault, allowLoopback: true });
    cleanups.push(() => gw.stop());
    await gw.start([
      { name: "good", url: good.url, auth: "header", headerName: "Authorization", source: "user" },
      { name: "bad", url: `http://127.0.0.1:${deadPort}/mcp`, auth: "header", headerName: "Authorization", source: "user" },
    ]);
    const statuses = gw.getStatuses();
    expect(statuses.find((s) => s.name === "good")?.state).toBe("connected");
    expect(statuses.find((s) => s.name === "bad")?.state).toBe("error");

    const agent = await connectAgentClient(gw.url);
    cleanups.push(() => agent.close());
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(["good__ok"]); // only the healthy backend's tool
  });

  it("supports ephemeral ports (port 0) — url reports the OS-assigned port (#3 per-repo gateways)", async () => {
    const backend = await makeFakeBackend(["t"]);
    cleanups.push(backend.close);
    const vault = new OAuthVault();
    vault.setHeader(canonicalResourceUri(backend.url), { name: "Authorization", value: "x" });
    const gw = new McpGateway({ port: 0, callbackPort: 0, vault, allowLoopback: true });
    cleanups.push(() => gw.stop());
    await gw.start([
      { name: "b", url: backend.url, auth: "header", headerName: "Authorization", source: "repo-local" },
    ]);
    const m = gw.url.match(/127\.0\.0\.1:(\d+)\/mcp/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0); // a real assigned port, not 0
    const agent = await connectAgentClient(gw.url);
    cleanups.push(() => agent.close());
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["b__t"]);
  });
});
