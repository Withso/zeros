import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { CloudV2PromptOutbox } from "./prompt-outbox.js";
import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptSchema, CloudV2PromptIdSchema,
  CloudV2PromptCounterSchema, CloudV2PromptStopSchema } from "./prompt-contract.js";

/** User-authenticated, creator-only HTTPS. A receipt is returned only after
 * COMMIT; no worker connection, credential fetch or provider call is awaited. */
export function createCloudV2PromptRoutes(outbox: CloudV2PromptOutbox): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/workspaces/:id/prompts";
  const body = bodyLimit({ maxSize: CLOUD_V2_MAX_PROMPT_BYTES, onError: c => c.json({ error: { code: "payload_too_large" } }, 413) });
  const id = (input: string) => {
    if (!z.string().uuid().safeParse(input).success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    return input;
  };
  app.use(`${path}*`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post(path, body, async c => {
    const parsed = CloudV2PromptSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud prompt");
    const { receipt, replay } = await outbox.enqueue(id(c.req.param("id")), c.get("user").id, parsed.data, c.get("user"));
    return c.json({ receipt }, replay ? 200 : 201);
  });
  app.get(path, async c => {
    const parsed = z.object({ chatId: CloudV2PromptIdSchema, after: CloudV2PromptCounterSchema.default("0"),
      limit: z.coerce.number().int().min(1).max(100).default(100) }).strict().safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid message status request");
    return c.json(await outbox.list(id(c.req.param("id")), c.get("user").id, parsed.data.chatId, parsed.data.after, parsed.data.limit));
  });
  app.post(`${path}/stop`, body, async c => {
    const parsed = CloudV2PromptStopSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid conversation Stop");
    return c.json(await outbox.stop(id(c.req.param("id")), c.get("user").id, parsed.data.chatId, parsed.data.throughEpoch, c.get("user")));
  });
  return app;
}
