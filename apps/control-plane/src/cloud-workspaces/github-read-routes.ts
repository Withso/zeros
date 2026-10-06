import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { githubReadRequestSchema } from "./github-read-policy.js";
import { GithubReadError, type DatabaseCloudGithubReads } from "./github-read-proxy.js";

export const CLOUD_GITHUB_READ_PATH = "/internal/v1/cloud-workspaces/engine/github-read";
const schema = z.object({ workspaceId: z.string().uuid(), organizationId: z.string().uuid(), generation: z.number().int().positive().safe(),
  engineInstanceId: z.string().uuid(), actorSessionId: z.string().uuid(), request: githubReadRequestSchema }).strict();
export function createCloudGithubReadRoutes(service: DatabaseCloudGithubReads): Hono {
  const app = new Hono();
  app.use(CLOUD_GITHUB_READ_PATH, bodyLimit({ maxSize: 16 * 1024 }));
  app.post(CLOUD_GITHUB_READ_PATH, async c => {
    c.header("Cache-Control", "no-store");
    const heartbeatToken = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!heartbeatToken) return c.json({ message: "GitHub read authority was rejected." }, 401);
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return c.json({ message: "Invalid GitHub read." }, 415);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "Invalid GitHub read." }, 422);
    const { request, ...scope } = parsed.data;
    try {
      const result = await service.read({ ...scope, heartbeatToken }, request);
      return c.body(result.body, result.status, { "Content-Type": result.contentType });
    } catch (error) {
      return c.json({ message: "GitHub repository read is unavailable." }, error instanceof GithubReadError ? error.status : 403);
    }
  });
  return app;
}
