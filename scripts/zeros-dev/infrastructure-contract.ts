import { z } from "zod";
import { createHash } from "node:crypto";
import { WindowSchema, TransportObservationSchema, GATE0_DETACHED_MS } from "./gate0-contract";
import { SetupObservationSchema } from "./setup-observation";
import { InfrastructureNativeIntentSchema, InfrastructureNativeTaskSchema, InfrastructureNativeProofSchema } from "./infrastructure-native";

// Owner option B: this scope is measured independently of the owner's §7
// agent/UI test. It cannot supply full Gate 0 or hourly agent coverage.
export const INFRASTRUCTURE_TOTAL_MS = 3_800_000;
export const INFRASTRUCTURE_DETACHED_MS = 31 * 60_000;
export const OWNER_SECTION7_COVERAGE = {
  agents: "not_covered_owner_section7", accountModels: "not_covered_owner_section7",
  agentHistory: "not_covered_owner_section7", detachedAgent: "not_covered_owner_section7",
} as const;
export const InfrastructureCoverageSchema = z.object({
  agents: z.literal("not_covered_owner_section7"), accountModels: z.literal("not_covered_owner_section7"),
  agentHistory: z.literal("not_covered_owner_section7"), detachedAgent: z.literal("not_covered_owner_section7"),
}).strict();
const count = z.number().int().nonnegative().safe();
const duration = z.number().nonnegative().finite();

export const InfrastructureSchema = z.object({
  version: z.literal(1), complete: z.boolean(), coverage: InfrastructureCoverageSchema,
  runtimePin: z.object({ buildId: z.string().uuid(), version: z.number().int().positive().safe(),
    runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), baseImageId: z.string().min(1).max(200) }).strict().optional(),
  initialSetup: SetupObservationSchema.optional(),
  intent: InfrastructureNativeIntentSchema.optional(),
  task: InfrastructureNativeTaskSchema.optional(),
  terminalChecks: count, fileChecks: count,
  cycles: z.array(z.object({ index: z.number().int().min(1).max(3), stopMs: duration, resumeMs: duration, usableMs: duration,
    stoppedAt: z.string().datetime(), readyAt: z.string().datetime(), setup: SetupObservationSchema }).strict()).max(3),
  detached: WindowSchema.extend({ authRemainingMs: duration, proof: InfrastructureNativeProofSchema }).strict().optional(),
  transports: z.array(TransportObservationSchema).max(12),
}).strict().superRefine((value, context) => {
  const task = value.task, intent = value.intent, detached = value.detached;
  const taskIntent = task ? (({ firstRow: _first, ...fields }) => fields)(task) : undefined;
  if (task && (!intent || JSON.stringify(taskIntent) !== JSON.stringify(intent)) || detached && (!task ||
    detached.proof.scopeSha256 !== task.scopeSha256 || detached.proof.programSha256 !== task.programSha256 ||
    detached.proof.sessionSha256 !== createHash("sha256").update(task.sessionId).digest("hex") ||
    Date.parse(detached.startedAt) < task.startedAtMs || Date.parse(detached.completedAt) > task.deadlineAtMs ||
    Date.parse(detached.completedAt) < Date.parse(detached.startedAt) || detached.durationMs > task.deadlineAtMs - task.startedAtMs))
    context.addIssue({ code: "custom", message: "Infrastructure task binding is inconsistent" });
  if (!value.complete) return;
  if (!intent || !task || !value.runtimePin || !value.initialSetup || value.initialSetup.state !== "succeeded" ||
    value.initialSetup.claimCount !== 1 || value.initialSetup.errorCode !== null || value.terminalChecks < 4 || value.fileChecks < 4 ||
    value.cycles.length !== 3 || value.cycles.some((row, index) => row.index !== index + 1 || row.setup.state !== "succeeded" ||
      row.setup.claimCount !== 1 || row.setup.errorCode !== null) || !detached || detached.durationMs <= GATE0_DETACHED_MS ||
    detached.authRemainingMs <= detached.durationMs || detached.proof.taskDurationMs <= GATE0_DETACHED_MS ||
    detached.proof.maxHeartbeatGapMs > 90_000 || !value.transports.length ||
    value.transports.some(row => row.coverage !== "complete" || row.lostConnections > 0 || row.unexplainedAuthorityCloses > 0))
    context.addIssue({ code: "custom", message: "Infrastructure proof is incomplete" });
});
export type Infrastructure = z.infer<typeof InfrastructureSchema>;

export function initialInfrastructure(): Infrastructure {
  return { version: 1, complete: false, coverage: { ...OWNER_SECTION7_COVERAGE }, terminalChecks: 0, fileChecks: 0, cycles: [], transports: [] };
}
