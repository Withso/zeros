import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { DatabaseCloudGithubReads } from "./github-read-proxy.js";

const repository = { owner: "org", repository: "repo", repositoryId: "456", installationId: 123 };
const scope = { workspaceId: "workspace", organizationId: "org", generation: 1, engineInstanceId: "engine", heartbeatToken: "synthetic-engine", actorSessionId: "actor" };
const request = { method: "GET", path: "/repos/org/repo/pulls/7" };
function fixture() {
  let now = 1_000_000;
  const broker = { mintWorkspaceRead: vi.fn(async () => ({ token: "synthetic-server-only", expiresAtMs: now + 3_600_000 })), revoke: vi.fn(async () => {}) };
  const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url) === "https://api.github.com/repos/org/repo") return Response.json({ id: 456 });
    if (new Headers(init?.headers).has("if-none-match")) return new Response(null, { status: 304 });
    return Response.json({ number: 7 }, { headers: { etag: '"revision-1"', "set-cookie": "must-not-leave" } });
  });
  const service = new DatabaseCloudGithubReads({} as pg.Pool, false, broker, { fetch: upstream, now: () => now });
  const authorize = vi.spyOn(service, "authorize").mockResolvedValue(repository);
  return { service, broker, upstream, authorize, advance: (ms: number) => { now += ms; } };
}
describe("repository-only GitHub read proxy", () => {
  it("keeps installation credentials server-side and revalidates cached reads", async () => {
    const f = fixture();
    const first = await f.service.read(scope, request);
    expect(first).toEqual({ status: 200, contentType: "application/json", body: '{"number":7}' });
    expect(f.broker.mintWorkspaceRead).toHaveBeenCalledWith({ installationId: 123, repositoryId: 456 });
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
    expect(await f.service.read(scope, request)).toEqual(first);
    expect(f.upstream).toHaveBeenCalledTimes(2);
    f.advance(6000);
    expect(await f.service.read(scope, request)).toEqual(first);
    expect(new Headers(f.upstream.mock.calls[3]?.[1]?.headers).get("if-none-match")).toBe('"revision-1"');
    f.authorize.mockRejectedValueOnce(new Error("retired"));
    await expect(f.service.read(scope, request)).rejects.toThrow();
    expect(f.upstream).toHaveBeenCalledTimes(4);
  });
  it("coalesces simultaneous reads but checks every actor independently", async () => {
    const f = fixture();
    const result = await Promise.all([f.service.read(scope, request), f.service.read({ ...scope, actorSessionId: "second-actor" }, request)]);
    expect(result[0]).toEqual(result[1]);
    expect(f.upstream).toHaveBeenCalledTimes(2);
    expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ actorSessionId: "second-actor" }));
  });
  it("revalidates explicit revision guards within the TTL", async () => {
    const f = fixture();
    await f.service.read(scope, request);
    await f.service.read(scope, { ...request, fresh: true });
    expect(f.upstream).toHaveBeenCalledTimes(4);
  });
  it("rejects repository replacement and actor revocation during upstream reads", async () => {
    const f = fixture();
    f.upstream.mockResolvedValueOnce(Response.json({ id: 999 }));
    await expect(f.service.read(scope, request)).rejects.toThrow("unavailable");
    expect(f.upstream).toHaveBeenCalledTimes(1);
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
    f.authorize.mockResolvedValueOnce(repository).mockRejectedValueOnce(new Error("revoked"));
    await expect(f.service.read(scope, request)).rejects.toThrow();
  });
  it.each(["error", "oversize", "graphql"])("closes %s response details", async kind => {
    const f = fixture();
    f.upstream.mockResolvedValueOnce(Response.json({ id: 456 })).mockResolvedValueOnce(kind === "oversize"
      ? new Response("x", { headers: { "content-length": String(9 * 1024 * 1024) } })
      : Response.json(kind === "graphql" ? { errors: [{ message: "synthetic-server-only" }] } : { message: "synthetic-server-only" }, { status: kind === "error" ? 403 : 200 }));
    await expect(f.service.read(scope, request)).rejects.toThrow("GitHub repository read is unavailable.");
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
  });
  it("limits each workspace even on cache hits and resets the budget", async () => {
    const f = fixture();
    for (let i = 0; i < 240; i++) await f.service.read(scope, request);
    await expect(f.service.read(scope, request)).rejects.toMatchObject({ status: 429 });
    expect(f.upstream).toHaveBeenCalledTimes(2);
    f.advance(60_001);
    await expect(f.service.read(scope, request)).resolves.toMatchObject({ status: 200 });
  });
  it("denies expanded scope before minting", async () => {
    const f = fixture();
    await expect(f.service.read(scope, { method: "GET", path: "/repos/org/other/pulls" })).rejects.toThrow();
    expect(f.broker.mintWorkspaceRead).not.toHaveBeenCalled();
  });
});
