import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CloudEventError, CloudEventRequestSchema, type DatabaseCloudWorkspaceEventService } from "./event-streams.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

export const CLOUD_EVENT_PATH = "/internal/v1/cloud-workspaces/engine/events";
const bodySchema = z.object({ workspaceId: z.string().uuid(), organizationId: z.string().uuid(),
  generation: z.number().int().safe().positive(), engineInstanceId: z.string().uuid(), request: CloudEventRequestSchema }).strict();
export function createCloudEventRoutes(service: DatabaseCloudWorkspaceEventService): Hono {
  const routes = new Hono();
  routes.use(CLOUD_EVENT_PATH, bodyLimit({ maxSize: 1100000 }));
  routes.post(CLOUD_EVENT_PATH, async c => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.json({ error: "engine_authority_rejected" }, 401);
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
      return c.json({ error: "invalid_event" }, 422);
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_event" }, 422);
    const { request, ...scope } = parsed.data;
    try { return c.json({ result: await service.request({ ...scope, heartbeatToken: token }, request) }); }
    catch (error) {
      if (error instanceof CloudWorkspaceEngineAuthorityError) return c.json({ error: "engine_authority_rejected" }, 401);
      if (error instanceof CloudEventError) return c.json({ error: error.code }, error.code === "invalid_event" ? 422 : 409);
      return c.json({ error: "event_service_unavailable" }, 503);
    }
  });
  return routes;
}
