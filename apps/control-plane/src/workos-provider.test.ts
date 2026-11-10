import { WorkOS } from "@workos-inc/node";
import { describe, expect, it } from "vitest";

import {
  RailwayWorkOSProvider,
  WorkOSAuthenticationRequiredError,
} from "./workos-provider.js";

const APP_ORIGIN = "https://app-alpha.zeros.build";
const STATE = "s".repeat(43);
const CHALLENGE = "c".repeat(43);

function provider(
  client?: WorkOS,
  apiOrigin = "https://api.workos.com",
): RailwayWorkOSProvider {
  return new RailwayWorkOSProvider(
    {
      provider: "workos",
      issuer: `${apiOrigin}/user_management/client_web_example`,
      jwksUrl: `${apiOrigin}/sso/jwks/client_web_example`,
      audience: "https://api-alpha.zeros.build",
      webClientId: "client_web_example",
      desktopClientId: "client_desktop_example",
    },
    {
      appOrigin: APP_ORIGIN,
      apiKey: "workos-key-for-tests",
      cookiePassword: "cookie-password-for-tests".repeat(2),
      webhookSecret: "webhook-secret-for-tests",
    },
    client,
  );
}

describe("WorkOS Hosted AuthKit authorization", () => {
  it("routes web and desktop authorization through the custom issuer host", () => {
    const customProvider = provider(undefined, "https://auth-api.zeros.build");
    const options = {
      state: STATE,
      codeChallenge: CHALLENGE,
      redirectUri: `${APP_ORIGIN}/auth/callback`,
    };
    for (const authorizationUrl of [
      customProvider.authorizationUrl(options),
      customProvider.desktopAuthorizationUrl({
        ...options,
        state: `zeros-alpha.${STATE}`,
        redirectUri: `${APP_ORIGIN}/auth/desktop/callback`,
      }),
    ]) {
      const url = new URL(authorizationUrl);
      expect(url.origin).toBe("https://auth-api.zeros.build");
      expect(url.pathname).toBe("/user_management/authorize");
    }
  });

  it("always starts the hosted UI for the web application with PKCE", () => {
    const url = new URL(
      provider().authorizationUrl({
        state: STATE,
        codeChallenge: CHALLENGE,
        redirectUri: `${APP_ORIGIN}/auth/callback`,
      }),
    );

    expect(url.origin).toBe("https://api.workos.com");
    expect(url.pathname).toBe("/user_management/authorize");
    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("client_id")).toBe("client_web_example");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/auth/callback`,
    );
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("starts Google or GitHub directly when the web sign-in page names one", () => {
    const start = (socialProvider?: "google" | "github") =>
      new URL(
        provider().authorizationUrl({
          state: STATE,
          codeChallenge: CHALLENGE,
          redirectUri: `${APP_ORIGIN}/auth/callback`,
          ...(socialProvider ? { socialProvider } : {}),
        }),
      );

    expect(start("google").searchParams.get("provider")).toBe("GoogleOAuth");
    expect(start("github").searchParams.get("provider")).toBe("GitHubOAuth");
    expect(start().searchParams.get("provider")).toBe("authkit");
    for (const url of [start("google"), start("github")]) {
      expect(url.searchParams.get("client_id")).toBe("client_web_example");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.has("connection_id")).toBe(false);
      expect(url.searchParams.has("organization_id")).toBe(false);
    }
  });

  it("always starts the hosted UI for the independent desktop application", () => {
    const url = new URL(
      provider().desktopAuthorizationUrl({
        state: `zeros-alpha.${STATE}`,
        codeChallenge: CHALLENGE,
        redirectUri: `${APP_ORIGIN}/auth/desktop/callback`,
      }),
    );

    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("client_id")).toBe("client_desktop_example");
    expect(url.searchParams.get("client_id")).not.toBe("client_web_example");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/auth/desktop/callback`,
    );
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("asks AuthKit for a new sign-in, not the browser's session, when adding an account", () => {
    const url = new URL(
      provider().desktopAuthorizationUrl({
        state: `zeros-alpha.${STATE}`,
        codeChallenge: CHALLENGE,
        redirectUri: `${APP_ORIGIN}/auth/desktop/callback`,
        fresh: true,
      }),
    );
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.has("max_age")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("client_desktop_example");
  });
});

describe("WorkOS web code exchange", () => {
  function replying(status: number, body: Record<string, unknown>): WorkOS {
    return new WorkOS({
      apiKey: "workos-key-for-tests",
      clientId: "client_web_example",
      maxRetries: 0,
      fetchFn: async () =>
        Response.json(body, {
          status,
          headers: { "x-request-id": "req_exchange_example" },
        }),
    });
  }

  it("reports a ceremony Hosted AuthKit must finish by code, without its pending token", async () => {
    const pending = "pending-authentication-token-example";
    const client = replying(403, {
      code: "organization_selection_required",
      message: "The user must choose an organization.",
      pending_authentication_token: pending,
      organizations: [{ id: "org_example", name: "Example" }],
      user: { id: "user_example", email: "person@example.com" },
    });

    const failure = await provider(client)
      .exchange({ code: "one-time-code", codeVerifier: "v".repeat(43) })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkOSAuthenticationRequiredError);
    expect(failure).toMatchObject({
      code: "organization_selection_required",
      status: 403,
      requestId: "req_exchange_example",
    });
    expect(JSON.stringify(failure)).not.toContain(pending);
    expect(String(failure)).not.toContain(pending);
  });

  it("leaves other provider failures as they are", async () => {
    const client = replying(400, {
      error: "invalid_grant",
      error_description: "The code has expired.",
    });

    const failure = await provider(client)
      .exchange({ code: "one-time-code", codeVerifier: "v".repeat(43) })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(WorkOSAuthenticationRequiredError);
  });
});

describe("WorkOS organization membership listing", () => {
  it("requests every lifecycle state needed for membership reconciliation", async () => {
    let capturedOptions: unknown;
    const client = {
      userManagement: {
        async listOrganizationMemberships(options: unknown) {
          capturedOptions = options;
          return {
            data: [
              {
                id: "om_pending_example",
                organizationId: "org_example",
                userId: "user_example",
                status: "pending" as const,
                directoryManaged: false,
                role: { slug: "member" },
                updatedAt: "2026-08-29T00:00:00.000Z",
              },
            ],
            listMetadata: { before: null, after: null },
          };
        },
      },
    } as unknown as WorkOS;

    const memberships = await provider(client).listMemberships({
      organizationId: "org_example",
      userId: "user_example",
    });

    expect(capturedOptions).toEqual({
      organizationId: "org_example",
      userId: "user_example",
      statuses: ["active", "inactive", "pending"],
      limit: 100,
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.status).toBe("pending");
  });
});

describe("WorkOS session proof projection", () => {
  it("preserves the session user and finite provider expiry without extra provider data", async () => {
    const session = { id: "session_proof", userId: "user_proof", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z",
      ipAddress: "192.0.2.1", userAgent: "private-provider-data" };
    const client = { userManagement: { listSessions: async () => ({
      data: [session], listMetadata: { after: null },
    }) } } as unknown as WorkOS;
    await expect(provider(client).listSessions("user_proof", { limit: 100 })).resolves.toEqual({
      data: [{ id: session.id, userId: session.userId, status: session.status,
        createdAt: session.createdAt, expiresAt: session.expiresAt }],
      listMetadata: { after: null },
    });
  });
});

describe("WorkOS native invitations", () => {
  const invitation = {
    id: "invitation_example",
    organizationId: "org_example",
    email: "invitee@example.com",
    state: "pending" as const,
    roleSlug: "member",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };

  it("sends one seven-day branded invitation with the authenticated inviter", async () => {
    let capturedOptions: unknown;
    const client = {
      userManagement: {
        async sendInvitation(options: unknown) {
          capturedOptions = options;
          return invitation;
        },
      },
    } as unknown as WorkOS;

    await provider(client).sendInvitation({
      organizationId: "org_example",
      email: "invitee@example.com",
      roleSlug: "member",
      inviterUserId: "user_inviter",
    });

    expect(capturedOptions).toEqual({
      organizationId: "org_example",
      email: "invitee@example.com",
      roleSlug: "member",
      inviterUserId: "user_inviter",
      expiresInDays: 7,
    });
  });

  it("resolves a custom invitation token only on the trusted backend", async () => {
    let capturedToken: unknown;
    const client = {
      userManagement: {
        async findInvitationByToken(token: unknown) {
          capturedToken = token;
          return invitation;
        },
      },
    } as unknown as WorkOS;

    await expect(
      provider(client).findInvitationByToken("provider_invitation_token"),
    ).resolves.toEqual(invitation);
    expect(capturedToken).toBe("provider_invitation_token");
  });

  it("revalidates a correlated invitation by provider ID", async () => {
    let capturedId: unknown;
    const client = {
      userManagement: {
        async getInvitation(invitationId: unknown) {
          capturedId = invitationId;
          return invitation;
        },
      },
    } as unknown as WorkOS;

    await expect(
      provider(client).getInvitation("invitation_example"),
    ).resolves.toEqual(invitation);
    expect(capturedId).toBe("invitation_example");
  });
});
