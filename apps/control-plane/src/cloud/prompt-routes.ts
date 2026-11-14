import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { localDeviceHeaders } from "./local-commands/routes.js";
import type { CloudV2PromptOutbox } from "./prompt-outbox.js";
import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptSchema, CloudV2PromptStopSchema } from "./prompt-contract.js";
import { promptStatusQuery } from "./prompt-status-query.js";

/** Admission precedes durable enqueue; returning a receipt never waits for
 * the worker to connect or execute the message. */
export function createCloudV2PromptRoutes(outbox: CloudV2PromptOutbox, authorizeSource?: (id: string, userId: string) => Promise<void>): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/workspaces/:id/prompts";
  const body = bodyLimit({ maxSize: CLOUD_V2_MAX_PROMPT_BYTES, onError: c => c.json({ error: { code: "payload_too_large" } }, 413) });
  const id = (input: string) => {
    if (!z.string().uuid().safeParse(input).success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    return input;
  };
  app.use(`${path}*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    // Stop remains possible after repository access is lost.
    if (!c.req.path.endsWith("/stop") && !await outbox.execution?.active(id(c.req.param("id")!))) await authorizeSource?.(id(c.req.param("id")!), c.get("user").id);
    await next();
  });
  app.post(path, body, async c => {
    const parsed = CloudV2PromptSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud prompt");
    const { receipt, replay } = await outbox.enqueue(id(c.req.param("id")), c.get("user").id, parsed.data, c.get("user"), { device: localDeviceHeaders(c, true) });
    return c.json({ receipt }, replay ? 200 : 201);
  });
  app.get(path, async c => {
    const cache = c.req.header("X-Zeros-Chat-Cache") === "1", query = promptStatusQuery(c.req.query(), cache);
    const workspaceId = id(c.req.param("id")), userId = c.get("user").id;
    if (cache) await authorizeSource?.(workspaceId, userId);
    const result = await outbox.list(workspaceId, userId, query.chatId, query.after, query.limit, query.includePayload === "true",
      cache ? { queueRevision: query.queueRevision } : undefined);
    if (cache) await authorizeSource?.(workspaceId, userId);
    return c.json(result);
  });
  app.post(`${path}/stop`, body, async c => {
    const parsed = CloudV2PromptStopSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid conversation Stop");
    return c.json(await outbox.stop(id(c.req.param("id")), c.get("user").id, parsed.data.chatId, parsed.data.throughEpoch, c.get("user")));
  });
  return app;
}
