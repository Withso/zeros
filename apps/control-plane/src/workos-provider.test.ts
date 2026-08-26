import { describe, expect, it, vi } from "vitest";

import {
  completeWorkOSGitHubVerification,
  RailwayWorkOSProvider,
  WorkOSDesktopVerificationError,
} from "./workos-provider.js";

const verification = {
  id: "email_verification_01EXAMPLE",
  userId: "user_01GITHUB",
  email: "person@example.com",
  expiresAt: "2099-01-15T09:00:00.000Z",
  code: "123456",
};

const authentication = {
  accessToken: "signed-desktop-access-token",
  refreshToken: "desktop-refresh-token",
  authenticationMethod: "GitHubOAuth",
  user: {
    id: verification.userId,
    email: verification.email,
    emailVerified: true,
    name: "Example Person",
  },
};

function setup(
  identities: Array<{ type: string; provider: string }> = [
    { type: "OAuth", provider: "GitHubOAuth" },
  ],
) {
  const getEmailVerification = vi.fn(async () => verification);
  const getUserIdentities = vi.fn(async () => identities);
  const authenticateWithEmailVerification = vi.fn(async () => authentication);
  const verifyDesktopBearer = vi.fn(async () => ({
    subject: verification.userId,
    sessionId: "session_01EXAMPLE",
  }));
  const revokeSession = vi.fn(async () => {});
  return {
    deps: {
      userManagement: {
        getEmailVerification,
        getUserIdentities,
        authenticateWithEmailVerification,
      },
      verifyDesktopBearer,
      revokeSession,
      now: () => Date.parse("2027-01-15T08:00:00.000Z"),
      desktopClientId: "client_desktop_example",
    },
    getEmailVerification,
    getUserIdentities,
    authenticateWithEmailVerification,
    verifyDesktopBearer,
    revokeSession,
  };
}

const challenge = {
  pendingAuthenticationToken: "pending-authentication-token",
  emailVerificationId: verification.id,
};

describe("WorkOS GitHub verification completion", () => {
  it("checks the challenged user's GitHub identity before using the confidential grant", async () => {
    const harness = setup();

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).resolves.toEqual(authentication);
    expect(harness.getEmailVerification).toHaveBeenCalledWith(verification.id);
    expect(harness.getUserIdentities).toHaveBeenCalledWith(verification.userId);
    expect(harness.authenticateWithEmailVerification).toHaveBeenCalledWith({
      clientId: "client_desktop_example",
      code: verification.code,
      pendingAuthenticationToken: challenge.pendingAuthenticationToken,
    });
    expect(harness.verifyDesktopBearer).toHaveBeenCalledWith(
      authentication.accessToken,
    );
  });

  it("rejects a challenge whose user has no GitHub identity before authentication", async () => {
    const harness = setup([{ type: "OAuth", provider: "GoogleOAuth" }]);

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "identity_rejected",
      }),
    );
    expect(harness.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });

  it("rejects an expired verification before looking up identities", async () => {
    const harness = setup();
    harness.getEmailVerification.mockResolvedValue({
      ...verification,
      expiresAt: "2027-01-15T08:00:00.000Z",
    });

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "challenge_rejected",
      }),
    );
    expect(harness.getUserIdentities).not.toHaveBeenCalled();
    expect(harness.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });

  it("revokes and rejects a session that does not belong to the challenged user", async () => {
    const harness = setup();
    harness.verifyDesktopBearer.mockResolvedValue({
      subject: "user_01OTHER",
      sessionId: "session_01WRONG",
    });

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "contract_rejected",
      }),
    );
    expect(harness.revokeSession).toHaveBeenCalledWith("session_01WRONG");
  });

  it("revokes a valid token when the pending authentication method was not GitHub", async () => {
    const harness = setup();
    harness.authenticateWithEmailVerification.mockResolvedValue({
      ...authentication,
      authenticationMethod: "Password",
    });

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "contract_rejected",
      }),
    );
    expect(harness.revokeSession).toHaveBeenCalledWith("session_01EXAMPLE");
  });
});

describe("RailwayWorkOSProvider browser exchange", () => {
  it("continues a consumed GitHub authorization code with its email-verification challenge", async () => {
    const accessToken = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
      ).toString("base64url"),
      "",
    ].join(".");
    const authenticateWithCode = vi.fn(async () => {
      throw {
        status: 400,
        code: "email_verification_required",
        pendingAuthenticationToken: challenge.pendingAuthenticationToken,
        rawData: {
          code: "email_verification_required",
          pending_authentication_token: challenge.pendingAuthenticationToken,
          email_verification_id: challenge.emailVerificationId,
        },
      };
    });
    const authenticateWithEmailVerification = vi.fn(async () => ({
      ...authentication,
      accessToken,
      sealedSession: "sealed-browser-session",
    }));
    const authenticate = vi.fn(async () => ({
      authenticated: true as const,
      sessionId: "session_01BROWSER",
      accessToken,
      user: authentication.user,
    }));
    const userManagement = {
      authenticateWithCode,
      authenticateWithEmailVerification,
      getEmailVerification: vi.fn(async () => verification),
      getUserIdentities: vi.fn(async () => [
        { type: "OAuth", provider: "GitHubOAuth" },
      ]),
      loadSealedSession: vi.fn(() => ({ authenticate })),
    };
    const provider = new RailwayWorkOSProvider(
      {
        provider: "workos",
        issuer: "https://api.workos.com/",
        jwksUrl: "https://api.workos.com/sso/jwks/client_desktop_example",
        audience: "https://api.zeros.build",
        webClientId: "client_web_example",
        desktopClientId: "client_desktop_example",
      },
      {
        appOrigin: "https://app.zeros.build",
        apiKey: "sk_test_example",
        cookiePassword: "cookie-password-for-tests".repeat(2),
        webhookSecret: "whsec_test_example",
      },
    );
    Reflect.set(provider, "client", { userManagement });

    await expect(
      provider.exchange({
        code: "one-time-authorization-code",
        codeVerifier: "pkce-verifier",
        redirectUri: "https://app.zeros.build/auth/callback",
      }),
    ).resolves.toEqual({
      sealedSession: "sealed-browser-session",
      sessionId: "session_01BROWSER",
      accessToken,
      accessTokenExpiresAt: expect.any(Number),
      user: authentication.user,
    });
    expect(authenticateWithCode).toHaveBeenCalledTimes(1);
    expect(authenticateWithEmailVerification).toHaveBeenCalledWith({
      clientId: "client_web_example",
      code: verification.code,
      pendingAuthenticationToken: challenge.pendingAuthenticationToken,
      session: {
        sealSession: true,
        cookiePassword: "cookie-password-for-tests".repeat(2),
      },
    });
  });
});
