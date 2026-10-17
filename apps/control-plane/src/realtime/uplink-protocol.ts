import { z } from "zod";

/** S2 `zeros-uplink` wire constants (contract 1.0.0, frozen). The CP
 * mirrors the contract here and never imports `@zeros/protocol`. */
export const UPLINK_PATH = "/v1/uplink";
export const UPLINK_SUBPROTOCOL = "zeros-uplink.v1";
/** Protocol majors this server speaks. During a rollout it keeps N and N-1. */
export const UPLINK_PROTOCOLS: readonly number[] = [1];
export const UPLINK_MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const UPLINK_MAX_RELAY_CHUNK_BYTES = 256 * 1024;
/** Relay data travels in binary frames: an 8-byte header, then one chunk
 * (contract "Binary relay frame"; relay payload is never base64 in `d`). */
export const UPLINK_RELAY_HEADER_BYTES = 8;
export const UPLINK_RELAY_VERSION = 0x01;
export const UPLINK_RELAY_KIND = { data: 0x01, dataFinal: 0x02 } as const;
/** The largest frame the socket accepts: one chunk plus its header. Text
 * frames are capped separately at `UPLINK_MAX_CONTROL_FRAME_BYTES`. */
export const UPLINK_MAX_BINARY_FRAME_BYTES = UPLINK_MAX_RELAY_CHUNK_BYTES + UPLINK_RELAY_HEADER_BYTES;
/** The ws hard ceiling sits 1 KiB above the exact caps so an oversized
 * frame reaches the parser and closes 4400 (the contract's size
 * violation) instead of dying at the socket with an unspecified 1009. */
export const UPLINK_MAX_SOCKET_PAYLOAD_BYTES = UPLINK_MAX_BINARY_FRAME_BYTES + 1024;

export type UplinkRelayChunk = Readonly<{
  /** Last chunk of the relayed client message. */
  final: boolean;
  /** The relayed message is binary on the client socket; otherwise text. */
  binary: boolean;
  /** Channel assigned by `relay.open`. */
  channel: number;
  payload: Buffer;
}>;

/** Parses one binary relay frame; null on any malformed byte. Unknown flag
 * bits are ignored so later minors can allocate them. */
export function parseUplinkRelayChunk(frame: Buffer): UplinkRelayChunk | null {
  if (frame.byteLength < UPLINK_RELAY_HEADER_BYTES || frame.byteLength > UPLINK_MAX_BINARY_FRAME_BYTES) return null;
  if (frame[0] !== UPLINK_RELAY_VERSION) return null;
  const kind = frame[1];
  if (kind !== UPLINK_RELAY_KIND.data && kind !== UPLINK_RELAY_KIND.dataFinal) return null;
  return Object.freeze({
    final: kind === UPLINK_RELAY_KIND.dataFinal,
    binary: (frame.readUInt16BE(2) & 1) === 1,
    channel: frame.readUInt32BE(4),
    payload: frame.subarray(UPLINK_RELAY_HEADER_BYTES),
  });
}
export const UPLINK_DEFAULT_PING_INTERVAL_MS = 20_000;
export const UPLINK_HELLO_TIMEOUT_MS = 10_000;
export const UPLINK_ACK_DELAY_MS = 250;
/** Liveness and readiness are durable only on transitions plus this watermark. */
export const UPLINK_WATERMARK_INTERVAL_MS = 5 * 60_000;

export const UPLINK_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  /** Verification could not complete (database slow or down); the engine
   * reconnects with backoff. Never 4401/4403 for this case. */
  internalError: 1011,
  frameInvalid: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  /** Proposed additive code: the organization's rollout flag is off. The
   * engine stops dialing and keeps the HTTP heartbeat (D9). */
  disabled: 4404,
  pingTimeout: 4408,
  superseded: 4409,
  protocolUnsupported: 4426,
  backpressure: 4429,
  draining: 4503,
} as const;

export const UPLINK_FEATURES = {
  /** Credential-control revision push (`cred.revision` / `cred.ack`). */
  credentialControls: "cred.v1",
  capabilities: "cap.v1",
  /** Client relay channels over the uplink. */
  relay: "relay.v1",
} as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The contract's machine code shape, shared by every frame that carries one. */
export const UplinkCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const code = UplinkCodeSchema;

export const UplinkEnvelopeSchema = z.object({
  t: z.string().regex(/^[a-z][a-z0-9]{0,31}\.[a-z][a-z0-9_]{0,47}$/),
  s: seq.min(1).optional(),
  a: seq.optional(),
  d: z.record(z.unknown()).optional(),
});
export type UplinkEnvelope = z.infer<typeof UplinkEnvelopeSchema>;

export const UplinkHelloSchema = z.object({
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  runtimeVersion: z.string().min(1).max(64),
  workspaceId: uuid,
  organizationId: uuid,
  generation: z.number().int().min(1).max(2_147_483_647),
  engineInstanceId: uuid,
  bootId: uuid,
  features: z.array(z.string().regex(/^[a-z][a-z0-9.]{1,47}$/)).max(64),
  lastJournalSeq: seq,
  resume: z.object({ token: z.string().min(16).max(512), lastReceivedSeq: seq }).optional(),
  authCursor: z.string().min(1).max(256).optional(),
});
export type UplinkHello = z.infer<typeof UplinkHelloSchema>;

export const UplinkPingSchema = z.object({ ts: timestampMs });
export const UplinkStatusReadySchema = z.object({
  ready: z.boolean(),
  phase: z.enum(["starting", "preparing", "ready", "degraded", "stopping"]),
  reason: code.optional(),
});
export const UplinkStatusReportSchema = z.object({
  engineVersion: z.string().max(64),
  health: z.enum(["ok", "degraded"]).optional(),
  observedPorts: z.array(z.object({ port: z.number().int().min(1).max(65_535), protocol: z.enum(["http", "tcp"]).optional() })).max(256).optional(),
});
export const UplinkActivityReportSchema = z.object({
  clients: z.number().int().min(0).max(10_000),
  runningTurns: z.number().int().min(0).max(10_000),
  liveTerminals: z.number().int().min(0).max(10_000),
  lastInputAtMs: timestampMs.optional(),
  windowMs: z.number().int().min(0).max(3_600_000),
});
export const UplinkCredentialKindSchema = z.enum(["agent-controls", "repository"]);
export const UplinkCredentialAckSchema = z.object({
  kind: UplinkCredentialKindSchema,
  revision: seq,
  result: z.enum(["applied", "failed"]),
  code: code.optional(),
});
export const UplinkAuthAppliedSchema = z.object({ syncId: uuid.optional(), authCursor: z.string().min(1).max(256) });
export type UplinkAuthApplied = z.infer<typeof UplinkAuthAppliedSchema>;

/** `auth.*` payloads the CP sends; produced by the capability authority. */
export type UplinkJwk = Readonly<{
  kty: "OKP"; crv: "Ed25519"; x: string; kid: string; use: "sig"; alg: "EdDSA";
  zeros_state?: "next" | "current" | "retiring";
}>;
export type UplinkEpochSet = Readonly<{
  wa?: number; wr?: number;
  members?: Readonly<Record<string, number>>;
  accounts?: Readonly<Record<string, number>>;
  devices?: Readonly<Record<string, number>>;
}>;
export type UplinkRevocation = Readonly<{ kind: "session" | "device"; id: string; until: number }>;
export type UplinkAuthSnapshot = Readonly<{
  epochs: UplinkEpochSet & { wa: number; wr: number };
  revocations: readonly UplinkRevocation[];
  authCursor: string;
  complete: boolean;
}>;
export type UplinkAuthDelta = Readonly<{
  epochs: UplinkEpochSet; revocations: readonly UplinkRevocation[]; authCursor: string;
}>;

export const UplinkErrorSchema = z.object({ code, message: z.string().max(512), fatal: z.boolean() });

export type UplinkStatusReady = z.infer<typeof UplinkStatusReadySchema>;
export type UplinkStatusReport = z.infer<typeof UplinkStatusReportSchema>;
export type UplinkActivityReport = z.infer<typeof UplinkActivityReportSchema>;
export type UplinkCredentialAck = z.infer<typeof UplinkCredentialAckSchema>;

/** Highest protocol major both sides speak, or null (close 4426). */
export function negotiateUplinkProtocol(range: { min: number; max: number }, supported = UPLINK_PROTOCOLS): number | null {
  if (range.min > range.max) return null;
  let chosen: number | null = null;
  for (const version of supported) if (version >= range.min && version <= range.max && (chosen === null || version > chosen)) chosen = version;
  return chosen;
}

/** Bearer heartbeat credential on the upgrade; checked once per connection. */
export function uplinkBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  return /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(header)?.[1] ?? null;
}
