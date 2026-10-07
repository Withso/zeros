import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { rateLimit } from "../ratelimit.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import {
  CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES,
  CloudComputerV2BuildRequestSchema,
  CloudComputerV2RevisionSchema,
  CloudComputerV2RepositorySchema,
  CloudComputerV2RepositorySetupSchema,
  CloudComputerV2SaveDraftSchema,
  CloudComputerV2VersionRequestSchema,
  CloudComputerV2AdminWorkspaceRequestSchema,
  type CloudComputerV2AdminWorkspaceRequest,
} from "./computer-v2-contract.js";

type Service = Pick<
  DatabaseCloudComputerV2Service,
  | "read"
  | "saveDraft"
  | "discard"
  | "build"
  | "getBuild"
  | "logs"
  | "cancel"
  | "activate"
  | "rebuild"
  | "updateRepositorySetupScript"
>;
export function createCloudComputerV2Routes(
  pool: pg.Pool,
  config: CloudWorkspaceBackendConfig,
  options: { service?: Service; createAdminWorkspace?: (c: Context, request: CloudComputerV2AdminWorkspaceRequest) => Promise<Response> } = {},
) {
  const app = new Hono(),
    service =
      options.service ?? new DatabaseCloudComputerV2Service(pool, config);
  const root = "/v1/organizations/:organization/cloud-computer/v2";
  app.use(root + "*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    root + "*",
    bodyLimit({
      maxSize: CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES,
      onError: () => {
        throw new HttpError(
          413,
          "payload_too_large",
          "Cloud Computer configuration is too large.",
        );
      },
    }),
  );
  const normalLimit = rateLimit("cloud-computer-v2", 60, 60_000),
    logLimit = rateLimit("cloud-computer-v2-logs", 180, 60_000);
  app.use(root + "*", (c, next) =>
    c.req.path.endsWith("/log") ? logLimit(c, next) : normalLimit(c, next),
  );
  function parse<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    value: unknown,
  ): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid Cloud Computer input.",
      );
    return parsed.data;
  }
  const id = (value: unknown) => parse(z.string().uuid(), value).toLowerCase();
  const integer = (value: string | undefined, zero = false) => {
    if (
      typeof value !== "string" ||
      !(zero ? /^(0|[1-9][0-9]{0,15})$/ : /^[1-9][0-9]{0,15}$/).test(value)
    )
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid Cloud Computer cursor or version.",
      );
    return parse(
      z
        .number()
        .int()
        .min(zero ? 0 : 1)
        .safe(),
      Number(value),
    );
  };
  const historyQuery = z
    .object({
      cursor: z.string().min(1).max(512).optional(),
      limit: z.string().optional(),
      activeRepositories: z.enum(["true", "false"]).optional(),
    })
    .strict();
  const logQuery = z
    .object({ after: z.string().optional(), limit: z.string().optional() })
    .strict();
  app.post(root + "/admin-workspaces", async (c) => {
    const request = parse(CloudComputerV2AdminWorkspaceRequestSchema, await c.req.json().catch(() => null));
    if (!options.createAdminWorkspace)
      throw new HttpError(503, "cloud_workspaces_not_configured", "Cloud workspace provisioning is not configured");
    return options.createAdminWorkspace(c, request);
  });
  app.get(root, (c) => {
    const query = parse(historyQuery, c.req.query());
    return service
      .read(id(c.req.param("organization")), c.get("user").id, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined
          ? { limit: parse(z.number().max(100), integer(query.limit)) }
          : {}),
      })
      .then((value) => {
        if (query.activeRepositories === "true") return c.json(value);
        // Shipped desktops parse a strict schema. Negotiate the additive field
        // so the server can deploy before those clients update.
        const { activeRepositories: _activeRepositories, ...legacy } = value;
        return c.json(legacy);
      });
  });
  app.put(root + "/draft", async (c) =>
    c.json(
      await service.saveDraft(
        id(c.req.param("organization")),
        c.get("user").id,
        parse(
          CloudComputerV2SaveDraftSchema,
          await c.req.json().catch(() => null),
        ),
      ),
    ),
  );
  app.put(root + "/repositories/:repository/setup", async c => c.json(
    await service.updateRepositorySetupScript(
      id(c.req.param("organization")), c.get("user").id,
      parse(CloudComputerV2RepositorySchema.shape.id, c.req.param("repository")),
      parse(CloudComputerV2RepositorySetupSchema, await c.req.json().catch(() => null)),
    ),
  ));
  app.post(root + "/discard", async (c) =>
    c.json(
      await service.discard(
        id(c.req.param("organization")),
        c.get("user").id,
        parse(
          CloudComputerV2RevisionSchema,
          await c.req.json().catch(() => null),
        ),
      ),
    ),
  );
  app.post(root + "/builds", async (c) =>
    c.json(
      await service.build(
        id(c.req.param("organization")),
        c.get("user").id,
        parse(
          CloudComputerV2BuildRequestSchema,
          await c.req.json().catch(() => null),
        ),
      ),
      202,
    ),
  );
  app.get(root + "/builds/:buildId", (c) =>
    service
      .getBuild(
        id(c.req.param("organization")),
        c.get("user").id,
        id(c.req.param("buildId")),
      )
      .then((value) => c.json(value)),
  );
  app.get(root + "/builds/:buildId/log", (c) => {
    const query = parse(logQuery, c.req.query());
    return service
      .logs(
        id(c.req.param("organization")),
        c.get("user").id,
        id(c.req.param("buildId")),
        {
          ...(query.after !== undefined
            ? { after: integer(query.after, true) }
            : {}),
          ...(query.limit !== undefined
            ? { limit: parse(z.number().max(100), integer(query.limit)) }
            : {}),
        },
      )
      .then((value) => c.json(value));
  });
  app.post(root + "/builds/:buildId/cancel", async (c) =>
    c.json(
      await service.cancel(
        id(c.req.param("organization")),
        c.get("user").id,
        id(c.req.param("buildId")),
        parse(
          CloudComputerV2RevisionSchema,
          await c.req.json().catch(() => null),
        ),
      ),
    ),
  );
  app.post(root + "/versions/:version/activate", async (c) =>
    c.json(
      await service.activate(
        id(c.req.param("organization")),
        c.get("user").id,
        integer(c.req.param("version")),
        parse(
          CloudComputerV2VersionRequestSchema,
          await c.req.json().catch(() => null),
        ),
      ),
    ),
  );
  app.post(root + "/versions/:version/rebuild", async (c) =>
    c.json(
      await service.rebuild(
        id(c.req.param("organization")),
        c.get("user").id,
        integer(c.req.param("version")),
        parse(
          CloudComputerV2VersionRequestSchema,
          await c.req.json().catch(() => null),
        ),
      ),
      202,
    ),
  );
  return app;
}
