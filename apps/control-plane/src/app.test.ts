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
    auth: {
      provider: "auth0",
      issuers: ["https://tenant.example.test/"],
      jwksUrl: "https://tenant.example.test/.well-known/jwks.json",
      audience: "https://api.example.test",
    },
    workos: null,
    port: 8080,
    isProduction: true,
    github,
    feedback: null,
    cloudWorkspaces: null,
  };
}

function workosConfig(): Config {
  return {
    ...config(null),
    auth: {
      provider: "workos",
      issuer: "https://identity.example.test/user_management/client_web",
      jwksUrl: "https://identity.example.test/sso/jwks/client_web",
      audience: "https://api.example.test",
      webClientId: "client_web",
      desktopClientId: "client_desktop",
    },
    workos: {
      appOrigin: "https://app.example.test",
      apiKey: "workos-api-key-for-tests",
      cookiePassword: "cookie-password-for-tests".repeat(2),
      webhookSecret: "webhook-secret-for-tests",
    },
  };
}

describe("app assembly — Railway WorkOS boundary", () => {
  const app = createApp(workosConfig(), pool, emailConfig as never);

  it("mounts browser, webhook, and desktop routes before /v1 bearer auth", async () => {
    const cases = [
      ["GET", "/auth/start?provider=unknown", 400],
      ["GET", "/auth/browser/session", 401],
      ["POST", "/auth/desktop-revoke", 400],
      ["POST", "/auth/workos-webhook", 401],
    ] as const;
    for (const [method, path, status] of cases) {
      const response = await app.request(path, { method });
      expect({ path, status: response.status }).toEqual({ path, status });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

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

describe("app assembly — request body limits", () => {
  const app = createApp(config(null), pool, emailConfig as never);
  const body = JSON.stringify({ logs: "x".repeat(300 * 1024) });

  it("allows feedback's scrubbed-log payload past the default route ceiling", async () => {
    const response = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // It reached authentication; the default 256 KiB limiter did not reject it.
    expect(response.status).toBe(401);
  });

  it("authenticates before granting feedback's larger transport ceiling", async () => {
    const response = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: "x".repeat(2 * 1024 * 1024) }),
    });

    // An unauthenticated request is rejected before the feedback-only body
    // middleware is allowed to inspect or buffer its multi-megabyte payload.
    expect(response.status).toBe(401);
  });

  it("throttles repeated feedback attempts by client IP before auth", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.request("/v1/feedback", {
        method: "POST",
        headers: { "x-real-ip": "192.0.2.10" },
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("keeps the 256 KiB ceiling on ordinary API routes", async () => {
    const response = await app.request("/v1/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(413);
  });
});
