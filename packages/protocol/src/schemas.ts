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
  "AGENT_OPEN_BOUNDARY_PORT",
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
  "AGENT_FORK_CONVERSATION",
  "AGENT_VALIDATE_KEY",
  "AGENT_GENERATE_TITLE",
  "AGENT_AGENTS_LIST",
  "AGENT_KEY_VALIDATED",
  "AGENT_TITLE_GENERATED",
  "AGENT_SESSION_CREATED",
  "AGENT_SESSION_CLOSED",
  "AGENT_AGENT_INITIALIZED",
  "AGENT_AUTH_COMPLETED",
  "AGENT_SESSION_UPDATE",
  "AGENT_BOUNDARY_STATUS_CHANGED",
  "AGENT_BOUNDARY_PORTS_CHANGED",
  "AGENT_BOUNDARY_PORT_OPENED",
  "AGENT_PERMISSION_REQUEST",
  "AGENT_PERMISSION_SETTLED",
  "AGENT_QUESTION_REQUEST",
  "AGENT_QUESTION_SETTLED",
  "AGENT_MODE_CHANGED",
  "AGENT_SESSIONS_LIST",
  "AGENT_SESSION_LOADED",
  "AGENT_CONVERSATION_FORKED",
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
const executionRoute = (env: Record<string, unknown>): unknown =>
  env.executionId ?? env.sessionId;

/** Hard wire limits for client-supplied process environment. These sit below
 * normal OS ARG_MAX ceilings while leaving ample room for PEMs and large MCP
 * configuration. They prevent a validly-authenticated peer from turning a
 * spawn request into an unbounded descriptor/allocation. */
export const MAX_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_ENV_ENTRIES = 512;
const MAX_AGENT_ENV_NAME_CODE_UNITS = 256;
const MAX_AGENT_ENV_VALUE_CODE_UNITS = 512 * 1024;
const MAX_AGENT_ENV_TOTAL_CODE_UNITS = 2 * 1024 * 1024;
const MAX_CONNECTED_AUTH_TOKEN_CODE_UNITS = 64 * 1024;
const MAX_CONNECTED_CAPABILITIES = 256;
const MAX_CONNECTED_CAPABILITY_CODE_UNITS = 256;
const MAX_GITHUB_TOKEN_CODE_UNITS = 64 * 1024;
const MAX_INTERACTION_ID_CODE_UNITS = 4 * 1024;
const MAX_QUESTION_ANSWERS = 256;
const MAX_SELECTED_OPTIONS_PER_ANSWER = 256;
const MAX_QUESTION_FREE_TEXT_CODE_UNITS = 1024 * 1024;
const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AGENT_ID_REQUIRED_CLIENT_TYPES = new Set([
  "AGENT_NEW_SESSION",
  "AGENT_OPEN_BOUNDARY_PORT",
  "AGENT_INIT_AGENT",
  "AGENT_AUTHENTICATE",
  "AGENT_VALIDATE_KEY",
  "AGENT_GENERATE_TITLE",
  "AGENT_PROMPT",
  "AGENT_CANCEL",
  "AGENT_STOP_BACKGROUND_TASK",
  "AGENT_STEER",
  "AGENT_CLOSE_SESSION",
  "AGENT_SET_MODE",
  "AGENT_SET_MODEL",
  "AGENT_COMPACT",
  "AGENT_UPDATE_CONFIG",
  "AGENT_LIST_SESSIONS",
  "AGENT_FORK_CONVERSATION",
  "AGENT_LOAD_SESSION",
]);

function isAgentEnv(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_AGENT_ENV_ENTRIES) return false;
  let total = 0;
  for (const [name, entry] of entries) {
    if (
      !PORTABLE_ENV_NAME.test(name) ||
      name.length > MAX_AGENT_ENV_NAME_CODE_UNITS ||
      typeof entry !== "string" ||
      entry.includes("\0") ||
      entry.length > MAX_AGENT_ENV_VALUE_CODE_UNITS
    ) {
      return false;
    }
    total += name.length + entry.length;
    if (total > MAX_AGENT_ENV_TOTAL_CODE_UNITS) return false;
  }
  return true;
}

function isOptionalAgentEnv(value: unknown): boolean {
  return value === undefined || isAgentEnv(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedInteractionId(value: unknown): value is string {
  return (
    isNonEmptyStr(value) &&
    value.length <= MAX_INTERACTION_ID_CODE_UNITS &&
    !value.includes("\0")
  );
}

function isPermissionResponse(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.outcome)) return false;
  if (value.outcome.outcome === "cancelled") return true;
  return (
    value.outcome.outcome === "selected" &&
    isBoundedInteractionId(value.outcome.optionId)
  );
}

function isQuestionResponse(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.outcome)) return false;
  const outcome = value.outcome;
  if (outcome.outcome === "declined" || outcome.outcome === "dismissed") {
    return true;
  }
  if (
    outcome.outcome !== "answered" ||
    !Array.isArray(outcome.answers) ||
    outcome.answers.length > MAX_QUESTION_ANSWERS
  ) {
    return false;
  }
  return outcome.answers.every((answer) => {
    if (
      !isPlainRecord(answer) ||
      !isBoundedInteractionId(answer.questionId) ||
      !Array.isArray(answer.selectedOptionIds) ||
      answer.selectedOptionIds.length > MAX_SELECTED_OPTIONS_PER_ANSWER ||
      !answer.selectedOptionIds.every(isBoundedInteractionId)
    ) {
      return false;
    }
    return (
      answer.freeText === undefined ||
      (isStr(answer.freeText) &&
        answer.freeText.length <= MAX_QUESTION_FREE_TEXT_CODE_UNITS &&
        !answer.freeText.includes("\0"))
    );
  });
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
  if (
    AGENT_ID_REQUIRED_CLIENT_TYPES.has(String(env.type)) &&
    !isNonEmptyStr(env.agentId)
  ) {
    bad("agentId");
  }
  // During the identity-model compatibility window clients send both names. They are two
  // spellings of one Zeros-owned route, never independent identities.
  if (
    String(env.type).startsWith("AGENT_") &&
    env.executionId !== undefined &&
    env.sessionId !== undefined &&
    env.executionId !== env.sessionId
  ) {
    bad("executionId/sessionId mismatch");
  }
  switch (env.type) {
    case "CONNECTED":
      if (
        !Array.isArray(env.capabilities) ||
        env.capabilities.length > MAX_CONNECTED_CAPABILITIES ||
        env.capabilities.some(
          (capability) =>
            !isNonEmptyStr(capability) ||
            capability.length > MAX_CONNECTED_CAPABILITY_CODE_UNITS ||
            capability.includes("\0"),
        )
      )
        bad("capabilities");
      if (
        env.protocolVersion !== undefined &&
        (!Number.isSafeInteger(env.protocolVersion) ||
          Number(env.protocolVersion) < 0)
      )
        bad("protocolVersion");
      if (
        env.authToken !== undefined &&
        (!isStr(env.authToken) ||
          env.authToken.length > MAX_CONNECTED_AUTH_TOKEN_CODE_UNITS ||
          /[\0\r\n]/.test(env.authToken))
      )
        bad("authToken");
      break;
    case "GITHUB_TOKEN_SET":
      if (
        env.token !== null &&
        (!isStr(env.token) ||
          env.token.length > MAX_GITHUB_TOKEN_CODE_UNITS ||
          /[\0\r\n]/.test(env.token))
      )
        bad("token");
      break;
    case "AGENT_LIST_AGENTS":
      if (env.force !== undefined && typeof env.force !== "boolean")
        bad("force");
      break;
    case "AGENT_NEW_SESSION":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.cwd) && !isNonEmptyStr(env.workspaceId))
        bad("cwd/workspaceId");
      if (env.chatId !== undefined && !isNonEmptyStr(env.chatId)) bad("chatId");
      if (env.cwd !== undefined && !isNonEmptyStr(env.cwd)) bad("cwd");
      if (env.workspaceId !== undefined && !isNonEmptyStr(env.workspaceId))
        bad("workspaceId");
      if (!isOptionalAgentEnv(env.env)) bad("env");
      if (env.cliBinary !== undefined && !isNonEmptyStr(env.cliBinary))
        bad("cliBinary");
      break;
    case "AGENT_PROMPT":
    case "AGENT_STEER":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!Array.isArray(env.prompt)) bad("prompt");
      // Optional correlation id — metadata only. Reject non-strings so a remote
      // client cannot smuggle structured payload into the active-turn record.
      if (env.promptId !== undefined && !isStr(env.promptId)) bad("promptId");
      break;
    case "AGENT_OPEN_BOUNDARY_PORT":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isNonEmptyStr(env.portId) || !/^[A-Za-z0-9_-]{32}$/.test(env.portId))
        bad("portId");
      break;
    case "AGENT_INIT_AGENT":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      break;
    case "AGENT_AUTHENTICATE":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.methodId)) bad("methodId");
      break;
    case "AGENT_CANCEL":
    case "AGENT_COMPACT":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      break;
    case "AGENT_CLOSE_SESSION":
      if (!isNonEmptyStr(executionRoute(env)) && !isNonEmptyStr(env.chatId))
        bad("executionId/chatId");
      if (env.chatId !== undefined && !isNonEmptyStr(env.chatId)) bad("chatId");
      break;
    case "AGENT_LOAD_SESSION":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (
        !isNonEmptyStr(executionRoute(env)) &&
        !isNonEmptyStr(env.chatId) &&
        (typeof env.providerBinding !== "object" ||
          env.providerBinding === null)
      )
        bad("executionId/chatId/providerBinding");
      if (env.chatId !== undefined && !isNonEmptyStr(env.chatId)) bad("chatId");
      if (env.cwd !== undefined && !isNonEmptyStr(env.cwd)) bad("cwd");
      if (env.workspaceId !== undefined && !isNonEmptyStr(env.workspaceId))
        bad("workspaceId");
      if (!isOptionalAgentEnv(env.env)) bad("env");
      if (env.cliBinary !== undefined && !isNonEmptyStr(env.cliBinary))
        bad("cliBinary");
      break;
    case "AGENT_FORK_CONVERSATION":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.sourceChatId)) bad("sourceChatId");
      if (
        !isNonEmptyStr(env.destinationChatId) ||
        env.destinationChatId === env.sourceChatId
      )
        bad("destinationChatId");
      if (env.workspaceId !== undefined && !isNonEmptyStr(env.workspaceId))
        bad("workspaceId");
      if (
        env.providerBinding !== undefined ||
        env.sessionId !== undefined ||
        env.executionId !== undefined ||
        env.lastTurnId !== undefined ||
        env.cwd !== undefined
      )
        bad("providerBinding/sessionId/executionId/lastTurnId/cwd");
      if (env.cliBinary !== undefined && !isNonEmptyStr(env.cliBinary))
        bad("cliBinary");
      if (!isOptionalAgentEnv(env.env)) bad("env");
      break;
    case "AGENT_STOP_BACKGROUND_TASK":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isNonEmptyStr(env.taskId)) bad("taskId");
      break;
    case "AGENT_SET_MODE":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isStr(env.modeId)) bad("modeId");
      break;
    case "AGENT_SET_MODEL":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isNonEmptyStr(env.model)) bad("model");
      break;
    case "AGENT_UPDATE_CONFIG":
      // Relay-reachable, and `env` flows into the agent subprocess environment,
      // so validate its SHAPE here (the engine handler additionally scrubs
      // hazardous names + clamps dirs for remote clients). It must be a plain
      // string→string object — reject arrays / nested objects / non-string vals.
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isAgentEnv(env.env)) bad("env");
      break;
    case "AGENT_PERMISSION_RESPONSE":
      if (!isBoundedInteractionId(env.permissionId)) bad("permissionId");
      if (!isPermissionResponse(env.response)) bad("response");
      break;
    case "AGENT_QUESTION_RESPONSE":
      if (!isBoundedInteractionId(env.questionId)) bad("questionId");
      if (
        env.nativeRequestId !== undefined &&
        !isBoundedInteractionId(env.nativeRequestId)
      )
        bad("nativeRequestId");
      if (!isQuestionResponse(env.response)) bad("response");
      break;
    case "AGENT_LIST_SESSIONS":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (env.cwd !== undefined && !isStr(env.cwd)) bad("cwd");
      if (env.cursor !== undefined && env.cursor !== null && !isStr(env.cursor))
        bad("cursor");
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
    case "AGENT_VALIDATE_KEY":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.apiKey)) bad("apiKey");
      break;
    case "AGENT_GENERATE_TITLE":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.model)) bad("model");
      if (!isNonEmptyStr(env.systemPrompt)) bad("systemPrompt");
      if (!isNonEmptyStr(env.prompt)) bad("prompt");
      if (!isOptionalAgentEnv(env.env)) bad("env");
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

/** Parse a frame received from a renderer/device. A peer may never self-label a
 * frame as engine-originated; retaining that direction bit at ingress avoids a
 * future handler accidentally trusting an engine-only response as a request. */
export function safeParseClientBridgeMessage(
  raw: unknown,
): BridgeMessage | null {
  const parsed = safeParseBridgeMessage(raw);
  return parsed?.source === "browser" ? parsed : null;
}
