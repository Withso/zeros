import type { WorkOS } from "@workos-inc/node";
import { describe, expect, it } from "vitest";

import { RailwayWorkOSProvider } from "./workos-provider.js";

const APP_ORIGIN = "https://app-alpha.zeros.build";
const STATE = "s".repeat(43);
const CHALLENGE = "c".repeat(43);

function provider(client?: WorkOS): RailwayWorkOSProvider {
  return new RailwayWorkOSProvider(
    {
      provider: "workos",
      issuer: "https://api.workos.com/user_management/client_web_example",
      jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
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
