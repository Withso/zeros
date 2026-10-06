import { z } from "zod";

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

const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ResidentPtyRequestSchema = z.discriminatedUnion("op", [
  z.object({ id: requestId, op: z.literal("attach"), protocol: z.literal(RESIDENT_PTY_PROTOCOL), authority: ResidentEngineAuthoritySchema }).strict(),
  z.object({ id: requestId, op: z.literal("list") }).strict(),
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
