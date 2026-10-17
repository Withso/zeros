import { z } from "zod";

/** S3 device stream wire constants (contract 1.1.0, Part 2). The CP mirrors
 * the frozen JSON schema here and never imports `@zeros/protocol`. */
export const DEVICE_STREAM_PATH = "/v1/device-stream";
export const DEVICE_STREAM_CONTRACT = 1;
export const DEVICE_STREAM_HELLO_TIMEOUT_MS = 10_000;
export const DEVICE_STREAM_HEARTBEAT_INTERVAL_MS = 20_000;
/** S3: resumable events are kept 10 min per device session. */
export const DEVICE_STREAM_RESUME_RETENTION_MS = 10 * 60_000;
/** A hello may carry up to 1000 known workspace versions. */
export const DEVICE_STREAM_MAX_HELLO_BYTES = 96 * 1024;
export const DEVICE_STREAM_MAX_FRAME_BYTES = 4 * 1024;
/** The ws ceiling sits above the hello cap so an oversized frame reaches the
 * parser and closes 4400 instead of an unspecified 1009. */
export const DEVICE_STREAM_MAX_SOCKET_PAYLOAD_BYTES = DEVICE_STREAM_MAX_HELLO_BYTES + 1024;

export const DEVICE_STREAM_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  internalError: 1011,
  frameInvalid: 4400,
  /** Missing, expired, reused or no-longer-authorized ticket or session. */
  unauthenticated: 4401,
  /** The rollout flag is off; POST /v1/device-sessions then answers 404. */
  disabled: 4404,
  pingTimeout: 4408,
  superseded: 4409,
  contractUnsupported: 4426,
  /** Rate or buffer limit; the client resumes with backoff. */
  backpressure: 4429,
  draining: 4503,
} as const;

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Cursor = z.string().min(1).max(256);

export const DeviceStreamEnvelopeSchema = z.object({
  t: z.string().min(1).max(64),
  d: z.record(z.unknown()),
  c: Cursor.optional(),
}).passthrough();

export const DeviceStreamHelloSchema = z.object({
  contract: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).passthrough(),
  ticket: z.string().min(32).max(512),
  resume: z.object({
    cursor: Cursor,
    catalogVersion: Version,
    workspaces: z.record(Uuid, Version).optional().refine(value => !value || Object.keys(value).length <= 1_000),
  }).passthrough().optional(),
}).passthrough();
export type DeviceStreamHello = z.infer<typeof DeviceStreamHelloSchema>;

export const DeviceStreamAttachSchema = z.object({ workspaceId: Uuid, clientSessionId: Uuid }).passthrough();
export const DeviceStreamPresenceSetSchema = z.object({
  workspaceId: Uuid, state: z.enum(["active", "idle", "away"]),
}).passthrough();
export const DeviceStreamAckSchema = z.object({ cursor: Cursor }).passthrough();
export const DeviceStreamPingSchema = z.object({ ts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).passthrough();

export type PresenceState = z.infer<typeof DeviceStreamPresenceSetSchema>["state"];

export type CapabilityGrant = { token: string; expiresAt: string };
export type DeviceCapabilities = { engine: CapabilityGrant; realtime: CapabilityGrant };
export type CapabilityRevokedScope = "workspace" | "account" | "session" | "device" | "organization";
export type CatalogResetReason = "resume_expired" | "instance_changed" | "contract_changed" | "server_reset";

/** Server event types whose frames carry a cursor and are replayed on resume. */
export const RESUMABLE_TYPES: ReadonlySet<string> = new Set([
  "catalog.changed", "lifecycle.changed", "notification", "capability.revoked",
]);

/** The contract major both sides speak, or null (close 4426). */
export function negotiateDeviceStreamContract(range: { min: number; max: number }): number | null {
  return range.min <= DEVICE_STREAM_CONTRACT && range.max >= DEVICE_STREAM_CONTRACT ? DEVICE_STREAM_CONTRACT : null;
}

/** Cursors are opaque to clients: `<lineage>.<sequence>`. The lineage is a
 * random per-device-session token minted by one realtime instance, so a
 * cursor from another instance or an earlier lineage never resumes. */
export function encodeDeviceStreamCursor(lineage: string, sequence: number): string {
  return `${lineage}.${sequence}`;
}

export function decodeDeviceStreamCursor(cursor: string): { lineage: string; sequence: number } | null {
  const match = /^([A-Za-z0-9_-]{16,64})\.(0|[1-9][0-9]{0,15})$/.exec(cursor);
  if (!match) return null;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) ? { lineage: match[1]!, sequence } : null;
}
