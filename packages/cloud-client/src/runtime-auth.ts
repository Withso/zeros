// Runtime-connection auth handshake (S3 Part 3). Handshake frames are
// pre-protocol: they are told apart from engine messages by a top-level `t`
// member and no `type` member. Unknown handshake frames after `auth.ok`
// close with 4400 on the server side; the client parser reports them as
// unknown so the caller can decide.

import type {
  RuntimeAuthFrame,
  RuntimeAuthFrameType,
} from "./generated/runtime-auth";

export type RuntimeAuthParseResult =
  | { kind: "known"; frame: RuntimeAuthFrame }
  | { kind: "unknown"; t: string }
  | { kind: "invalid" };

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "auth",
  "auth.renew",
  "auth.ok",
  "auth.renewed",
] satisfies RuntimeAuthFrameType[]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A parsed text message is a handshake frame when it has a top-level `t`
 * and no `type` member. Engine protocol messages always carry `type` and
 * never a top-level `t` (BaseMessage, packages/protocol/src/messages.ts).
 */
export function isRuntimeHandshakeFrame(value: unknown): boolean {
  return isRecord(value) && typeof value.t === "string" && value.type === undefined;
}

export function parseRuntimeAuthFrame(text: string): RuntimeAuthParseResult {
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
  return { kind: "known", frame: parsed as unknown as RuntimeAuthFrame };
}
