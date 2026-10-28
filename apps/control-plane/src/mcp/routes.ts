import { Hono, type Context } from "hono";
import { isIP } from "node:net";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { McpUuidSchema } from "../cloud/contract.js";
import { rateLimit } from "../ratelimit.js";
import { McpRepositorySchema } from "./model.js";
import { McpOAuth } from "./oauth.js";
import { MCP_CALLBACK_PATH, MCP_CLIENT_PATH, clientMetadataDocument } from "./oauth-provider.js";
import { probeMcp } from "./probe.js";
import { McpStore } from "./store.js";

const runtime = z.object({ kind: z.literal("local"), id: McpUuidSchema, admitted: z.literal(true) }).strict();
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success) throw new HttpError(422, "invalid_mcp_request", "Invalid MCP request");
  return result.data;
}
export function createMcpRoutes(store: McpStore, oauth: McpOAuth): Hono {
  const app = new Hono(), base = "/v1/organizations/:organization/extensions";
  for (const path of [base, `${base}/*`]) {
    app.use(path, bodyLimit({ maxSize: 256 * 1024 }));
    app.use(path, rateLimit("organization-mcp", 90, 60_000));
    app.use(path, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  }
  app.get(base, async c => {
    if (c.req.query("kind") && c.req.query("kind") !== "mcp") throw new HttpError(422, "invalid_extension_kind", "Unknown extension kind");
    return c.json({ extensions: await store.list(c.req.param("organization"), c.get("user").id) });
  });
  app.get(`${base}/mcp/repositories`, async c => c.json({ repositories: await store.listRepositories(c.req.param("organization"), c.get("user").id) }));
  app.post(`${base}/mcp/resolve`, async c => {
    const input = await body(c, z.object({ repository: McpRepositorySchema, runtime }).strict());
    return c.json({ servers: await store.resolve(c.req.param("organization"), c.get("user").id, input.repository) });
  });
  app.post(`${base}/mcp/probe`, rateLimit("mcp-probe", 10, 60_000), async c =>
    c.json(await probeMcp(store, oauth, c.req.param("organization"), c.get("user").id, await c.req.json().catch(() => null), c.req.raw.signal)));
  app.post(`${base}/mcp/oauth/start`, rateLimit("mcp-oauth-start", 10, 60_000), async c =>
    c.json(await oauth.start(c.req.param("organization"), c.get("user").id, await c.req.json().catch(() => null), c.req.raw.signal)));
  app.get(`${base}/mcp/oauth/:attemptId`, async c => c.json(await oauth.status(c.req.param("organization"), c.get("user").id, c.req.param("attemptId"))));
  app.delete(`${base}/mcp/oauth/:attemptId`, async c => { await oauth.cancel(c.req.param("organization"), c.get("user").id, c.req.param("attemptId")); return c.json({ ok: true }); });
  app.post(`${base}/:id/mcp/authorization`, async c => {
    const input = await body(c, z.object({ runtime, repository: McpRepositorySchema, force: z.boolean().optional() }).strict());
    const org = c.req.param("organization"), user = c.get("user").id, id = c.req.param("id");
    return c.json(await oauth.authorizationForRepository(org, user, input.repository, id, input.force));
  });
  app.put(`${base}/:id`, async c => {
    const placement = z.enum(["local", "cloud"]).default("local").safeParse(c.req.query("githubPlacement"));
    if (!placement.success) throw new HttpError(422, "invalid_mcp_request", "Choose a GitHub connection.");
    return c.json({ extension: await store.put(c.req.param("organization"), c.get("user").id, c.req.param("id"), await c.req.json().catch(() => null), placement.data) });
  });
  app.delete(`${base}/:id`, async c => {
    const input = await body(c, z.object({ expectedRevision: z.number().int().positive().safe() }).strict());
    await store.remove(c.req.param("organization"), c.get("user").id, c.req.param("id"), input.expectedRevision);
    return c.json({ ok: true });
  });
  return app;
}

/** Callback is intentionally before bearer middleware. Random one-use state
 * selects a durable, actor-bound attempt; the browser never receives a token. */
export function createMcpPublicRoutes(oauth: McpOAuth): Hono {
  const app = new Hono();
  app.get(MCP_CLIENT_PATH, c => {
    try {
      if (new URL(c.req.url).searchParams.size > (c.req.query("redirect_uri") === undefined ? 0 : 1)) throw new Error("Invalid metadata parameters");
      const document = clientMetadataDocument(oauth.origin, c.req.query("redirect_uri"));
      c.header("Cache-Control", "public, max-age=3600");
      return c.json(document);
    } catch { return c.json({ error: "invalid_redirect" }, 422); }
  });
  app.get(MCP_CALLBACK_PATH, rateLimit("mcp-oauth-callback", 60, 60_000, c => {
    const ip = c.req.header("x-real-ip"); return ip && isIP(ip) ? ip : "unknown";
  }), async c => {
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    try {
      await oauth.callback(c.req.query("state") ?? "", c.req.query("code") ?? "", c.req.query("iss"), c.req.query("error"));
      return c.text("MCP sign-in completed. You can close this window and return to Zeros.");
    } catch { return c.text("MCP sign-in could not complete or was cancelled. Return to Zeros and start sign-in again.", 400); }
  });
  return app;
}
