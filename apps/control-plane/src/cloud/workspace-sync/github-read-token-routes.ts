import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { rateLimit } from "../../ratelimit.js";
import { localBody, localDeviceHeaders, localRouteError, localUuid } from "../local-commands/routes.js";
import { SYNC_HEADER, SYNC_WANTED_HEADER } from "./contract.js";
import type { CloudWorkspaceGithubReadTokens } from "./github-read-token.js";

export function createCloudWorkspaceGithubReadTokenRoutes(tokens: Pick<CloudWorkspaceGithubReadTokens, "issue">): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/workspaces/:id/github-read-token";
  app.onError(localRouteError);
  app.use(path, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post(path, rateLimit("cloud-github-read-user", 120, 60_000),
    bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) }),
    rateLimit("cloud-github-read-device", 12, 60_000, c => `${c.get("user").id}:${localDeviceHeaders(c)!.deviceId.toLowerCase()}`),
    async c => {
      if (c.req.header(SYNC_HEADER) !== "1" || c.req.header(SYNC_WANTED_HEADER) !== "1")
        throw new HttpError(400, "invalid_request", "Both sync opt-ins are required");
      await localBody(c, z.object({}).strict());
      return c.json(await tokens.issue(localUuid(c.req.param("id")), c.get("user"), localDeviceHeaders(c)!));
    });
  return app;
}
