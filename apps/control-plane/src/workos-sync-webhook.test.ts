import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { createWorkOSManagementEventRoutes } from "./workos-sync-events.js";
import type { WorkOSManagementProvider } from "./workos-provider.js";

const pool = {
  connect: () => {
    throw new Error("ignored requests must not reach Postgres");
  },
} as unknown as pg.Pool;

function provider(
  constructWebhookEvent: WorkOSManagementProvider["constructWebhookEvent"],
): WorkOSManagementProvider {
  return { constructWebhookEvent } as unknown as WorkOSManagementProvider;
}

describe("WorkOS management webhook boundary", () => {
  it("passes the exact raw body and signature to the official SDK verifier", async () => {
    const construct = vi.fn(async () => ({
      id: "event_unknown",
      event: "unsubscribed.event",
      createdAt: "2027-01-15T08:00:00.000Z",
      data: {},
    }));
    const app = createWorkOSManagementEventRoutes(
      pool,
      provider(construct),
      "webhook-secret",
    );
    const raw = '{ "preserve" : "spacing" }';
    const response = await app.request("/auth/workos-webhook", {
      method: "POST",
      headers: { "workos-signature": "signed-header" },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(construct).toHaveBeenCalledWith(
      raw,
      "signed-header",
      "webhook-secret",
    );
    expect(await response.json()).toEqual({ accepted: true, ignored: true });
  });

  it("rejects failed SDK signature verification", async () => {
    const app = createWorkOSManagementEventRoutes(
      pool,
      provider(async () => {
        throw new Error("signature mismatch");
      }),
      "webhook-secret",
    );
    const response = await app.request("/auth/workos-webhook", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an oversized body before SDK verification", async () => {
    const construct = vi.fn();
    const app = createWorkOSManagementEventRoutes(
      pool,
      provider(construct),
      "webhook-secret",
    );
    const response = await app.request("/auth/workos-webhook", {
      method: "POST",
      body: "x".repeat(65 * 1024),
    });
    expect(response.status).toBe(413);
    expect(construct).not.toHaveBeenCalled();
  });
});
