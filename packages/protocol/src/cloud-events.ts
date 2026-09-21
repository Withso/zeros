import { z } from "zod";
import type { BridgeMessage } from "./messages";

export const CLOUD_REPLAY_EVENT_TYPES = new Set([
  "AGENT_SESSION_UPDATE", "AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED",
  "AGENT_QUESTION_REQUEST", "AGENT_QUESTION_SETTLED", "AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED", "DB_CHANGED",
]);
const sequence = z.number().int().safe().nonnegative();
export const CloudEventCursorSchema = z.object({ streamId: z.uuid(), sequence }).strict();
export const CloudEventClientRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), conversationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
  z.object({ kind: z.literal("replay"), cursor: CloudEventCursorSchema }).strict(),
]);
export type CloudEventCursor = z.infer<typeof CloudEventCursorSchema>;
export type CloudStreamEvent = { sequence: number; frame: BridgeMessage };
export type CloudEventEngineRequest =
  { kind: "append"; batchId: string; events: CloudStreamEvent[] } |
  { kind: "replay"; streamId: string; after: number };
export const CloudEventAppendResultSchema = z.object({ streamId: z.uuid(), head: sequence, replayed: z.boolean() }).strict();
export const CloudEventReplayResultSchema = z.object({ streamId: z.uuid(), head: sequence, firstRetained: sequence,
  cursor: sequence, events: z.array(z.object({ sequence, frame: z.record(z.string(), z.unknown()) }).strict()).max(128) }).strict();
