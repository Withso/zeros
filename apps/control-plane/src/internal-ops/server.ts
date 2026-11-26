import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { providers, type Checks, type Provider } from "./providers.js";

export const policySchema = z
  .object({
    environment: z.enum(["development", "alpha", "production"]),
    organizationId: z.uuid(),
    issuer: z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
    audience: z.string().regex(/^[a-f0-9]{64}$/),
    principals: z
      .array(
        z
          .object({
            subject: z
              .string()
              .max(256)
              .regex(/^(?:user:[\w-]+|service:[a-f0-9]{32}\.access)$/),
            tools: z.array(z.enum(providers)).nonempty(),
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.principals.map((p) => p.subject)).size ===
      policy.principals.length,
  );
type Policy = z.infer<typeof policySchema>;
const definitions: Record<Provider, string> = {
  boat: "Check the configured Boat wallet and its start allowance.",
  cloudflare: "Read the configured Cloudflare zone status.",
  workos:
    "Verify that the development team can reach its configured WorkOS organization.",
  railway:
    "Read the latest deployment status for the selected Railway service and environment.",
  planetscale: "Read the state of the configured PlanetScale database.",
};
const limit = 16 * 1024;
type AuditEvent = {
  subject: string;
  environment: string;
  organizationId: string;
  provider: Provider | null;
  outcome: "ok" | "unavailable" | "denied";
};

export function internalOpsServer(
  policy: Policy,
  checks: Checks,
  options: { keys?: JWTVerifyGetKey; audit?: (event: AuditEvent) => void } = {},
) {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(`${policy.issuer}/cdn-cgi/access/certs`));
  const audit =
    options.audit ??
    ((event) =>
      console.info(JSON.stringify({ event: "ops_provider_check", ...event })));
  const principals = new Map(policy.principals.map((p) => [p.subject, p]));
  const windows = new Map<string, { end: number; count: number }>();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.post(
    "/mcp",
    bodyLimit({ maxSize: limit, onError: (c) => c.body(null, 413) }),
    async (c) => {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(c.req.url).origin)
        return c.body(null, 403);
      const assertion =
        c.req.header("cf-access-jwt-assertion") ??
        c.req.header("authorization")?.match(/^Bearer ([^ ]+)$/i)?.[1];
      if (!assertion || assertion.length > 16384) return c.body(null, 401);
      let subject: string;
      try {
        const { payload } = await jwtVerify(assertion, keys, {
          algorithms: ["RS256"],
          issuer: policy.issuer,
          audience: policy.audience,
          requiredClaims: ["iat", "exp", "sub"],
          maxTokenAge: "1h",
        });
        if (payload.type !== "app" || typeof payload.sub !== "string")
          return c.body(null, 401);
        if (payload.sub) subject = `user:${payload.sub}`;
        else if (
          typeof payload.common_name === "string" &&
          /^[a-f0-9]{32}\.access$/.test(payload.common_name)
        )
          subject = `service:${payload.common_name}`;
        else return c.body(null, 401);
      } catch {
        return c.body(null, 401);
      }
      const principal = principals.get(subject);
      if (!principal) return c.body(null, 403);
      const now = Date.now();
      let window = windows.get(subject);
      if (!window || window.end <= now) {
        window = { end: now + 60_000, count: 0 };
        windows.set(subject, window);
      }
      if (++window.count > 60) {
        c.header("retry-after", String(Math.ceil((window.end - now) / 1000)));
        return c.body(null, 429);
      }
      const body: unknown = await c.req.json().catch(() => null);
      if (!body || Array.isArray(body) || typeof body !== "object")
        return c.body(null, 400);
      const allowed = principal.tools.filter(
        (tool) => checks[tool] !== undefined,
      );
      const server = new Server(
        { name: "zeros-internal-ops", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: allowed.map((provider) => ({
          name: `check_${provider}`,
          description: definitions[provider],
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const provider = allowed.find(
          (tool) => request.params.name === `check_${tool}`,
        );
        const event = {
          subject,
          environment: policy.environment,
          organizationId: policy.organizationId,
          provider: provider ?? null,
        };
        if (
          !provider ||
          Object.keys(request.params.arguments ?? {}).length !== 0
        ) {
          audit({ ...event, outcome: "denied" });
          return {
            isError: true,
            content: [{ type: "text", text: "Operation unavailable" }],
          };
        }
        try {
          const result = {
            environment: policy.environment,
            zerosOrganizationId: policy.organizationId,
            provider,
            ...(await checks[provider]!()),
          };
          audit({ ...event, outcome: "ok" });
          return {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch {
          audit({ ...event, outcome: "unavailable" });
          return {
            isError: true,
            content: [{ type: "text", text: "Provider check failed" }],
          };
        }
      });
      try {
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          maxRequestBodySize: limit,
        });
        await server.connect(transport);
        const response = await transport.handleRequest(c.req.raw, {
          parsedBody: body,
        });
        return c.newResponse(response.body, response);
      } finally {
        await server.close();
      }
    },
  );
  app.all("/mcp", (c) => {
    c.header("allow", "POST");
    return c.body(null, 405);
  });
  return app;
}
