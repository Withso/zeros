import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { rateLimit } from "../../ratelimit.js";
import { CloudApiKeyNameSchema, type CloudApiCredentials } from "./credentials.js";

export function createCloudApiManagementRoutes(credentials: CloudApiCredentials): Hono {
  const app = new Hono();
  const keys = "/v1/organizations/:org/api-keys", access = "/v1/cloud-v2/organizations/:org/api-access";
  for (const path of [keys, `${keys}/*`, access]) app.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store"); await next();
  }, bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) }),
  rateLimit("cloud-api-management", 60, 60_000));
  const uuid = (value: string | undefined) => {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) throw new HttpError(404, "not_found", "Not found");
    return parsed.data;
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid request");
    return parsed.data;
  };
  app.get(keys, async c => c.json(await credentials.list(uuid(c.req.param("org")), c.get("user").id)));
  app.post(keys, async c => {
    const input = await body(c, z.object({ name: CloudApiKeyNameSchema }).strict());
    return c.json(await credentials.create(uuid(c.req.param("org")), c.get("user").id, input.name), 201);
  });
  app.delete(`${keys}/:id`, async c => {
    await credentials.revoke(uuid(c.req.param("org")), c.get("user").id, uuid(c.req.param("id")));
    return c.body(null, 204);
  });
  app.get(access, async c => c.json(await credentials.access(uuid(c.req.param("org")), c.get("user").id)));
  app.put(access, async c => {
    const input = await body(c, z.object({ workspaceApiAccess: z.boolean() }).strict());
    return c.json(await credentials.setAccess(uuid(c.req.param("org")), c.get("user").id, input.workspaceApiAccess));
  });
  return app;
}
