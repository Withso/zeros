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
