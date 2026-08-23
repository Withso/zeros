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
});
