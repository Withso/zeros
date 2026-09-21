import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CloudCommandError, CloudCommandRequestSchema, type DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import { HttpError } from "../authz.js";

export const CLOUD_COMMAND_PATH = "/internal/v1/cloud-workspaces/engine/commands";
const bodySchema = z.object({
  workspaceId: z.string().uuid(), organizationId: z.string().uuid(),
  generation: z.number().int().safe().positive(), engineInstanceId: z.string().uuid(),
  request: CloudCommandRequestSchema,
  actorSessionId:z.string().uuid().optional(),
}).strict();

/** No browser bearer or provider key grants queue authority. Every operation
 * rechecks the live engine, workspace, organization and execution fence. */
export function createCloudCommandRoutes(service: DatabaseCloudWorkspaceCommandService): Hono {
  const routes = new Hono();
  routes.use(CLOUD_COMMAND_PATH, bodyLimit({ maxSize: 256 * 1024 }));
  routes.post(CLOUD_COMMAND_PATH, async c => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.json({ error: "engine_authority_rejected" }, 401);
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
      return c.json({ error: "invalid_command" }, 422);
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_command" }, 422);
    const { request, actorSessionId, ...binding } = parsed.data;
    const scope = { ...binding, heartbeatToken: token,...(actorSessionId?{actorSessionId}:{}) };
    try {
      let result: unknown;
      switch (request.kind) {
        case "snapshot": result = await service.snapshot(scope, request.conversationId); break;
        case "read": result = await service.read(scope, request.commandId); break;
        case "mutate": result = await service.mutate(scope, request.mutation, request.admissionError ?? null); break;
        case "stop": result = await service.stop(scope, request.conversationId, request.operationId); break;
        case "claim": result = await service.claim(scope, request.conversationId, request.executionId, request.claimId); break;
        case "settle": result = await service.settle(scope, request.result); break;
      }
      return c.json({ result });
    } catch (error) {
      if (error instanceof CloudWorkspaceEngineAuthorityError) return c.json({ error: "engine_authority_rejected" }, 401);
      if (error instanceof HttpError) return c.json({error:"cloud_actor_authority_rejected"},403);
      if (error instanceof CloudCommandError) return c.json({ error: error.code },
        error.code === "command_conflict" || error.code === "command_context_changed" ? 409 : error.code === "command_not_found" ? 404 : 422);
      // Never echo driver messages or prompt-bearing query parameters.
      return c.json({ error: "command_service_unavailable" }, 503);
    }
  });
  return routes;
}
