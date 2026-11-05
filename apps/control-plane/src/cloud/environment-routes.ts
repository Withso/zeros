import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import { CloudEnvironmentMetadataSchema, CloudEnvironmentRepositoryIdSchema } from "./environment-contract.js";
import type { CloudEnvironments } from "./environment-store.js";

const base = "/v1/cloud-v2/organizations/:organization/environment/:repositoryId";
function target(c: Context) {
  const input = z.object({ organization: z.string().uuid(), repositoryId: CloudEnvironmentRepositoryIdSchema,
    repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => !value.includes("\n")),
  }).safeParse({ organization: c.req.param("organization"), repositoryId: c.req.param("repositoryId"), repository: c.req.query("repository") });
  if (!input.success) throw new HttpError(422, "cloud_environment_invalid", "Choose a repository for this environment.");
  return input.data;
}

export function createCloudEnvironmentRoutes(store: Pick<CloudEnvironments, "get" | "patch">): Hono {
  const app = new Hono();
  app.use(base, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  // JSON escaping can expand bounded UTF-8 material sixfold.
  app.use(base, bodyLimit({ maxSize: 2 * 1024 * 1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Environment request is too large." } }, 413) }));
  app.use(base, rateLimit("cloud-environment", 90, 60_000));
  app.get(base, async c => {
    const scope = target(c);
    return c.json({ environment: CloudEnvironmentMetadataSchema.parse(await store.get(scope.organization, c.get("user").id, scope.repositoryId, scope.repository)) });
  });
  app.patch(base, async c => {
    const scope = target(c);
    return c.json({ environment: CloudEnvironmentMetadataSchema.parse(await store.patch(scope.organization, c.get("user").id, scope.repositoryId, scope.repository, await c.req.json().catch(() => null))) });
  });
  return app;
}
