import { describe, expect, it, vi } from "vitest";

import {
  createWorkOSDesktopRevocationRoutes,
  revokeWorkOSDesktopSessions,
} from "./workos-desktop-revocation.js";
import type { WorkOSDesktopProvider } from "./workos-provider.js";

function provider(
  overrides: Partial<WorkOSDesktopProvider> = {},
): WorkOSDesktopProvider {
  return {
    async verifyDesktopBearer() {
      return { subject: "user_example", sessionId: "session_exact" };
    },
    async listSessions() {
      return { data: [], listMetadata: { after: null } };
    },
    async revokeSession() {},
    ...overrides,
  };
}

describe("Railway WorkOS desktop revocation", () => {
  it("targets the exact cryptographically verified current session", async () => {
    const revoked: string[] = [];
    expect(
      await revokeWorkOSDesktopSessions({
        scope: "current",
        subject: "user_example",
        sessionId: "session_exact",
        provider: provider({
          async revokeSession(sessionId) {
            revoked.push(sessionId);
          },
        }),
      }),
    ).toEqual({ revoked: 1 });
    expect(revoked).toEqual(["session_exact"]);
  });

  it("paginates and revokes every active session for all-device logout", async () => {
    const revoked: string[] = [];
    const calls: Array<{ subject: string; after?: string }> = [];
    const auth = provider({
      async listSessions(subject, options) {
        calls.push({
          subject,
          ...(options.after ? { after: options.after } : {}),
        });
        return options.after
          ? {
              data: [{ id: "session_2", status: "active" }],
              listMetadata: { after: null },
            }
          : {
              data: [
                { id: "session_1", status: "active" },
                { id: "session_old", status: "revoked" },
              ],
              listMetadata: { after: "next" },
            };
      },
      async revokeSession(sessionId) {
        revoked.push(sessionId);
      },
    });

    expect(
      await revokeWorkOSDesktopSessions({
        scope: "all",
        subject: "user_example",
        sessionId: "session_exact",
        provider: auth,
      }),
    ).toEqual({ revoked: 2 });
    expect(revoked.sort()).toEqual(["session_1", "session_2"]);
    expect(calls).toEqual([
      { subject: "user_example" },
      { subject: "user_example", after: "next" },
    ]);
  });

  it("queues a security notification only after all-device revocation succeeds", async () => {
    const notify = vi.fn(async () => {});
    const app = createWorkOSDesktopRevocationRoutes(provider(), {
      onAllSessionsRevoked: notify,
    });

    const response = await app.request("/auth/desktop-revoke", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "all" }),
    });

    expect(response.status).toBe(200);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      providerSubject: "user_example",
      revoked: 0,
    });
  });

  it("does not queue a notification when provider revocation fails", async () => {
    const notify = vi.fn(async () => {});
    const app = createWorkOSDesktopRevocationRoutes(
      provider({
        async listSessions() {
          throw new Error("provider unavailable");
        },
      }),
      { onAllSessionsRevoked: notify },
    );

    const response = await app.request("/auth/desktop-revoke", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "all" }),
    });

    expect(response.status).toBe(503);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps a successful logout successful when notification enqueue fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createWorkOSDesktopRevocationRoutes(provider(), {
        async onAllSessionsRevoked() {
          throw new Error("recipient@example.com must never reach the log");
        },
      });

      const response = await app.request("/auth/desktop-revoke", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-access-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope: "all" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revoked: 0 });
      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith(
        "[auth] sessions-revoked notification enqueue failed",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("validates the bounded scope before verifying the bearer", async () => {
    let verifications = 0;
    const app = createWorkOSDesktopRevocationRoutes(
      provider({
        async verifyDesktopBearer() {
          verifications += 1;
          return { subject: "user_example", sessionId: "session_exact" };
        },
      }),
    );
    const response = await app.request("/auth/desktop-revoke", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "invented" }),
    });

    expect(response.status).toBe(400);
    expect(verifications).toBe(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts only a verified desktop bearer", async () => {
    const app = createWorkOSDesktopRevocationRoutes(
      provider({
        async verifyDesktopBearer() {
          throw new Error("wrong client");
        },
      }),
    );
    const response = await app.request("/auth/desktop-revoke", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "current" }),
    });
    expect(response.status).toBe(401);
  });
});
