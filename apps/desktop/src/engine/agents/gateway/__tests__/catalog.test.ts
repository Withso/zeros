import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, CallToolResultSchema, EmptyResultSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { McpGateway } from "../server";
import { OAuthVault } from "../oauth-provider";
import { canonicalResourceUri } from "../oauth-url";
import type { GatewayBackend } from "../../mcp-registry";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tool = (name: string, description = name) => ({ name, description, inputSchema: { type: "object" as const } });

async function fixture() {
  let list: (cursor?: string) => Promise<ListToolsResult> = async () => ({ tools: [tool("search")] });
  let call: (name: string) => Promise<CallToolResult> = async (name) => ({ content: [{ type: "text", text: name }] });
  const cursors: Array<string | undefined> = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<Server>();
  const backend = http.createServer((req, res) => {
    void (async () => {
      const id = req.headers["mcp-session-id"];
      let transport = typeof id === "string" ? sessions.get(id) : undefined;
      if (!transport) {
        const server = new Server({ name: "catalog", version: "1" }, { capabilities: { tools: { listChanged: true } } });
        const next = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => { sessions.set(id, next); } });
        next.onclose = () => { servers.delete(server); if (next.sessionId) sessions.delete(next.sessionId); };
        servers.add(server);
        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
          cursors.push(request.params?.cursor);
          return list(request.params?.cursor);
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) => call(request.params.name));
        await server.connect(next);
        transport = next;
      }
      await transport.handleRequest(req, res);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await Promise.all([...servers].map((server) => server.close()));
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}/mcp`;
  const vault = new OAuthVault();
  const gateway = new McpGateway({ port: 0, callbackPort: 0, allowLoopback: true, vault });
  cleanups.push(() => gateway.stop());
  const definition: GatewayBackend = { name: "catalog", url, auth: "header", source: "user" };
  const authorize = () => vault.setHeader(canonicalResourceUri(url), { name: "Authorization", value: "synthetic" });
  const connect = async () => {
    const client = new Client({ name: "agent", version: "1" });
    const snapshots: string[][] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      snapshots.push((await client.listTools()).tools.map((t) => t.name));
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)));
    cleanups.push(() => client.close());
    return { client, snapshots };
  };
  return { gateway, definition, authorize, connect, cursors,
    listWith(fn: typeof list) { list = fn; },
    callWith(fn: typeof call) { call = fn; },
    async notify() {
      await Promise.all([...servers].map(async (server) => {
        await server.sendToolListChanged();
        // A round trip drains the notification from this ordered connection.
        // HTTP sessions can outlive a client's closed SSE listener. Do not
        // let one of those retired fixture sessions strand the test barrier.
        await server.request({ method: "ping" }, EmptyResultSchema, { timeout: 250 }).catch(() => {});
      }));
    },
  };
}

describe("MCP gateway catalog updates", () => {
  it("revisions only committed catalog changes, including schemas and the empty catalog", async () => {
    const f = await fixture(); f.authorize();
    f.listWith(async () => ({ tools: [tool("read")] }));
    await f.gateway.start([f.definition]);
    const first = f.gateway.catalogRevision;
    await f.gateway.reconnect();
    expect(f.gateway.catalogRevision).toBe(first);
    await f.notify();
    expect(f.gateway.catalogRevision).toBe(first);
    f.listWith(async () => ({ tools: [{ ...tool("read"), description: "New schema description" }] }));
    await f.notify();
    await vi.waitFor(() => expect(f.gateway.catalogRevision).not.toBe(first));
    const second = f.gateway.catalogRevision;
    f.listWith(async () => { throw new Error("temporary discovery failure"); });
    await f.notify();
    await vi.waitFor(() => expect(f.gateway.getStatuses()[0]?.detail).toContain("temporary discovery failure"));
    expect(f.gateway.catalogRevision).toBe(second);
    await f.gateway.reload([]);
    expect(f.gateway.catalogRevision).not.toBe(second);
    const empty = f.gateway.catalogRevision;
    await f.gateway.reload([]);
    expect(f.gateway.catalogRevision).toBe(empty);
    const another = await fixture();
    expect(another.gateway.catalogRevision).not.toBe(empty);
  });
  it("preserves backend result validation for tools from every page", async () => {
    const f = await fixture(); f.authorize();
    const validated = { ...tool("validated"), outputSchema: {
      $id: "https://fixture.invalid/result", type: "object" as const, properties: { value: { type: "number" } }, required: ["value"],
    } };
    f.listWith(async (cursor) => cursor ? { tools: [tool("last")] } : { tools: [validated], nextCursor: "last" });
    f.callWith(async () => ({ content: [], structuredContent: { value: "invalid" } }));
    await f.gateway.start([f.definition]);
    const { client, snapshots } = await f.connect();
    // Bypass this fixture client's own metadata cache: the gateway must retain
    // the backend SDK's validation, even when the agent has no such validator.
    await expect(client.request({ method: "tools/call", params: { name: "catalog__validated" } }, CallToolResultSchema))
      .rejects.toThrow(/output schema/);
    // A schema-only update may reuse its native $id. It must replace, rather
    // than silently reuse, the previous generation's compiled validator.
    f.listWith(async () => ({ tools: [{ ...validated, outputSchema: {
      ...validated.outputSchema, properties: { value: { type: "string" } },
    } }] }));
    await f.notify();
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await expect(client.request({ method: "tools/call", params: { name: "catalog__validated" } }, CallToolResultSchema))
      .resolves.toMatchObject({ structuredContent: { value: "invalid" } });
  });

  it("retains confirmed result validators when a later discovery page fails", async () => {
    const f = await fixture(); f.authorize();
    const validated = { ...tool("validated"), outputSchema: {
      type: "object" as const, properties: { value: { type: "number" } }, required: ["value"],
    } };
    f.listWith(async () => ({ tools: [validated] }));
    f.callWith(async () => ({ content: [], structuredContent: { value: 7 } }));
    await f.gateway.start([f.definition]);
    const { client } = await f.connect();
    f.listWith(async (cursor) => {
      if (cursor) throw new Error("second page unavailable");
      return { tools: [{ ...validated, outputSchema: {
        type: "object", properties: { value: { type: "string" } }, required: ["value"],
      } }], nextCursor: "last" };
    });
    await f.notify();
    await vi.waitFor(() => expect(f.gateway.getStatuses()[0]?.detail).toContain("second page unavailable"));
    await expect(client.request({ method: "tools/call", params: { name: "catalog__validated" } }, CallToolResultSchema))
      .resolves.toMatchObject({ structuredContent: { value: 7 } });
  });

  it("retains confirmed result validators if a replacement schema cannot be compiled", async () => {
    const f = await fixture(); f.authorize();
    const validated = { ...tool("validated"), outputSchema: {
      type: "object" as const, properties: { value: { type: "number" } }, required: ["value"],
    } };
    f.listWith(async () => ({ tools: [validated] }));
    f.callWith(async () => ({ content: [], structuredContent: { value: "invalid" } }));
    await f.gateway.start([f.definition]);
    const { client } = await f.connect();
    f.listWith(async () => ({ tools: [{ ...validated, outputSchema: {
      type: "object", properties: { value: { type: "invalid-type" } },
    } }] }));
    await f.notify();
    await vi.waitFor(() => expect(f.gateway.getStatuses()[0]?.detail).toContain("Could not refresh tools"));
    await expect(client.request({ method: "tools/call", params: { name: "catalog__validated" } }, CallToolResultSchema))
      .rejects.toThrow(/output schema/);
  });

  it("loads all pages, including an empty intermediate page, and filters/calls tools from the last page", async () => {
    const f = await fixture(); f.authorize();
    f.listWith(async (cursor) => cursor === "last"
      ? { tools: [tool("read"), tool("disabled")] }
      : cursor === "empty" ? { tools: [], nextCursor: "last" }
        : { tools: [tool("search")], nextCursor: "empty" });
    await f.gateway.start([{ ...f.definition, disabledTools: ["disabled"] }]);
    const { client } = await f.connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["catalog__search", "catalog__read"]);
    expect(f.cursors).toEqual([undefined, "empty", "last"]);
    expect(f.gateway.getStatuses()[0]).toMatchObject({ toolCount: 2, tools: ["search", "read", "disabled"] });
    await expect(client.callTool({ name: "catalog__read" })).resolves.toMatchObject({ content: [{ text: "read" }] });
    await f.gateway.reconnect();
    expect((await client.listTools()).tools).toHaveLength(2);
  });

  it("does not publish a partial catalog when a later page fails, at startup or during refresh", async () => {
    const f = await fixture(); f.authorize();
    const incomplete = async (cursor?: string): Promise<ListToolsResult> => {
      if (cursor) throw new Error("second page unavailable");
      return { tools: [tool("partial")], nextCursor: "second" };
    };
    f.listWith(incomplete);
    await f.gateway.start([f.definition]);
    const { client, snapshots } = await f.connect();
    expect((await client.listTools()).tools).toEqual([]);
    expect(f.gateway.getStatuses()[0]).toMatchObject({ state: "error", toolCount: 0 });
    f.listWith(async () => ({ tools: [tool("confirmed")] }));
    await f.gateway.reconnect();
    await vi.waitFor(() => expect(snapshots).toEqual([["catalog__confirmed"]]));
    f.listWith(incomplete);
    await f.notify();
    await vi.waitFor(() => expect(f.gateway.getStatuses()[0]?.detail).toContain("second page unavailable"));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["catalog__confirmed"]);
    expect(snapshots).toHaveLength(1);
  });

  it("rejects a repeated cursor instead of looping or advertising the first page as complete", async () => {
    const f = await fixture(); f.authorize();
    f.listWith(async () => ({ tools: [tool("search")], nextCursor: "again" }));
    await f.gateway.start([f.definition]);
    expect(f.gateway.getStatuses()[0]).toMatchObject({ state: "error", detail: expect.stringMatching(/cursor/i) });
    expect(f.cursors).toEqual([undefined, "again"]);
    const { client } = await f.connect();
    expect((await client.listTools()).tools).toEqual([]);
  });

  it("cannot call a replacement backend through the old catalog while another backend is still connecting", async () => {
    const f = await fixture(); f.authorize();
    await f.gateway.start([f.definition]);
    const { client } = await f.connect();
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.listWith(async () => {
      if (++reads > 1) await gate;
      return { tools: [tool("replacement")] };
    });
    const reload = f.gateway.reload([f.definition, { ...f.definition, name: "slow" }]);
    try {
      await vi.waitFor(() => expect(reads).toBe(2));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["catalog__search"]);
      await expect(client.callTool({ name: "catalog__search" })).rejects.toThrow(/not connected/);
    } finally { release(); await reload; }
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["catalog__replacement", "slow__replacement"]);
  });

  it("updates every connected client after authorization/reconnect and tool filtering, without duplicate notifications", async () => {
    const f = await fixture();
    await f.gateway.start([f.definition]);
    const first = await f.connect();
    const second = await f.connect();
    expect(first.client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect((await first.client.listTools()).tools).toEqual([]);
    f.authorize();
    await f.gateway.reconnect();
    await vi.waitFor(() => expect(first.snapshots).toEqual([["catalog__search"]]));
    await vi.waitFor(() => expect(second.snapshots).toEqual(first.snapshots));
    await first.client.close();
    await f.gateway.reconnect();
    await f.gateway.reload([{ ...f.definition, disabledTools: ["search"] }]);
    await vi.waitFor(() => expect(second.snapshots).toEqual([["catalog__search"], []]));
    expect(f.gateway.getStatuses()[0]).toMatchObject({ toolCount: 0, tools: ["search"] });
    await f.gateway.reload([f.definition]);
    await vi.waitFor(() => expect(second.snapshots.at(-1)).toEqual(["catalog__search"]));
    await f.gateway.reload([]);
    await vi.waitFor(() => expect(second.snapshots).toHaveLength(4));
    expect(second.snapshots.at(-1)).toEqual([]);
  });

  it("refreshes backend changes, including schema-only changes, and retains the confirmed catalog on transient read failure", async () => {
    const f = await fixture(); f.authorize();
    await f.gateway.start([f.definition]);
    const { client, snapshots } = await f.connect();
    f.listWith(async () => ({ tools: [tool("inspect")] }));
    await f.notify();
    await vi.waitFor(() => expect(snapshots).toEqual([["catalog__inspect"]]));
    await expect(client.callTool({ name: "catalog__inspect" })).resolves.toMatchObject({ content: [{ text: "inspect" }] });
    expect(f.gateway.getStatuses()[0]?.tools).toEqual(["inspect"]);
    f.listWith(async () => ({ tools: [tool("inspect", "Updated description")] }));
    await f.notify();
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    expect((await client.listTools()).tools[0]?.description).toBe("Updated description");
    f.listWith(async () => { throw new Error("temporary list failure"); });
    await f.notify();
    await vi.waitFor(() => expect(f.gateway.getStatuses()[0]?.detail).toContain("temporary list failure"));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["catalog__inspect"]);
    expect(snapshots).toHaveLength(2);
    f.listWith(async () => ({ tools: [] }));
    await f.notify();
    await vi.waitFor(() => expect(snapshots).toHaveLength(3));
    expect(snapshots.at(-1)).toEqual([]);
    expect(f.gateway.getStatuses()[0]).toMatchObject({ state: "connected", toolCount: 0 });
    expect(f.gateway.getStatuses()[0]?.detail).toBeUndefined();
  });

  it("coalesces changes during a refresh and rejects results from a removed backend", async () => {
    const f = await fixture(); f.authorize();
    await f.gateway.start([f.definition]);
    const { client, snapshots } = await f.connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.listWith(async () => { await gate; return { tools: [tool("stale")] }; });
    try {
      await f.notify();
      await vi.waitFor(() => expect(f.cursors).toHaveLength(2));
      f.listWith(async () => ({ tools: [tool("latest")] }));
      await f.notify();
      release();
      await vi.waitFor(() => expect(snapshots).toEqual([["catalog__latest"]]));
      expect(f.cursors).toHaveLength(3);
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      f.listWith(async () => { await pending; return { tools: [tool("removed")] }; });
      await f.notify();
      await vi.waitFor(() => expect(f.cursors).toHaveLength(4));
      await f.gateway.reload([]);
      finish();
      await vi.waitFor(() => expect(snapshots.at(-1)).toEqual([]));
      expect((await client.listTools()).tools).toEqual([]);
      expect(f.gateway.getStatuses()).toEqual([]);
    } finally { release(); }
  });
});
