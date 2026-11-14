import { z } from "zod";
import { HttpError } from "../authz.js";
import { CloudV2PromptCounterSchema, CloudV2PromptIdSchema } from "./prompt-contract.js";

const base = z.object({ chatId: CloudV2PromptIdSchema, after: CloudV2PromptCounterSchema.default("0"),
  limit: z.coerce.number().int().min(1).max(100).default(100), includePayload: z.enum(["true", "false"]).default("true") }).strict();
const revision = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(value => Number.isSafeInteger(Number(value))).transform(Number);
const own = base.extend({ queueRevision: revision.optional() }).refine(value => value.includePayload === "true" &&
  (value.after === "0" ? value.queueRevision === undefined : value.queueRevision !== undefined));

export function promptStatusQuery(input: unknown, cache: boolean): {
  chatId: string; after: string; limit: number; includePayload: "true" | "false"; queueRevision?: number;
} {
  const parsed = (cache ? own : base).safeParse(input);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid message status request");
  return parsed.data;
}
