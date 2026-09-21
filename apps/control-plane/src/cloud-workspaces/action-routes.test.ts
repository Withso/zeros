import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudActionRoutes, CLOUD_ACTION_PATH } from "./action-routes.js";
import type { DatabaseCloudWorkspaceActionService } from "./action-receipts.js";
import { CloudCommandError } from "./commands.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

describe("internal action receipt boundary", () => {
  const body = () => ({ workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    request: { kind: "read", operationId: randomUUID() } });
  const headers = { authorization: `Bearer zwh_${"x".repeat(43)}`, "content-type": "application/json" };
  it("denies browser credentials and binding overrides before receipt access", async () => {
    const request = vi.fn(); const app = createCloudActionRoutes({ request } as unknown as DatabaseCloudWorkspaceActionService);
    expect((await app.request(CLOUD_ACTION_PATH, { method: "POST", headers: { ...headers, authorization: "Bearer browser-token" }, body: JSON.stringify(body()) })).status).toBe(401);
    expect((await app.request(CLOUD_ACTION_PATH, { method: "POST", headers, body: JSON.stringify({ ...body(), token: "override" }) })).status).toBe(422);
    expect((await app.request(CLOUD_ACTION_PATH, { method: "POST", headers, body: "x".repeat(300000) })).status).toBe(413);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    [new CloudCommandError("command_conflict", "private detail"), 409, "command_conflict"],
    [new CloudWorkspaceEngineAuthorityError(), 401, "engine_authority_rejected"],
    [new Error("private driver parameters"), 503, "command_service_unavailable"],
  ])("exposes stable errors without native answer or SQL content", async (error, status, code) => {
    const request = vi.fn().mockRejectedValue(error), app = createCloudActionRoutes({ request } as unknown as DatabaseCloudWorkspaceActionService);
    const response = await app.request(CLOUD_ACTION_PATH, { method: "POST", headers, body: JSON.stringify(body()) });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
