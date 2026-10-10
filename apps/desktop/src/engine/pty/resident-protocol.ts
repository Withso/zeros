import { z } from "zod";
import path from "node:path";

// Private engine↔resident-host transport. The root supervisor supplies authority
// out of band; an engine cannot enroll itself by sending a higher fence here.
export const RESIDENT_PTY_PROTOCOL = "zeros.resident-pty/v1";
// Includes worst-case JSON escaping of a 256 KiB terminal snapshot.
export const RESIDENT_FRAME_BYTES = 2 * 1024 * 1024;
export const RESIDENT_MAX_SESSIONS = 32;
export const ResidentEngineAuthoritySchema = z.object({
  organizationId: z.uuid(), workspaceId: z.uuid(), engineId: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type ResidentEngineAuthority = z.infer<typeof ResidentEngineAuthoritySchema>;

const dimension = z.number().int().min(2).max(500);
const boundedString = (size: number) => z.string().max(size).refine(value => !value.includes("\0"));
// Renderer terminal IDs are persisted opaque values (for example pty-…);
// engine/host authority UUIDs must not narrow that existing contract.
const sessionId = boundedString(256).min(1);
export const ResidentPtyCreateSchema = z.object({
  sessionId, cwd: boundedString(4096).min(1), cols: dimension, rows: dimension,
  command: boundedString(32768).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), boundedString(32768))
    .refine(value => Object.keys(value).length <= 256 && Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024),
  // Retain only these literal redactions, in memory; never return launch env.
  redactValues: z.array(boundedString(32768).min(1)).max(256).optional(),
  actorUserId: boundedString(256).min(1).nullable().optional(),
  registryWorkspaceId: boundedString(256).min(1).nullable().optional(),
  environmentOwnerId: boundedString(256).min(1).nullable().optional(),
  brokerId: z.uuid().nullable().optional(),
}).strict();
export type ResidentPtyCreate = z.infer<typeof ResidentPtyCreateSchema>;
export const ResidentPtyInputSchema = z.object({
  producerId: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // PTY input includes ordinary control bytes (including NUL/Ctrl+Space).
  data: z.string().min(1).max(64 * 1024),
  actorUserId: boundedString(256).min(1).nullable().optional(),
}).strict();
export type ResidentPtyInput = z.infer<typeof ResidentPtyInputSchema>;

export const ResidentPtySessionSchema = z.object({
  sessionId, pid: z.number().int().positive(), cwd: z.string().max(4096),
  cols: dimension, rows: dimension, createdAt: z.number().int().nonnegative(),
  actorUserId: z.string().max(256).nullable(), exited: z.boolean(),
  registryWorkspaceId: z.string().max(256).nullable().default(null),
  environmentOwnerId: z.string().max(256).nullable().default(null),
  brokerId: z.uuid().nullable().default(null),
  githubShared: z.boolean().default(false),
  lastInputAtMs: z.number().int().nonnegative().default(0),
}).strict();
export type ResidentPtySession = z.infer<typeof ResidentPtySessionSchema>;
const ResidentPtyExitSchema = z.object({ exitCode: z.number().int(), signal: z.number().int().nullable() }).strict();
export const ResidentPtySnapshotSchema = z.object({
  data: z.string().max(256 * 1024), bytes: z.number().int().min(0).max(256 * 1024),
  truncated: z.boolean(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exit: ResidentPtyExitSchema.optional(),
}).strict().refine(value => Buffer.byteLength(value.data) === value.bytes);
export type ResidentPtySnapshot = z.infer<typeof ResidentPtySnapshotSchema>;

export const ResidentWorkloadInspectionSchema=z.object({version:z.literal(1),complete:z.boolean(),busy:z.boolean()}).strict();
export type ResidentWorkloadInspection=z.infer<typeof ResidentWorkloadInspectionSchema>;

// Classification facts never adopt a PID or grant signalling authority. The
// engine verifies original ownership and C3 against its same fresh census.
const kernelUnsigned = z.string().regex(/^(?:0|[1-9]\d{0,19})$/)
  .refine(value => BigInt(value) <= 18_446_744_073_709_551_615n);
const kernelPositive = kernelUnsigned.refine(value => value !== "0");
export const ResidentWorkloadBirthSchema = z.object({
  pid: z.number().int().positive().max(2_147_483_647), startToken: kernelPositive,
}).strict();
export type ResidentWorkloadBirth = z.infer<typeof ResidentWorkloadBirthSchema>;
export const ResidentWorkloadCommonSchema = z.object({
  directory: boundedString(4096).min(1).refine(value => path.posix.isAbsolute(value) && path.posix.normalize(value) === value),
  dev: kernelUnsigned, ino: kernelPositive,
}).strict();
export type ResidentWorkloadCommon = z.infer<typeof ResidentWorkloadCommonSchema>;
export const ResidentWorkloadAuthoritySchema = ResidentEngineAuthoritySchema.omit({token: true}).strict();
export type ResidentWorkloadAuthority = z.infer<typeof ResidentWorkloadAuthoritySchema>;
export const RESIDENT_LEGACY_CONTROL_BYTES = 4096;
export const ResidentLegacyRetirementRequestSchema = z.object({
  version: z.literal(1), operation: z.literal("retire-legacy-resident"),
  requestId: z.uuid(), hostId: z.uuid(), authority: ResidentEngineAuthoritySchema,
}).strict();
export type ResidentLegacyRetirementRequest = z.infer<typeof ResidentLegacyRetirementRequestSchema>;
export const ResidentLegacyRetirementReceiptSchema = z.object({
  version: z.literal(1), operation: z.literal("retire-legacy-resident"), requestId: z.uuid(),
  source: z.object({ hostId: z.uuid(), authority: ResidentWorkloadAuthoritySchema,
    runtime: z.object({ runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), bootId: z.uuid(), supervisorSessionId: z.uuid() }).strict(),
    scope: ResidentWorkloadCommonSchema,
  }).strict(),
  phase: z.literal("retired"), proof: z.object({ kind: z.literal("dedicated-resident-cgroup"), populated: z.literal(0) }).strict(),
  replacement: z.literal("fresh-view-required"),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= RESIDENT_LEGACY_CONTROL_BYTES);
export type ResidentLegacyRetirementReceipt = z.infer<typeof ResidentLegacyRetirementReceiptSchema>;
export type ResidentLegacyRuntime = ResidentLegacyRetirementReceipt["source"]["runtime"] & { cgroupRoot: string };

/** Correlation with the root-held source only. This receipt cannot install a
 * replacement birth or stand for the current engine's aggregate census. */
export function residentLegacyRetirementReceiptMatchesRequest(value: unknown, request: ResidentLegacyRetirementRequest,
  runtime: ResidentLegacyRuntime): value is ResidentLegacyRetirementReceipt {
  const parsed = ResidentLegacyRetirementReceiptSchema.safeParse(value), body = ResidentLegacyRetirementRequestSchema.safeParse(request);
  if (!parsed.success || !body.success) return false;
  const source = parsed.data.source;
  return parsed.data.requestId === body.data.requestId && source.hostId === body.data.hostId &&
    source.scope.directory === `${runtime.cgroupRoot}/engine-workload-${body.data.hostId}` &&
    (["organizationId", "workspaceId", "engineId", "generation", "fence"] as const)
      .every(key => source.authority[key] === body.data.authority[key]) &&
    (["runtimeId", "bootId", "supervisorSessionId"] as const).every(key => source.runtime[key] === runtime[key]);
}
export const ResidentWorkloadCensusRequestSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), censusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  common: ResidentWorkloadCommonSchema,
}).strict();
export type ResidentQuietTerminal = z.infer<typeof ResidentQuietTerminalSchema>;
export type ResidentWorkloadCensusRequest = z.infer<typeof ResidentWorkloadCensusRequestSchema>;
export const ResidentQuietTerminalSchema = z.object({
  executionId: boundedString(256).min(1), generation: boundedString(256).min(1),
  supervisor: ResidentWorkloadBirthSchema, shell: ResidentWorkloadBirthSchema,
  targetExecutable: z.object({dev: kernelUnsigned, ino: kernelPositive}).strict(),
  noRecentInput: z.literal(true),
}).strict();
export const ResidentWorkloadClassificationSchema = ResidentWorkloadCensusRequestSchema.extend({
  authority: ResidentWorkloadAuthoritySchema, owner: ResidentWorkloadBirthSchema,
  complete: z.boolean(), pendingLaunches: z.number().int().min(0).max(4096),
  failedRetirements: z.number().int().min(0).max(4096),
  quietTerminals: z.array(ResidentQuietTerminalSchema).max(RESIDENT_MAX_SESSIONS),
}).strict().superRefine((value, context) => {
  const scopes = new Set<string>(), members = new Set<number>([value.owner.pid]);
  for (const terminal of value.quietTerminals) {
    const scope = `${terminal.executionId}\0${terminal.generation}`;
    if (scopes.has(scope) || members.has(terminal.supervisor.pid) || members.has(terminal.shell.pid) ||
      terminal.supervisor.pid === terminal.shell.pid) {
      context.addIssue({code: "custom", message: "conflicting original workload classification"});
      return;
    }
    scopes.add(scope); members.add(terminal.supervisor.pid); members.add(terminal.shell.pid);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
    context.addIssue({code: "custom", message: "workload classification exceeds capacity"});
});
export type ResidentWorkloadClassification = z.infer<typeof ResidentWorkloadClassificationSchema>;

export const ResidentWorkloadFenceRequestSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), mode: z.enum(["preserve", "drain"]),
}).strict();
export type ResidentWorkloadFenceRequest = z.infer<typeof ResidentWorkloadFenceRequestSchema>;
// This receipt covers only this original owner's process groups and pending
// launches. It never certifies whole-tree quiescence or detached descendants.
export const ResidentWorkloadFenceStatusSchema = ResidentWorkloadFenceRequestSchema.extend({
  authority: ResidentWorkloadAuthoritySchema, scope: z.literal("owner-process-groups"),
  phase: z.enum(["fenced", "joined", "drained", "released"]),
}).strict().refine(value => value.mode === "preserve" ? value.phase !== "drained" : value.phase !== "joined");
export type ResidentWorkloadFenceStatus = z.infer<typeof ResidentWorkloadFenceStatusSchema>;

/** Correlation only. Matching does not certify completeness, kernel membership
 * or the original owner; those remain the custody registry's checks. */
export function residentWorkloadClassificationMatchesRequest(value: unknown, request: ResidentWorkloadCensusRequest,
  authority: ResidentWorkloadAuthority): value is ResidentWorkloadClassification {
  const parsed = ResidentWorkloadClassificationSchema.safeParse(value);
  const census = ResidentWorkloadCensusRequestSchema.safeParse(request);
  if (!parsed.success || !census.success) return false;
  const reply = parsed.data;
  return reply.requestId === census.data.requestId && reply.censusSha256 === census.data.censusSha256 &&
    reply.common.directory === census.data.common.directory && reply.common.dev === census.data.common.dev && reply.common.ino === census.data.common.ino &&
    (["organizationId", "workspaceId", "engineId", "generation", "fence"] as const).every(key => reply.authority[key] === authority[key]);
}

const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ResidentPtyRequestSchema = z.discriminatedUnion("op", [
  z.object({ id: requestId, op: z.literal("attach"), protocol: z.literal(RESIDENT_PTY_PROTOCOL), authority: ResidentEngineAuthoritySchema }).strict(),
  z.object({ id: requestId, op: z.literal("list") }).strict(),
  z.object({ id: requestId, op: z.literal("inspect-workloads") }).strict(),
  z.object({ id: requestId, op: z.literal("classify-workloads"), census: ResidentWorkloadCensusRequestSchema }).strict(),
  z.object({ id: requestId, op: z.literal("fence-workloads"), fence: ResidentWorkloadFenceRequestSchema }).strict(),
  z.object({ id: requestId, op: z.literal("join-workloads"), fence: ResidentWorkloadFenceRequestSchema }).strict(),
  z.object({ id: requestId, op: z.literal("drain-workloads"), fence: ResidentWorkloadFenceRequestSchema }).strict(),
  z.object({ id: requestId, op: z.literal("resume-workloads"), fence: ResidentWorkloadFenceRequestSchema }).strict(),
  z.object({ id: requestId, op: z.literal("create"), launch: ResidentPtyCreateSchema }).strict(),
  z.object({ id: requestId, op: z.literal("snapshot"), sessionId, includeExit: z.literal(true).optional() }).strict(),
  z.object({ id: requestId, op: z.literal("write"), sessionId, input: ResidentPtyInputSchema }).strict(),
  z.object({ id: requestId, op: z.literal("cursor"), sessionId, producerId: z.uuid() }).strict(),
  z.object({ id: requestId, op: z.literal("resize"), sessionId, cols: dimension, rows: dimension }).strict(),
  z.object({ id: requestId, op: z.literal("close"), sessionId }).strict(),
]);
export type ResidentPtyRequest = z.infer<typeof ResidentPtyRequestSchema>;

export const ResidentPtyErrorSchema = z.enum([
  "authority_rejected", "request_rejected", "host_unavailable", "cwd_rejected",
  "session_limit", "session_not_found", "session_exited", "spawn_failed",
  "input_limit", "input_conflict", "input_sequence", "snapshot_unavailable",
]);
export type ResidentPtyErrorCode = z.infer<typeof ResidentPtyErrorSchema>;
export class ResidentPtyError extends Error {
  constructor(readonly code: ResidentPtyErrorCode) { super(code); }
}
export const ResidentPtyFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), id: requestId, result: z.unknown() }).strict(),
  z.object({ kind: z.literal("error"), id: requestId, code: ResidentPtyErrorSchema }).strict(),
  z.object({ kind: z.literal("data"), sessionId, sequence: z.number().int().positive(), data: z.string().max(64 * 1024) }).strict(),
  z.object({ kind: z.literal("exit"), sessionId, exitCode: z.number().int(), signal: z.number().int().nullable() }).strict(),
]);
export type ResidentPtyFrame = z.infer<typeof ResidentPtyFrameSchema>;
