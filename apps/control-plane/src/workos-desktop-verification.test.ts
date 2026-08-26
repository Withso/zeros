import { describe, expect, it, vi } from "vitest";

import {
  createWorkOSDesktopVerificationRoutes,
  WorkOSDesktopVerificationError,
} from "./workos-desktop-verification.js";
import type { WorkOSDesktopVerificationProvider } from "./workos-provider.js";

const authentication = {
  accessToken: "signed-desktop-access-token",
  refreshToken: "desktop-refresh-token",
  authenticationMethod: "GitHubOAuth",
  user: {
    id: "user_01GITHUB",
    email: "person@example.com",
    emailVerified: true,
    name: "Example Person",
  },
};

function setup(
  completeGitHubVerification: WorkOSDesktopVerificationProvider["completeGitHubVerification"] = vi.fn(
    async () => authentication,
  ),
) {
  return {
    app: createWorkOSDesktopVerificationRoutes({
      completeGitHubVerification,
    }),
    completeGitHubVerification,
  };
}

function request(body: unknown): Request {
  return new Request(
    "https://api-alpha.zeros.build/auth/desktop/complete-github-verification",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("Railway WorkOS desktop GitHub verification", () => {
  it("continues only the exact bounded WorkOS challenge", async () => {
    const { app, completeGitHubVerification } = setup();
    const response = await app.request(
      request({
        pending_authentication_token: "pending-authentication-token",
        email_verification_id: "email_verification_01EXAMPLE",
      }),
    );

    expect(response.status).toBe(200);
    expect(completeGitHubVerification).toHaveBeenCalledWith({
      pendingAuthenticationToken: "pending-authentication-token",
      emailVerificationId: "email_verification_01EXAMPLE",
    });
    expect(await response.json()).toEqual({
      access_token: authentication.accessToken,
      refresh_token: authentication.refreshToken,
      authentication_method: authentication.authenticationMethod,
      user: {
        id: authentication.user.id,
        email: authentication.user.email,
        email_verified: true,
        name: authentication.user.name,
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects malformed or oversized challenges before calling WorkOS", async () => {
    const { app, completeGitHubVerification } = setup();
    for (const body of [
      {},
      {
        pending_authentication_token: "pending-authentication-token",
        email_verification_id: "foreign_01EXAMPLE",
      },
      {
        pending_authentication_token: "x".repeat(9_000),
        email_verification_id: "email_verification_01EXAMPLE",
      },
    ]) {
      expect((await app.request(request(body))).status).toBe(400);
    }
    expect(completeGitHubVerification).not.toHaveBeenCalled();
  });

  it("does not turn a non-GitHub or mismatched challenge into a session", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = setup(async () => {
      throw new WorkOSDesktopVerificationError("identity_rejected");
    });
    const response = await app.request(
      request({
        pending_authentication_token: "pending-authentication-token",
        email_verification_id: "email_verification_01EXAMPLE",
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "verification_rejected" });
    expect(warning).toHaveBeenCalledWith(
      "[workos-desktop-verification] 403 verification rejected: identity_rejected",
    );
    warning.mockRestore();
  });

  it("fails closed when WorkOS is unavailable", async () => {
    const { app } = setup(async () => {
      throw new Error("provider unavailable");
    });
    const response = await app.request(
      request({
        pending_authentication_token: "pending-authentication-token",
        email_verification_id: "email_verification_01EXAMPLE",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "verification_unavailable",
    });
  });
});
