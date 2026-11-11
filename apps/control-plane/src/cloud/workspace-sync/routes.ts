import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { rateLimit } from "../../ratelimit.js";
import { localBody, localDeviceHeaders, localRouteError, localUuid } from "../local-commands/routes.js";
import type { CloudWorkspaceSync } from "./store.js";

export function createCloudWorkspaceSyncRoutes(sync: CloudWorkspaceSync): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/workspaces/:id/sync/grant";
  app.onError(localRouteError);
  app.use(path, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post(path, rateLimit("cloud-sync-grant-user", 120, 60_000),
    bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) }),
    rateLimit("cloud-sync-grant-device", 12, 60_000, c => `${c.get("user").id}:${localUuid(c.req.param("id")!).toLowerCase()}:${localDeviceHeaders(c)!.deviceId.toLowerCase()}`),
    async c => {
      await localBody(c, z.object({}).strict(), true);
      return c.json(await sync.grant(localUuid(c.req.param("id")), c.get("user"), localDeviceHeaders(c)!));
    });
  return app;
}
