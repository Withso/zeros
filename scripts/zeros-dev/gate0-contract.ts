import { z } from "zod";
import { SetupObservationSchema } from "./setup-observation";

export const GATE0_WORK_MS = 60 * 60_000;
export const GATE0_DETACHED_MS = 30 * 60_000;
export const GATE0_TASK_MS = 31 * 60_000;
export const GATE0_TOTAL_MS = 8_000_000;
export const GATE0_TICK_MS = 5 * 60_000;
const count = z.number().int().nonnegative().safe();
const duration = z.number().nonnegative().finite();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WindowSchema = z.object({ startedAt: z.string().datetime(), completedAt: z.string().datetime(), durationMs: duration }).strict();
export const TransportObservationSchema = z.object({
  connectionId: z.string().uuid(), coverage: z.enum(["complete", "unavailable"]),
  directAttempts: count, directReady: count, relayAttempts: count, relayReady: count,
  lostConnections: count, authorityCloses: count, unexplainedAuthorityCloses: count,
  firstClose: z.enum(["authority_expired", "authority_revoked", "authority_unavailable", "account_binding_required", "actor_forbidden",
    "protocol_mismatch", "handshake_failed", "engine_shutdown", "abnormal", "other"]).optional(),
}).strict().refine(value => value.directReady <= value.directAttempts && value.relayReady <= value.relayAttempts &&
  value.unexplainedAuthorityCloses <= value.authorityCloses);
export type TransportObservation = z.infer<typeof TransportObservationSchema>;
export const ModelEligibilitySchema = z.object({ agent: z.enum(["claude", "codex", "cursor"]),
  selectedModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/), allowedCount: count, eligible: z.boolean(),
  unavailableCount: count, scopeSha256: digest }).strict();
export type ModelEligibility = z.infer<typeof ModelEligibilitySchema>;
export const Gate0Schema = z.object({
  version: z.literal(1), complete: z.boolean(),
  models: z.array(ModelEligibilitySchema).max(3),
  initialSetup: SetupObservationSchema.optional(),
  workload: WindowSchema.extend({ samples: count, agentTurns: z.object({ claude: count, codex: count, cursor: count }).strict(),
    fileChecks: count, historyChecks: count }).strict().optional(),
  cycles: z.array(z.object({ index: z.number().int().min(1).max(3), stopMs: duration, resumeMs: duration, usableMs: duration,
    stoppedAt: z.string().datetime(), readyAt: z.string().datetime(), setup: SetupObservationSchema }).strict()).max(3),
  detached: WindowSchema.extend({ authRemainingMs: duration, commandSha256: digest, scopeSha256: digest,
    taskDurationMs: duration, heartbeatCount: count, maxHeartbeatGapMs: duration,
    historySha256: digest, historyRows: count, replayEvents: count, cursorSha256: digest }).strict().optional(),
  transports: z.array(TransportObservationSchema).max(12),
}).strict().superRefine((value, context) => {
  if (!value.complete) return;
  const work = value.workload, detached = value.detached;
  if (!work || work.durationMs < GATE0_WORK_MS || work.samples !== 13 || work.fileChecks < 13 || work.historyChecks < 3 ||
    Object.values(work.agentTurns).some(n => n < 1) || value.models.length !== 3 ||
    new Set(value.models.map(row => row.agent)).size !== 3 || value.models.some(row => !row.eligible) ||
    !value.initialSetup || value.initialSetup.state !== "succeeded" || value.initialSetup.claimCount !== 1 || value.initialSetup.errorCode !== null ||
    value.cycles.length !== 3 || value.cycles.some((row, i) => row.index !== i + 1 || row.setup.state !== "succeeded" || row.setup.claimCount !== 1 || row.setup.errorCode !== null) ||
    !detached || detached.durationMs < GATE0_DETACHED_MS || detached.taskDurationMs < GATE0_DETACHED_MS ||
    detached.authRemainingMs <= detached.durationMs || detached.heartbeatCount < 31 || detached.maxHeartbeatGapMs > 90_000 ||
    !detached.historyRows || !detached.replayEvents || !value.transports.length ||
    value.transports.some(row => row.coverage !== "complete" || row.unexplainedAuthorityCloses > 0))
    context.addIssue({ code: "custom", message: "Gate 0 proof is incomplete" });
});
export type Gate0 = z.infer<typeof Gate0Schema>;
