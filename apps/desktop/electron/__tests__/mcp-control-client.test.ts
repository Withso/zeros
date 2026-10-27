import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpControlClient, MCP_CONTROL_MAX_BYTES } from "../mcp-control-client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const serverId = "33333333-3333-4333-8333-333333333333";
const request = () => ({ type: "mcp.request", requestId: randomUUID(), action: "resolve", organizationId, repository: "fixture/repo", runtimeId });
const session = { provider: "workos" as const, sub: "fixture-sub", accountId: "fixture-account", sessionId: "fixture-session", accessToken: "fixture-zeros-bearer" };
const server = { id: serverId, name: "fixture", transport: "stdio", command: "tool", env: { MCP_KEY: "fixture-mcp-secret" } };
const clients: McpControlClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });
function fixture(admitRepository?: (input: { organizationId: string; repository: string }) => Promise<void>) {
  let current = true, identity: typeof session | null = session, changed: (() => void) | undefined;
  const output: Array<Record<string, any>> = [];
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ servers: [server] }));
  const client = new McpControlClient({ session: async () => identity, baseUrl: () => "https://api.example.test", fetch: fetcher,
    current: () => current, write: line => { output.push(JSON.parse(line)); return true; },
    onSessionChanged: listener => { changed = listener; return () => { changed = undefined; }; },
    ...(admitRepository ? { admitRepository } : {}),
  });
  clients.push(client);
  return { client, output, fetcher, replaceChild: () => { current = false; }, account: (next: typeof session | null) => { identity = next; changed?.(); } };
}
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }

describe("main private MCP control courier", () => {
  it("resolves through the selected native account and delivers only the exact child response", async () => {
    const f = fixture(), value = request();
    expect(await f.client.receive(value)).toBe(true);
    expect(f.fetcher).toHaveBeenCalledWith(`https://api.example.test/v1/organizations/${organizationId}/extensions/mcp/resolve`, expect.objectContaining({
      method: "POST", redirect: "error", headers: expect.objectContaining({ authorization: "Bearer fixture-zeros-bearer" }),
      body: JSON.stringify({ repository: "fixture/repo", runtime: { kind: "local", id: runtimeId, admitted: true } }),
    }));
    expect(f.output).toEqual([{ type: "host.mcp.response", requestId: value.requestId, data: { accountId: session.accountId, servers: [server] } }]);
    expect(JSON.stringify(f.output)).not.toContain(session.accessToken);
  });

  it("requires the expected account for authorization and fences A to B to A during I/O", async () => {
    const f = fixture(), value = { ...request(), action: "authorization", serverId };
    await f.client.receive(value);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.output[0]).toHaveProperty("error");
    const held = gate();
    f.fetcher.mockImplementation(async () => { await held.promise; return Response.json({ headers: { Authorization: "Bearer fixture-service-token" } }); });
    const pending = f.client.receive({ ...value, requestId: randomUUID(), accountId: session.accountId });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    f.account({ ...session, accountId: "other" }); f.account(session); held.release(); await pending;
    expect(f.output.slice(1)).toEqual([{ type: "host.mcp.accountChanged" }, { type: "host.mcp.accountChanged" }]);
    expect(JSON.stringify(f.output)).not.toContain("fixture-service-token");
  });

  it("does not deliver to a replacement child and suppresses provider error content", async () => {
    const f = fixture(), held = gate();
    f.fetcher.mockImplementation(async () => { await held.promise; return Response.json({ servers: [server] }); });
    const pending = f.client.receive(request());
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    f.replaceChild(); held.release(); await pending; expect(f.output).toEqual([]);
    const denied = fixture();
    denied.fetcher.mockResolvedValue(new Response("fixture-secret-error", { status: 401 }));
    await denied.client.receive(request());
    expect(denied.output[0]).toMatchObject({ error: "MCP request could not complete." });
    expect(JSON.stringify(denied.output)).not.toContain("fixture-secret-error");
  });

  it("bounds concurrency, input shape, response bytes and deadline", async () => {
    const f = fixture(), held = gate();
    f.fetcher.mockImplementation(async () => { await held.promise; return Response.json({ servers: [] }); });
    const pending = Array.from({ length: 8 }, () => f.client.receive(request()));
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(8));
    await f.client.receive(request()); expect(f.output[0]).toHaveProperty("error");
    held.release(); await Promise.all(pending);
    await f.client.receive({ ...request(), repository: "/local/repo" });
    expect(f.fetcher).toHaveBeenCalledTimes(8);
    f.fetcher.mockResolvedValue(new Response(" ".repeat(MCP_CONTROL_MAX_BYTES + 1)));
    await f.client.receive(request()); expect(f.output.at(-1)).toHaveProperty("error");
    vi.useFakeTimers();
    f.fetcher.mockImplementation(() => new Promise(() => {}));
    const timed = f.client.receive(request());
    await vi.advanceTimersByTimeAsync(27_001); await timed;
    expect(f.output.at(-1)).toHaveProperty("error");
  });

  it("delivers bounded header projection without any account bearer or upstream extras", async () => {
    const f = fixture(), value = { ...request(), action: "authorization", serverId, accountId: session.accountId, force: true };
    f.fetcher.mockResolvedValue(Response.json({ headers: { Authorization: "Bearer fixture-service-token" }, expiresAt: 9_999_999_999_999, accessToken: "must-strip" }));
    await f.client.receive(value);
    expect(f.output[0]?.data).toEqual({ accountId: session.accountId, headers: { Authorization: "Bearer fixture-service-token" }, expiresAt: 9_999_999_999_999 });
    expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toEqual({ repository: "fixture/repo", runtime: { kind: "local", id: runtimeId, admitted: true }, force: true });
    expect(JSON.stringify(f.output)).not.toMatch(/fixture-zeros-bearer|must-strip/);
  });

  it("admits repository access natively once per bounded scope and renews only on demand", async () => {
    vi.useFakeTimers();
    const admit = vi.fn(async () => {}), f = fixture(admit);
    await f.client.receive(request()); await f.client.receive(request());
    expect(admit).toHaveBeenCalledExactlyOnceWith({ organizationId, repository: "fixture/repo" });
    await vi.advanceTimersByTimeAsync(120_001);
    expect(admit).toHaveBeenCalledOnce();
    await f.client.receive(request()); expect(admit).toHaveBeenCalledTimes(2);
    await f.client.receive({ ...request(), repository: "fixture/other" }); expect(admit).toHaveBeenCalledTimes(3);
    await f.client.receive({ ...request(), runtimeId: randomUUID() }); expect(admit).toHaveBeenCalledTimes(4);
    f.account(session); await f.client.receive(request()); expect(admit).toHaveBeenCalledTimes(5);
  });

  it("fences account replacement while native repository admission is pending", async () => {
    const held = gate(), admit = vi.fn(async () => { await held.promise; }), f = fixture(admit);
    const pending = f.client.receive(request());
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
    f.account({ ...session, accountId: "other" }); f.account(session);
    held.release(); await pending;
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.output).toEqual([{ type: "host.mcp.accountChanged" }, { type: "host.mcp.accountChanged" }]);
    await f.client.receive(request()); expect(admit).toHaveBeenCalledTimes(2);
  });
});
