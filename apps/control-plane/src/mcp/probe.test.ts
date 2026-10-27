import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { mergeMcpSecrets, McpDraftSchema } from "./model.js";
import { probeMcp } from "./probe.js";
import type { McpStore } from "./store.js";
import type { McpOAuth } from "./oauth.js";

const config = { name: "fixture", transport: "http" as const, url: "https://mcp.example.test/mcp", auth: "none" as const };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const store = { draft: vi.fn(async (_org: string, _user: string, raw: unknown) => {
    const input = McpDraftSchema.parse(raw);
    return { input, ...mergeMcpSecrets(input.config, input.secrets ?? {}, {}), binding: "fixture-binding" };
  }), requireMember: vi.fn(async () => {}), put: vi.fn() };
  const oauth = { draftAuthorization: vi.fn(async () => ({ headers: { Authorization: "Bearer fixture-auth" } })) };
  return { store, oauth, probe: (raw: unknown, fetcher: FetchLike, signal?: AbortSignal) =>
    probeMcp(store as unknown as McpStore, oauth as unknown as McpOAuth, randomUUID(), randomUUID(), raw, signal, fetcher) };
}

async function remote(options: { tools?: boolean; page?: (cursor?: string) => { names: string[]; nextCursor?: string } } = {}) {
  const sessions = new Set<StreamableHTTPServerTransport>(), requests: Array<{ method?: string; authorization?: string }> = [];
  const cursors: Array<string | undefined> = [];
  const http = createServer(async (req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization });
    const existing = [...sessions].find(session => session.sessionId === req.headers["mcp-session-id"]);
    if (existing) { await existing.handleRequest(req, res); return; }
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: options.tools === false ? {} : { tools: {} } });
    if (options.tools !== false) server.setRequestHandler(ListToolsRequestSchema, async request => {
      cursors.push(request.params?.cursor);
      const page = options.page?.(request.params?.cursor) ?? { names: [request.params?.cursor ? "second" : "first"],
        ...(request.params?.cursor ? {} : { nextCursor: "next" }) };
      return { tools: page.names.map(name => ({ name, inputSchema: { type: "object" as const } })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    sessions.add(transport); await server.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const session of sessions) await session.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const fetcher: FetchLike = async (input, init) => {
    const incoming = new Request(input, init);
    expect(new URL(incoming.url).origin).toBe("https://mcp.example.test");
    return fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, {
      method: incoming.method, headers: incoming.headers, signal: incoming.signal,
      ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: await incoming.text() }),
    });
  };
  return { fetcher, requests, cursors };
}

describe("unsaved MCP verification", () => {
  it("performs real initialization and paged tool discovery, then terminates the probe session without saving", async () => {
    const f = fixture(), server = await remote();
    expect(await f.probe({ config }, server.fetcher)).toEqual({ status: "connected", toolCount: 2, tools: ["first", "second"],
      stages: ["validation", "transport", "initialize", "tools"].map(stage => ({ stage, status: "passed" })) });
    expect(server.requests.some(request => request.method === "DELETE")).toBe(true);
    expect(f.store.put).not.toHaveBeenCalled();
  });

  it("includes disabled names and deduplicates exact names across pages without changing the raw count", async () => {
    const f = fixture(), server = await remote({ page: cursor => cursor
      ? { names: ["blocked", "allowed", "Case.Tool"] }
      : { names: ["allowed", "blocked"], nextCursor: "next" } });
    expect(await f.probe({ config: { ...config, disabled_tools: ["blocked", "not-advertised"] } }, server.fetcher))
      .toMatchObject({ status: "connected", toolCount: 5, tools: ["allowed", "blocked", "Case.Tool"] });
    expect(server.cursors).toEqual([undefined, "next"]);
    expect(f.store.put).not.toHaveBeenCalled();
  });

  it.each([true, false])("returns an authoritative empty catalog with tools capability %s", async tools => {
    const f = fixture(), server = await remote({ tools, page: () => ({ names: [] }) });
    expect(await f.probe({ config }, server.fetcher)).toMatchObject({ status: "connected", toolCount: 0, tools: [] });
    expect(server.cursors).toHaveLength(tools ? 1 : 0);
  });

  it("returns the complete catalog at the existing page and tool limits", async () => {
    const f = fixture(), names = Array.from({ length: 1024 }, (_, index) => `tool-${index}`);
    const server = await remote({ page: cursor => {
      const page = Number(cursor ?? 0);
      return { names: names.slice(page * 100, page === 9 ? undefined : (page + 1) * 100),
        ...(page === 9 ? {} : { nextCursor: String(page + 1) }) };
    } });
    expect(await f.probe({ config }, server.fetcher)).toMatchObject({ status: "connected", toolCount: 1024, tools: names });
    expect(server.cursors).toHaveLength(10);
  });

  it.each(["tools", "pages"])("does not publish a partial catalog after exceeding the %s bound", async limit => {
    const f = fixture(), server = await remote({ page: cursor => limit === "tools"
      ? cursor ? { names: Array.from({ length: 1024 }, () => "duplicate") } : { names: ["first"], nextCursor: "next" }
      : { names: [`page-${cursor ?? 0}`], nextCursor: String(Number(cursor ?? 0) + 1) } });
    const result = await f.probe({ config }, server.fetcher);
    expect(result).toMatchObject({ status: "failed", stages: expect.arrayContaining([{ stage: "tools", status: "failed" }]) });
    expect(result).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("toolCount");
    expect(server.cursors).toHaveLength(limit === "tools" ? 2 : 10);
    expect(server.requests.some(request => request.method === "DELETE")).toBe(true);
  });

  it("does not publish a discovered catalog after membership is revoked", async () => {
    const f = fixture(), server = await remote();
    f.store.requireMember.mockRejectedValue(new HttpError(404, "not_found", "MCP configuration not found"));
    await expect(f.probe({ config }, server.fetcher)).rejects.toMatchObject({ status: 404 });
    expect(server.cursors).toEqual([undefined, "next"]);
    expect(server.requests.some(request => request.method === "DELETE")).toBe(true);
  });

  it("reports only attempted stages when sign-in is absent and uses connected unsaved OAuth when provided", async () => {
    const f = fixture(), fetcher = vi.fn<FetchLike>();
    const absent = await f.probe({ config: { ...config, auth: "oauth" } }, fetcher);
    expect(absent).toMatchObject({ status: "needs-auth", stages: [{ stage: "validation", status: "passed" }] });
    expect(absent).not.toHaveProperty("tools");
    expect(fetcher).not.toHaveBeenCalled();
    const server = await remote(), oauthAttemptId = randomUUID();
    expect((await f.probe({ config: { ...config, auth: "oauth" }, oauthAttemptId }, server.fetcher)).status).toBe("connected");
    expect(f.oauth.draftAuthorization).toHaveBeenCalledWith(expect.any(String), expect.any(String), oauthAttemptId, "fixture-binding");
    expect(server.requests.every(request => request.authorization === "Bearer fixture-auth")).toBe(true);
    expect(f.store.put).not.toHaveBeenCalled();
  });

  it("cancels a held authorization read within the overall deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(), fetcher = vi.fn<FetchLike>();
    f.oauth.draftAuthorization.mockImplementation(() => new Promise(() => {}));
    const pending = f.probe({ config: { ...config, auth: "oauth" }, oauthAttemptId: randomUUID() }, fetcher);
    await vi.advanceTimersByTimeAsync(20_001);
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", message: "Connection check timed out or was cancelled" });
    expect(result).not.toHaveProperty("tools");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports actual HTTP authentication refusal without reflecting provider response text", async () => {
    const f = fixture(), fetcher = vi.fn<FetchLike>(async () => new Response("fixture-private-error", { status: 401 }));
    const result = await f.probe({ config }, fetcher);
    expect(result).toMatchObject({ status: "needs-auth", stages: [{ stage: "validation", status: "passed" }, { stage: "transport", status: "passed" }, { stage: "initialize", status: "needs-auth" }] });
    expect(result).not.toHaveProperty("tools");
    expect(JSON.stringify(result)).not.toContain("fixture-private-error");
  });
});
