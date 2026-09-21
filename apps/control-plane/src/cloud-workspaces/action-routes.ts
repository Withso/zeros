import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CloudActionEngineRequestSchema, type DatabaseCloudWorkspaceActionService } from "./action-receipts.js";
import { CloudCommandError } from "./commands.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import { HttpError } from "../authz.js";

export const CLOUD_ACTION_PATH = "/internal/v1/cloud-workspaces/engine/actions";
const bodySchema = z.object({ workspaceId: z.string().uuid(), organizationId: z.string().uuid(),
  generation: z.number().int().safe().positive(), engineInstanceId: z.string().uuid(),
  actorSessionId:z.string().uuid().optional(),request: CloudActionEngineRequestSchema }).strict();
export function createCloudActionRoutes(service: DatabaseCloudWorkspaceActionService): Hono {
  const routes = new Hono();
  routes.use(CLOUD_ACTION_PATH, bodyLimit({ maxSize: 256 * 1024 }));
  routes.post(CLOUD_ACTION_PATH, async c => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.json({ error: "engine_authority_rejected" }, 401);
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
      return c.json({ error: "invalid_command" }, 422);
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_command" }, 422);
    const { request: _request, actorSessionId,...binding } = parsed.data;
    const scope={...binding,...(actorSessionId?{actorSessionId}:{})};
    try { return c.json({ result: await service.request({ ...scope, heartbeatToken: token }, (raw as { request: unknown }).request) }); }
    catch (error) {
      if (error instanceof CloudWorkspaceEngineAuthorityError) return c.json({ error: "engine_authority_rejected" }, 401);
      if (error instanceof HttpError) return c.json({error:"cloud_actor_authority_rejected"},403);
      if (error instanceof CloudCommandError) return c.json({ error: error.code },
        error.code === "command_conflict" || error.code === "command_context_changed" ? 409 : error.code === "command_not_found" ? 404 : 422);
      return c.json({ error: "command_service_unavailable" }, 503);
    }
  });
  return routes;
}
