import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimit } from "../ratelimit.js";
import type { DatabaseReleaseCanaryService, DatabaseReleaseCanaryDesignationService } from "./release-canaries.js";

type AdmissionService = Pick<DatabaseReleaseCanaryService, "preflight" | "admit">;
type DesignationService = Pick<DatabaseReleaseCanaryDesignationService, "readDesignation" | "designate">;
const internal = "/internal/v1/release-canaries";
const designation = "/v1/cloud-agent-credentials/:credential/release-canary";

export function createReleaseCanaryAdmissionRoutes(service: AdmissionService) {
  const app = new Hono();
  app.use(`${internal}/*`, bodyLimit({ maxSize: 16 * 1024 }));
  app.use(`${internal}/*`, rateLimit("release-canary-admission", 12, 60_000));
  app.use(`${internal}/*`, async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.post(`${internal}/preflight`, async context => context.json(await service.preflight(await context.req.json().catch(() => null), context.req.header("authorization"))));
  app.post(`${internal}/admissions`, async context => context.json(await service.admit(await context.req.json().catch(() => null), context.req.header("authorization"))));
  return app;
}
export function createReleaseCanaryDesignationRoutes(service: DesignationService) {
  const app = new Hono();
  app.use(designation, bodyLimit({ maxSize: 4096 }));
  app.use(designation, rateLimit("release-canary-designation", 12, 60_000));
  app.use(designation, async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.get(designation, async context => context.json(await service.readDesignation(context.get("user").id, context.req.param("credential"))));
  app.put(designation, async context => context.json(await service.designate(context.get("user").id, context.req.param("credential"), await context.req.json().catch(() => null))));
  return app;
}
