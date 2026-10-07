import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { rateLimit } from "../ratelimit.js";
import { requireCloudComputerAuthority } from "./computer-identity.js";
import { cloudWorkspaceV2Required } from "./supported-generation.js";

/** Authenticated compatibility boundary. Historical records/cleanup stay in
 * storage; these routes can no longer save, build, publish or activate them. */
export function createCloudComputerRoutes(pool: pg.Pool) {
  const app = new Hono(),
    root = "/v1/organizations/:organization/cloud-computer";
  app.use(root + "*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
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
  const refuse = async (c: import("hono").Context) => {
    const id = z.string().uuid().safeParse(c.req.param("organization"));
    if (!id.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid Cloud Computer identity.",
      );
    await withSystemTx(pool, async (tx) => {
      const user = c.get("user").id;
      if (
        !(
          await tx.query(
            "SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL FOR SHARE",
            [user],
          )
        ).rowCount
      )
        throw new HttpError(404, "not_found", "Cloud Computer not found");
      await requireCloudComputerAuthority(tx, id.data, user);
    });
    throw cloudWorkspaceV2Required();
  };
  app.all(root + "*", refuse);
  return app;
}
