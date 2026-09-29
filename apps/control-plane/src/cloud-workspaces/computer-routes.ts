import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { DatabaseCloudComputerService } from "./computer.js";
export function createCloudComputerRoutes(
  pool: pg.Pool,
  config: CloudWorkspaceBackendConfig,
  workosEnabled = false,
) {
  const app = new Hono(),
    service = new DatabaseCloudComputerService(pool, config, undefined, workosEnabled),
    root = "/v1/organizations/:organization/cloud-computer";
  app.use(
    root + "*",
    bodyLimit({
      maxSize: 65536,
      onError: () => {
        throw new HttpError(
          413,
          "payload_too_large",
          "Cloud Computer configuration is too large.",
        );
      },
    }),
  );
  app.use(root + "*", rateLimit("cloud-computer", 60, 60000));
  app.use(root + "*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const id = (value: unknown) => {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid Cloud Computer identity.",
      );
    return parsed.data;
  };
  app.get(root, (c) =>
    service
      .read(id(c.req.param("organization")), c.get("user").id)
      .then((value) => c.json(value)),
  );
  app.put(root, async (c) =>
    c.json(
      await service.save(
        id(c.req.param("organization")),
        c.get("user").id,
        await c.req.json().catch(() => null),
      ),
    ),
  );
  app.post(root + "/activate", async (c) => {
    const body = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        version: z.number().int().positive(),
        artifactId: z.string().uuid(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid Cloud Computer version.",
      );
    return c.json(
      await service.activate(
        id(c.req.param("organization")),
        c.get("user").id,
        body.data.expectedRevision,
        body.data.version,
        body.data.artifactId,
      ),
    );
  });
  app.post(root + "/builds", async (c) => c.json(await service.build(
    id(c.req.param("organization")), c.get("user").id, await c.req.json().catch(() => null)), 202));
  app.post(root + "/rollback", async (c) => {
    const body = z.object({ expectedRevision: z.number().int().positive(), artifactId: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HttpError(422, "invalid_input", "Invalid rollback image.");
    return c.json(await service.rollback(id(c.req.param("organization")), c.get("user").id, body.data.expectedRevision, body.data.artifactId));
  });
  app.get(root + "/builds/:build/log", (c) =>
    service
      .logs(
        id(c.req.param("organization")),
        c.get("user").id,
        id(c.req.param("build")),
      )
      .then((value) => c.json(value)),
  );
  app.post(root + "/builds/:build/cancel", (c) =>
    service
      .cancel(
        id(c.req.param("organization")),
        c.get("user").id,
        id(c.req.param("build")),
      )
      .then((value) => c.json(value)),
  );
  return app;
}
