import { describe, expect, it, vi } from "vitest";

import {
  AUTH_CLAIM_NAMESPACE,
  WorkOSDesktopClient,
  validateWorkOSDesktopTokenClaims,
  type WorkOSDesktopTokenClaims,
} from "../workos-desktop-client";

const config = {
  clientId: "client_desktop_example",
  issuer: "https://api.workos.com/user_management/client_web_example",
  jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
  audience: "https://api-alpha.zeros.build",
};

const claims: WorkOSDesktopTokenClaims = {
  providerSubject: "user_example",
  sessionId: "session_example",
  tokenId: "token_example",
  clientId: config.clientId,
  clientKind: "desktop",
  email: "person@example.com",
  emailVerified: true,
  displayName: "Example Person",
  issuedAt: 1_700_000_000,
  expiresAt: 4_000_000_000,
};

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-token",
    refresh_token: "refresh-token-next",
    authentication_method: "GitHubOAuth",
    user: {
      object: "user",
      id: claims.providerSubject,
      email: claims.email,
      email_verified: true,
      name: claims.displayName,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WorkOS desktop public client", () => {
  it("exchanges a code as a public client and verifies identity before returning", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: "authorization-code",
        code_verifier: "pkce-verifier",
      });
      return jsonResponse(responseBody());
    });
    const client = new WorkOSDesktopClient({
      config,
      fetch: fetchMock as typeof fetch,
      verifyAccessToken: async () => claims,
    });

    await expect(
      client.exchangeCode({
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
      }),
    ).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token-next",
      providerSubject: claims.providerSubject,
      sessionId: claims.sessionId,
      clientKind: "desktop",
      authenticationMethod: "GitHubOAuth",
      expiresAt: claims.expiresAt * 1_000,
    });
  });

  it("refreshes without a client secret and persists even an unchanged token value", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: "refresh-token-current",
      });
      expect(body).not.toHaveProperty("client_secret");
      return jsonResponse(
        responseBody({ refresh_token: "refresh-token-current" }),
      );
    });
    const client = new WorkOSDesktopClient({
      config,
      fetch: fetchMock as typeof fetch,
      verifyAccessToken: async () => claims,
    });

    await expect(
      client.refresh({
        refreshToken: "refresh-token-current",
        expectedSubject: claims.providerSubject,
        expectedSessionId: claims.sessionId,
      }),
    ).resolves.toMatchObject({
      status: "active",
      session: { refreshToken: "refresh-token-current" },
    });
  });

  it("retries the same refresh token after a transient failure inside the replay window", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) throw new TypeError("socket closed");
      return jsonResponse(responseBody());
    });
    const sleep = vi.fn(async () => undefined);
    const client = new WorkOSDesktopClient({
      config,
      fetch: fetchMock as typeof fetch,
      verifyAccessToken: async () => claims,
      sleep,
    });

    await expect(
      client.refresh({
        refreshToken: "refresh-token-current",
        expectedSubject: claims.providerSubject,
        expectedSessionId: claims.sessionId,
      }),
    ).resolves.toMatchObject({ status: "active" });
    expect(bodies).toEqual([
      {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: "refresh-token-current",
      },
      {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: "refresh-token-current",
      },
    ]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("classifies only an explicit invalid_grant as terminal", async () => {
    const terminal = new WorkOSDesktopClient({
      config,
      fetch: (async () =>
        jsonResponse(
          { error: "invalid_grant", error_description: "revoked" },
          400,
        )) as typeof fetch,
      verifyAccessToken: async () => claims,
    });
    await expect(
      terminal.refresh({
        refreshToken: "refresh-token-current",
        expectedSubject: claims.providerSubject,
        expectedSessionId: claims.sessionId,
      }),
    ).resolves.toEqual({ status: "terminal", reason: "invalid_grant" });

    const unavailable = new WorkOSDesktopClient({
      config,
      fetch: (async () =>
        jsonResponse({ error: "unavailable" }, 503)) as typeof fetch,
      verifyAccessToken: async () => claims,
      sleep: async () => undefined,
    });
    await expect(
      unavailable.refresh({
        refreshToken: "refresh-token-current",
        expectedSubject: claims.providerSubject,
        expectedSessionId: claims.sessionId,
      }),
    ).resolves.toMatchObject({ status: "transient" });
  });

  it("keeps a replacement refresh token when post-rotation verification is unavailable", async () => {
    const client = new WorkOSDesktopClient({
      config,
      fetch: (async () => jsonResponse(responseBody())) as typeof fetch,
      verifyAccessToken: async () => {
        throw new Error("JWKS temporarily unavailable");
      },
    });

    await expect(
      client.refresh({
        refreshToken: "refresh-token-current",
        expectedSubject: claims.providerSubject,
        expectedSessionId: claims.sessionId,
      }),
    ).resolves.toEqual({
      status: "transient",
      reason: "verification_unavailable",
      replacementRefreshToken: "refresh-token-next",
    });
  });

  it("enforces desktop client, session, verified email, and time claims", () => {
    const payload = {
      sub: claims.providerSubject,
      sid: claims.sessionId,
      jti: claims.tokenId,
      client_id: config.clientId,
      iat: claims.issuedAt,
      exp: claims.expiresAt,
      [`${AUTH_CLAIM_NAMESPACE}email`]: claims.email,
      [`${AUTH_CLAIM_NAMESPACE}email_verified`]: true,
      [`${AUTH_CLAIM_NAMESPACE}name`]: claims.displayName,
    };
    expect(validateWorkOSDesktopTokenClaims(payload, config)).toEqual(claims);
    expect(() =>
      validateWorkOSDesktopTokenClaims(
        { ...payload, client_id: "client_web_example" },
        config,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "token_client_rejected",
      }),
    );
    expect(() =>
      validateWorkOSDesktopTokenClaims(
        { ...payload, [`${AUTH_CLAIM_NAMESPACE}email_verified`]: false },
        config,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "email_unverified",
      }),
    );
  });
});
