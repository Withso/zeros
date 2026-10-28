import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import type { CloudGithubConnections } from "./github-connections.js";
import {
  CloudGithubConnectionMutationSchema as request,
  CloudGithubConnectionStatusSchema,
  CloudGithubOauthStartedSchema,
  CloudGithubRepositoryPageSchema,
} from "./github-connection-contract.js";

const query = z.object({ organizationId: z.string().uuid() });
export function createCloudGithubConnectionRoutes(
  service: CloudGithubConnections,
): Hono {
  const app = new Hono();
  app.use("/v1/cloud-v2/github/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    await next();
  });
  app.get(
    "/v1/cloud-v2/github/connection",
    rateLimit("cloud-github-read", 60, 60_000),
    async (c) => {
      const parsed = query.safeParse(c.req.query());
      if (!parsed.success)
        throw new HttpError(422, "invalid_input", "Choose an organization.");
      return c.json(
        CloudGithubConnectionStatusSchema.parse(
          await service.status({ ...parsed.data, userId: c.get("user").id }),
        ),
      );
    },
  );
  app.post(
    "/v1/cloud-v2/github/connection",
    bodyLimit({ maxSize: 8192 }),
    rateLimit("cloud-github-connect", 20, 60_000),
    async (c) => {
      const parsed = request.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new HttpError(
          422,
          "invalid_input",
          "Invalid GitHub connection request.",
        );
      const input = parsed.data,
        scope = {
          organizationId: input.organizationId,
          userId: c.get("user").id,
        };
      switch (input.action) {
        case "oauth":
          return c.json(
            CloudGithubOauthStartedSchema.parse(
              await service.begin(scope, input.expected),
            ),
          );
        case "cancel":
          await service.store.cancelOauth(scope, input.expected);
          break;
        case "pat":
          await service.connectPat(scope, input.expected, input.token);
          break;
        case "select":
          await service.store.select(scope, input.expected, input.method);
          break;
        case "disconnect":
          await service.store.disconnect(scope, input.expected, input.method);
          break;
      }
      return c.json(
        CloudGithubConnectionStatusSchema.parse(await service.status(scope)),
      );
    },
  );
  app.get(
    "/v1/cloud-v2/github/repositories",
    rateLimit("cloud-github-repositories", 60, 60_000),
    async (c) => {
      const parsed = query
        .extend({ page: z.coerce.number().int().min(1).max(100).default(1) })
        .safeParse(c.req.query());
      if (!parsed.success)
        throw new HttpError(422, "invalid_input", "Invalid repository page.");
      return c.json(
        CloudGithubRepositoryPageSchema.parse(
          await service.repositories(
            {
              organizationId: parsed.data.organizationId,
              userId: c.get("user").id,
            },
            parsed.data.page,
          ),
        ),
      );
    },
  );
  return app;
}
