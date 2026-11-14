import { z } from "zod";

const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CloudRuntimeUpdateRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), id: id.optional() }).strict(),
  z.object({ op: z.literal("prepare"), instanceId: id, revision, generation }).strict(),
  z.object({ op: z.literal("commit"), id, revision, generation }).strict(),
  z.object({ op: z.literal("activate"), id }).strict(),
  z.object({ op: z.literal("cancel"), id }).strict(),
  z.object({ op: z.literal("ready"), id }).strict(),
  /** runtime-staging-v1: stage the control plane's chosen target now (verified bytes on disk), independent of quiet. The
   * request names no digest or path; the control plane chooses. */
  z.object({ op: z.literal("stage") }).strict(),
]);
export type CloudRuntimeUpdateRequest = z.infer<typeof CloudRuntimeUpdateRequestSchema>;
export const CloudRuntimeUpdateReplySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({ status: z.literal("current") }).strict(),
  z.object({ status: z.literal("target"), sha256 }).strict(),
  z.object({ status: z.literal("prepared"), id, sha256 }).strict(),
  z.object({ status: z.literal("committed"), id }).strict(),
  z.object({ status: z.literal("activating"), id }).strict(),
  z.object({ status: z.literal("cancelled"), id }).strict(),
  z.object({ status: z.literal("completed"), id }).strict(),
  /** runtime-staging-v1: the target's verified bytes are staged on this VM; a later quiet prepare reuses them. */
  z.object({ status: z.literal("staged"), sha256 }).strict(),
]);
export type CloudRuntimeUpdateReply = z.infer<typeof CloudRuntimeUpdateReplySchema>;
