// Negative-path tests for createAuthMiddleware — the single most
// security-critical function in the service. Every case here is a token the
// middleware MUST reject; the last case proves a fully-valid token gets past
// the checks (it reaches the DB layer, which is stubbed to throw a sentinel —
// the success path itself is covered by integration.test.ts with a real DB).
//
// No network, no Auth0: a throwaway RSA key pair is served from a local HTTP
// JWKS endpoint, and tokens are signed here with jose — same library, real
// signatures, real verification.

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { Hono } from "hono";
import type pg from "pg";
import { createAuthMiddleware } from "./auth.js";
import type { Config } from "./config.js";

const AUDIENCE = "https://api.zeros.build";
const ISSUER = "https://test-tenant.auth0.local/";
const WORKOS_ISSUER = "https://identity.test/user_management/client_web";
const WORKOS_WEB_CLIENT_ID = "client_web";
const WORKOS_DESKTOP_CLIENT_ID = "client_desktop";
const NS = "https://zeros.build/";

let privateKey: CryptoKey;
let wrongKey: CryptoKey;
let jwksServer: http.Server;
let config: Config;
let app: Hono;
let workosApp: Hono;

/** A pool stub whose first touch throws a sentinel — reaching it proves the
 *  token cleared every auth check. */
const REACHED_DB = "REACHED_DB_SENTINEL";
const poolStub = {
  connect: () => {
    throw new Error(REACHED_DB);
  },
} as unknown as pg.Pool;

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/** Base claims for a token that would be fully valid. */
function validClaims(): Record<string, unknown> {
  return {
    [`${NS}email`]: "user@example.com",
    [`${NS}email_verified`]: true,
    [`${NS}name`]: "Test User",
  };
}

async function sign(
  claims: Record<string, unknown>,
  opts: {
    key?: CryptoKey;
    issuer?: string | false;
    audience?: string | false;
    expiresIn?: string | false;
  } = {},
): Promise<string> {
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setSubject("github|12345");
  if (opts.issuer !== false) jwt = jwt.setIssuer(opts.issuer ?? ISSUER);
  if (opts.audience !== false) jwt = jwt.setAudience(opts.audience ?? AUDIENCE);
  if (opts.expiresIn !== false) jwt = jwt.setExpirationTime(opts.expiresIn ?? "1h");
  return jwt.sign(opts.key ?? privateKey);
}

async function request(token?: string): Promise<Response> {
  return app.request("/v1/me", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function signWorkos(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    sid: "session_example",
    client_id: WORKOS_WEB_CLIENT_ID,
    ...validClaims(),
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(WORKOS_ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("user_example")
    .setJti("token_example")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function workosRequest(token: string): Promise<Response> {
  return workosApp.request("/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  const real = await generateKeyPair("RS256");
  const imposter = await generateKeyPair("RS256");
  privateKey = real.privateKey;
  wrongKey = imposter.privateKey;

  const jwk = { ...(await exportJWK(real.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  jwksServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const address = jwksServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  config = {
    databaseUrl: "postgres://unused",
    auth: {
      provider: "auth0",
      issuers: [ISSUER],
      jwksUrl: `http://127.0.0.1:${port}/jwks.json`,
      audience: AUDIENCE,
    },
    port: 0,
    isProduction: false,
    feedback: null,
    github: {
      appId: 123,
      clientId: "Iv1.test",
      clientSecret: "test-client-secret",
      appSlug: "zeros-test",
      oauthCallbackUrl: "http://127.0.0.1/github/callback",
      webBaseUrl: "https://github.test",
      apiBaseUrl: "https://api.github.test",
      variantKey: "github.com",
      desktopSchemes: [
        "zeros",
        "zeros-alpha",
        "zeros-beta",
        "zeros-dev",
      ],
    },
  };

  app = new Hono();
  app.use("/v1/*", createAuthMiddleware(config, poolStub));
  app.get("/v1/me", (c) => c.json({ ok: true }));
  // Surface the sentinel so the "valid token reaches the DB" case is assertable.
  app.onError((err, c) => c.json({ error: { message: err.message } }, 500));

  workosApp = new Hono();
  workosApp.use(
    "/v1/*",
    createAuthMiddleware(
      {
        ...config,
        auth: {
          provider: "workos",
          issuer: WORKOS_ISSUER,
          jwksUrl: config.auth.jwksUrl,
          audience: AUDIENCE,
          webClientId: WORKOS_WEB_CLIENT_ID,
          desktopClientId: WORKOS_DESKTOP_CLIENT_ID,
        },
      },
      poolStub,
    ),
  );
  workosApp.get("/v1/me", (c) => c.json({ ok: true }));
  workosApp.onError((err, c) =>
    c.json({ error: { message: err.message } }, 500),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

describe("createAuthMiddleware — rejects", () => {
  it("a request with no bearer token", async () => {
    const res = await request();
    expect(res.status).toBe(401);
  });

  it("garbage that isn't a JWT", async () => {
    const res = await request("not-a-jwt");
    expect(res.status).toBe(401);
  });

  it("an expired token", async () => {
    const token = await sign(validClaims(), { expiresIn: "-1h" });
    const res = await request(token);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("ERR_JWT_EXPIRED");
  });

  it("a token with NO exp at all (requiredClaims)", async () => {
    const token = await sign(validClaims(), { expiresIn: false });
    const res = await request(token);
    expect(res.status).toBe(401);
  });

  it("a token for the wrong audience", async () => {
    const token = await sign(validClaims(), { audience: "https://someone-elses-api" });
    const res = await request(token);
    expect(res.status).toBe(401);
  });

  it("a token from the wrong issuer", async () => {
    const token = await sign(validClaims(), { issuer: "https://evil-tenant.auth0.local/" });
    const res = await request(token);
    expect(res.status).toBe(401);
  });

  it("a token signed by a key outside the JWKS", async () => {
    const token = await sign(validClaims(), { key: wrongKey });
    const res = await request(token);
    expect(res.status).toBe(401);
  });

  it("an unsigned alg=none token", async () => {
    const header = b64url(JSON.stringify({ alg: "none" }));
    const payload = b64url(
      JSON.stringify({
        ...validClaims(),
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "github|12345",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const res = await request(`${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it("a valid token MISSING the email claim", async () => {
    const claims = validClaims();
    delete claims[`${NS}email`];
    const res = await request(await sign(claims));
    expect(res.status).toBe(401);
  });

  it("a valid token with email_verified ABSENT (fail closed)", async () => {
    const claims = validClaims();
    delete claims[`${NS}email_verified`];
    const res = await request(await sign(claims));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("email_unverified");
  });

  it("a valid token with email_verified: false", async () => {
    const claims = { ...validClaims(), [`${NS}email_verified`]: false };
    const res = await request(await sign(claims));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("email_unverified");
  });
});

describe("createAuthMiddleware — accepts", () => {
  it("a fully valid token (clears every check and reaches the DB layer)", async () => {
    const res = await request(await sign(validClaims()));
    // The pool stub throws the sentinel — a 500 carrying it means every auth
    // check passed and the middleware moved on to user provisioning.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(REACHED_DB);
  });

  it("a valid token with TOP-LEVEL claims (namespaced-fallback path)", async () => {
    const res = await request(
      await sign({ email: "user@example.com", email_verified: true, name: "Test User" }),
    );
    expect(res.status).toBe(500); // sentinel again — token accepted
  });
});

describe("createAuthMiddleware — WorkOS contract", () => {
  it("accepts a fully verified token from an allowed Application", async () => {
    const res = await workosRequest(await signWorkos());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(REACHED_DB);
  });

  it("rejects a correctly signed token from another Application", async () => {
    const res = await workosRequest(
      await signWorkos({ client_id: "client_untrusted" }),
    );
    expect(res.status).toBe(401);
  });

  it("requires the WorkOS session and token identifiers", async () => {
    const res = await workosRequest(await signWorkos({ sid: undefined }));
    expect(res.status).toBe(401);
  });

  it("does not accept top-level profile claims in place of the saved JWT template", async () => {
    const res = await workosRequest(
      await signWorkos({
        [`${NS}email`]: undefined,
        [`${NS}email_verified`]: undefined,
        [`${NS}name`]: undefined,
        email: "user@example.com",
        email_verified: true,
      }),
    );
    expect(res.status).toBe(401);
  });
});
