import { describe, expect, it } from "vitest";
import type pg from "pg";

import {
  brokerSecretMatches,
  createWorkOSIdentityEventRoutes,
} from "./workos-events.js";

const SECRET = "s".repeat(48);
const pool = {
  connect: () => {
    throw new Error("invalid requests must not reach Postgres");
  },
} as unknown as pg.Pool;

describe("WorkOS identity-event broker boundary", () => {
  it("compares the complete broker credential without prefix acceptance", () => {
    expect(brokerSecretMatches(SECRET, SECRET)).toBe(true);
    expect(brokerSecretMatches(SECRET, `${SECRET}x`)).toBe(false);
    expect(brokerSecretMatches(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(brokerSecretMatches(SECRET, "")).toBe(false);
  });

  it("rejects a missing or wrong broker credential before reading the body", async () => {
    const app = createWorkOSIdentityEventRoutes(pool, SECRET);
    for (const supplied of [undefined, "wrong-secret"]) {
      const response = await app.request("/internal/auth/workos/events", {
        method: "POST",
        headers: supplied ? { "x-zeros-auth-broker": supplied } : undefined,
        body: "not-json",
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("validates the reduced lifecycle event before opening a transaction", async () => {
    const app = createWorkOSIdentityEventRoutes(pool, SECRET);
    const response = await app.request("/internal/auth/workos/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zeros-auth-broker": SECRET,
      },
      body: JSON.stringify({ eventType: "user.updated" }),
    });
    expect(response.status).toBe(422);
  });
});
