import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import {
  authenticateMember,
  authenticateProvisioner,
  generationHeaders,
  type MemberVerifier,
} from "./authentication.js";
import { DevConnectionBroker } from "./broker.js";
import type { DevConnectionsConfig } from "./config.js";
import { DevConnectionStore } from "./store.js";
import {ConditionalRemovalRequestSchema} from "./client.js";
import {
  denied,
  GenerationSchema,
  GrantScopeSchema,
  parse,
  parseMaterial,
  uuid,
  type GithubMaterial,
} from "./types.js";

export function createDevConnectionsRoutes(options: {
  config: DevConnectionsConfig;
  store: DevConnectionStore;
  broker: DevConnectionBroker;
  verifyMember: MemberVerifier;
  verifyGithub: (material: GithubMaterial) => Promise<void>;
  ready: () => Promise<void>;
}) {
  const { config, store, broker } = options,
    app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 100000,
      onError: (c) => c.json({ error: "dev_connection_invalid" }, 413),
    }),
  );
  // Fixed service bucket bounds pre-auth work without attacker-controlled map
  // keys. Authorization and SQL journals remain the cross-replica authority.
  app.use(
    "/v1/*",
    rateLimit("dev-connections", 1200, 60000, () => "service"),
  );
  // Do not forward raw provider, parser, JOSE or database errors to clients/logs.
  app.onError((error, c) =>
    error instanceof HttpError
      ? c.json({ error: error.code }, error.status as 403 | 409 | 422)
      : c.json({ error: "dev_connection_unavailable" }, 503),
  );
  app.get("/healthz", async (c) => {
    await options.ready();
    return c.json({ ok: true, service: "dev-connections", version: 1, mode:"runtime", build:process.env.DEV_CONNECTIONS_BUILD });
  });
  app.post("/v1/generations", async (c) => {
    authenticateProvisioner(c.req.raw, config.provisionerToken);
    const input = parse(GenerationSchema, await c.req.json());
    if (input.organization !== config.auth.organization) denied();
    return c.json(await store.registerGeneration(input));
  });
  app.put("/v1/generations/:id/key", async (c) => {
    authenticateProvisioner(c.req.raw, config.provisionerToken);
    const input = parse(GenerationSchema, await c.req.json());
    if (
      input.id !== c.req.param("id") ||
      input.organization !== config.auth.organization
    )
      denied();
    await store.rotateGeneration(input);
    return c.json({ ok: true });
  });
  app.delete("/v1/generations/:id", async (c) => {
    authenticateProvisioner(c.req.raw, config.provisionerToken);
    await store.revokeGeneration(parse(uuid, c.req.param("id")));
    return c.json({ ok: true });
  });
  const member = (request: Request) =>
    authenticateMember(request, store, options.verifyMember);
  app.post("/v1/member",async c=>{const ctx=await member(c.req.raw);return c.json({issuer:ctx.member.issuer,subject:ctx.member.subject,organization:ctx.member.organization});});
  app.post("/v1/restore", async (c) =>
    c.json({ connections: await store.restore(await member(c.req.raw)) }),
  );
  app.post("/v1/connections", async (c) => {
    const ctx = await member(c.req.raw),
      body: unknown = await c.req.json();
    const shape = parse(
        z.object({ material: z.unknown() }).passthrough(),
        body,
      ),
      material = parseMaterial(shape.material);
    if (material.kind === "github-app") await options.verifyGithub(material);
    return c.json(await store.connect(ctx, body));
  });
  app.post("/v1/connections/removals",async c=>c.json(await store.removeConditionally(await member(c.req.raw),
    parse(ConditionalRemovalRequestSchema,await c.req.json()))));
  app.put("/v1/connections/:id/consent", async (c) => {
    const ctx = await member(c.req.raw);
    await store.consent(
      ctx,
      parse(uuid, c.req.param("id")),
      await c.req.json(),
    );
    return c.json({ ok: true });
  });
  app.delete("/v1/connections/:id", async (c) => {
    await store.revokeConnection(
      await member(c.req.raw),
      parse(uuid, c.req.param("id")),
    );
    return c.json({ ok: true });
  });
  app.post("/v1/grants", async (c) => {
    const ctx = await member(c.req.raw),
      body = parse(
        z.object({ bindingId: uuid, scope: GrantScopeSchema }).strict(),
        await c.req.json(),
      );
    return c.json(await broker.grant(ctx, body.bindingId, body.scope));
  });
  // Leaf authority stays backend-only. The SSH qualification operator is the
  // sole product caller; expectedVersion + persisted cooldown bound renewal.
  app.post("/v1/qualification", async c => {
    const ctx=await member(c.req.raw), body=parse(z.object({bindingId:uuid,scope:GrantScopeSchema,
      expectedVersion:z.number().int().positive().safe()}).strict(),await c.req.json());
    if(body.scope.action!=="agent")denied();
    return c.json(await broker.grant(ctx,body.bindingId,body.scope,body.expectedVersion));
  });
  app.get("/v1/revocations", async (c) =>
    c.json({
      events: await store.revocations(
        generationHeaders(c.req.raw),
        c.req.query("after") ?? "0",
      ),
    }),
  );
  return app;
}
