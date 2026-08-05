import { describe, expect, it } from "vitest";
import type pg from "pg";

import { createApp } from "./app.js";
import type { Config, GithubBackendConfig } from "./config.js";

// These assert POSITION in the middleware chain, which no per-router test can
// see. `github.test.ts` proved `createGithubUnconfiguredRoutes()` answers 503
// — and it does, in isolation. Mounted after `createAuthMiddleware`, the same
// router was unreachable without a bearer token, so the real service answered
// `401 Missing bearer token` instead. Two callers are hurt by that: GitHub's
// browser callback, which never carries a token at all, and any desktop whose
// Auth0 session lapsed, which then cannot tell "GitHub App sign-in is off on
// this control plane" from "sign in again".

// createApp only stores the pool; the routes exercised here reject before any
// query. A stub keeps the suite runnable without TEST_DATABASE_URL.
const pool = {
  query: () => {
    throw new Error("no route under test may reach the database");
  },
} as unknown as pg.Pool;

const emailConfig = { from: null, token: null, apiUrl: "", inviteLinkBase: "" };

const githubConfig: GithubBackendConfig = {
  appId: 123456,
  clientId: "Iv1.test-client",
  clientSecret: "test-client-secret",
  refreshBindingSecret: "test-binding-secret",
  appSlug: "zeros-test",
  oauthCallbackUrl: "https://api.example.test/v1/github/oauth/callback",
  completionPageUrl: "https://app.example.test/github/connected",
  webBaseUrl: "https://github.example.test",
  apiBaseUrl: "https://api.github.example.test",
  variantKey: "github.com",
  desktopSchemes: ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"],
};

function config(github: GithubBackendConfig | null): Config {
  return {
    databaseUrl: "postgres://unused",
    authIssuers: ["https://tenant.example.test/"],
    authJwksUrl: "https://tenant.example.test/.well-known/jwks.json",
    authAudience: "https://api.example.test",
    port: 8080,
    isProduction: true,
    github,
  };
}

describe("app assembly — no GitHub App registered", () => {
  const app = createApp(config(null), pool, emailConfig as never);

  it("answers /v1/github/* with 503 github_not_configured, not 401", async () => {
    for (const [method, path] of [
      ["POST", "/v1/github/oauth/start"],
      ["POST", "/v1/github/oauth/exchange"],
      ["POST", "/v1/github/oauth/refresh"],
      ["GET", "/v1/github/installations"],
      ["GET", "/v1/github/oauth/callback?state=abc"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(
        { path, status: response.status },
        "an unconfigured GitHub block must announce itself before auth",
      ).toEqual({ path, status: 503 });
      expect(await response.json()).toMatchObject({
        error: { code: "github_not_configured" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
    }
  });

  it("still requires a bearer token on every OTHER /v1 route", async () => {
    const response = await app.request("/v1/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });
});

describe("app assembly — GitHub App registered", () => {
  const app = createApp(config(githubConfig), pool, emailConfig as never);

  it("serves the OAuth callback without a bearer token", async () => {
    // GitHub redirects the user's BROWSER here; it can never carry the
    // desktop's Auth0 token. 422 is the malformed-state rejection, which
    // proves the route ran instead of being swallowed by the auth middleware.
    const response = await app.request("/v1/github/oauth/callback?state=abc");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_oauth_state" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("keeps every other GitHub route behind auth", async () => {
    const response = await app.request("/v1/github/oauth/start", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });
});

describe("app assembly — healthz", () => {
  it("needs no bearer token so Railway's healthcheck can pass", async () => {
    const healthy = createApp(config(null), {
      query: async () => ({ rows: [] }),
    } as unknown as pg.Pool, emailConfig as never);
    const response = await healthy.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
