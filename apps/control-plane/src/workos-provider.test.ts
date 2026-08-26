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
  createdAt: "2027-01-15T07:59:59.900Z",
};

const eventEvidence = [
  {
    id: "event_oauth_succeeded",
    event: "authentication.oauth_succeeded",
    createdAt: "2027-01-15T07:59:59.910Z",
    context: { client_id: "client_desktop_example" },
    data: {
      email: verification.email,
      status: "succeeded",
      type: "oauth",
      userId: verification.userId,
    },
  },
  {
    id: "event_verification_created",
    event: "email_verification.created",
    createdAt: "2027-01-15T07:59:59.920Z",
    context: { client_id: "client_desktop_example" },
    data: {
      id: verification.id,
      email: verification.email,
      userId: verification.userId,
    },
  },
];

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
  const listEvents = vi.fn(async () => ({ data: eventEvidence }));
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
      events: { listEvents },
      verifyDesktopBearer,
      revokeSession,
      now: () => Date.parse("2027-01-15T08:00:00.000Z"),
      wait: vi.fn(async () => {}),
      desktopClientId: "client_desktop_example",
    },
    getEmailVerification,
    getUserIdentities,
    authenticateWithEmailVerification,
    listEvents,
    verifyDesktopBearer,
    revokeSession,
  };
}

const challenge = {
  pendingAuthenticationToken: "pending-authentication-token",
  emailVerificationId: verification.id,
};

describe("WorkOS GitHub verification completion", () => {
  it("allows WorkOS to link the GitHub identity while completing verification", async () => {
    const harness = setup([]);
    harness.getUserIdentities
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ type: "OAuth", provider: "GitHubOAuth" }]);

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).resolves.toEqual(authentication);
    expect(
      harness.authenticateWithEmailVerification.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.getUserIdentities.mock.invocationCallOrder[0] ?? 0);
    expect(harness.getUserIdentities).toHaveBeenCalledTimes(2);
    expect(harness.deps.wait).toHaveBeenCalledOnce();
  });

  it("proves the OAuth challenge before the grant and checks the linked GitHub identity after it", async () => {
    const harness = setup();

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).resolves.toEqual(authentication);
    expect(harness.getEmailVerification).toHaveBeenCalledWith(verification.id);
    expect(harness.listEvents).toHaveBeenCalledWith({
      events: ["authentication.oauth_succeeded", "email_verification.created"],
      rangeStart: "2027-01-15T07:59:49.900Z",
      rangeEnd: "2027-01-15T08:00:09.900Z",
      limit: 100,
      order: "desc",
    });
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

  it("revokes a completed session when WorkOS did not link a GitHub identity", async () => {
    const harness = setup([{ type: "OAuth", provider: "GoogleOAuth" }]);

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "identity_rejected",
      }),
    );
    expect(harness.authenticateWithEmailVerification).toHaveBeenCalledOnce();
    expect(harness.revokeSession).toHaveBeenCalledWith("session_01EXAMPLE");
  });

  it("rejects a challenge without matching OAuth event evidence before authentication", async () => {
    const harness = setup();
    harness.listEvents.mockResolvedValue({ data: [] });

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "identity_rejected",
      }),
    );
    expect(harness.listEvents).toHaveBeenCalledTimes(3);
    expect(harness.deps.wait).toHaveBeenCalledTimes(2);
    expect(harness.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });

  it("rejects OAuth evidence issued for another WorkOS application", async () => {
    const harness = setup();
    harness.listEvents.mockResolvedValue({
      data: eventEvidence.map((event) => ({
        ...event,
        context: { client_id: "client_other_application" },
      })),
    });

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkOSDesktopVerificationError>>({
        code: "identity_rejected",
      }),
    );
    expect(harness.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });

  it("rejects unrelated OAuth evidence outside the challenge event pair", async () => {
    const harness = setup();
    harness.listEvents.mockResolvedValue({
      data: eventEvidence.map((event) =>
        event.event === "authentication.oauth_succeeded"
          ? { ...event, createdAt: "2027-01-15T08:00:08.900Z" }
          : event,
      ),
    });

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
    expect(harness.listEvents).not.toHaveBeenCalled();
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

  it("accepts a verified GitHub result when WorkOS omits the optional authentication method", async () => {
    const harness = setup();
    harness.authenticateWithEmailVerification.mockResolvedValue({
      ...authentication,
      authenticationMethod: undefined,
    });

    await expect(
      completeWorkOSGitHubVerification(challenge, harness.deps),
    ).resolves.toEqual({
      ...authentication,
      authenticationMethod: null,
    });
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
      authenticationMethod: undefined,
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
    const events = {
      listEvents: vi.fn(async () => ({
        data: eventEvidence.map((event) => ({
          ...event,
          context: { client_id: "client_web_example" },
        })),
      })),
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
    Reflect.set(provider, "client", { userManagement, events });

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
