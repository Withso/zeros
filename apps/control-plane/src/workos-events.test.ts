import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { createWorkOSIdentityEventRoutes } from "./workos-events.js";

const NOW = 1_800_000_000_000;
const SECRET = "webhook-signing-secret-for-tests";
const pool = {
  connect: () => {
    throw new Error("invalid requests must not reach Postgres");
  },
} as unknown as pg.Pool;

function event(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "event_01TEST",
    event: "user.updated",
    created_at: "2027-01-15T08:00:00.000Z",
    data: {
      id: "user_01TEST",
      email: "user@example.com",
      email_verified: true,
      name: "Updated User",
      profile_picture_url: "https://images.example.com/user.png",
    },
    ...overrides,
  };
}

function signedRequest(
  payload: unknown,
  options: { timestamp?: number; signature?: string } = {},
): Request {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = options.timestamp ?? NOW;
  const signature = createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Request("https://api-alpha.zeros.build/auth/workos-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "workos-signature": `t=${timestamp}, v1=${options.signature ?? signature}`,
    },
    body,
  });
}

describe("Railway WorkOS identity-event boundary", () => {
  it("verifies the exact raw body before reducing and applying an event", async () => {
    const apply = vi.fn(async () => ({ status: "applied" as const }));
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply,
    });
    const response = await app.request(signedRequest(event()));

    expect(response.status).toBe(202);
    expect(apply).toHaveBeenCalledWith({
      eventId: "event_01TEST",
      eventType: "user.updated",
      createdAt: "2027-01-15T08:00:00.000Z",
      user: {
        id: "user_01TEST",
        email: "user@example.com",
        emailVerified: true,
        name: "Updated User",
        profilePictureUrl: "https://images.example.com/user.png",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an invalid signature without parsing or applying the body", async () => {
    const apply = vi.fn();
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply,
    });
    const response = await app.request(
      signedRequest(JSON.stringify(event(), null, 2), {
        signature: "0".repeat(64),
      }),
    );
    expect(response.status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects stale and future signatures", async () => {
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply: vi.fn(),
    });
    for (const timestamp of [NOW - 180_001, NOW + 180_001]) {
      const response = await app.request(signedRequest(event(), { timestamp }));
      expect(response.status).toBe(401);
    }
  });

  it("acknowledges unsubscribed events without touching Postgres", async () => {
    const apply = vi.fn();
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply,
    });
    const response = await app.request(
      signedRequest(event({ event: "organization.created" })),
    );
    expect(response.status).toBe(202);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before signature work", async () => {
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply: vi.fn(),
    });
    const response = await app.request(signedRequest("x".repeat(65 * 1024)));
    expect(response.status).toBe(413);
  });

  it("adopts provider verification for a user created unverified", async () => {
    const adoptVerifiedEmail = vi.fn(async () => {});
    const apply = vi.fn();
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply,
      adoptVerifiedEmail,
    });
    const response = await app.request(
      signedRequest(
        event({
          event: "user.created",
          data: {
            id: "user_01CREATED",
            email: "person@example.com",
            email_verified: false,
            name: null,
            profile_picture_url: null,
          },
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      status: "verified",
    });
    expect(adoptVerifiedEmail).toHaveBeenCalledWith("user_01CREATED");
    // Creation predates the Zeros account, so the linked-profile sync must not run.
    expect(apply).not.toHaveBeenCalled();
  });

  it("leaves an already-verified new user untouched", async () => {
    const adoptVerifiedEmail = vi.fn(async () => {});
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply: vi.fn(),
      adoptVerifiedEmail,
    });
    const response = await app.request(
      signedRequest(
        event({
          event: "user.created",
          data: {
            id: "user_01GOOGLE",
            email: "person@example.com",
            email_verified: true,
            name: null,
            profile_picture_url: null,
          },
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      status: "already_verified",
    });
    expect(adoptVerifiedEmail).not.toHaveBeenCalled();
  });

  it("asks WorkOS to redeliver when adoption fails", async () => {
    const adoptVerifiedEmail = vi.fn(async () => {
      throw new Error("WorkOS unavailable");
    });
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply: vi.fn(),
      adoptVerifiedEmail,
    });
    const response = await app.request(
      signedRequest(
        event({
          event: "user.created",
          data: {
            id: "user_01CREATED",
            email: "person@example.com",
            email_verified: false,
            name: null,
            profile_picture_url: null,
          },
        }),
      ),
    );
    // Non-2xx on purpose: a dropped adoption leaves the user unable to sign in.
    expect(response.status).toBe(503);
  });

  it("ignores creation when the deployment has not opted into adoption", async () => {
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply: vi.fn(),
    });
    const response = await app.request(
      signedRequest(
        event({
          event: "user.created",
          data: {
            id: "user_01CREATED",
            email: "person@example.com",
            email_verified: false,
            name: null,
            profile_picture_url: null,
          },
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, ignored: true });
  });

  it("rejects a malformed creation event without calling WorkOS", async () => {
    const adoptVerifiedEmail = vi.fn(async () => {});
    const app = createWorkOSIdentityEventRoutes(pool, SECRET, {
      now: () => NOW,
      apply: vi.fn(),
      adoptVerifiedEmail,
    });
    const response = await app.request(
      signedRequest(
        event({
          event: "user.created",
          data: { id: "user_01CREATED", email_verified: "no" },
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(adoptVerifiedEmail).not.toHaveBeenCalled();
  });
});
