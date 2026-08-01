import { describe, expect, it, vi } from "vitest";

import {
  GithubAppClient,
  GithubAppClientError,
  aggregateGithubAppInstallations,
} from "../github-app-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const validRefreshBinding = `zghrb_v1.${"a".repeat(43)}.${"b".repeat(43)}`;

describe("GitHub App control-plane client", () => {
  it("accepts only a bounded HTTPS authorization handoff", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        authorizeUrl:
          "https://github.com/login/oauth/authorize?state=opaque",
        state: "must-not-leave-the-client",
        expiresAt: new Date(1_060_000).toISOString(),
        flowKind: "oauth",
      }),
    );
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test/",
      fetch: fetchImpl as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.start("auth-access", {
        nonce: "n".repeat(43),
        variantKey: "github.com",
        scheme: "zeros-dev",
        installFlow: true,
      }),
    ).resolves.toEqual({
      authorizeUrl:
        "https://github.com/login/oauth/authorize?state=opaque",
      expiresAtMs: 1_060_000,
      flowKind: "oauth",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.zeros.test/v1/github/oauth/start",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer auth-access",
        }),
      }),
    );
  });

  it("falls back to the requested flow kind with an older control plane", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          authorizeUrl:
            "https://github.com/apps/zeros/installations/new?state=opaque",
          expiresAt: new Date(1_060_000).toISOString(),
        }),
      ) as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.start("auth-access", {
        nonce: "n".repeat(43),
        variantKey: "github.com",
        scheme: "zeros-dev",
        installFlow: true,
      }),
    ).resolves.toMatchObject({ flowKind: "install" });
  });

  it("rejects an invented flow kind from the control plane", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          authorizeUrl:
            "https://github.com/login/oauth/authorize?state=opaque",
          expiresAt: new Date(1_060_000).toISOString(),
          flowKind: "configure",
        }),
      ) as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.start("auth-access", {
        nonce: "n".repeat(43),
        variantKey: "github.com",
        scheme: "zeros-dev",
        installFlow: true,
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("refuses a non-GitHub authorization destination from the control plane", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          authorizeUrl: "https://accounts.example/phish",
          expiresAt: new Date(1_060_000).toISOString(),
        }),
      ) as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.start("auth-access", {
        nonce: "n".repeat(43),
        variantKey: "github.com",
        scheme: "zeros-dev",
        installFlow: true,
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("rejects insecure remote URLs but permits explicit dev loopback", async () => {
    expect(
      () =>
        new GithubAppClient({
          baseUrl: "http://api.zeros.test",
        }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new GithubAppClient({
          baseUrl: "http://127.0.0.1:8080",
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
  });

  it("requires the control-plane base URL to be a bare origin", () => {
    expect(
      () =>
        new GithubAppClient({
          baseUrl: "https://api.zeros.test/prefix",
        }),
    ).toThrow(/origin/);
    expect(
      () =>
        new GithubAppClient({
          baseUrl: "https://api.zeros.test/?redirect=elsewhere",
        }),
    ).toThrow(/origin/);
  });

  it("validates and aggregates installation metadata", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          accessToken: "app-access",
          refreshToken: "app-refresh",
          refreshBinding: validRefreshBinding,
          expiresAtMs: 5_000_000,
          refreshTokenExpiresAtMs: 50_000_000,
          login: "octocat",
          variantKey: "github.com",
          installationsComplete: true,
          installations: [
            {
              repositoryCount: 3,
              allRepositories: false,
              suspendedAt: null,
            },
            {
              repositoryCount: 9,
              allRepositories: true,
              suspendedAt: "2026-07-01T00:00:00.000Z",
            },
          ],
        }),
      ) as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.exchange("auth-access", "n".repeat(43)),
    ).resolves.toMatchObject({
      accessToken: "app-access",
      refreshToken: "app-refresh",
      refreshBinding: validRefreshBinding,
      login: "octocat",
      installationCount: 2,
      activeInstallationCount: 1,
      repositoryCount: 3,
      allRepositories: false,
    });
  });

  it("rejects a token pair that cannot be rotated before it expires", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          accessToken: "app-access",
          expiresAtMs: 5_000_000,
          login: "octocat",
          variantKey: "github.com",
          installationsComplete: true,
          installations: [],
        }),
      ) as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.exchange("auth-access", "n".repeat(43)),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("connects without publishing counts when the initial inventory is partial", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          accessToken: "app-access",
          refreshToken: "app-refresh",
          refreshBinding: validRefreshBinding,
          expiresAtMs: 5_000_000,
          refreshTokenExpiresAtMs: 50_000_000,
          login: "octocat",
          variantKey: "github.com",
          installationsComplete: false,
          installations: [{ repositoryCount: 999 }],
        }),
      ) as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(
      client.exchange("auth-access", "n".repeat(43)),
    ).resolves.toEqual({
      accessToken: "app-access",
      refreshToken: "app-refresh",
      refreshBinding: validRefreshBinding,
      expiresAtMs: 5_000_000,
      refreshTokenExpiresAtMs: 50_000_000,
      login: "octocat",
      variantKey: "github.com",
    });
  });

  it("marks only a confirmed GitHub refresh refusal as terminal", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "github_authorization_expired",
              message: "Reconnect.",
            },
          },
          401,
        ),
      ) as typeof fetch,
    });

    const error = await client
      .refresh("auth-access", "app-refresh", validRefreshBinding)
      .catch((value) => value);
    expect(error).toBeInstanceOf(GithubAppClientError);
    expect(error).toMatchObject({
      code: "github_authorization_expired",
      terminal: true,
    });
  });

  it("validates explicit installation refresh metadata", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          login: "octocat",
          complete: true,
          installations: [
            {
              repositoryCount: 2,
              allRepositories: true,
              suspendedAt: null,
            },
          ],
        }),
      ) as typeof fetch,
    });

    await expect(
      client.refreshInstallations("zeros-access", "app-access"),
    ).resolves.toEqual({
      login: "octocat",
      complete: true,
      installationCount: 1,
      activeInstallationCount: 1,
      repositoryCount: 2,
      allRepositories: true,
    });
  });

  it("does not publish a partial installation inventory as authoritative", async () => {
    const client = new GithubAppClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        jsonResponse({
          login: "octocat",
          complete: false,
          installations: [],
        }),
      ) as typeof fetch,
    });

    await expect(
      client.refreshInstallations("zeros-access", "app-access"),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("GitHub App installation aggregation", () => {
  it("reports all-repository access only when every installation is active", () => {
    expect(
      aggregateGithubAppInstallations([
        {
          repositoryCount: 2,
          allRepositories: true,
          suspendedAt: null,
        },
        {
          repositoryCount: 4,
          allRepositories: true,
          suspendedAt: null,
        },
      ]),
    ).toEqual({
      installationCount: 2,
      activeInstallationCount: 2,
      repositoryCount: 6,
      allRepositories: true,
    });
  });
});
