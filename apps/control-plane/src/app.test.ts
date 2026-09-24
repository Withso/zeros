import { describe, expect, it, vi } from "vitest";
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
    inviteLinkBase: "https://app.example.test/invite",
    port: 8080,
    isProduction: true,
    deploymentChannel: "production",
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
      opsOrigin: null,
      apiKey: "workos-api-key-for-tests",
      cookiePassword: "cookie-password-for-tests".repeat(2),
      webhookSecret: "webhook-secret-for-tests",
    },
  };
}

describe("unexpected error privacy", () => {
  it.each([true, false])("omits driver details from logs and HTTP responses (production=%s)", async (isProduction) => {
    const app = createApp({ ...config(null), isProduction }, pool, emailConfig as never);
    const sentinel = "private-value-that-must-never-be-logged";
    app.get("/test-error", () => {
      throw Object.assign(new Error(sentinel), {
        code: "23505", detail: sentinel, query: sentinel, where: sentinel,
        schema: sentinel, table: sentinel, constraint: sentinel,
      });
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request("/test-error");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
      expect(log).toHaveBeenCalledExactlyOnceWith("[error]", { code: "internal", sqlState: "23505" });
      expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    } finally { log.mockRestore(); }
  });
});

describe("database cutover maintenance", () => {
  it("rejects every application surface before auth, provider calls or writes", async () => {
    const query = vi.fn(async () => ({ rows: [{ value: 1 }] }));
    const maintenance = { ...workosConfig(), databaseMaintenanceMode: true };
    const app = createApp(maintenance, { query } as unknown as pg.Pool, emailConfig as never);
    for (const [method, path] of [
      ["GET", "/v1/me"], ["POST", "/auth/workos-webhook"], ["GET", "/auth/start"],
      ["POST", "/v1/organizations"], ["POST", "/internal/v2/cloud-workspaces/engine/register"],
      ["GET", "/healthz/extra"], ["POST", "/healthz"], ["GET", "/preview/"],
    ]) {
      const response = await app.request(path!, { method });
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("30");
    }
    expect(query).not.toHaveBeenCalled();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, maintenance: true });
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
  });
});

describe("app assembly — Railway WorkOS boundary", () => {
  const app = createApp(workosConfig(), pool, emailConfig as never);

  it("mounts browser, webhook, and desktop routes before /v1 bearer auth", async () => {
    const cases = [
      ["GET", "/auth/start?provider=unknown", 400],
      ["GET", "/auth/browser/session", 401],
      ["GET", "/auth/desktop/start?provider=unknown", 400],
      ["POST", "/auth/desktop-revoke", 400],
      ["POST", "/auth/workos-webhook", 401],
    ] as const;
    for (const [method, path, status] of cases) {
      const response = await app.request(path, { method });
      expect({ path, status: response.status }).toEqual({ path, status });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("does not expose an anonymous verification-continuation endpoint", async () => {
    const response = await app.request(
      "/auth/desktop/complete-github-verification",
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});

describe("public Alpha Dev onboarding configuration", () => {
  /** Build a valid Alpha discovery contract with placeholder public client IDs. */
  function alphaConfig(): Config {
    const configured = workosConfig();
    configured.deploymentChannel = "alpha";
    configured.auth = {
      provider: "workos",
      issuer: "https://api.workos.com/user_management/client_web",
      jwksUrl: "https://api.workos.com/sso/jwks/client_web",
      audience: "https://api-alpha.zeros.build",
      desktopClientId: "client_desktop",
      webClientId: "client_web",
    };
    configured.workos!.appOrigin = "https://app-alpha.zeros.build";
    return configured;
  }

  it("serves only the public Alpha contract without authentication or a database read", async () => {
    const app = createApp(alphaConfig(), pool, emailConfig as never);
    const response = await app.request("/auth/desktop/dev-config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      environment: "alpha",
      env: {
        AUTH_PROVIDER: "workos",
        AUTH_DESKTOP_CLIENT_ID: "client_desktop",
        AUTH_ISSUER: "https://api.workos.com/user_management/client_web",
        AUTH_JWKS_URL: "https://api.workos.com/sso/jwks/client_web",
        AUTH_AUDIENCE: "https://api-alpha.zeros.build",
        VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
      },
    });
  });

  it.each(["beta", "production"] as const)(
    "does not bootstrap Dev from %s",
    async (channel) => {
      const configured = alphaConfig();
      configured.deploymentChannel = channel;
      expect(
        (
          await createApp(configured, pool, emailConfig as never).request(
            "/auth/desktop/dev-config",
          )
        ).status,
      ).toBe(404);
    },
  );

  it("fails closed while Alpha is unconfigured or mismatched", async () => {
    const configured = alphaConfig();
    configured.auth.audience = "https://api.zeros.build";
    expect(
      (
        await createApp(configured, pool, emailConfig as never).request(
          "/auth/desktop/dev-config",
        )
      ).status,
    ).toBe(503);
    const legacy = config(null);
    legacy.deploymentChannel = "alpha";
    expect(
      (
        await createApp(legacy, pool, emailConfig as never).request(
          "/auth/desktop/dev-config",
        )
      ).status,
    ).toBe(503);
  });
});

describe("app assembly — isolated Ops browser namespace", () => {
  const configured = workosConfig();
  configured.deploymentChannel = "alpha";
  configured.workos!.opsOrigin = "https://ops-alpha.example.test";
  const app = createApp(configured, pool, emailConfig as never);

  it("mounts the Ops WorkOS ceremony before bearer auth without widening app callbacks", async () => {
    const ops = await app.request("/ops/auth/start");
    expect(ops.status).toBe(400);
    expect(ops.headers.get("cache-control")).toBe("no-store");
    const invented = await app.request("/ops-auth/start");
    expect(invented.status).toBe(404);
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
    const healthy = createApp(
      config(null),
      {
        query: async () => ({ rows: [] }),
      } as unknown as pg.Pool,
      emailConfig as never,
    );
    const response = await healthy.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("reports aggregate cloud posture without making a degraded subsystem a crash loop", async () => {
    const cloud = createApp(
      config(null),
      {
        query: async () => ({ rows: [] }),
      } as unknown as pg.Pool,
      emailConfig as never,
      {
        cloudWorkspaceHealthService: {
          read: async () => ({
            enabled: true,
            setupExecution: "paused",
            durability: "enabled",
            outboxDelivery: "retained",
            operationalState: "degraded",
            reasons: ["deletion_jobs_failed"],
          }),
        },
      },
    );
    const response = await cloud.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      cloudWorkspaces: {
        setupExecution: "paused",
        operationalState: "degraded",
        reasons: ["deletion_jobs_failed"],
      },
    });
  });

  it("exposes a boot-deferred migration while cloud runtime remains disabled", async () => {
    const healthy = createApp(
      config(null),
      {
        query: async () => ({ rows: [] }),
      } as unknown as pg.Pool,
      emailConfig as never,
      {
        migrationStatus: {
          state: "controlled_migration_pending",
          migration: "0025_cloud_workspace_engine_authority.sql",
          dependentRuntime: "cloud_workspaces",
        },
      },
    );

    const response = await healthy.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      migrations: {
        state: "controlled_migration_pending",
        migration: "0025_cloud_workspace_engine_authority.sql",
        dependentRuntime: "cloud_workspaces",
      },
    });
  });

  it("rejects every cloud route before auth or database access while migration is pending", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pending = createApp(
      config(null),
      { query } as unknown as pg.Pool,
      emailConfig as never,
      {
        migrationStatus: {
          state: "controlled_migration_pending",
          migration: "0025_cloud_workspace_engine_authority.sql",
          dependentRuntime: "cloud_workspaces",
        },
      },
    );
    const paths = [
      "/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-workspaces",
      "/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-workspaces/22222222-2222-4222-8222-222222222222",
      "/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-workspace-management/provider-connections",
      "/v1/devices",
      "/v1/devices/33333333-3333-4333-8333-333333333333",
      "/internal/v1/cloud-workspaces/engine/heartbeat",
      "/internal/v2/cloud-workspaces/engine/client-admission",
      "/v1/cloud-workspaces",
      "/v1/cloud-workspaces/22222222-2222-4222-8222-222222222222/invitations",
      "/v1/cloud-workspace-invitations/accept",
      "/v1/cloud-compute-credits",
      "/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-compute-credits",
      "/v1/auth/snapshot",
      "/v1/auth/events",
    ];

    for (const requestPath of paths) {
      const response = await pending.request(requestPath);
      expect(response.status, requestPath).toBe(503);
      expect(await response.json(), requestPath).toMatchObject({
        error: {
          code: "controlled_migration_pending",
          migration: "0025_cloud_workspace_engine_authority.sql",
        },
      });
    }
    expect(query).not.toHaveBeenCalled();

    const unrelated = await pending.request("/v1/me");
    expect(unrelated.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("app assembly — cloud workspace internal capabilities", () => {
  it("mounts capability auth outside interactive bearer middleware only when supplied", async () => {
    const service = {
      redeem: async () => ({ version: 1, material: "bounded" }),
      registerEngine: async () => ({ version: 1 }),
      heartbeat: async () => ({ version: 1 }),
    };
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceInternalSetupService: service,
    });
    const response = await app.request(
      "/internal/v1/cloud-workspaces/setup/admission",
      {
        method: "POST",
        headers: {
          authorization: `Bearer zws_${"A".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          organizationId: "22222222-2222-4222-8222-222222222222",
          generation: 1,
          setupRunId: "33333333-3333-4333-8333-333333333333",
          executionFence: 1,
          expected: {
            imageRef: "snapshot-pinned",
            imageSourceCommit: "a".repeat(40),
            repositoryRevision: "refs/heads/main",
            settingsVersion: 1,
            settingsSha256: "b".repeat(64),
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, material: "bounded" });

    const disabled = createApp(config(null), pool, emailConfig as never);
    expect(
      (
        await disabled.request(
          "/internal/v1/cloud-workspaces/setup/admission",
          { method: "POST" },
        )
      ).status,
    ).toBe(404);
  });

  it("throttles capability guesses by trusted edge IP before service work", async () => {
    let serviceCalls = 0;
    const service = {
      redeem: async () => {
        serviceCalls += 1;
        return { version: 1 };
      },
      registerEngine: async () => {
        serviceCalls += 1;
        return { version: 1 };
      },
      heartbeat: async () => {
        serviceCalls += 1;
        return { version: 1 };
      },
    };
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceInternalSetupService: service,
    });
    let response: Response | null = null;
    for (let attempt = 0; attempt < 601; attempt += 1) {
      response = await app.request(
        "/internal/v1/cloud-workspaces/setup/admission",
        {
          method: "POST",
          headers: {
            authorization: "Bearer invalid",
            "cf-connecting-ip": "203.0.113.91",
          },
        },
      );
    }

    expect(response?.status).toBe(429);
    expect(serviceCalls).toBe(0);
  });

  it("keeps engine registration and heartbeats out of the streaming traffic budget", async () => {
    const heartbeat = vi.fn(async () => ({ version: 1 }));
    const redeem = vi.fn(async () => ({ version: 1 }));
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceInternalSetupService: { redeem, registerEngine: heartbeat, heartbeat },
    });
    const post = (path: string, token: string) => app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-real-ip": "203.0.113.94" },
      body: JSON.stringify({ workspaceId: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222", generation: 1,
        engineInstanceId: "33333333-3333-4333-8333-333333333333" }),
    });
    for (let attempt = 0; attempt < 600; attempt += 1)
      await post("/internal/v1/cloud-workspaces/setup/admission", "invalid");
    expect((await post("/internal/v1/cloud-workspaces/setup/admission", "invalid")).status).toBe(429);
    const beat = () => post("/internal/v1/cloud-workspaces/engine/heartbeat", `zwh_${"c".repeat(43)}`);
    // 300 engines per address at the default 10-second cadence.
    for (let attempt = 0; attempt < 1_800; attempt += 1) expect((await beat()).status).toBe(200);
    expect(heartbeat).toHaveBeenCalledTimes(1_800);
    expect((await beat()).status).toBe(429);
    expect(redeem).not.toHaveBeenCalled();
  });

  it.each(["client-admission", "agent-execution"])("throttles valid-shape v2 %s guesses before service work", async (endpoint) => {
    const invoke = vi.fn(async () => ({ version: 1 }));
    const service = {
      redeem: invoke, registerEngine: invoke, heartbeat: invoke,
      admitActorClient: invoke, agentExecutions: { validate: invoke },
    };
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceInternalSetupService: service as never,
    });
    const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", generation: 1, engineInstanceId: "33333333-3333-4333-8333-333333333333" };
    const body = endpoint === "client-admission"
      ? { ...scope, grantToken: `zwa_${"a".repeat(43)}` }
      : { ...scope, request: { kind: "validate", leaseId: "44444444-4444-4444-8444-444444444444" } };
    const request = () => app.request(`/internal/v2/cloud-workspaces/engine/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer zwh_${"b".repeat(43)}`, "x-real-ip": endpoint === "client-admission" ? "203.0.113.92" : "203.0.113.93" }, body: JSON.stringify(body),
    });
    for (let attempt = 0; attempt < 600; attempt += 1) expect((await request()).status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(600);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(invoke).toHaveBeenCalledTimes(600);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("app assembly — isolated cloud preview proxy", () => {
  it("preserves HTTPS preview identity behind the TLS-terminating edge without trusting a forwarded host", async () => {
    const host = "0123456789abcdef0123456789abcdef.cloud-preview.example.test";
    const handlePreviewRequest = vi.fn(async (request: Request) => new Response(await request.text()));
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceAccessService: {
        issue: async () => { throw new Error("unused"); }, revoke: async () => { throw new Error("unused"); },
        recognizesPreviewRequest: request => new URL(request.url).origin === `https://${host}`,
        handlePreviewRequest,
      },
    });
    const response = await app.request(`http://${host}/submit?x=1`, { method: "POST", headers: { "x-forwarded-proto": "https" }, body: "exact-body" });
    expect(response.status).toBe(200); expect(await response.text()).toBe("exact-body");
    expect(handlePreviewRequest.mock.calls[0]![0].url).toBe(`https://${host}/submit?x=1`);
    const unrelated = await app.request("http://api.example.test/v1/me", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": host } });
    expect(unrelated.status).toBe(401); expect(handlePreviewRequest).toHaveBeenCalledOnce();
    for (const proto of ["http", "https,http", ""]) {
      await app.request(`http://${host}/submit`, { headers: { "x-forwarded-proto": proto } });
    }
    expect(handlePreviewRequest).toHaveBeenCalledOnce();
  });

  it("does not enter the preview database path while a controlled migration is pending", async () => {
    const handlePreviewRequest = vi.fn(async () => new Response("proxied"));
    const app = createApp(config(null), pool, emailConfig as never, {
      migrationStatus: {
        state: "controlled_migration_pending",
        migration: "0025_cloud_workspace_engine_authority.sql",
        dependentRuntime: "cloud_workspaces",
      },
      cloudWorkspaceAccessService: {
        issue: async () => {
          throw new Error("not used");
        },
        revoke: async () => {
          throw new Error("not used");
        },
        recognizesPreviewRequest: () => true,
        handlePreviewRequest,
      },
    });

    const response = await app.request(
      "https://0123456789abcdef0123456789abcdef.cloud-preview.example.test/app",
    );

    expect(response.status).not.toBe(200);
    expect(handlePreviewRequest).not.toHaveBeenCalled();
  });

  it("serves a capability-authorized preview before interactive auth", async () => {
    const access = {
      issue: async () => {
        throw new Error("not used");
      },
      revoke: async () => {
        throw new Error("not used");
      },
      recognizesPreviewRequest: (request: Request) =>
        new URL(request.url).hostname.endsWith(".cloud-preview.example.test"),
      handlePreviewRequest: async (request: Request) =>
        new URL(request.url).hostname.endsWith(".cloud-preview.example.test")
          ? new Response("proxied", {
              headers: { "cache-control": "no-store" },
            })
          : null,
    };
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceAccessService: access,
    });
    const response = await app.request(
      "https://0123456789abcdef0123456789abcdef.cloud-preview.example.test/app",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied");

    const api = await app.request("https://api.example.test/v1/me");
    expect(api.status).toBe(401);
  });

  it("throttles preview hosts by trusted client IP before capability or database work", async () => {
    let handled = 0;
    const access = {
      issue: async () => {
        throw new Error("not used");
      },
      revoke: async () => {
        throw new Error("not used");
      },
      recognizesPreviewRequest: (request: Request) =>
        new URL(request.url).hostname.endsWith(".cloud-preview.example.test"),
      handlePreviewRequest: async () => {
        handled += 1;
        return new Response("denied", { status: 401 });
      },
    };
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceAccessService: access,
    });
    let response: Response | null = null;
    for (let attempt = 0; attempt < 601; attempt += 1) {
      response = await app.request(
        "https://0123456789abcdef0123456789abcdef.cloud-preview.example.test/app",
        { headers: { "x-real-ip": "198.51.100.77" } },
      );
    }
    expect(response?.status).toBe(429);
    expect(handled).toBe(600);
  });

  it("keeps Cloudflare preview clients in independent pre-auth buckets", async () => {
    let handled = 0;
    const access = {
      issue: async () => {
        throw new Error("not used");
      },
      revoke: async () => {
        throw new Error("not used");
      },
      recognizesPreviewRequest: (request: Request) =>
        new URL(request.url).hostname.endsWith(".cloud-preview.example.test"),
      handlePreviewRequest: async () => {
        handled += 1;
        return new Response("denied", { status: 401 });
      },
    };
    const app = createApp(config(null), pool, emailConfig as never, {
      cloudWorkspaceAccessService: access,
    });
    const url =
      "https://fedcba9876543210fedcba9876543210.cloud-preview.example.test/app";
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await app.request(url, {
        headers: { "cf-connecting-ip": "198.51.100.81" },
      });
    }
    const otherClient = await app.request(url, {
      headers: { "cf-connecting-ip": "198.51.100.82" },
    });

    expect(otherClient.status).toBe(401);
    expect(handled).toBe(601);
  });

  it("allows the dedicated revocation header through CORS preflight", async () => {
    const app = createApp(config(null), pool, emailConfig as never);
    const response = await app.request(
      "/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-workspaces/22222222-2222-4222-8222-222222222222/access/33333333-3333-4333-8333-333333333333",
      {
        method: "OPTIONS",
        headers: {
          origin: "app://zeros",
          "access-control-request-method": "DELETE",
          "access-control-request-headers":
            "authorization,x-zeros-access-credential,x-zeros-runtime-admission",
        },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "x-zeros-access-credential",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain("x-zeros-runtime-admission");
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
