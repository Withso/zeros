import { z } from "zod";
import type { BridgeMessage } from "./messages";
import type { InitializeResponse, QuestionRequest, RequestPermissionRequest } from "./agent-events";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stopReason = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "budget_exhausted", "blocking_limit", "prompt_too_long"]);
const usage = z.object({ accountingVersion: z.literal(1).optional(), revision: amount.int().optional(), costKind: z.enum(["estimated", "reported"]).optional(),
  inputTokens: amount.optional(), outputTokens: amount.optional(), cacheReadTokens: amount.optional(), cacheWriteTokens: amount.optional(),
  reasoningTokens: amount.optional(), totalCostUsd: amount.optional(), perModel: z.array(z.object({ model: z.string().min(1).max(256),
    inputTokens: amount.optional(), outputTokens: amount.optional(), cacheReadTokens: amount.optional(), cacheWriteTokens: amount.optional(), costUsd: amount.optional() }).strict()).max(32).optional() }).strict();
/** A durable terminal is always tied to its native turn. Receipt readers also
 * require commandId/executionId to match the accepting command. */
export const CloudTurnOutcomeSchema = z.object({
  commandId: z.uuid().optional(), conversationId: identity, executionId: identity.nullable(), turnId: identity, agentId: z.string().min(1).max(64),
  status: z.enum(["completed", "failed", "cancelled"]), stopReason: stopReason.nullable(), startedAt: amount.optional(), endedAt: amount.nullable().optional(),
  response: z.object({ stopReason: stopReason.optional(), usage: usage.optional(), effectiveModel: z.string().min(1).max(256).optional(), userMessageId: identity.optional() }).strict().optional(),
  error: z.string().max(8000).optional(), failure: z.object({
    kind: z.enum(["timeout", "auth-required", "verification-required", "cloud-credentials-unavailable", "subprocess-exited", "protocol-error", "transport-closed", "lifecycle-superseded", "rate-limited", "design-protection-failed", "session-expired"]),
    message: z.string().max(8000), agentId: z.string().max(64).optional(), advice: z.string().max(8000).optional(),
    stage: z.enum(["initialize", "newSession", "loadSession", "forkSession", "prompt", "cancel", "stopBackgroundTask", "setMode"]).optional(),
    exit: z.object({ code: z.number().int().safe().nullable(), signal: z.string().max(64).nullable(), stderrTail: z.string().max(8000) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type CloudTurnOutcome = z.infer<typeof CloudTurnOutcomeSchema>;
export interface CloudConversationSnapshot {
  version: 1;
  conversationId: string;
  agentId: string;
  executionId: string | null;
  session: Record<string, unknown> | null;
  initialize: InitializeResponse | null;
  messages: Array<{ msgId: string; kind: string; payload: string; createdAt: number }>;
  activeTurn: { turnId: string; startedAt: number } | null;
  latestTurn?: CloudTurnOutcome | null;
  permissions: Array<{ permissionId: string; agentId: string; request: RequestPermissionRequest }>;
  questions: Array<{ questionId: string; agentId: string; request: QuestionRequest }>;
}

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
