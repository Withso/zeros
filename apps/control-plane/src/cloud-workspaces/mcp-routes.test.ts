import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { createCloudCustomizationRoutes } from "./mcp-routes.js";
import type { DatabaseCloudCustomizationService } from "./customization-store.js";

describe("organization customization HTTP ownership", () => {
  it("uses the authenticated actor, exposes no-store responses, and bounds secret-bearing writes", async () => {
    const user = randomUUID(), org = randomUUID(), service = { read: vi.fn(async () => ({ organization: {}, member: {} })), save: vi.fn(async () => ({ revision: 1 })) };
    const app = new Hono(); app.use("*", async (c, next) => { c.set("user", { id: user } as AuthedUser); await next(); });
    app.onError((error, c) => c.json({ error: "rejected" }, error instanceof HttpError && error.status === 413 ? 413 : 500));
    app.route("/", createCloudCustomizationRoutes(service as unknown as DatabaseCloudCustomizationService));
    const path = `/v1/organizations/${org}/customization`;
    const read = await app.request(path); expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
    expect(service.read).toHaveBeenCalledWith(org, user);
    const value = { expectedRevision: 0, document: { servers: [], skills: [], cursorTeamSettings: "disabled" } };
    const saved = await app.request(path + "/member", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    expect(saved.status).toBe(200); expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(service.save).toHaveBeenCalledWith(org, user, "member", value);
    const large = await app.request(path + "/member", { method: "PUT", body: "x".repeat(262145) });
    expect(large.status).toBe(413);
    expect(service.save).toHaveBeenCalledTimes(1);
  });
});
