import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import { DatabaseCloudWorkspaceHistoryService } from "./history.js";

const base =
  "/v1/organizations/:organization/cloud-workspaces/:workspace/history";
const chatsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    afterId: z.string().min(1).max(255).optional(),
    revision: z.coerce.number().int().safe().nonnegative().optional(),
  })
  .strict();
const messagesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    beforeMsgId: z.string().min(1).max(255).optional(),
    before: z.coerce.number().int().safe().nonnegative().optional(),
  })
  .strict();
const searchQuery = z.object({
  query: z.string().max(1000),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  chatId: z.string().min(1).max(255).optional(),
  folder: z.string().min(1).max(4096).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  revision: z.coerce.number().int().safe().nonnegative().optional(),
}).strict();
const commandsQuery = z.object({ conversationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict();
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(422, "invalid_input", "Invalid cloud history request");
  return result.data;
}
export function createCloudWorkspaceHistoryRoutes(pool: pg.Pool): Hono {
  const app = new Hono(),
    service = new DatabaseCloudWorkspaceHistoryService(pool);
  app.use(`${base}/*`, rateLimit("cloud-workspace-history", 240, 60_000));
  app.use(`${base}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(`${base}/chats`, async (c) =>
    c.json(
      await service.chats({
        workspaceId: parse(z.string().uuid(), c.req.param("workspace")),
        organizationId: parse(z.string().uuid(), c.req.param("organization")),
        accountUserId: c.get("user").id,
        ...parse(chatsQuery, c.req.query()),
      }),
    ),
  );
  app.get(`${base}/search`, async (c) => c.json(await service.search({
    workspaceId: parse(z.string().uuid(), c.req.param("workspace")),
    organizationId: parse(z.string().uuid(), c.req.param("organization")),
    accountUserId: c.get("user").id,
    ...parse(searchQuery, c.req.query()),
  })));
  app.get(`${base}/messages/:chat`, async (c) =>
    c.json(
      await service.messages({
        workspaceId: parse(z.string().uuid(), c.req.param("workspace")),
        organizationId: parse(z.string().uuid(), c.req.param("organization")),
        accountUserId: c.get("user").id,
        chatId: c.req.param("chat"),
        ...parse(messagesQuery, c.req.query()),
      }),
    ),
  );
  app.get(`${base}/commands`, async c => c.json(await service.commands({
    workspaceId: parse(z.string().uuid(), c.req.param("workspace")),
    organizationId: parse(z.string().uuid(), c.req.param("organization")), accountUserId: c.get("user").id,
    ...parse(commandsQuery, c.req.query()),
  })));
  app.get(`${base}/commands/:command`, async c => c.json(await service.receipt({
    workspaceId: parse(z.string().uuid(), c.req.param("workspace")),
    organizationId: parse(z.string().uuid(), c.req.param("organization")), accountUserId: c.get("user").id,
    commandId: parse(z.string().uuid(), c.req.param("command")),
  })));
  return app;
}
