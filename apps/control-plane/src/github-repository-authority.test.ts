import { generateKeyPairSync } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { GithubBackendConfig } from "./config.js";
import { GithubRepositoryAuthority } from "./github-repository-authority.js";
import { createCloudV2RepositoryResolver, createCloudV2RepositoryTokens } from "./cloud/github.js";

vi.mock("./db.js", () => ({ withSystemTx: async (pool: unknown, run: (tx: unknown) => unknown) => run(pool) }));
const config = { appId: 1, clientId: "fixture", apiBaseUrl: "https://github.example.test", variantKey: "github.com",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString() } as GithubBackendConfig;

function fixture() {
  const actor = { id: "installation-row", installation: "12", owner: "example", login: "member", user: "23", generation: "generation-one",
    connection: "connection-one", account: "1", organization: "1", membership: "1" };
  const pool = { query: vi.fn(async () => ({ rows: [{ ...actor }] })) };
  let role = "write", userId = 23, repositoryId = 42;
  const revoked: string[] = [], issued: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) {
      const request = JSON.parse(String(init?.body)); issued.push(request);
      return Response.json({ token: `fixture-installation-${issued.length}`, permissions: request.permissions, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    }
    if (url.endsWith("/installation/token")) { revoked.push(String((init?.headers as Record<string, string>).authorization)); return new Response(null, { status: 204 }); }
    if (url.includes("/collaborators/")) return Response.json({ permission: role, user: { id: userId, login: "member" } });
    if (url.endsWith("/repos/example/repo") || url.endsWith("/repositories/42")) return Response.json({ id: repositoryId, full_name: "example/repo" });
    throw new Error("Unexpected provider operation");
  });
  const authority = new GithubRepositoryAuthority(pool as unknown as pg.Pool, config, fetch);
  const request = { organizationId: "org", userId: "local-user", owner: "example", repositories: ["repo"], access: "read" as const };
  return { actor, pool, fetch, revoked, issued, authority, request, role: (value: string) => { role = value; }, user: (value: number) => { userId = value; }, repository: (value: number) => { repositoryId = value; } };
}

describe("exact human repository authority", () => {
  it("narrows both credentials by immutable repository IDs without also sending names", async () => {
    const f = fixture();
    await f.authority.mint({ ...f.request, repositoryIds: ["42"] });
    expect(f.issued).toEqual([
      { repository_ids: [42], permissions: { metadata: "read" } },
      { repository_ids: [42], permissions: { metadata: "read", contents: "read", pull_requests: "read" } },
    ]);
  });
  it("keeps the same permission and cleanup checks with an independent cloud actor", async () => {
    const f = fixture(), snapshot = vi.fn(async () => ({ ...f.actor }));
    const cloud = new GithubRepositoryAuthority(f.pool as unknown as pg.Pool, config, f.fetch, snapshot);
    await cloud.mint(f.request);
    expect(f.pool.query).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledTimes(2);
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const result = await original(input, init);
      if (String(input).endsWith("/installation/token")) snapshot.mockRejectedValue(new Error("connection removed"));
      return result;
    });
    await expect(cloud.mint(f.request)).rejects.toThrow("connection removed");
    expect(f.revoked).toContain("Bearer fixture-installation-4");
  });
  it("refuses a reused repository name even when the human has permission on its replacement", async () => {
    const f = fixture(); f.repository(99);
    await expect(f.authority.mint({ ...f.request, repositoryIds: ["42"] })).rejects.toMatchObject({ status: 403 });
    expect(f.issued).toHaveLength(1);
    expect(f.revoked).toEqual(["Bearer fixture-installation-1"]);
  });
  it("revokes the candidate credential if the repository name is replaced during probe cleanup", async () => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/installation/token")) f.repository(99);
      return response;
    });
    await expect(f.authority.mint({ ...f.request, repositoryIds: ["42"] })).rejects.toMatchObject({ status: 403 });
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
  it.each([[], ["0"], ["01"], ["9007199254740992"], ["42", "43"]].map(repositoryIds => ({ repositoryIds })))("rejects malformed or mismatched ID scopes $repositoryIds before mint", async ({ repositoryIds }) => {
    const f = fixture();
    await expect(f.authority.mint({ ...f.request, repositoryIds })).rejects.toMatchObject({ status: 403 });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("retains the injected selected-cloud actor reader through final revalidation without consulting Local OAuth rows", async () => {
    const f = fixture(), actorSnapshot = vi.fn(async () => ({ ...f.actor }));
    const authority = new GithubRepositoryAuthority(f.pool as unknown as pg.Pool, config, f.fetch, actorSnapshot);
    await authority.mint({ ...f.request, repositoryIds: ["42"] });
    expect(f.pool.query).not.toHaveBeenCalled(); expect(actorSnapshot).toHaveBeenCalledTimes(2);
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/installation/token")) f.actor.generation = "reconnected";
      return response;
    });
    await expect(authority.mint({ ...f.request, repositoryIds: ["42"] })).rejects.toMatchObject({ status: 403 });
    expect(f.revoked).toContain("Bearer fixture-installation-4");
  });
  it("resolves a fresh or retained Computer source with a live immutable ID and cleans up its observation credential", async () => {
    for (const repositoryId of [undefined, "42"]) {
      const f = fixture(), resolve = createCloudV2RepositoryResolver(f.pool as unknown as pg.Pool, config, f.fetch);
      await expect(resolve("org", "local-user", { repository: "example/repo", ...(repositoryId ? { repositoryId } : {}) }))
        .resolves.toEqual({ repository: "example/repo", repositoryId: "42" });
      expect(f.revoked).toContain("Bearer fixture-installation-2");
      expect(f.issued.at(-1)).toMatchObject({ repository_ids: [42], permissions: { metadata: "read" } });
    }
  });
  it("does not admit a newly observed Computer identity after the connection changes during credential cleanup", async () => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/installation/token") &&
        (init?.headers as Record<string, string>).authorization === "Bearer fixture-installation-2") f.actor.generation = "reconnected";
      return response;
    });
    const resolve = createCloudV2RepositoryResolver(f.pool as unknown as pg.Pool, config, f.fetch);
    await expect(resolve("org", "local-user", { repository: "example/repo" })).rejects.toMatchObject({ code: "github_authorization_changed" });
  });
  it("defaults clone/head credentials to read-only and never inherits installation permissions", async () => {
    const f = fixture();
    const token = await createCloudV2RepositoryTokens(f.pool as unknown as pg.Pool, config, f.fetch)("org", "local-user", "example/repo");
    expect(token.token).toBe("fixture-installation-2");
    expect(f.issued).toEqual([
      { repositories: ["repo"], permissions: { metadata: "read" } },
      { repositories: ["repo"], permissions: { metadata: "read", contents: "read", pull_requests: "read" } },
    ]);
    expect(f.revoked).toEqual(["Bearer fixture-installation-1"]);
  });
  it("keeps read-only users read-only and refuses an explicit write", async () => {
    const f = fixture(); f.role("read");
    await expect(f.authority.mint({ ...f.request, access: "write" })).rejects.toMatchObject({ status: 403 });
    expect(f.issued).toHaveLength(1);
    await f.authority.mint({ ...f.request, access: "user" });
    expect(f.issued.at(-1)?.permissions).toEqual({ metadata: "read", contents: "read", pull_requests: "read" });
  });
  it.each(["none", "unknown", ""])("refuses missing or unsupported effective permission %j", async role => {
    const f = fixture(); f.role(role);
    await expect(f.authority.mint(f.request)).rejects.toMatchObject({ status: 403 });
    expect(f.issued).toHaveLength(1);
  });
  it("binds the human to the immutable GitHub id, not a reusable username", async () => {
    const f = fixture(); f.user(99);
    await expect(f.authority.mint(f.request)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["generation", "connection", "membership", "account"] as const)("revokes a minted token when %s changes across the provider call", async field => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (f.issued.length === 2) f.actor[field] = "successor";
      return response;
    });
    await expect(f.authority.mint(f.request)).rejects.toMatchObject({ status: 403 });
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
  it("rechecks remote permission after mint and fails closed when membership disappears", async () => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      if (f.issued.length === 2) f.role("none");
      return original(input, init);
    });
    await expect(f.authority.mint(f.request)).rejects.toMatchObject({ status: 403 });
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
  it.each(["generation", "connection", "membership", "account", "permission"] as const)("does not release a credential when %s changes during probe cleanup", async field => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/installation/token") &&
        (init?.headers as Record<string, string>).authorization === "Bearer fixture-installation-1") {
        if (field === "permission") f.role("none");
        else f.actor[field] = "successor";
      }
      return response;
    });
    await expect(f.authority.mint(f.request)).rejects.toMatchObject({ status: 403 });
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
});
