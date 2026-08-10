// ──────────────────────────────────────────────────────────
// Runtime validation at the trust boundary
// ──────────────────────────────────────────────────────────
//
// Once the bridge is reachable over a relay, a remote client is
// UNTRUSTED input. Every frame the engine decrypts must be validated
// before it reaches the dispatcher. This module owns that gate.
//
// V1 validates the envelope (id/source/timestamp/type) and that the
// type is a known discriminator, preserving the payload via catchall.
// Per-field schemas for each message can be tightened incrementally
// without changing the call sites.
// ──────────────────────────────────────────────────────────

import { z } from "zod";
import type { BridgeMessage } from "./messages";
import { CODEX_CAPABILITY_OPERATIONS } from "./messages";

/** Every known wire `type` discriminator. Keep in sync with the
 *  BridgeMessage union (the union is the source of truth; this list
 *  is the runtime guard). */
export const KNOWN_MESSAGE_TYPES = [
  "CONNECTED",
  "CONNECTION_REJECTED",
  "OWNER_SIGNED_OUT",
  "HEARTBEAT",
  "ENGINE_READY",
  "DB_CHANGED",
  "GITHUB_TOKEN_SET",
  "GITHUB_TOKEN_CHANGED",
  "GITHUB_CREDENTIAL_CHANGED",
  "ENGINE_ERROR",
  "AGENT_LIST_AGENTS",
  "AGENT_NEW_SESSION",
  "AGENT_INIT_AGENT",
  "AGENT_AUTHENTICATE",
  "AGENT_PROMPT",
  "AGENT_CANCEL",
  "AGENT_STOP_BACKGROUND_TASK",
  "AGENT_STEER",
  "AGENT_STEERED",
  "AGENT_CLOSE_SESSION",
  "AGENT_PERMISSION_RESPONSE",
  "AGENT_QUESTION_RESPONSE",
  "AGENT_SET_MODE",
  "AGENT_SET_MODEL",
  "AGENT_COMPACT",
  "AGENT_UPDATE_CONFIG",
  "AGENT_LIST_SESSIONS",
  "AGENT_LOAD_SESSION",
  "AGENT_VALIDATE_KEY",
  "AGENT_GENERATE_TITLE",
  "AGENT_AGENTS_LIST",
  "AGENT_KEY_VALIDATED",
  "AGENT_TITLE_GENERATED",
  "AGENT_SESSION_CREATED",
  "AGENT_AGENT_INITIALIZED",
  "AGENT_AUTH_COMPLETED",
  "AGENT_SESSION_UPDATE",
  "AGENT_PERMISSION_REQUEST",
  "AGENT_PERMISSION_SETTLED",
  "AGENT_QUESTION_REQUEST",
  "AGENT_QUESTION_SETTLED",
  "AGENT_MODE_CHANGED",
  "AGENT_SESSIONS_LIST",
  "AGENT_SESSION_LOADED",
  "AGENT_PROMPT_COMPLETE",
  "AGENT_PROMPT_FAILED",
  "AGENT_AGENT_STDERR",
  "AGENT_AGENT_EXITED",
  "AGENT_ERROR",
  "WORKSPACE_REQUEST",
  "WORKSPACE_RESPONSE",
  "WORKSPACE_ERROR",
  "PTY_CREATE",
  "PTY_CREATED",
  "PTY_WRITE",
  "PTY_RESIZE",
  "PTY_KILL",
  "PTY_DATA",
  "PTY_EXIT",
  "PTY_LIST",
  "PTY_LIST_RESULT",
  "PTY_TERMINALS_CHANGED",
  "RESOLVE_AGENT_BINARY",
  "AGENT_BINARY_RESOLVED",
  "CODEX_JOB_START",
  "CODEX_JOB_GET",
  "CODEX_JOB_LIST",
  "CODEX_JOB_CANCEL",
  "CODEX_JOB_SNAPSHOT",
  "CODEX_JOBS_LIST",
  "CODEX_CAPABILITY_REQUEST",
  "CODEX_CAPABILITY_RESPONSE",
] as const;

const knownTypes = new Set<string>(KNOWN_MESSAGE_TYPES);

// Compile-time drift guard: every BridgeMessage `type` literal must appear in
// KNOWN_MESSAGE_TYPES and vice-versa. If a new union member is added (or a stale
// entry remains) without updating the list, these assignments fail to compile —
// catching the exact "Unknown bridge message type" / dropped-frame drift that
// the hand-maintained list otherwise risks (e.g. DB_CHANGED was missing).
type _MissingFromKnown = Exclude<
  BridgeMessage["type"],
  (typeof KNOWN_MESSAGE_TYPES)[number]
>;
type _ExtraInKnown = Exclude<
  (typeof KNOWN_MESSAGE_TYPES)[number],
  BridgeMessage["type"]
>;
const _assertNoMissing: _MissingFromKnown extends never
  ? true
  : [
      "BridgeMessage type missing from KNOWN_MESSAGE_TYPES:",
      _MissingFromKnown,
    ] = true;
const _assertNoExtra: _ExtraInKnown extends never
  ? true
  : [
      "KNOWN_MESSAGE_TYPES entry not in the BridgeMessage union:",
      _ExtraInKnown,
    ] = true;
void _assertNoMissing;
void _assertNoExtra;

/** Envelope shared by every bridge message. `catchall` preserves the
 *  per-type payload fields so a validated message round-trips intact. */
const BridgeEnvelope = z
  .object({
    id: z.string(),
    source: z.enum(["browser", "engine"]),
    timestamp: z.number(),
    type: z.string(),
  })
  .catchall(z.unknown());

const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isUint = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isBoundedStr = (v: unknown, max: number): v is string =>
  isNonEmptyStr(v) && v.length <= max;

function isBoundedJsonObject(value: unknown, maxChars: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return JSON.stringify(value).length <= maxChars;
  } catch {
    return false;
  }
}

/** Per-type field validation for the relay-REACHABLE WRITE paths. The envelope
 *  check only guarantees id/source/timestamp/type; the engine's dispatcher then
 *  reads payload fields directly (PTY_RESIZE.cols → coerceDim, AGENT_SET_MODE
 *  .modeId, WORKSPACE_REQUEST.op, PTY_WRITE.data, …). A type-confused payload
 *  from an untrusted relay client must be rejected HERE rather than relying on
 *  each handler being individually defensive. Engine→client, read-only, and
 *  pairing types stay permissive (the default case) so older/extra fields don't
 *  break — only the inbound write set is strict-validated. */
function assertInboundPayload(env: Record<string, unknown>): void {
  const bad = (field: string): never => {
    throw new Error(`Invalid ${String(env.type)} payload: ${field}`);
  };
  switch (env.type) {
    case "AGENT_PROMPT":
    case "AGENT_STEER":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (!Array.isArray(env.prompt)) bad("prompt");
      // Optional correlation id — metadata only. Reject non-strings so a remote
      // client cannot smuggle structured payload into the active-turn record.
      if (env.promptId !== undefined && !isStr(env.promptId)) bad("promptId");
      break;
    case "AGENT_CANCEL":
    case "AGENT_CLOSE_SESSION":
    case "AGENT_COMPACT":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      break;
    case "AGENT_LOAD_SESSION":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (
        env.nativeSessionId !== undefined &&
        !isBoundedStr(env.nativeSessionId, 200)
      )
        bad("nativeSessionId");
      break;
    case "AGENT_STOP_BACKGROUND_TASK":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (!isNonEmptyStr(env.taskId)) bad("taskId");
      break;
    case "AGENT_SET_MODE":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (!isStr(env.modeId)) bad("modeId");
      break;
    case "AGENT_UPDATE_CONFIG":
      // Relay-reachable, and `env` flows into the agent subprocess environment,
      // so validate its SHAPE here (the engine handler additionally scrubs
      // hazardous names + clamps dirs for remote clients). It must be a plain
      // string→string object — reject arrays / nested objects / non-string vals.
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (
        typeof env.env !== "object" ||
        env.env === null ||
        Array.isArray(env.env) ||
        !Object.values(env.env as Record<string, unknown>).every(
          (v) => typeof v === "string",
        )
      )
        bad("env");
      break;
    case "AGENT_PERMISSION_RESPONSE":
      if (!isNonEmptyStr(env.permissionId)) bad("permissionId");
      break;
    case "WORKSPACE_REQUEST":
      if (!isNonEmptyStr(env.op)) bad("op");
      if (
        env.params !== undefined &&
        (typeof env.params !== "object" || env.params === null)
      )
        bad("params");
      break;
    // (Removed) WORKSPACE_APPROVAL_RESPONSE — the host-approval broker is gone
    // from both the engine and the wire union; the type is unknown now, so
    // parseBridgeMessage rejects it at the envelope stage.
    case "PTY_CREATE":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (env.cols !== undefined && !isUint(env.cols)) bad("cols");
      if (env.rows !== undefined && !isUint(env.rows)) bad("rows");
      break;
    case "PTY_WRITE":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (!isStr(env.data)) bad("data");
      break;
    case "PTY_RESIZE":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (!isUint(env.cols)) bad("cols");
      if (!isUint(env.rows)) bad("rows");
      break;
    case "PTY_KILL":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      break;
    case "PTY_LIST":
      // workspaceId is optional; nothing else is required to enumerate.
      if (env.workspaceId !== undefined && !isStr(env.workspaceId))
        bad("workspaceId");
      break;
    case "RESOLVE_AGENT_BINARY":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      break;
    case "CODEX_JOB_START":
      if (!isBoundedStr(env.cwd, 4096)) bad("cwd");
      if (!isBoundedStr(env.prompt, 100_000)) bad("prompt");
      if (env.model !== undefined && !isBoundedStr(env.model, 200))
        bad("model");
      if (
        env.reasoningEffort !== undefined &&
        !["minimal", "low", "medium", "high", "xhigh"].includes(
          String(env.reasoningEffort),
        )
      )
        bad("reasoningEffort");
      if (
        env.sandboxMode !== undefined &&
        !["read-only", "workspace-write"].includes(String(env.sandboxMode))
      )
        bad("sandboxMode");
      if (
        env.networkAccessEnabled !== undefined &&
        typeof env.networkAccessEnabled !== "boolean"
      )
        bad("networkAccessEnabled");
      if (
        env.timeoutMs !== undefined &&
        (!Number.isSafeInteger(env.timeoutMs) ||
          Number(env.timeoutMs) < 1_000 ||
          Number(env.timeoutMs) > 30 * 60_000)
      )
        bad("timeoutMs");
      if (
        env.outputSchema !== undefined &&
        !isBoundedJsonObject(env.outputSchema, 128_000)
      )
        bad("outputSchema");
      break;
    case "CODEX_JOB_GET":
    case "CODEX_JOB_CANCEL":
      if (!isBoundedStr(env.jobId, 200)) bad("jobId");
      break;
    case "CODEX_JOB_LIST":
      break;
    case "CODEX_CAPABILITY_REQUEST":
      if (!CODEX_CAPABILITY_OPERATIONS.includes(env.operation as never))
        bad("operation");
      if (!isBoundedStr(env.cwd, 4096)) bad("cwd");
      if (env.sessionId !== undefined && !isBoundedStr(env.sessionId, 200))
        bad("sessionId");
      if (env.params !== undefined) {
        try {
          const encoded = JSON.stringify(env.params);
          if (encoded === undefined || encoded.length > 256_000) bad("params");
        } catch {
          bad("params");
        }
      }
      break;
    case "AGENT_VALIDATE_KEY":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.apiKey)) bad("apiKey");
      break;
    case "AGENT_GENERATE_TITLE":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.model)) bad("model");
      if (!isNonEmptyStr(env.systemPrompt)) bad("systemPrompt");
      if (!isNonEmptyStr(env.prompt)) bad("prompt");
      break;
  }
}

/** Validate + parse an inbound frame. Throws on a malformed envelope, an
 *  unknown message type, or a type-confused payload on a write-reaching type.
 *  Returns the message typed as BridgeMessage. */
export function parseBridgeMessage(raw: unknown): BridgeMessage {
  const env = BridgeEnvelope.parse(raw);
  if (!knownTypes.has(env.type)) {
    throw new Error(`Unknown bridge message type: ${env.type}`);
  }
  assertInboundPayload(env);
  return env as unknown as BridgeMessage;
}

/** Non-throwing variant. Returns null on any validation failure. */
export function safeParseBridgeMessage(raw: unknown): BridgeMessage | null {
  const r = BridgeEnvelope.safeParse(raw);
  if (!r.success || !knownTypes.has(r.data.type)) return null;
  try {
    assertInboundPayload(r.data);
  } catch {
    return null;
  }
  return r.data as unknown as BridgeMessage;
}
