import { describe, expect, it, vi } from "vitest";
import { CloudGithubConnections } from "./github-connections.js";
import type {
  CloudGithubConnectionStore,
  CloudGithubCredentialSnapshot,
} from "./github-connections-store.js";
import type { GithubBackendConfig } from "../config.js";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
};
const identity = { id: "12", login: "contributor" };
const repository = {
  id: 42,
  name: "project",
  owner: { login: "owner" },
  default_branch: "main",
  private: true,
  archived: false,
  permissions: { pull: true, push: true },
};
const config = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  appSlug: "zeros-test",
  clientId: "test-client",
  clientSecret: "synthetic-client-secret",
  oauthCallbackUrl: "https://api.example.test/v1/github/oauth/callback",
} as GithubBackendConfig;
function fixture(method: "pat" | "github-app" = "pat") {
  const assertCurrent = vi.fn(async () => {});
  const snapshot: CloudGithubCredentialSnapshot = {
    generation: "g1",
    identity,
    assertCurrent,
    material:
      method === "pat"
        ? { method, accessToken: "synthetic-personal-token", expiresAt: null }
        : {
            method,
            accessToken: "synthetic-app-token",
            refreshToken: "synthetic-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            refreshExpiresAt: Date.now() + 86_400_000,
          },
  };
  const store = {
    credential: vi.fn(async () => snapshot),
    assertCurrent: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    fingerprint: vi.fn(async () => "g1"),
    status: vi.fn(),
    beginOauth: vi.fn(async () => "g2"),
    consumeOauth: vi.fn(),
    cancelOauth: vi.fn(),
    lockCurrent: vi.fn(async () => {}),
  };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    return Response.json(
      path === "/user"
        ? { id: 12, login: "contributor" }
        : path.endsWith("/branches")
          ? []
          : repository,
    );
  });
  const service = new CloudGithubConnections(
    store as unknown as CloudGithubConnectionStore,
    config,
    fetcher as typeof fetch,
  );
  return { service, store, fetcher, snapshot, assertCurrent };
}
describe("selected cloud GitHub credentials", () => {
  it.each(["pat", "github-app"] as const)(
    "uses only the selected %s for user-attributed APIs",
    async (method) => {
      const { service, fetcher, snapshot } = fixture(method);
      const access = await service.access(scope);
      await access.api.repository({ repository: "owner/project" });
      expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
        "https://api.github.com/user",
        "https://api.github.com/repos/owner/project",
      ]);
      for (const call of fetcher.mock.calls as unknown as [
        string,
        RequestInit,
      ][])
        expect(new Headers(call[1].headers).get("authorization")).toBe(
          `Bearer ${snapshot.material.accessToken}`,
        );
    },
  );
  it("requires the immutable GitHub human, even if a login spelling matches", async () => {
    const { service, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json({ id: 77, login: "contributor" }));
    await expect(service.access(scope)).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
  });
  it("pins configuration admission to the observed repository and generation through commit", async () => {
    const { service, store, fetcher } = fixture();
    const admitted = await service.authorizeRepositoryConfiguration(
      scope.organizationId,
      scope.userId,
      "owner/project",
    );
    expect(admitted.repositoryId).toBe("42");
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/user", "/repos/owner/project", "/repositories/42/branches"]);
    const tx = {} as Parameters<typeof admitted.assertCurrent>[0];
    await admitted.assertCurrent(tx);
    expect(store.lockCurrent).toHaveBeenCalledExactlyOnceWith(tx, scope, "g1");
    store.lockCurrent.mockRejectedValueOnce(new Error("connection changed"));
    await expect(admitted.assertCurrent(tx)).rejects.toThrow(
      "connection changed",
    );
  });
  it("does not fall back to another connection after expiry or revocation", async () => {
    const { service, store, fetcher } = fixture();
    store.credential.mockRejectedValue(
      new Error("selected connection unavailable"),
    );
    await expect(service.access(scope)).rejects.toThrow(
      "selected connection unavailable",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("proves Contents read instead of treating metadata-only access as source access", async () => {
    const { service, fetcher } = fixture();
    fetcher.mockImplementation(async (url) =>
      new URL(String(url)).pathname.endsWith("/branches")
        ? new Response(null, { status: 403 })
        : Response.json(
            new URL(String(url)).pathname === "/user"
              ? { id: 12, login: "contributor" }
              : repository,
          ),
    );
    await expect(
      service.check({
        ...scope,
        owner: "owner",
        repositories: ["project"],
        access: "read",
      }),
    ).rejects.toMatchObject({ code: "github_cloud_access_denied" });
  });
  it("rejects requested writes for a read-only human", async () => {
    const { service, fetcher } = fixture();
    fetcher.mockImplementation(async (url) =>
      Response.json(
        new URL(String(url)).pathname === "/user"
          ? { id: 12, login: "contributor" }
          : { ...repository, permissions: { pull: true, push: false } },
      ),
    );
    await expect(
      service.check({
        ...scope,
        owner: "owner",
        repositories: ["project"],
        access: "write",
      }),
    ).rejects.toMatchObject({ code: "github_cloud_write_denied" });
  });
  it("fences the saved PAT against a reconnect while validation is in flight", async () => {
    const { service, store } = fixture();
    store.assertCurrent.mockRejectedValue(new Error("changed"));
    await expect(
      service.connectPat(scope, "g1", "synthetic-pat"),
    ).rejects.toThrow("changed");
    expect(store.save).not.toHaveBeenCalled();
  });
  it("keeps OAuth state, PKCE, and the selected generation together", async () => {
    const { service, store } = fixture();
    const result = await service.begin(scope, "g1");
    const url = new URL(result.url);
    expect(result.generation).toBe("g2");
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^zcg_/);
    expect(store.beginOauth).toHaveBeenCalledWith(
      scope,
      "g1",
      url.searchParams.get("state"),
      expect.any(String),
    );
    expect(result).not.toHaveProperty("verifier");
  });
  it("retires a declined browser sign-in so Settings stops waiting for its consumed state", async () => {
    const { service, store, fetcher } = fixture();
    store.consumeOauth.mockResolvedValue({
      scope,
      expected: "g2",
      verifier: "synthetic-verifier",
    });
    await expect(
      service.callback("zcg_synthetic", undefined, true),
    ).rejects.toMatchObject({ code: "github_oauth_cancelled" });
    expect(store.cancelOauth).toHaveBeenCalledExactlyOnceWith(scope, "g2");
    expect(store.save).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not erase a newer attempt when retiring a failed callback", async () => {
    const { service, store } = fixture();
    store.consumeOauth.mockResolvedValue({
      scope,
      expected: "g2",
      verifier: "synthetic-verifier",
    });
    store.cancelOauth.mockRejectedValueOnce(new Error("newer generation"));
    await expect(
      service.callback("zcg_synthetic", undefined, true),
    ).rejects.toMatchObject({ code: "github_oauth_cancelled" });
    expect(store.cancelOauth).toHaveBeenCalledExactlyOnceWith(scope, "g2");
    expect(store.save).not.toHaveBeenCalled();
  });
  it("does not disclose another credential or an upstream error body", async () => {
    const { service, fetcher } = fixture();
    fetcher.mockResolvedValue(
      Response.json(
        { message: "synthetic-private-provider-detail" },
        { status: 401 },
      ),
    );
    const error = await service.access(scope).catch((value) => value);
    expect(error.code).toBe("github_authorization_expired");
    expect(JSON.stringify(error)).not.toContain(
      "synthetic-private-provider-detail",
    );
  });
  it("shows a verified GitHub login rename without changing the saved human identity", async () => {
    const { service, store, fetcher } = fixture();
    store.status.mockResolvedValue({
      generation: "g1",
      selectedMethod: "pat",
      methods: {
        pat: { configured: true, login: "old-login", health: "connected" },
        "github-app": { configured: false, health: "not-connected" },
      },
    });
    fetcher.mockResolvedValue(Response.json({ id: 12, login: "renamed-user" }));
    expect((await service.status(scope)).methods.pat.login).toBe(
      "renamed-user",
    );
    expect(store.save).not.toHaveBeenCalled();
  });
});
