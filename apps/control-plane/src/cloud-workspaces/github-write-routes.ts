import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { cloudGithubNativeSourceSchema } from "./github-native-schema.js";
import { githubWriteRedemption, type DatabaseCloudGithubWriteGrants } from "./github-write-grants.js";
export const CLOUD_GITHUB_WRITE_PATH = "/internal/v1/cloud-workspaces/engine/github-write";
const requestSchema = z.object({
  workspaceId: z.string().uuid(), organizationId: z.string().uuid(), generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(),
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("native-capabilities") }).strict(),
    z.object({ kind: z.literal("native-context"), source: cloudGithubNativeSourceSchema }).strict(),
    z.object({ kind: z.literal("author"), actorSessionId: z.string().uuid() }).strict(),
    githubWriteRedemption.extend({ kind: z.literal("redeem"), actorSessionId: z.string().uuid() }).strict(),
    z.object({ kind: z.literal("release"), grant: z.string().regex(/^zgw_[A-Za-z0-9_-]{43}$/) }).strict(),
  ]),
}).strict();
export function createCloudGithubWriteRoutes(service: DatabaseCloudGithubWriteGrants): Hono {
  const app = new Hono();
  app.use(CLOUD_GITHUB_WRITE_PATH, bodyLimit({ maxSize: 256 * 1024 }));
  app.post(CLOUD_GITHUB_WRITE_PATH, async c => {
    c.header("Cache-Control", "no-store");
    const heartbeatToken = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!heartbeatToken) return c.json({ error: "engine_authority_rejected" }, 401);
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return c.json({ error: "invalid_github_write" }, 415);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_github_write" }, 422);
    const { request, ...identity } = parsed.data, scope = { ...identity, heartbeatToken };
    try {
      if (request.kind === "native-capabilities") return c.json(await service.nativeContext(scope));
      if (request.kind === "native-context") return c.json(await service.nativeContext(scope, request.source));
      if (request.kind === "author") return c.json(await service.gitAuthor({ ...scope, actorSessionId: request.actorSessionId }));
      if (request.kind === "release") {
        await service.release(scope, request.grant);
        return c.json({ released: true });
      }
      return c.json(await service.redeem({ ...scope, actorSessionId: request.actorSessionId }, request));
    } catch { return c.json({ error: "github_write_authority_rejected" }, 403); }
  });
  return app;
}
