// Device-stream (S3 Part 2) frame parsing. Per the versioning rule, clients
// ignore unknown event types and unknown fields, so parsing is deliberately
// shallow: a known `t` with an object `d` is accepted as-is and extra
// members pass through untouched. Schema-exact validation happens in the
// contract round-trip tests, not on the hot path.

import type {
  DeviceStreamFrame,
  DeviceStreamFrameType,
} from "./generated/device-stream";

export type DeviceStreamParseResult =
  | { kind: "known"; frame: DeviceStreamFrame }
  | { kind: "unknown"; t: string }
  | { kind: "invalid" };

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "hello",
  "attach",
  "detach",
  "presence.set",
  "ack",
  "ping",
  "ready",
  "catalog.changed",
  "catalog.reset",
  "lifecycle.changed",
  "presence.changed",
  "notification",
  "capability.renewed",
  "capability.revoked",
  "heartbeat",
  "pong",
  "drain",
  "error",
] satisfies DeviceStreamFrameType[]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Narrow the frame to the known S3 envelope without dropping fields. */
export function parseDeviceStreamFrame(text: string): DeviceStreamParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(parsed)) return { kind: "invalid" };
  const t = parsed.t;
  if (typeof t !== "string" || !isRecord(parsed.d)) return { kind: "invalid" };
  if (!KNOWN_TYPES.has(t)) return { kind: "unknown", t };
  return { kind: "known", frame: parsed as unknown as DeviceStreamFrame };
}
