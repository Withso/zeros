import { describe, expect, it, vi } from "vitest";

import { GithubCloudWorkspaceRepositoryResolver } from "./github-repositories.js";

const credential = {
  mint: vi.fn(async () => ({
    token: "ghs_repository_read_only",
    expiresAtMs: Date.now() + 60 * 60_000,
  })),
  revoke: vi.fn(async () => undefined),
};

function repositoryResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: 123456789,
    name: "zeros",
    full_name: "withso/zeros",
    owner: { login: "withso" },
    clone_url: "https://github.com/withso/zeros.git",
    html_url: "https://github.com/withso/zeros",
    default_branch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    ...overrides,
  });
}

describe("GithubCloudWorkspaceRepositoryResolver", () => {
  it("resolves an org-approved repository and exact commit with one contents-only grant", async () => {
    const token = "fixture-org-read-token";
    const broker = { mint: vi.fn(), mintContentsRead: vi.fn(async () => ({ token, expiresAtMs: Date.now() + 3_600_000 })),
      revoke: vi.fn(async () => {}) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(repositoryResponse())
      .mockResolvedValueOnce(Response.json({ sha: "a".repeat(40) }));
    const resolver = new GithubCloudWorkspaceRepositoryResolver({ credential: broker, fetch });
    await expect(resolver.resolve({ installationId: 987654, owner: "withso", repository: "zeros",
      repositoryId: "123456789", revision: "feature/template" })).resolves.toMatchObject({ resolvedRevision: "a".repeat(40) });
    expect(broker.mint).not.toHaveBeenCalled();
    expect(broker.mintContentsRead).toHaveBeenCalledWith({ installationId: 987654, repositoryId: 123456789 });
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/withso/zeros/commits/feature%2Ftemplate");
    expect(broker.revoke).toHaveBeenCalledWith(token);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes(token))).toBe(true);
  });

  it.each(["repository", "commit", "lookup", "revocation"])("refuses a failed org %s verification and retires the read grant", async failed => {
    const broker = { mint: vi.fn(), mintContentsRead: vi.fn(async () => ({ token: "fixture-org-read-token", expiresAtMs: Date.now() + 3_600_000 })),
      revoke: vi.fn(async () => { if (failed === "revocation") throw new Error("unavailable"); }) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(repositoryResponse(failed === "repository" ? { id: 111 } : {}))
      .mockResolvedValueOnce(Response.json({ sha: failed === "commit" ? "b".repeat(40) : "a".repeat(40) }, { status: failed === "lookup" ? 404 : 200 }));
    const resolver = new GithubCloudWorkspaceRepositoryResolver({ credential: broker, fetch });
    await expect(resolver.resolve({ installationId: 987654, owner: "withso", repository: "zeros",
      repositoryId: "123456789", revision: "a".repeat(40) })).rejects.toThrow("unavailable");
    expect(broker.revoke).toHaveBeenCalledOnce();
  });
  it("resolves a forge-owned immutable id and revokes its temporary token", async () => {
    const fetch = vi.fn(async () => repositoryResponse());
    const resolver = new GithubCloudWorkspaceRepositoryResolver({
      credential,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      resolver.resolve({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).resolves.toEqual({
      forge: "github.com",
      forgeRepositoryId: "123456789",
      owner: "withso",
      name: "zeros",
      cloneUrl: "https://github.com/withso/zeros.git",
      webUrl: "https://github.com/withso/zeros",
      defaultBranch: "main",
      visibility: "private",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/withso/zeros",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer ghs_repository_read_only",
        }),
      }),
    );
    expect(credential.revoke).toHaveBeenCalledWith(
      "ghs_repository_read_only",
    );
  });

  it("accepts a valid default branch containing path components", async () => {
    const isolatedCredential = {
      mint: vi.fn(async () => ({
        token: "ghs_repository_read_only",
        expiresAtMs: Date.now() + 60 * 60_000,
      })),
      revoke: vi.fn(async () => undefined),
    };
    const resolver = new GithubCloudWorkspaceRepositoryResolver({
      credential: isolatedCredential,
      fetch: vi.fn(async () =>
        repositoryResponse({ default_branch: "release/2026.08" }),
      ) as typeof globalThis.fetch,
    });

    await expect(
      resolver.resolve({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).resolves.toMatchObject({ defaultBranch: "release/2026.08" });
  });

  it.each([
    ["renamed response", { full_name: "attacker/zeros" }],
    ["archived repository", { archived: true }],
    ["non-GitHub clone URL", { clone_url: "https://evil.test/zeros.git" }],
    ["missing immutable id", { id: null }],
  ])("fails closed for a %s and still revokes the token", async (_name, patch) => {
    const isolatedCredential = {
      mint: vi.fn(async () => ({
        token: "ghs_repository_read_only",
        expiresAtMs: Date.now() + 60 * 60_000,
      })),
      revoke: vi.fn(async () => undefined),
    };
    const resolver = new GithubCloudWorkspaceRepositoryResolver({
      credential: isolatedCredential,
      fetch: vi.fn(async () => repositoryResponse(patch)) as typeof globalThis.fetch,
    });
    await expect(
      resolver.resolve({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).rejects.toThrow("unavailable");
    expect(isolatedCredential.revoke).toHaveBeenCalledTimes(1);
  });

  it("fails the resolution when temporary-token revocation cannot be proven", async () => {
    const isolatedCredential = {
      mint: vi.fn(async () => ({
        token: "ghs_repository_read_only",
        expiresAtMs: Date.now() + 60 * 60_000,
      })),
      revoke: vi.fn(async () => {
        throw new Error("network failed");
      }),
    };
    const resolver = new GithubCloudWorkspaceRepositoryResolver({
      credential: isolatedCredential,
      fetch: vi.fn(async () => repositoryResponse()) as typeof globalThis.fetch,
    });
    await expect(
      resolver.resolve({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).rejects.toThrow("unavailable");
  });
});
