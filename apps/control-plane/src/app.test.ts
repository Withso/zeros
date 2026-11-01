import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {Context} from "hono";
import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {HttpError} from "./authz.js";
import { DatabaseAcquireTimeoutError } from "./db.js";

import { createApp, type CreateAppDependencies } from "./app.js";
import type { Config, GithubBackendConfig } from "./config.js";
import { configureControlPlaneTracing, shutdownControlPlaneTracing } from "./tracing.js";
import { workosTestAuth } from "./test-workos-env.js";

// These assert POSITION in the middleware chain, which no per-router test can
// see. `github.test.ts` proved `createGithubUnconfiguredRoutes()` answers 503
// — and it does, in isolation. Mounted after `createAuthMiddleware`, the same
// router was unreachable without a bearer token, so the real service answered
// `401 Missing bearer token` instead. Two callers are hurt by that: GitHub's
// browser callback, which never carries a token at all, and any desktop whose
// session lapsed, which then cannot tell "GitHub App sign-in is off on
// this control plane" from "sign in again".

// createApp only stores the pool; the routes exercised here reject before any
// query. A stub keeps the suite runnable without TEST_DATABASE_URL.
const pool = {
  query: () => {
    throw new Error("no route under test may reach the database");
  },
} as unknown as pg.Pool;

const emailConfig = { from: null, token: null, apiUrl: "", inviteLinkBase: "" };





it("requires app authentication before a paid chat title request", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    const app = createApp({ ...config(null), chatTitleApiKey: "synthetic-title-key" }, pool, emailConfig as never);
    const response = await app.request("/v1/chat-titles", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: "chat", messageId: "message", prompt: "Fix login redirect" }),
    });
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

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
    auth: workosTestAuth(),
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

it.each(["worker", "realtime"] as const)("exposes only liveness and release readiness on a %s process", async processRole => {
  const query = vi.fn(async () => ({ rows: [] }));
  const app = createApp({ ...config(null), processRole }, { query } as unknown as pg.Pool, emailConfig as never);
  expect((await app.request("/healthz")).status).toBe(200);
  for (const path of ["/v1/me", "/v1/cloud-workspaces", "/v1/auth/events", "/auth/login", "/internal/v1/runtime-bases"]) {
    expect((await app.request(path)).status).toBe(404);
  }
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
});

it("opts the assembled app into scalar query-cost observation without exposing raw request data", async () => {
  const observer = vi.fn();
  const healthPool = { query: async () => ({ command: "SELECT", rowCount: 1, rows: [] }) } as unknown as pg.Pool;
  const app = createApp({ ...config(null), slowRequestLogMs: 60_000 }, healthPool, emailConfig as never,
    { requestCostObserver: observer });
  const response = await app.request("/healthz?token=private-request-sentinel");
  expect(response.status).toBe(200);
  expect(observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 1, scope: "application-query-port",
    method: "GET", route: "/healthz", status: 200, queriesStarted: 1, queriesCompleted: 1,
    sqlStatements: 1, sqlWriteStatements: 0, complete: true }));
  expect(JSON.stringify(observer.mock.calls)).not.toContain("private-request-sentinel");
  expect(app.requestCostObserverStatus?.()).toEqual({ enabled: true, pending: 0, dropped: 0, errors: 0 });
});

it("keeps an opted-in assembled-app observer failure outside the HTTP result", async () => {
  const observer = vi.fn(() => { throw new Error("synthetic observer failure"); });
  const healthPool = { query: async () => ({ command: "SELECT", rowCount: 1, rows: [] }) } as unknown as pg.Pool;
  const app = createApp(config(null), healthPool, emailConfig as never, { requestCostObserver: observer });
  expect((await app.request("/healthz")).status).toBe(200);
  expect(observer).toHaveBeenCalledOnce();
  expect(app.requestCostObserverStatus?.()).toEqual({ enabled: true, pending: 0, dropped: 0, errors: 1 });
});

it("exposes bounded pending/drop coverage to the opted-in app collector without awaiting it", async () => {
  const pending: Array<() => void> = [];
  const observer = () => new Promise<void>(resolve => { pending.push(resolve); });
  const healthPool = { query: async () => ({ command: "SELECT", rowCount: 1, rows: [] }) } as unknown as pg.Pool;
  const app = createApp(config(null), healthPool, emailConfig as never, { requestCostObserver: observer });
  try {
    for (let index = 0; index < 18; index++) expect((await app.request("/healthz")).status).toBe(200);
    const status = app.requestCostObserverStatus?.();
    expect(status).toEqual({ enabled: true, pending: 16, dropped: 2, errors: 0 });
    expect(Object.isFrozen(status)).toBe(true);
  } finally { for (const resolve of pending) resolve(); }
  await Promise.resolve();
  expect(app.requestCostObserverStatus?.()).toEqual({ enabled: true, pending: 0, dropped: 2, errors: 0 });
});

it("keeps collector inspection absent and pool identity unchanged when app observation is disabled", async () => {
  const query = async () => ({ command: "SELECT", rowCount: 1, rows: [] });
  const healthPool = { query } as unknown as pg.Pool;
  const app = createApp(config(null), healthPool, emailConfig as never);
  expect(app.requestCostObserverStatus).toBeUndefined();
  expect((await app.request("/healthz")).status).toBe(200);
  expect(healthPool.query).toBe(query);
});

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
  it("returns a closed retry response for capacity loss, including on customer cloud routes", async () => {
    for (const path of ["/v1/me", "/v1/cloud-v2/workspaces"]) {
      const app = createApp(config(null), pool, emailConfig as never);
      const context = new Context(new Request(`https://api.example.test${path}`));
      const response = await app.errorHandler(new DatabaseAcquireTimeoutError(), context);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: { code: "service_busy", message: "Service is temporarily busy" } });
    }
  });
  it("projects deliberate customer cloud errors without infrastructure messages or details",async()=>{
    const app=createApp(config(null),pool,emailConfig as never);
    const context=new Context(new Request('https://api.example.test/v1/cloud-v2/workspaces/workspace'),{path:'/v1/cloud-v2/workspaces/workspace'});
    const response=await app.errorHandler(new HttpError(503,'boat_credit_limit','Boat raw diagnostic',{target:'private-target'}),context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:{code:'cloud_workspace_unavailable',message:'The cloud workspace is temporarily unavailable'}});
  });
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
    // desktop's access token. 422 is the malformed-state rejection, which
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

describe("app assembly — cloud GitHub connections", () => {
  function cloudDependencies(callback = vi.fn(async () => {})): CreateAppDependencies {
    return { cloudV2: {
      routes: { store: {}, computers: {}, bridgeBaseUrl: "wss://api.example.test",
        githubConnections: { callback, authorizeRepositoryConfiguration: vi.fn() } },
      workers: {}, proxy: {},
    } } as unknown as CreateAppDependencies;
  }

  it.each([true, false])("requires authentication for App and PAT routes (App configured=%s)", async configured => {
    const app = createApp(config(configured ? githubConfig : null), pool, emailConfig as never, cloudDependencies());
    for (const [method, path] of [
      ["GET", "/v1/cloud-v2/github/connection"],
      ["POST", "/v1/cloud-v2/github/connection"],
      ["GET", "/v1/cloud-v2/github/repositories"],
    ]) {
      const response = await app.request(path!, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
    }
  });

  it("dispatches cloud OAuth from the browser without returning credentials or Local handoff data", async () => {
    const callback = vi.fn(async () => {}), state = `zcg_${"a".repeat(43)}`;
    const app = createApp(config(githubConfig), pool, emailConfig as never, cloudDependencies(callback));
    const response = await app.request(`/v1/github/oauth/callback?state=${state}&code=synthetic-code`);
    expect(response.status).toBe(200);
    expect(callback).toHaveBeenCalledExactlyOnceWith(state, "synthetic-code", false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("Return to Zeros");
    expect(html).not.toContain(state);
    expect(html).not.toContain("synthetic-code");
  });

  it("keeps non-cloud states on the Local single-use handoff route", async () => {
    const callback = vi.fn(async () => {}), query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const localPool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool;
    const app = createApp(config(githubConfig), localPool, emailConfig as never, cloudDependencies(callback));
    const response = await app.request(`/v1/github/oauth/callback?state=${"b".repeat(43)}&code=synthetic-code`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "oauth_state_expired" } });
    expect(callback).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM github_oauth_states"))).toBe(true);
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
      "/v1/cloud-v2/workspaces", "/v1/cloud-v2/computers",
      "/v1/cloud-agent-credentials", "/v1/organizations/11111111-1111-4111-8111-111111111111/agent-connections",
      "/v1/auth/snapshot", "/v1/auth/events",
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





describe("app assembly — tracing", () => {
  const PARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  let exporter: InMemorySpanExporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    configureControlPlaneTracing({ exporter, sampleRatio: 1, processRole: "api", processor: "simple" });
  });
  afterEach(async () => {
    await shutdownControlPlaneTracing();
  });

  it("records one server span on the caller's trace without the organization identifier", async () => {
    const app = createApp(config(null), pool, emailConfig as never);
    await app.request("/v1/organizations/11111111-1111-4111-8111-111111111111/does-not-exist", {
      headers: { traceparent: PARENT },
    });
    const servers = exporter.getFinishedSpans().filter(span => span.kind === SpanKind.SERVER);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    const text = [servers[0]!.name, ...Object.values(servers[0]!.attributes).map(String)].join(" ");
    expect(text).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("allows the traceparent header through CORS preflight", async () => {
    const app = createApp(config(null), pool, emailConfig as never);
    const response = await app.request(
      "/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-workspaces/22222222-2222-4222-8222-222222222222/access/33333333-3333-4333-8333-333333333333",
      {
        method: "OPTIONS",
        headers: {
          origin: "app://zeros",
          "access-control-request-method": "DELETE",
          "access-control-request-headers": "authorization,traceparent",
        },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("traceparent");
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
