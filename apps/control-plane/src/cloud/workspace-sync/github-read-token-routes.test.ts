import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { createCloudWorkspaceGithubReadTokenRoutes } from "./github-read-token-routes.js";

function fixture() {
  const app = new Hono(), userId = randomUUID();
  const issue = vi.fn(async () => ({ token: "fixture-scoped-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), repository: "example/project" }));
  app.use("*", async (c, next) => { c.set("user", { id: userId } as AuthedUser); await next(); });
  app.route("/", createCloudWorkspaceGithubReadTokenRoutes({ issue }));
  const call = (deviceId: string, workspaceId = randomUUID()) => app.request(`/v1/cloud-v2/workspaces/${workspaceId}/github-read-token`, {
    method: "POST", body: "{}", headers: { "content-type": "application/json", "x-zeros-sync": "1", "x-zeros-sync-wanted": "1",
      "x-zeros-device-id": deviceId, "x-zeros-device-registration": randomUUID(), "x-zeros-device-instance": randomUUID() },
  });
  return { issue, call };
}

describe("GitHub read-token rate limits", () => {
  it("limits a device across workspaces, registrations and UUID casing", async () => {
    const f = fixture(), device = randomUUID();
    for (let i = 0; i < 12; i++) expect((await f.call(device)).status).toBe(200);
    const response = await f.call(device.toUpperCase());
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("rate_limited");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.issue).toHaveBeenCalledTimes(12);
    expect((await f.call(randomUUID())).status).toBe(200);
  });

  it("bounds aggregate requests from a person's registered devices", async () => {
    const f = fixture(), devices = Array.from({ length: 11 }, () => randomUUID());
    for (let i = 0; i < 120; i++) expect((await f.call(devices[i % devices.length]!)).status).toBe(200);
    const response = await f.call(devices[10]!);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("rate_limited");
    expect(f.issue).toHaveBeenCalledTimes(120);
  });
});
