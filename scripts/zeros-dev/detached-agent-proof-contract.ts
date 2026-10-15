import { z } from "zod";
import { CloudAgentBootConversationSchema, CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema, CloudBootCommandSnapshotSchema } from "@zeros/protocol/cloud-commands";
import { CloudEventCursorSchema, CloudEventReplayResultSchema, CloudTurnOutcomeSchema } from "@zeros/protocol/cloud-events";

export const DETACHED_AGENT_INPUT_BYTES = 4 * 1024 * 1024;
export const DETACHED_AGENT_MIN_MS = 30 * 60_000;
export const DETACHED_AGENT_LAUNCH_FLOOR_MS = 120_000;

const count = z.number().int().nonnegative().safe();
const time = z.number().int().nonnegative().safe();
const duration = z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const provider = z.enum(["claude", "codex", "cursor"]);

const execution = z.object({ kind: z.literal("cloud"), organizationId: z.uuid(), workspaceId: z.uuid(),
  generation: count.positive(), authorityEpoch: count.positive(), engineInstanceId: z.uuid(),
  bootScope: CloudAgentBootScopeSchema }).strict();
const row = z.object({ msgId: id, kind: z.string().min(1).max(64),
  payload: z.string().max(512 * 1024).refine(value => Buffer.byteLength(value) <= 512 * 1024),
  createdAt: time }).strict();

/** A bounded observation subset of cloudEvents.snapshot, not a new wire or
 * evidence of full-chat completeness. The future owner recorder must select
 * these fields from an authenticated RuntimeClient response. */
export const DetachedAgentSnapshotSchema = z.object({ cursor: CloudEventCursorSchema, snapshot: z.object({
  conversationId: id, agentId: provider, executionId: id.nullable(),
  messages: z.array(row).max(200), activeTurn: z.object({ turnId: id, startedAt: time }).strict().nullable(),
  latestTurn: CloudTurnOutcomeSchema.nullable(), permissions: z.array(z.unknown()).max(32),
  questions: z.array(z.unknown()).max(32),
}).strict() }).strict();

export const DetachedAgentTaskRowSchema = z.object({ n: count.max(31), ms: time, run: z.uuid(), nonce: z.uuid() }).strict();
const context = { binding: CloudAgentBootConversationSchema, executionIdentity: execution };

/** All values here are untrusted offline observations. No provider session,
 * expiry claim, boolean, admission signature or device key is accepted as
 * authority. There is no executable owner adapter or receipt signer yet. */
export const DetachedAgentProofInputSchema = z.object({
  schema: z.literal("zeros.detached-agent-offline-input/v1"),
  intent: z.object({ runId: z.uuid(), nonce: z.uuid(), programSha256: digest }).strict(),
  accepted: z.object({ conversationId: id, commandId: z.uuid(), turnId: id, executionId: id, agentId: provider }).strict(),
  before: z.object({ ...context, commands: CloudBootCommandSnapshotSchema, events: DetachedAgentSnapshotSchema }).strict(),
  after: z.object({ ...context, command: CloudBootCommandEntrySchema.extend({ conversationId: id }).strict(),
    events: DetachedAgentSnapshotSchema }).strict(),
  // Token timestamps describe the launch observation only. They neither prove
  // a provider session nor authorize any part of the disconnected interval.
  launchAuth: z.object({ observedAtMs: time, expiresAtMs: time }).strict(),
  detached: z.object({ startedAtMs: time, completedAtMs: time, durationMs: duration,
    clientRequests: z.literal(0), tokenRefreshes: z.literal(0), openTransports: z.literal(0),
    commandsIssued: z.literal(0) }).strict(),
  activity: z.object({ programSha256: digest, firstRow: DetachedAgentTaskRowSchema,
    output: z.string().min(1).max(16 * 1024) }).strict(),
  replay: z.array(z.object({ requested: CloudEventCursorSchema, response: CloudEventReplayResultSchema }).strict()).min(1).max(64),
}).strict();
export type DetachedAgentProofInput = z.infer<typeof DetachedAgentProofInputSchema>;

/** A consistency report, deliberately not a signed receipt, grant, live pass,
 * hourly result or Gate 0 result. Parsing observations cannot authenticate them. */
export const DetachedAgentOfflineCheckSchema = z.object({
  schema: z.literal("zeros.detached-agent-offline-check/v1"), validation: z.literal("consistent"),
  qualification: z.literal("not_performed"), authority: z.literal("not_verified"),
  nativeDispatches: z.null(),
  inputSha256: digest, scopeSha256: digest, commandSha256: digest,
  beforeContextSha256: digest, afterContextSha256: digest, historySha256: digest, replaySha256: digest,
  launchAuth: z.object({ observedAtMs: time, expiresAtMs: time }).strict(),
  detached: z.object({ startedAtMs: time, completedAtMs: time, durationMs: duration.gt(DETACHED_AGENT_MIN_MS) }).strict(),
  nativeTurn: z.object({ startedAtMs: time, endedAtMs: time, durationMs: count.gt(DETACHED_AGENT_MIN_MS) }).strict(),
  task: z.object({ durationMs: count.gt(DETACHED_AGENT_MIN_MS), rowCount: z.literal(32),
    maxHeartbeatGapMs: count.min(45_000).max(90_000), programSha256: digest, outputSha256: digest }).strict(),
  coverage: z.object({ kind: z.literal("bounded_task_observations"), fullChat: z.literal("not_proven"),
    baselineRows: count.max(200), immutableRows: count.max(200), mutableRows: count.max(200),
    finalRows: count.max(200), replayEvents: count.positive().max(8192) }).strict(),
}).strict().refine(value => value.coverage.immutableRows + value.coverage.mutableRows === value.coverage.baselineRows &&
  value.coverage.finalRows >= value.coverage.baselineRows && value.detached.completedAtMs > value.detached.startedAtMs &&
  value.launchAuth.observedAtMs <= value.detached.startedAtMs && value.launchAuth.expiresAtMs < value.detached.completedAtMs &&
  value.launchAuth.expiresAtMs - value.launchAuth.observedAtMs >= DETACHED_AGENT_LAUNCH_FLOOR_MS &&
  value.launchAuth.expiresAtMs - value.detached.startedAtMs > 3000 &&
  value.nativeTurn.startedAtMs <= value.detached.startedAtMs &&
  value.nativeTurn.endedAtMs - value.detached.startedAtMs > DETACHED_AGENT_MIN_MS &&
  value.nativeTurn.endedAtMs - value.nativeTurn.startedAtMs === value.nativeTurn.durationMs,
"Offline observations are inconsistent");
export type DetachedAgentOfflineCheck = z.infer<typeof DetachedAgentOfflineCheckSchema>;
