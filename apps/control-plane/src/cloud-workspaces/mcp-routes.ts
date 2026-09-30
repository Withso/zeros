import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import type { DatabaseCloudCustomizationService } from "./customization-store.js";

export function createCloudCustomizationRoutes(service: DatabaseCloudCustomizationService) {
  const app = new Hono(), root = "/v1/organizations/:organization/customization";
  for (const route of [root, root + "/*"]) {
    app.use(route, bodyLimit({ maxSize: 256 * 1024, onError: () => { throw new HttpError(413, "payload_too_large", "Customization is too large."); } }));
    app.use(route, rateLimit("cloud-customization", 60, 60_000));
    app.use(route, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  }
  app.get(root, async c => c.json(await service.read(c.req.param("organization"), c.get("user").id)));
  app.put(root + "/:scope", async c => c.json(await service.save(c.req.param("organization")!, c.get("user").id,
    c.req.param("scope")!, await c.req.json().catch(() => null))));
  return app;
}
