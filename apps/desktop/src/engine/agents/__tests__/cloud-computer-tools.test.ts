import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CloudComputerMcpServer } from "../cloud-computer-tools";
import type { CloudAgentLease } from "../cloud-agent-lease";

describe("execution-scoped Cloud Computer MCP", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function fixture() {
    const controller = new AbortController();
    const call = vi.fn(async () => ({ computers: [] }));
    const lease = { computerToolsVersion: 1, signal: controller.signal, computerTool: call,
      assertLive() { controller.signal.throwIfAborted(); } } as unknown as CloudAgentLease;
    const server = await CloudComputerMcpServer.start(lease);
    cleanup.push(() => server.stopAndProve());
    const registration = server.registration;
    const client = new Client({ name: "native-fixture", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } });
    await client.connect(transport);
    cleanup.push(() => client.close());
    return { controller, call, server, registration, client, transport };
  }
  it("advertises exactly five strict tools and forwards native identity outside arguments", async () => {
    const f = await fixture();
    const tools = (await f.client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual([
      "ListComputers", "GetComputerConfiguration", "CreateComputerConfiguration", "GetComputerBuildStatus", "UpdateRepositorySetupScript",
    ]);
    for (const tool of tools) expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(await f.client.callTool({ name: "ListComputers", arguments: {} })).toMatchObject({ structuredContent: { computers: [] } });
    expect(f.call).toHaveBeenCalledWith(expect.any(String), { name: "ListComputers", arguments: {} }, expect.any(AbortSignal));
    const result = await f.client.callTool({ name: "ListComputers", arguments: { actorUserId: randomUUID() } });
    expect(result.isError).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it("keeps native request identity on replay without conflating identical new calls", async () => {
    const f = await fixture();
    for (const id of [101, 101, 102]) {
      const response = await fetch(f.registration.url, { method: "POST", headers: {
        ...f.registration.headers, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-session-id": f.transport.sessionId!,
      }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ListComputers", arguments: {} } }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id, result: { structuredContent: { computers: [] } } });
    }
    const identities = (f.call.mock.calls as unknown[][]).map(call => call[0]);
    expect(identities).toHaveLength(3);
    expect(identities[0]).toBe(identities[1]);
    expect(identities[2]).not.toBe(identities[0]);
  });
  it("authenticates requests, rejects foreign origins and retires immediately on Stop", async () => {
    const f = await fixture();
    expect((await fetch(f.registration.url, { method: "POST" })).status).toBe(401);
    expect((await fetch(f.registration.url, { method: "POST", headers: { ...f.registration.headers, origin: "https://foreign.example.test" } })).status).toBe(403);
    f.controller.abort();
    await expect(f.client.callTool({ name: "ListComputers", arguments: {} })).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
    await f.server.stopAndProve();
    await expect(fetch(f.registration.url)).rejects.toThrow();
  });
  it("returns a refreshable typed conflict without forwarding exception text", async () => {
    const f = await fixture();
    const conflict = { conflict: true, revision: 4, latestBuildId: randomUUID() };
    f.call.mockResolvedValueOnce(conflict as never);
    expect(await f.client.callTool({ name: "CreateComputerConfiguration", arguments: {
      installScript: "echo ready", expectedRevision: 1, previousBuildId: null,
    } })).toMatchObject({ isError: true, structuredContent: conflict });
    f.call.mockRejectedValueOnce(new Error("private-provider-diagnostic"));
    const error = await f.client.callTool({ name: "ListComputers", arguments: {} });
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error)).not.toContain("private-provider-diagnostic");
  });
});
