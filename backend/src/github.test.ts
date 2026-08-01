import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import pg from "pg";

import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import type { GithubBackendConfig } from "./config.js";
import {
  cleanupExpiredGithubOauth,
  createGithubPublicRoutes,
  createGithubRoutes,
  createGithubUnconfiguredRoutes,
  GITHUB_HANDOFF_TTL_MS,
  githubCompletionUrl,
  resolveGithubOauthFlowKind,
  type GithubRouteDependencies,
} from "./github.js";
import { runMigrations } from "./migrate.js";

// An environment with no GitHub App registered used to get the router's generic
// 404 "Not found", which the desktop surfaced as
// `GithubAppClientError: Not found`. A precise code is what lets Settings say
// "use gh CLI or a Personal Access Token for now".
describe("GitHub routes without a registered App", () => {
  it("answers every /v1/github route with github_not_configured", async () => {
    const app = createGithubUnconfiguredRoutes();

    for (const [method, path] of [
      ["POST", "/v1/github/oauth/start"],
      ["POST", "/v1/github/oauth/exchange"],
      ["POST", "/v1/github/oauth/refresh"],
      ["POST", "/v1/github/oauth/revoke"],
      ["POST", "/v1/github/installations/refresh"],
      ["GET", "/v1/github/installations"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "github_not_configured" },
      });
    }
  });
});

describe("GitHub OAuth flow selection", () => {
  it("leaves time for the hosted Open Zeros gesture", () => {
    expect(GITHUB_HANDOFF_TTL_MS).toBe(5 * 60_000);
  });

  it("reauthorizes instead of reopening installation settings for a known cross-device connection", () => {
    expect(
      resolveGithubOauthFlowKind({
        installRequested: true,
        hasAuthorization: true,
        hasInstallation: true,
      }),
    ).toBe("oauth");
  });

  it("treats either account-side record as an existing setup", () => {
    expect(
      resolveGithubOauthFlowKind({
        installRequested: true,
        hasAuthorization: false,
        hasInstallation: false,
      }),
    ).toBe("install");
    expect(
      resolveGithubOauthFlowKind({
        installRequested: true,
        hasAuthorization: true,
        hasInstallation: false,
      }),
    ).toBe("oauth");
    expect(
      resolveGithubOauthFlowKind({
        installRequested: true,
        hasAuthorization: false,
        hasInstallation: true,
      }),
    ).toBe("oauth");
  });

  it("preserves explicit OAuth behavior for a brand-new account", () => {
    expect(
      resolveGithubOauthFlowKind({
        installRequested: false,
        hasAuthorization: false,
        hasInstallation: false,
      }),
    ).toBe("oauth");
  });

  it("keeps the desktop handoff secret in the hosted page fragment", () => {
    const completion = new URL(
      githubCompletionUrl(
        "https://app.zeros.build/github/connected",
        {
          scheme: "zeros-beta",
          client_nonce: "n".repeat(43),
        },
      ),
    );

    expect(completion.origin).toBe("https://app.zeros.build");
    expect(completion.pathname).toBe("/github/connected");
    expect(completion.search).toBe("");
    expect(new URLSearchParams(completion.hash.slice(1))).toEqual(
      new URLSearchParams({
        scheme: "zeros-beta",
        nonce: "n".repeat(43),
      }),
    );
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbDescribe = databaseUrl ? describe : describe.skip;

const githubConfig: GithubBackendConfig = {
  appId: 123456,
  clientId: "Iv1.test-client",
  clientSecret: "test-client-secret",
  refreshBindingSecret: "test-binding-secret",
  appSlug: "zeros-test",
  oauthCallbackUrl: "https://api.example.test/v1/github/oauth/callback",
  webBaseUrl: "https://github.example.test",
  apiBaseUrl: "https://api.github.example.test",
  variantKey: "github.com",
  desktopSchemes: ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"],
};

type FetchCall = { url: string; init?: RequestInit };

function githubFetch(calls: FetchCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });

    if (url.endsWith("/login/oauth/access_token")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type") === "refresh_token") {
        return Response.json({
          access_token: "rotated-access-token",
          expires_in: 28_800,
          refresh_token: "rotated-refresh-token",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
        });
      }
      return Response.json({
        access_token: "initial-access-token",
        expires_in: 28_800,
        refresh_token: "initial-refresh-token",
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
      });
    }
    if (url.endsWith("/user")) {
      return Response.json({ login: "octocat" });
    }
    if (url.includes("/user/installations?")) {
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: 987654,
            app_id: githubConfig.appId,
            account: { login: "acme", type: "Organization" },
            target_type: "Organization",
            repository_selection: "selected",
            suspended_at: null,
            created_at: "2026-07-01T00:00:00.000Z",
            html_url:
              "https://github.example.test/organizations/acme/settings/installations/987654",
          },
        ],
      });
    }
    if (url.includes("/user/installations/987654/repositories")) {
      return Response.json({ total_count: 3, repositories: [] });
    }
    if (
      url.includes("/applications/") &&
      url.endsWith("/token") &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: "unexpected fake URL" }, { status: 500 });
  }) as typeof fetch;
}

function testApp(
  pool: pg.Pool,
  user: AuthedUser,
  dependencies: GithubRouteDependencies,
): Hono {
  const app = new Hono();
  app.route("/", createGithubPublicRoutes(pool, githubConfig, dependencies));
  app.use("/v1/*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createGithubRoutes(pool, githubConfig, dependencies));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return c.json({ error: { code: "internal" } }, 500);
  });
  return app;
}

async function startFlow(
  app: Hono,
  nonce: string,
  installFlow = true,
): Promise<{
  state: string;
  authorizeUrl: string;
  flowKind: "oauth" | "install";
}> {
  const response = await app.request("/v1/github/oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nonce,
      variantKey: "github.com",
      scheme: "zeros-dev",
      installFlow,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    state: string;
    authorizeUrl: string;
    flowKind: "oauth" | "install";
  };
}

async function callback(app: Hono, state: string): Promise<Response> {
  return app.request(
    `/v1/github/oauth/callback?code=temporary-code&state=${encodeURIComponent(
      state,
    )}`,
    { redirect: "manual" },
  );
}

async function connectCredential(
  app: Hono,
  nonce: string,
): Promise<Record<string, unknown>> {
  const started = await startFlow(app, nonce);
  const redirected = await callback(app, started.state);
  expect(redirected.status).toBe(302);
  const exchanged = await app.request("/v1/github/oauth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()) as Record<string, unknown>;
}

dbDescribe("GitHub App OAuth handoff", () => {
  let pool: pg.Pool;
  let userA: AuthedUser;
  let userB: AuthedUser;
  let calls: FetchCall[];
  let appA: Hono;
  let appB: Hono;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    userA = await ensureUser(pool, {
      provider: "auth0",
      providerSub: randomUUID(),
      email: `github-a-${randomUUID()}@example.com`,
      displayName: "GitHub A",
    });
    userB = await ensureUser(pool, {
      provider: "auth0",
      providerSub: randomUUID(),
      email: `github-b-${randomUUID()}@example.com`,
      displayName: "GitHub B",
    });
    calls = [];
    const dependencies = { fetch: githubFetch(calls) };
    appA = testApp(pool, userA, dependencies);
    appB = testApp(pool, userB, dependencies);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("uses the install URL for the one-trip install + authorization flow", async () => {
    const nonce = "a".repeat(43);
    const started = await startFlow(appA, nonce);
    const url = new URL(started.authorizeUrl);
    expect(url.pathname).toBe("/apps/zeros-test/installations/new");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(started.state).not.toBe(nonce);
    expect(started.flowKind).toBe("install");
  });

  it("uses direct OAuth when another device already recorded this account's installation", async () => {
    const crossDeviceUser = await ensureUser(pool, {
      provider: "auth0",
      providerSub: randomUUID(),
      email: `github-cross-device-${randomUUID()}@example.com`,
      displayName: "GitHub Cross Device",
    });
    await pool.query(
      `INSERT INTO github_authorizations (
         owner_user_id, app_variant, github_login
       ) VALUES ($1, 'github.com', 'octocat')`,
      [crossDeviceUser.id],
    );
    await pool.query(
      `INSERT INTO github_installations (
         github_installation_id, app_variant, owner_user_id,
         account_login, account_type, target_type
       ) VALUES (
         246810, 'github.com', $1, 'Withso', 'Organization', 'Organization'
       )`,
      [crossDeviceUser.id],
    );
    const crossDeviceApp = testApp(pool, crossDeviceUser, {
      fetch: githubFetch([]),
    });

    // A newly installed desktop has no local credential and therefore asks for
    // an install flow. The account-level server snapshot must override that
    // stale local inference or GitHub renders "Configure" and never completes
    // the user-token callback needed by this Mac.
    const started = await startFlow(
      crossDeviceApp,
      "m".repeat(43),
      true,
    );
    const authorize = new URL(started.authorizeUrl);

    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.flowKind).toBe("oauth");
  });

  it("consumes OAuth state and the desktop handoff exactly once", async () => {
    const nonce = "b".repeat(43);
    const started = await startFlow(appA, nonce);
    const redirected = await callback(appA, started.state);
    expect(redirected.status).toBe(302);
    const location = new URL(redirected.headers.get("location")!);
    expect(location.origin).toBe("https://app.zeros.build");
    expect(location.pathname).toBe("/github/connected");
    expect(location.search).toBe("");
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("scheme")).toBe("zeros-dev");
    expect(fragment.get("nonce")).toBe(nonce);

    const replayedState = await callback(appA, started.state);
    expect(replayedState.status).toBe(422);

    const exchange = await appA.request("/v1/github/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      accessToken: "initial-access-token",
      refreshToken: "initial-refresh-token",
      login: "octocat",
      variantKey: "github.com",
      installationsComplete: true,
    });
    expect(body).toHaveProperty("expiresAtMs");
    expect(body).toHaveProperty("refreshTokenExpiresAtMs");
    expect(body.refreshBinding).toMatch(
      /^zghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(body.installations).toEqual([
      expect.objectContaining({
        installationId: 987654,
        accountLogin: "acme",
        repositoryCount: 3,
        allRepositories: false,
      }),
    ]);

    const replayedHandoff = await appA.request("/v1/github/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(replayedHandoff.status).toBe(404);
  });

  it("binds the handoff to the Auth0 user who started it", async () => {
    const nonce = "c".repeat(43);
    const started = await startFlow(appA, nonce);
    expect((await callback(appA, started.state)).status).toBe(302);

    const stolen = await appB.request("/v1/github/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(stolen.status).toBe(404);

    const owner = await appA.request("/v1/github/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(owner.status).toBe(200);
  });

  it("uses S256 PKCE for the direct authorization reconnect flow", async () => {
    calls.length = 0;
    const nonce = "d".repeat(43);
    const started = await startFlow(appA, nonce, false);
    const authorize = new URL(started.authorizeUrl);
    expect(started.flowKind).toBe("oauth");
    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );

    expect((await callback(appA, started.state)).status).toBe(302);
    const exchangeCall = calls.find((call) =>
      call.url.endsWith("/login/oauth/access_token"),
    );
    const form = new URLSearchParams(String(exchangeCall?.init?.body ?? ""));
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(form.get("code_verifier")).not.toBe(
      authorize.searchParams.get("code_challenge"),
    );
  });

  it("re-checks installations with the bound GitHub account only", async () => {
    const refreshed = await appA.request("/v1/github/installations/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: "current-access-token" }),
    });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      login: "octocat",
      complete: true,
      installations: [
        {
          installationId: 987654,
          accountLogin: "acme",
          repositoryCount: 3,
        },
      ],
    });

    // A Zeros account with no GitHub authorization at all is NOT a mismatch:
    // reporting it as one left the desktop's Settings row stuck on
    // "unavailable" forever, because a mismatch has no recovery path while
    // github_authorization_expired drives the reconnect flow.
    const noAuthorization = await appB.request(
      "/v1/github/installations/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: "current-access-token" }),
      },
    );
    expect(noAuthorization.status).toBe(401);
    expect(await noAuthorization.json()).toMatchObject({
      error: { code: "github_authorization_expired" },
    });

    // A genuinely foreign GitHub account still reports a mismatch.
    await pool.query(
      `UPDATE github_authorizations SET github_login = 'someone-else'
       WHERE owner_user_id = $1`,
      [userA.id],
    );
    const wrongGithubAccount = await appA.request(
      "/v1/github/installations/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: "current-access-token" }),
      },
    );
    expect(wrongGithubAccount.status).toBe(403);
    expect(await wrongGithubAccount.json()).toMatchObject({
      error: { code: "github_account_mismatch" },
    });
    await pool.query(
      `UPDATE github_authorizations SET github_login = 'octocat'
       WHERE owner_user_id = $1`,
      [userA.id],
    );
  });

  // Enumerating installations costs up to 60 outbound GitHub calls. Doing that
  // before confirming the token belongs to this Zeros account turned the route
  // into a token-validity oracle paid for with our IP reputation.
  it("verifies the bound account before enumerating installations", async () => {
    const before = calls.length;
    const response = await appB.request("/v1/github/installations/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: "current-access-token" }),
    });

    expect(response.status).toBe(401);
    const attempted = calls.slice(before).map((call) => call.url);
    expect(attempted.filter((url) => url.endsWith("/user"))).toHaveLength(1);
    expect(
      attempted.filter((url) => url.includes("/user/installations")),
    ).toHaveLength(0);
  });

  it("rotates refresh tokens and revokes without exposing the client secret in a response", async () => {
    const current = await connectCredential(appA, "e".repeat(43));
    const tokenCallsBeforeRejections = calls.filter((call) =>
      call.url.endsWith("/login/oauth/access_token"),
    ).length;
    const stolenBinding = await appB.request("/v1/github/oauth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });
    expect(stolenBinding.status).toBe(401);

    const mismatchedToken = await appA.request("/v1/github/oauth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: "another-refresh-token",
        refreshBinding: current.refreshBinding,
      }),
    });
    expect(mismatchedToken.status).toBe(401);
    expect(
      calls.filter((call) => call.url.endsWith("/login/oauth/access_token")),
    ).toHaveLength(tokenCallsBeforeRejections);

    const refreshed = await appA.request("/v1/github/oauth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });
    expect(refreshed.status).toBe(200);
    const refreshBody = (await refreshed.json()) as Record<string, unknown>;
    expect(refreshBody).toMatchObject({
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      refreshBinding: expect.stringMatching(
        /^zghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      ),
    });
    expect(JSON.stringify(refreshBody)).not.toContain(
      githubConfig.clientSecret,
    );

    const revoked = await appA.request("/v1/github/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      revoked: true,
      remotelyRevoked: true,
    });

    // Idempotent: a retry must not send GitHub a second authenticated revoke or
    // append a duplicate audit row for a grant this backend no longer holds.
    const revokeCallsAfterFirst = calls.filter(
      (call) =>
        call.url.includes("/applications/") && call.url.endsWith("/token"),
    ).length;
    const replayed = await appA.request("/v1/github/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({
      revoked: true,
      remotelyRevoked: false,
    });
    expect(
      calls.filter(
        (call) =>
          call.url.includes("/applications/") && call.url.endsWith("/token"),
      ),
    ).toHaveLength(revokeCallsAfterFirst);
  });

  // The refresh binding is stateless, so without a row check a leaked or
  // backed-up (refreshToken, refreshBinding) pair would keep minting fresh
  // access tokens for months after the user clicked Disconnect — GitHub's
  // /applications/{id}/token revocation only kills the one access token.
  it("stops minting tokens for a refresh pair whose authorization was revoked", async () => {
    const current = await connectCredential(appA, "1".repeat(43));
    const revoked = await appA.request("/v1/github/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });
    expect(revoked.status).toBe(200);

    const tokenCallsBeforeReplay = calls.filter((call) =>
      call.url.endsWith("/login/oauth/access_token"),
    ).length;
    const replayed = await appA.request("/v1/github/oauth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });

    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({
      error: { code: "github_authorization_expired" },
    });
    // Rejected before the rotation, so no token was consumed at GitHub.
    expect(
      calls.filter((call) => call.url.endsWith("/login/oauth/access_token")),
    ).toHaveLength(tokenCallsBeforeReplay);
  });

  // The `code` is single-use and the callback has already spent it, so failing
  // the whole connect on a cosmetic listing error abandoned a live ~6-month
  // refresh token with no row, no audit entry, and nothing able to revoke it.
  it("completes a connect whose installation inventory is unavailable", async () => {
    const nonce = "i".repeat(43);
    const flaky = testApp(pool, userA, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.includes("/user/installations")) {
          return Response.json({ message: "server error" }, { status: 500 });
        }
        return githubFetch([])(input as never, init as never);
      }) as typeof fetch,
    });

    const started = await startFlow(flaky, nonce);
    const redirected = await callback(flaky, started.state);
    expect(redirected.status).toBe(302);
    // No `error=` in the fragment: the authorization really did complete.
    expect(redirected.headers.get("location")).not.toContain("error=");

    const exchanged = await flaky.request("/v1/github/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(exchanged.status).toBe(200);
    const body = (await exchanged.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      login: "octocat",
      accessToken: "initial-access-token",
      // Honest about what is unknown, so the desktop does not report 0 apps.
      installationsComplete: false,
      installations: [],
    });

    const recorded = await pool.query(
      `SELECT github_login FROM github_authorizations WHERE owner_user_id = $1`,
      [userA.id],
    );
    expect(recorded.rows[0]?.github_login).toBe("octocat");
  });

  // Only nonce_hash is stored, so the sealed columns are undecryptable from a
  // WAL segment, a PITR restore, or the nightly off-platform dump.
  it("never writes a usable GitHub token into Postgres", async () => {
    const nonce = "s".repeat(43);
    const started = await startFlow(appA, nonce);
    expect((await callback(appA, started.state)).status).toBe(302);

    const stored = await pool.query<{
      access_token_sealed: Buffer;
      refresh_token_sealed: Buffer;
    }>(
      `SELECT access_token_sealed, refresh_token_sealed
       FROM github_oauth_handoffs WHERE owner_user_id = $1`,
      [userA.id],
    );
    const bytes = Buffer.concat(
      stored.rows.flatMap((row) => [
        row.access_token_sealed,
        row.refresh_token_sealed,
      ]),
    ).toString("latin1");
    expect(bytes).not.toContain("initial-access-token");
    expect(bytes).not.toContain("initial-refresh-token");

    // …and the desktop still gets the plaintext pair back for its nonce.
    const exchanged = await appA.request("/v1/github/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(await exchanged.json()).toMatchObject({
      accessToken: "initial-access-token",
      refreshToken: "initial-refresh-token",
    });
  });

  it("does not classify a backend client-secret misconfiguration as a revoked user grant", async () => {
    const current = await connectCredential(appA, "f".repeat(43));
    const misconfigured = testApp(pool, userA, {
      fetch: (async () =>
        Response.json({
          error: "incorrect_client_credentials",
          error_description: "The client secret is invalid.",
        })) as typeof fetch,
    });
    const response = await misconfigured.request("/v1/github/oauth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: current.refreshToken,
        refreshBinding: current.refreshBinding,
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "github_oauth_failed" },
    });
  });

  it("physically removes expired token handoffs instead of only hiding them", async () => {
    const nonceHash = Buffer.alloc(32, 7);
    await pool.query(
      `INSERT INTO github_oauth_handoffs (
         nonce_hash, owner_user_id, app_variant, access_token_sealed,
         access_token_expires_at, refresh_token_sealed,
         refresh_token_expires_at, login, installations,
         installations_complete, expires_at
       ) VALUES (
         $1, $2, 'github.com', '\\x0a'::bytea, now() + interval '1 hour',
         '\\x0b'::bytea, now() + interval '6 months', 'octocat',
         '[]'::jsonb, true, now() - interval '1 minute'
       )`,
      [nonceHash, userA.id],
    );

    await cleanupExpiredGithubOauth(pool);

    const retained = await pool.query(
      `SELECT 1 FROM github_oauth_handoffs WHERE nonce_hash = $1`,
      [nonceHash],
    );
    expect(retained.rowCount).toBe(0);
  });
});
