import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudEventRoutes, CLOUD_EVENT_PATH } from "./event-routes.js";
import { CloudEventError, type DatabaseCloudWorkspaceEventService } from "./event-streams.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

describe("internal cloud event boundary", () => {
  const body = () => { const engineInstanceId = randomUUID(); return { workspaceId: randomUUID(), organizationId: randomUUID(),
    generation: 1, engineInstanceId, request: { kind: "replay", streamId: engineInstanceId, after: 0 } }; };
  const headers = { authorization: `Bearer zwh_${"x".repeat(43)}`, "content-type": "application/json" };
  it("requires engine authority and rejects client-controlled extra binding fields", async () => {
    const request = vi.fn(); const app = createCloudEventRoutes({ request } as unknown as DatabaseCloudWorkspaceEventService);
    expect((await app.request(CLOUD_EVENT_PATH, { method: "POST", body: JSON.stringify(body()) })).status).toBe(401);
    expect((await app.request(CLOUD_EVENT_PATH, { method: "POST", headers, body: JSON.stringify({ ...body(), token: "override" }) })).status).toBe(422);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    [new CloudEventError("event_cursor_expired"), 409, "event_cursor_expired"],
    [new CloudWorkspaceEngineAuthorityError(), 401, "engine_authority_rejected"],
    [new Error("private driver text"), 503, "event_service_unavailable"],
  ])("returns stable bounded failures without driver text", async (error, status, code) => {
    const request = vi.fn().mockRejectedValue(error), app = createCloudEventRoutes({ request } as unknown as DatabaseCloudWorkspaceEventService);
    const response = await app.request(CLOUD_EVENT_PATH, { method: "POST", headers, body: JSON.stringify(body()) });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
