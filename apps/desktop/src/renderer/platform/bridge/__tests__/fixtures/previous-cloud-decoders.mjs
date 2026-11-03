// Generated from Withso/zeros b3f7105390ff9339f55a245646a2bcff51e0f49d (MIT). Do not edit.
// See previous-cloud-decoders.provenance.json for source hashes.
/* eslint-disable no-undef, @typescript-eslint/no-unused-vars, no-control-regex -- Preserve the frozen legacy decoder code. */
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// previous:packages/protocol/src/schemas.ts
import { z } from "zod";
function isAgentEnv(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_AGENT_ENV_ENTRIES) return false;
  let total = 0;
  for (const [name, entry] of entries) {
    if (!PORTABLE_ENV_NAME.test(name) || name.length > MAX_AGENT_ENV_NAME_CODE_UNITS || typeof entry !== "string" || entry.includes("\0") || entry.length > MAX_AGENT_ENV_VALUE_CODE_UNITS) {
      return false;
    }
    total += name.length + entry.length;
    if (total > MAX_AGENT_ENV_TOTAL_CODE_UNITS) return false;
  }
  return true;
}
function isOptionalAgentEnv(value) {
  return value === void 0 || isAgentEnv(value);
}
function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMemorySettingsUpdate(value) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.some(
    (key) => key !== "localMemoriesEnabled" && key !== "toolAssistedGenerationEnabled"
  )) {
    return false;
  }
  return keys.every((key) => typeof value[key] === "boolean");
}
function isGoalUpdate(value) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.some(
    (key) => key !== "objective" && key !== "status" && key !== "tokenBudget"
  )) {
    return false;
  }
  if (value.objective !== void 0 && (!isStr(value.objective) || value.objective.trim().length === 0 || value.objective.length > 4e3 || value.objective.includes("\0"))) {
    return false;
  }
  if (value.status !== void 0 && (!isStr(value.status) || !AGENT_GOAL_STATUSES.has(value.status))) {
    return false;
  }
  return value.tokenBudget === void 0 || value.tokenBudget === null || Number.isSafeInteger(value.tokenBudget) && Number(value.tokenBudget) > 0;
}
function isBoundedInteractionId(value) {
  return isNonEmptyStr(value) && value.length <= MAX_INTERACTION_ID_CODE_UNITS && !value.includes("\0");
}
function isPermissionResponse(value) {
  if (!isPlainRecord(value) || !isPlainRecord(value.outcome)) return false;
  if (value.outcome.outcome === "cancelled") return true;
  return value.outcome.outcome === "selected" && isBoundedInteractionId(value.outcome.optionId);
}
function isQuestionResponse(value) {
  if (!isPlainRecord(value) || !isPlainRecord(value.outcome)) return false;
  const outcome = value.outcome;
  if (outcome.outcome === "declined" || outcome.outcome === "dismissed") {
    return true;
  }
  if (outcome.outcome !== "answered" || !Array.isArray(outcome.answers) || outcome.answers.length > MAX_QUESTION_ANSWERS) {
    return false;
  }
  return outcome.answers.every((answer) => {
    if (!isPlainRecord(answer) || !isBoundedInteractionId(answer.questionId) || !Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.length > MAX_SELECTED_OPTIONS_PER_ANSWER || !answer.selectedOptionIds.every(isBoundedInteractionId)) {
      return false;
    }
    return answer.freeText === void 0 || isStr(answer.freeText) && answer.freeText.length <= MAX_QUESTION_FREE_TEXT_CODE_UNITS && !answer.freeText.includes("\0");
  });
}
function assertInboundPayload(env) {
  const bad = (field) => {
    throw new Error(`Invalid ${String(env.type)} payload: ${field}`);
  };
  if (AGENT_ID_REQUIRED_CLIENT_TYPES.has(String(env.type)) && !isNonEmptyStr(env.agentId)) {
    bad("agentId");
  }
  if (String(env.type).startsWith("AGENT_") && env.executionId !== void 0 && env.sessionId !== void 0 && env.executionId !== env.sessionId) {
    bad("executionId/sessionId mismatch");
  }
  switch (env.type) {
    case "CONNECTED":
      if (!Array.isArray(env.capabilities) || env.capabilities.length > MAX_CONNECTED_CAPABILITIES || env.capabilities.some(
        (capability) => !isNonEmptyStr(capability) || capability.length > MAX_CONNECTED_CAPABILITY_CODE_UNITS || capability.includes("\0")
      ))
        bad("capabilities");
      if (env.protocolVersion !== void 0 && (!Number.isSafeInteger(env.protocolVersion) || Number(env.protocolVersion) < 0))
        bad("protocolVersion");
      if (env.authToken !== void 0 && (!isStr(env.authToken) || env.authToken.length > MAX_CONNECTED_AUTH_TOKEN_CODE_UNITS || /[\0\r\n]/.test(env.authToken)))
        bad("authToken");
      break;
    case "GITHUB_TOKEN_SET":
      if (env.token !== null && (!isStr(env.token) || env.token.length > MAX_GITHUB_TOKEN_CODE_UNITS || /[\0\r\n]/.test(env.token)))
        bad("token");
      break;
    case "AGENT_LIST_AGENTS":
      if (env.force !== void 0 && typeof env.force !== "boolean")
        bad("force");
      break;
    case "AGENT_NEW_SESSION":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (env.agentRole !== void 0 && env.agentRole !== "code" && env.agentRole !== "design")
        bad("agentRole");
      if (env.agentRole === "design") {
        if (!isNonEmptyStr(env.workspaceId)) bad("workspaceId");
        if (!isNonEmptyStr(env.designDocumentId) || env.designDocumentId.length > 256)
          bad("designDocumentId");
      } else if (env.designDocumentId !== void 0) {
        bad("designDocumentId");
      }
      if (!isNonEmptyStr(env.cwd) && !isNonEmptyStr(env.workspaceId))
        bad("cwd/workspaceId");
      if (env.chatId !== void 0 && !isNonEmptyStr(env.chatId)) bad("chatId");
      if (env.cwd !== void 0 && !isNonEmptyStr(env.cwd)) bad("cwd");
      if (env.workspaceId !== void 0 && !isNonEmptyStr(env.workspaceId))
        bad("workspaceId");
      if (!isOptionalAgentEnv(env.env)) bad("env");
      if (env.cliBinary !== void 0 && !isNonEmptyStr(env.cliBinary))
        bad("cliBinary");
      break;
    case "AGENT_PROMPT":
    case "AGENT_STEER":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!Array.isArray(env.prompt)) bad("prompt");
      if (env.type === "AGENT_PROMPT" && env.startedAt !== void 0 && (!isUint(env.startedAt) || !Number.isSafeInteger(env.startedAt)))
        bad("startedAt");
      if (env.promptId !== void 0 && !isStr(env.promptId)) bad("promptId");
      break;
    case "AGENT_OPEN_BOUNDARY_PORT":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isNonEmptyStr(env.portId) || !/^[A-Za-z0-9_-]{32}$/.test(env.portId))
        bad("portId");
      break;
    case "AGENT_INIT_AGENT":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (env.chatId !== void 0 && (!isNonEmptyStr(env.chatId) || env.chatId.length > 512)) bad("chatId");
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
      if (env.chatId !== void 0 && !isNonEmptyStr(env.chatId)) bad("chatId");
      if (env.userStop !== void 0 && env.userStop !== true) bad("userStop");
      break;
    case "AGENT_LOAD_SESSION":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(executionRoute(env)) && !isNonEmptyStr(env.chatId) && (typeof env.providerBinding !== "object" || env.providerBinding === null))
        bad("executionId/chatId/providerBinding");
      if (env.chatId !== void 0 && !isNonEmptyStr(env.chatId)) bad("chatId");
      if (env.cwd !== void 0 && !isNonEmptyStr(env.cwd)) bad("cwd");
      if (env.workspaceId !== void 0 && !isNonEmptyStr(env.workspaceId))
        bad("workspaceId");
      if (!isOptionalAgentEnv(env.env)) bad("env");
      if (env.cliBinary !== void 0 && !isNonEmptyStr(env.cliBinary))
        bad("cliBinary");
      break;
    case "AGENT_FORK_CONVERSATION":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (!isNonEmptyStr(env.sourceChatId)) bad("sourceChatId");
      if (!isNonEmptyStr(env.destinationChatId) || env.destinationChatId === env.sourceChatId)
        bad("destinationChatId");
      if (env.workspaceId !== void 0 && !isNonEmptyStr(env.workspaceId))
        bad("workspaceId");
      if (env.providerBinding !== void 0 || env.sessionId !== void 0 || env.executionId !== void 0 || env.lastTurnId !== void 0 || env.cwd !== void 0)
        bad("providerBinding/sessionId/executionId/lastTurnId/cwd");
      if (env.cliBinary !== void 0 && !isNonEmptyStr(env.cliBinary))
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
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isAgentEnv(env.env)) bad("env");
      break;
    case "AGENT_MEMORY_SETTINGS_READ":
    case "AGENT_MEMORY_RESET":
    case "AGENT_PROVIDER_QUOTA_READ":
      break;
    case "AGENT_CONFIGURATION_PROVENANCE_READ":
      if (env.cwd !== void 0 && !isNonEmptyStr(env.cwd)) bad("cwd");
      break;
    case "AGENT_MEMORY_SETTINGS_UPDATE":
      if (!isMemorySettingsUpdate(env.settings)) bad("settings");
      break;
    case "AGENT_GOAL_SET":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isGoalUpdate(env.update)) bad("update");
      if (env.origin !== void 0 && env.origin !== "user") bad("origin");
      break;
    case "AGENT_GOAL_CLEAR":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (env.origin !== void 0 && env.origin !== "user") bad("origin");
      break;
    case "AGENT_RETRY_SAFETY_REVIEW":
      if (!isNonEmptyStr(executionRoute(env))) bad("executionId");
      if (!isBoundedInteractionId(env.retryId)) bad("retryId");
      break;
    case "AGENT_PERMISSION_RESPONSE":
      if (!isBoundedInteractionId(env.permissionId)) bad("permissionId");
      if (!isPermissionResponse(env.response)) bad("response");
      break;
    case "AGENT_QUESTION_RESPONSE":
      if (!isBoundedInteractionId(env.questionId)) bad("questionId");
      if (env.nativeRequestId !== void 0 && !isBoundedInteractionId(env.nativeRequestId))
        bad("nativeRequestId");
      if (!isQuestionResponse(env.response)) bad("response");
      break;
    case "AGENT_LIST_SESSIONS":
      if (!isNonEmptyStr(env.agentId)) bad("agentId");
      if (env.cwd !== void 0 && !isStr(env.cwd)) bad("cwd");
      if (env.cursor !== void 0 && env.cursor !== null && !isStr(env.cursor))
        bad("cursor");
      break;
    case "WORKSPACE_REQUEST":
      if (!isNonEmptyStr(env.op)) bad("op");
      if (env.params !== void 0 && (typeof env.params !== "object" || env.params === null))
        bad("params");
      break;
    // (Removed) WORKSPACE_APPROVAL_RESPONSE — the host-approval broker is gone
    // from both the engine and the wire union; the type is unknown now, so
    // parseBridgeMessage rejects it at the envelope stage.
    case "PTY_CREATE":
      if (!isNonEmptyStr(env.sessionId)) bad("sessionId");
      if (env.cols !== void 0 && !isUint(env.cols)) bad("cols");
      if (env.rows !== void 0 && !isUint(env.rows)) bad("rows");
      if (env.loginProvider !== void 0 && (env.ephemeral !== true || !["claude", "codex"].includes(env.loginProvider))) bad("loginProvider");
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
      if (env.workspaceId !== void 0 && !isStr(env.workspaceId))
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
function safeParseBridgeMessage(raw) {
  const r = BridgeEnvelope.safeParse(raw);
  if (!r.success || !knownTypes.has(r.data.type)) return null;
  try {
    assertInboundPayload(r.data);
  } catch {
    return null;
  }
  return r.data;
}
var KNOWN_MESSAGE_TYPES, knownTypes, BridgeEnvelope, isStr, isNonEmptyStr, isUint, executionRoute, MAX_BRIDGE_FRAME_BYTES, MAX_AGENT_ENV_ENTRIES, MAX_AGENT_ENV_NAME_CODE_UNITS, MAX_AGENT_ENV_VALUE_CODE_UNITS, MAX_AGENT_ENV_TOTAL_CODE_UNITS, MAX_CONNECTED_AUTH_TOKEN_CODE_UNITS, MAX_CONNECTED_CAPABILITIES, MAX_CONNECTED_CAPABILITY_CODE_UNITS, MAX_GITHUB_TOKEN_CODE_UNITS, MAX_INTERACTION_ID_CODE_UNITS, MAX_QUESTION_ANSWERS, MAX_SELECTED_OPTIONS_PER_ANSWER, MAX_QUESTION_FREE_TEXT_CODE_UNITS, PORTABLE_ENV_NAME, AGENT_ID_REQUIRED_CLIENT_TYPES, AGENT_GOAL_STATUSES;
var init_schemas = __esm({
  "previous:packages/protocol/src/schemas.ts"() {
    KNOWN_MESSAGE_TYPES = [
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
      "AGENT_MEMORY_SETTINGS_READ",
      "AGENT_MEMORY_SETTINGS_UPDATE",
      "AGENT_MEMORY_RESET",
      "AGENT_CONFIGURATION_PROVENANCE_READ",
      "AGENT_PROVIDER_QUOTA_READ",
      "AGENT_GOAL_SET",
      "AGENT_GOAL_CLEAR",
      "AGENT_RETRY_SAFETY_REVIEW",
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
      "AGENT_MEMORY_SETTINGS",
      "AGENT_MEMORY_RESET_COMPLETE",
      "AGENT_CONFIGURATION_PROVENANCE",
      "AGENT_PROVIDER_QUOTA",
      "AGENT_PROVIDER_QUOTA_UPDATED",
      "DESIGN_AGENT_DRAFT",
      "AGENT_GOAL_CHANGED",
      "AGENT_SAFETY_REVIEW_RETRIED",
      "AGENT_SESSIONS_LIST",
      "AGENT_SESSION_LOADED",
      "AGENT_CONVERSATION_FORKED",
      "AGENT_PROMPT_COMPLETE",
      "AGENT_PROMPT_FAILED",
      "AGENT_AGENT_STDERR",
      "AGENT_CAPABILITY_NOTICE",
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
      "AGENT_BINARY_RESOLVED"
    ];
    knownTypes = new Set(KNOWN_MESSAGE_TYPES);
    BridgeEnvelope = z.object({
      id: z.string(),
      source: z.enum(["browser", "engine"]),
      timestamp: z.number(),
      type: z.string()
    }).catchall(z.unknown());
    isStr = (v) => typeof v === "string";
    isNonEmptyStr = (v) => typeof v === "string" && v.length > 0;
    isUint = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
    executionRoute = (env) => env.executionId ?? env.sessionId;
    MAX_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;
    MAX_AGENT_ENV_ENTRIES = 512;
    MAX_AGENT_ENV_NAME_CODE_UNITS = 256;
    MAX_AGENT_ENV_VALUE_CODE_UNITS = 512 * 1024;
    MAX_AGENT_ENV_TOTAL_CODE_UNITS = 2 * 1024 * 1024;
    MAX_CONNECTED_AUTH_TOKEN_CODE_UNITS = 64 * 1024;
    MAX_CONNECTED_CAPABILITIES = 256;
    MAX_CONNECTED_CAPABILITY_CODE_UNITS = 256;
    MAX_GITHUB_TOKEN_CODE_UNITS = 64 * 1024;
    MAX_INTERACTION_ID_CODE_UNITS = 4 * 1024;
    MAX_QUESTION_ANSWERS = 256;
    MAX_SELECTED_OPTIONS_PER_ANSWER = 256;
    MAX_QUESTION_FREE_TEXT_CODE_UNITS = 1024 * 1024;
    PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
    AGENT_ID_REQUIRED_CLIENT_TYPES = /* @__PURE__ */ new Set([
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
      "AGENT_MEMORY_SETTINGS_READ",
      "AGENT_MEMORY_SETTINGS_UPDATE",
      "AGENT_MEMORY_RESET",
      "AGENT_CONFIGURATION_PROVENANCE_READ",
      "AGENT_PROVIDER_QUOTA_READ",
      "AGENT_GOAL_SET",
      "AGENT_GOAL_CLEAR",
      "AGENT_RETRY_SAFETY_REVIEW",
      "AGENT_LIST_SESSIONS",
      "AGENT_FORK_CONVERSATION",
      "AGENT_LOAD_SESSION"
    ]);
    AGENT_GOAL_STATUSES = /* @__PURE__ */ new Set([
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete"
    ]);
  }
});

// previous:apps/desktop/src/renderer/platform/bridge/runtime-client.ts
function parseInboundBridgeWebSocketFrame(raw) {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_BRIDGE_FRAME_BYTES) {
    return null;
  }
  try {
    const message = safeParseBridgeMessage(JSON.parse(raw));
    return message?.source === "engine" ? message : null;
  } catch {
    return null;
  }
}
var CLOUD_CONTROL_REQUESTS, DIAGNOSTIC_REQUEST_TYPES;
var init_runtime_client = __esm({
  "previous:apps/desktop/src/renderer/platform/bridge/runtime-client.ts"() {
    init_schemas();
    CLOUD_CONTROL_REQUESTS = /* @__PURE__ */ new Set([
      "AGENT_CANCEL",
      "AGENT_STOP_BACKGROUND_TASK",
      "AGENT_STEER",
      "AGENT_CLOSE_SESSION",
      "AGENT_PERMISSION_RESPONSE",
      "AGENT_QUESTION_RESPONSE"
    ]);
    DIAGNOSTIC_REQUEST_TYPES = /* @__PURE__ */ new Set([
      "WORKSPACE_REQUEST",
      "PTY_LIST",
      "PTY_CREATE",
      "PTY_WRITE",
      "PTY_KILL",
      "AGENT_LIST_AGENTS",
      "AGENT_INIT_AGENT",
      "AGENT_NEW_SESSION",
      "AGENT_LOAD_SESSION",
      "AGENT_PROMPT",
      ...CLOUD_CONTROL_REQUESTS
    ]);
  }
});

// previous:apps/desktop/src/renderer/platform/bridge/cloud-workspace-key.ts
function cloudWorkspaceKey(target) {
  const key = `cloud://${target.organizationId}/${target.workspaceId}`;
  if (!UUID_IDENTITY.test(target.organizationId) || !UUID_IDENTITY.test(target.workspaceId))
    throw new Error("Invalid cloud workspace identity");
  return key.toLowerCase();
}
function parseCloudWorkspaceKey(value) {
  if (typeof value !== "string") return null;
  const match = KEY.exec(value);
  if (!match) return null;
  const relativePath = match[3] ?? "";
  if (relativePath.split("/").some((part) => part === ".." || part === ".") || Array.from(relativePath).some(
    (char) => char === "\\" || char.charCodeAt(0) < 32
  )) {
    throw new Error("Invalid cloud workspace path");
  }
  return {
    organizationId: match[1].toLowerCase(),
    workspaceId: match[2].toLowerCase(),
    relativePath
  };
}
function cloudScopedId(target, id) {
  cloudWorkspaceKey(target);
  if (!id) throw new Error("Invalid cloud resource identity");
  return `cloud:${target.organizationId.toLowerCase()}:${target.workspaceId.toLowerCase()}:${encodeURIComponent(id)}`;
}
function parseCloudScopedId(value) {
  if (typeof value !== "string") return null;
  const match = ID.exec(value);
  if (!match) return null;
  try {
    return {
      organizationId: match[1].toLowerCase(),
      workspaceId: match[2].toLowerCase(),
      id: decodeURIComponent(match[3])
    };
  } catch {
    throw new Error("Invalid cloud resource identity");
  }
}
function cloudTargetForValue(value) {
  const parsed = parseCloudWorkspaceKey(value) ?? parseCloudScopedId(value);
  if (!parsed && typeof value === "string" && /^cloud:/i.test(value)) {
    throw new Error("Invalid cloud workspace identity");
  }
  return parsed;
}
var UUID, UUID_IDENTITY, KEY, ID;
var init_cloud_workspace_key = __esm({
  "previous:apps/desktop/src/renderer/platform/bridge/cloud-workspace-key.ts"() {
    UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    UUID_IDENTITY = new RegExp(`^${UUID}$`, "i");
    KEY = new RegExp(`^cloud://(${UUID})/(${UUID})(?:/(.*))?$`, "i");
    ID = new RegExp(`^cloud:(${UUID}):(${UUID}):(.+)$`, "i");
  }
});

// previous:packages/protocol/src/run-actions.ts
function runSessionId(folder, actionId = LEGACY_RUN_ACTION_ID) {
  let h = 5381;
  for (let i = 0; i < folder.length; i++)
    h = (h << 5) + h + folder.charCodeAt(i) | 0;
  const base = `pty-run-${(h >>> 0).toString(36)}`;
  if (actionId === LEGACY_RUN_ACTION_ID) return base;
  return `${base}-${actionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
var LEGACY_RUN_ACTION_ID;
var init_run_actions = __esm({
  "previous:packages/protocol/src/run-actions.ts"() {
    LEGACY_RUN_ACTION_ID = "run";
  }
});

// previous:packages/protocol/src/changes-history.ts
import { z as z4 } from "zod";
var commitId, turnIdentitySchema, turnHistoryCursorSchema, changesHistorySchema;
var init_changes_history = __esm({
  "previous:packages/protocol/src/changes-history.ts"() {
    commitId = z4.string().regex(/^[0-9a-f]{7,64}$/i);
    turnIdentitySchema = z4.object({
      chatId: z4.string().min(1).max(4096),
      turnId: z4.string().min(1).max(4096)
    });
    turnHistoryCursorSchema = turnIdentitySchema.extend({
      startedAt: z4.number().int().safe()
    });
    changesHistorySchema = z4.discriminatedUnion("kind", [
      z4.object({ kind: z4.literal("commits") }),
      z4.object({
        kind: z4.literal("commit-range"),
        from: commitId,
        to: commitId
      }),
      z4.object({ kind: z4.literal("turns") }),
      z4.object({ kind: z4.literal("last-turn") }),
      z4.object({
        kind: z4.literal("turn-range"),
        from: turnIdentitySchema,
        to: turnIdentitySchema
      })
    ]);
  }
});

// previous:apps/desktop/src/renderer/platform/bridge/cloud-runtime-wire.ts
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nativeValue(scope, value, path = false) {
  const target = cloudTargetForValue(value);
  if (!target) return value;
  if (cloudWorkspaceKey(scope) !== cloudWorkspaceKey(target))
    throw new Error("Cloud workspace changed before dispatch");
  const id = parseCloudScopedId(value);
  if (id) {
    const base = runSessionId(cloudWorkspaceKey(scope));
    return id.id === base || id.id.startsWith(`${base}-`) ? runSessionId(scope.root) + id.id.slice(base.length) : id.id;
  }
  const folder = parseCloudWorkspaceKey(value);
  if (!path) return scope.engineWorkspaceId;
  return folder.relativePath ? `${scope.root.replace(/\/$/, "")}/${folder.relativePath}` : scope.root;
}
function mapFields(scope, value, direction, chat = false) {
  const mapped = { ...value };
  for (const key of [
    "chatId",
    "conversationId",
    "sourceChatId",
    "destinationChatId",
    "excludeChatId",
    ...chat ? ["id"] : ["sessionId", "executionId"]
  ]) {
    if (typeof value[key] !== "string" || !value[key]) continue;
    const base = runSessionId(scope.root);
    const incoming = value[key] === base || value[key].startsWith(`${base}-`) ? runSessionId(cloudWorkspaceKey(scope)) + value[key].slice(base.length) : value[key];
    mapped[key] = direction === "in" ? cloudScopedId(scope, incoming) : nativeValue(scope, value[key]);
  }
  if (typeof value.workspaceId === "string")
    mapped.workspaceId = direction === "in" ? cloudWorkspaceKey(scope) : nativeValue(scope, value.workspaceId);
  for (const key of ["cwd", "folder", "repoRoot"]) {
    if (typeof value[key] !== "string") continue;
    if (direction === "out") mapped[key] = nativeValue(scope, value[key], true);
    else if (value[key] === scope.root || value[key] === scope.engineWorkspaceId)
      mapped[key] = cloudWorkspaceKey(scope);
    else if (value[key].startsWith(`${scope.root}/`))
      mapped[key] = cloudWorkspaceKey(scope) + value[key].slice(scope.root.length);
  }
  return mapped;
}
function mapTurnIdentity(scope, value, direction) {
  const identity = turnIdentitySchema.parse(value);
  const row = record(value);
  const chatId = nativeValue(scope, identity.chatId);
  nativeValue(scope, row.workspaceId);
  nativeValue(scope, row.folder, true);
  const owner = {};
  if ("workspaceId" in row) owner.workspaceId = row.workspaceId;
  if ("folder" in row) owner.folder = row.folder;
  return {
    ...row,
    ...mapFields(scope, owner, direction),
    chatId: direction === "in" ? cloudScopedId(scope, chatId) : chatId
  };
}
function cloudIncoming(scope, message) {
  const out = mapFields(scope, message, "in");
  if (message.session)
    out.session = mapFields(scope, record(message.session), "in");
  if (message.response)
    out.response = mapFields(scope, record(message.response), "in");
  if (message.notification)
    out.notification = mapFields(scope, record(message.notification), "in");
  if (message.request)
    out.request = mapFields(scope, record(message.request), "in");
  if (Array.isArray(message.chatIds))
    out.chatIds = message.chatIds.map((id) => cloudScopedId(scope, String(id)));
  if (Array.isArray(message.terminals))
    out.terminals = message.terminals.map(
      (row) => mapFields(scope, record(row), "in")
    );
  if (message.type === "DB_CHANGED") {
    out.workspaceId = cloudWorkspaceKey(scope);
    out.workspaceIds = [cloudWorkspaceKey(scope)];
    out.cloudWorkspace = cloudWorkspaceKey(scope);
  }
  if (message.result && typeof message.result === "object") {
    const result = mapFields(scope, record(message.result), "in");
    if (message.op === "chats.titleSeeds" && Array.isArray(result.seeds))
      result.seeds = result.seeds.map((seed) => mapFields(scope, record(seed), "in"));
    if (message.op === "turns.reset" && typeof result.resetId === "string")
      result.resetId = cloudScopedId(scope, result.resetId);
    if (message.op === "turns.get" && result.turn)
      result.turn = mapTurnIdentity(scope, result.turn, "in");
    if (message.op === "turns.list" && Array.isArray(result.turns))
      result.turns = result.turns.map((turn) => mapTurnIdentity(scope, turn, "in"));
    if (message.op === "codeReview.list" && Array.isArray(result.threads))
      result.threads = result.threads.map((thread) => mapFields(scope, record(thread), "in"));
    const workspace = (row) => ({
      ...record(row),
      id: cloudWorkspaceKey(scope),
      path: cloudWorkspaceKey(scope),
      repoRoot: cloudWorkspaceKey(scope),
      placement: "cloud",
      organizationId: scope.organizationId
    });
    if (message.op === "workspace.get")
      return { ...out, result: workspace(message.result) };
    if (Array.isArray(result.workspaces))
      result.workspaces = result.workspaces.map(workspace);
    if (result.workspace) result.workspace = workspace(result.workspace);
    for (const key of ["chats", "summaries"])
      if (Array.isArray(result[key]))
        result[key] = result[key].map(
          (row) => mapFields(scope, record(row), "in", true)
        );
    for (const key of ["chatDeletions", "messageResets"])
      if (Array.isArray(result[key]))
        result[key] = result[key].map((id) => cloudScopedId(scope, String(id)));
    if (message.type === "WORKSPACE_RESPONSE" && message.op === "messages.search" && Array.isArray(result.hits))
      result.hits = result.hits.map((value) => {
        const hit = record(value);
        if (typeof hit.chatId !== "string" || !hit.chatId || parseCloudWorkspaceKey(hit.chatId))
          throw new Error("Invalid cloud search result identity");
        const chatId = nativeValue(scope, hit.chatId);
        return { ...hit, ...mapFields(scope, { chatId }, "in") };
      });
    if (Array.isArray(result.messages) && message.op === "db.pull")
      result.messages = result.messages.map(
        (row) => mapFields(scope, record(row), "in")
      );
    out.result = Array.isArray(message.result) ? message.result : result;
  }
  return out;
}
var init_cloud_runtime_wire = __esm({
  "previous:apps/desktop/src/renderer/platform/bridge/cloud-runtime-wire.ts"() {
    init_cloud_workspace_key();
    init_run_actions();
    init_changes_history();
  }
});

// previous:packages/protocol/src/cloud-v2-relay.ts
import { z as z2 } from "zod";
var CLOUD_V2_RELAY_PROTOCOL = 2;
var CLOUD_V2_MAX_HISTORY_ROWS = 500;
var CloudV2AgentSchema = z2.enum(["codex", "claude", "cursor"]);
var CloudV2CapabilitiesSchema = z2.object({
  design: z2.literal(false),
  browser: z2.literal(false),
  simulators: z2.literal(false),
  terminal: z2.boolean(),
  files: z2.boolean(),
  git: z2.boolean(),
  agents: z2.array(CloudV2AgentSchema).max(3),
  promptOutbox: z2.literal(1).optional(),
  githubPullRequests: z2.literal(1).optional(),
  /** Configuration delivery is sent only after a worker advertises this version. */
  mcp: z2.literal(1).optional()
}).strict();
var clientId = z2.uuid();
var frame = z2.unknown();
var CloudV2MessageRowSchema = z2.object({
  msgId: z2.string().min(1).max(256),
  kind: z2.string().max(64),
  payload: z2.string().max(1e6),
  createdAt: z2.number().int().nonnegative()
}).strict();
var chatRow = z2.object({ id: z2.string().min(1).max(256) }).loose();
var CloudV2HistoryFrameSchema = z2.object({
  t: z2.literal("history"),
  chats: z2.array(chatRow).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
  chatDeletions: z2.array(z2.string().min(1).max(256)).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
  messages: z2.object({
    chatId: z2.string().min(1).max(256),
    rows: z2.array(CloudV2MessageRowSchema).max(CLOUD_V2_MAX_HISTORY_ROWS)
  }).strict().optional()
}).strict();
var CloudV2WorkerFrameSchema = z2.discriminatedUnion("t", [
  z2.object({
    t: z2.literal("hello"),
    protocol: z2.literal(CLOUD_V2_RELAY_PROTOCOL),
    workerVersion: z2.string().min(1).max(64),
    capabilities: CloudV2CapabilitiesSchema
  }).strict(),
  /** `"*"` reaches every attached app connection. */
  z2.object({ t: z2.literal("frame"), clientId: z2.union([clientId, z2.literal("*")]), frame }).strict(),
  CloudV2HistoryFrameSchema,
  /** Idle means no running agent turn or recent terminal activity. */
  z2.object({ t: z2.literal("idle"), idle: z2.boolean() }).strict(),
  z2.object({ t: z2.literal("request"), id: z2.uuid(), kind: z2.literal("github-token"), purpose: z2.enum(["git", "gh"]).optional() }).strict(),
  z2.object({ t: z2.literal("stop-ack"), id: z2.uuid() }).strict()
]);
var proxy = z2.object({ baseUrl: z2.url(), token: z2.string().min(16).max(4096), expiresAt: z2.number().int() }).strict();
var secret = z2.string().min(16).max(16384);
var mcpValues = z2.record(z2.string().min(1).max(256), z2.string().max(16384)).refine((value) => Object.keys(value).length <= 128, "Too many MCP values");
var mcpIdentity = { id: z2.uuid(), name: z2.string().min(1).max(128) };
var RuntimeMcpServerSchema = z2.discriminatedUnion("transport", [
  z2.object({
    ...mcpIdentity,
    transport: z2.literal("stdio"),
    command: z2.string().min(1).max(4096),
    args: z2.array(z2.string().max(8192)).max(128).optional(),
    cwd: z2.string().max(4096).optional(),
    env: mcpValues.optional(),
    listen_url: z2.string().min(1).max(4096).optional()
  }).strict(),
  ...["http", "sse"].map((transport) => z2.object({
    ...mcpIdentity,
    transport: z2.literal(transport),
    url: z2.string().min(1).max(4096),
    headers: mcpValues.optional(),
    auth: z2.enum(["none", "header", "oauth"]).optional(),
    disabled_tools: z2.array(z2.string().min(1).max(256)).max(1024).optional()
  }).strict())
]);
var CloudV2ControlFrameSchema = z2.discriminatedUnion("t", [
  z2.object({ t: z2.literal("prompts") }).strict(),
  z2.object({ t: z2.literal("open"), clientId }).strict(),
  z2.object({ t: z2.literal("close"), clientId }).strict(),
  z2.object({ t: z2.literal("frame"), clientId, frame }).strict(),
  z2.object({ t: z2.literal("stop"), id: z2.uuid() }).strict(),
  /** Sent after hello and again before any proxy token expires or a login
   * changes. HTTPS revision polling repairs a missed push. The control plane
   * owns proxy token refresh. */
  z2.object({
    t: z2.literal("config"),
    promptOutbox: z2.literal(1).optional(),
    githubPullRequests: z2.literal(1).optional(),
    loginRevision: z2.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    mcpServers: z2.array(RuntimeMcpServerSchema).max(128).optional(),
    workspace: z2.object({
      id: z2.uuid(),
      organizationId: z2.uuid(),
      checkoutPath: z2.string().min(1).max(1024),
      repository: z2.string().min(1).max(512),
      github: z2.object({
        repositoryId: z2.string().regex(/^[1-9][0-9]{0,15}$/),
        repository: z2.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
        previousRepositories: z2.array(z2.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)).max(102)
      }).strict().optional(),
      /** Created from the locally available baseCommit, else the on-disk baseBranch. */
      branch: z2.string().min(1).max(255),
      baseBranch: z2.string().min(1).max(255),
      /** Delivered only with checkout-v2; the base head recorded at creation. */
      baseCommit: z2.string().regex(/^[0-9a-f]{40}$/).optional(),
      /** Delivered only with workspace-setup-v1; runs once after a new checkout. */
      setup: z2.string().max(8e3).optional()
    }).strict(),
    agents: z2.object({
      codex: proxy.optional(),
      claude: z2.union([z2.object({ oauthToken: secret }).strict(), z2.object({ apiKey: secret }).strict()]).optional(),
      cursor: z2.object({ apiKey: z2.string().min(1).max(4096) }).strict().optional()
    }).strict()
  }).strict(),
  z2.object({ t: z2.literal("reply"), id: z2.uuid(), token: z2.string().min(1).max(8192), expiresAt: z2.number().int() }).strict(),
  z2.object({ t: z2.literal("refusal"), id: z2.uuid(), code: z2.string().min(1).max(64) }).strict()
]);
var CloudV2WorkerHelloSchema = z2.object({
  protocol: z2.literal(CLOUD_V2_RELAY_PROTOCOL),
  runtimeSha256: z2.string().regex(/^[0-9a-f]{64}$/),
  bootId: z2.uuid()
}).strict();
var CloudV2WorkerHistorySchema = CloudV2HistoryFrameSchema.extend({ bootId: z2.uuid(), sequence: z2.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
var CloudV2WorkerActivitySchema = z2.object({ idle: z2.boolean() }).strict();
var CloudV2WorkerActivityReplySchema = z2.object({
  loginRevision: z2.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  state: z2.enum(["creating", "starting", "running", "stopping", "stopped", "failed", "deleting", "deleted"])
}).strict();
var CloudV2WorkerTimingSchema = z2.object({
  phase: z2.enum(["worker_checkout", "worker_checkout_fetch", "worker_checkout_switch", "worker_session_store", "worker_services", "worker_configure"]),
  durationMs: z2.number().int().nonnegative().max(36e5)
}).strict();

// previous:packages/protocol/src/cloud-v2-prompts.ts
import { z as z3 } from "zod";
var CLOUD_V2_MAX_PROMPT_BYTES = 8 * 1024 * 1024;
var CLOUD_V2_PROMPT_POLL_MS = 25e3;
var CloudV2PromptIdSchema = z3.string().min(1).max(256).regex(/^(?!cloud:)[^\u0000-\u001f]+$/);
var CloudV2PromptCounterSchema = z3.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine((value) => /^[0-9]+$/.test(value) && BigInt(value) < 9223372036854775807n);
var text = z3.string().max(CLOUD_V2_MAX_PROMPT_BYTES);
var annotations = z3.object({
  audience: z3.array(z3.enum(["user", "assistant"])).max(2).optional(),
  lastModified: z3.string().max(128).optional(),
  priority: z3.number().min(0).max(1).optional()
}).strict().optional();
var content = z3.discriminatedUnion("type", [
  z3.object({ type: z3.literal("text"), text, annotations }).strict(),
  z3.object({ type: z3.literal("image"), data: text, mimeType: z3.string().max(128), uri: text.optional(), annotations }).strict(),
  z3.object({ type: z3.literal("audio"), data: text, mimeType: z3.string().max(128), annotations }).strict(),
  z3.object({
    type: z3.literal("resource_link"),
    uri: text,
    name: z3.string().max(1024),
    description: text.optional(),
    mimeType: z3.string().max(128).optional(),
    size: z3.number().nonnegative().optional(),
    title: z3.string().max(1024).optional(),
    annotations
  }).strict(),
  z3.object({ type: z3.literal("resource"), resource: z3.union([
    z3.object({ uri: text, text, mimeType: z3.string().max(128).optional() }).strict(),
    z3.object({ uri: text, blob: text, mimeType: z3.string().max(128).optional() }).strict()
  ]), annotations }).strict()
]);
var attachment = z3.object({
  name: z3.string().max(1024),
  mimeType: z3.string().max(128),
  kind: z3.enum(["image", "text", "file"]),
  delivery: z3.literal("reference").optional(),
  size: z3.number().nonnegative().optional(),
  thumbnailUri: text.optional(),
  diskPath: z3.string().max(2048).optional(),
  attachmentId: z3.string().max(256).optional()
}).strict();
var attachmentGroup = z3.object({ id: z3.string().min(1).max(160), name: z3.string().min(1).max(512) }).strict().optional();
var CloudV2PromptSchema = z3.object({
  chatId: CloudV2PromptIdSchema,
  userMessageId: CloudV2PromptIdSchema,
  agentId: z3.enum(["codex", "claude", "cursor"]),
  model: z3.string().max(256).optional(),
  effort: z3.string().max(64).optional(),
  mode: z3.enum(["prompt", "steer"]).optional(),
  prompt: z3.array(content).min(1).max(256),
  startedAt: z3.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bubble: z3.object({
    retryText: text.optional(),
    displayText: text.optional(),
    autoAction: z3.string().max(256).optional(),
    attachments: z3.array(attachment).max(100).optional(),
    segments: z3.array(z3.discriminatedUnion("type", [
      z3.object({ type: z3.literal("text"), text }).strict(),
      z3.object({ type: z3.literal("mention"), label: z3.string().max(1024), path: z3.string().max(2048), kind: z3.enum(["file", "folder", "selection"]) }).strict(),
      attachment.extend({ type: z3.literal("attachment"), group: attachmentGroup }).strict()
    ])).max(512).optional()
  }).strict().optional()
}).strict();
var CloudV2PromptReceiptSchema = z3.object({
  workspaceId: z3.string().uuid(),
  chatId: CloudV2PromptIdSchema,
  userMessageId: CloudV2PromptIdSchema,
  sequence: CloudV2PromptCounterSchema,
  epoch: CloudV2PromptCounterSchema,
  acceptedAt: z3.string().datetime(),
  workspaceState: z3.enum(["creating", "running", "stopping", "stopped", "starting", "deleting", "deleted", "failed"])
}).strict();
var CloudV2PromptStateSchema = z3.enum(["queued", "inboxed", "dispatching", "accepted", "completed", "failed", "cancelled", "interrupted"]);
var CloudV2PromptStatusSchema = z3.object({
  receipt: CloudV2PromptReceiptSchema,
  state: CloudV2PromptStateSchema,
  payload: CloudV2PromptSchema.nullable(),
  cancelRequested: z3.boolean()
}).strict();
var CloudV2PromptStopSchema = z3.object({ chatId: CloudV2PromptIdSchema, throughEpoch: CloudV2PromptCounterSchema }).strict();
var CloudV2PromptStopReplySchema = z3.object({ chatId: CloudV2PromptIdSchema, epoch: CloudV2PromptCounterSchema }).strict();
var CloudV2PromptPullSchema = z3.object({
  waitMs: z3.number().int().min(0).max(CLOUD_V2_PROMPT_POLL_MS),
  held: z3.array(CloudV2PromptIdSchema).max(128).optional()
}).strict();
var CloudV2PromptDeliverySchema = z3.object({ receipt: CloudV2PromptReceiptSchema, payload: CloudV2PromptSchema, deliveryId: z3.string().uuid() }).strict();
var CloudV2PromptPullReplySchema = z3.object({ prompts: z3.array(CloudV2PromptDeliverySchema).max(16), stops: z3.array(CloudV2PromptStopReplySchema).max(128) }).strict();
var CloudV2PromptAckSchema = z3.object({ userMessageId: CloudV2PromptIdSchema, deliveryId: z3.string().uuid() }).strict();
var CloudV2PromptBeginSchema = CloudV2PromptAckSchema.extend({ dispatchId: z3.string().uuid() });
var CloudV2PromptOutcomeSchema = z3.object({
  userMessageId: CloudV2PromptIdSchema,
  dispatchId: z3.string().uuid().optional(),
  deliveryId: z3.string().uuid().optional(),
  state: z3.enum(["accepted", "completed", "failed", "cancelled", "interrupted"])
}).strict().refine((value) => !!value.dispatchId || !!value.deliveryId && value.state !== "accepted");

// previous:packages/protocol/src/agent-messages.ts
var isPlainObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
function mergeRawOutput(prev, next) {
  if (next === void 0 || next === null) return prev;
  const prevStamp = isPlainObject(prev) ? prev.zerosQuestion : void 0;
  const nextStamp = isPlainObject(next) ? next.zerosQuestion : void 0;
  const stamp = nextStamp ?? prevStamp;
  if (stamp === void 0) return next;
  if (isPlainObject(next) && Object.keys(next).length === 1 && nextStamp !== void 0 && isPlainObject(prev)) {
    return { ...prev, zerosQuestion: stamp };
  }
  if (isPlainObject(next)) {
    return { ...next, zerosQuestion: stamp };
  }
  return { output: next, zerosQuestion: stamp };
}
function mergeResourceLinks(previous, incoming) {
  if (!incoming?.length) return previous;
  const links = new Map((previous ?? []).map((link) => [link.uri, link]));
  for (const link of incoming.slice(0, 50)) {
    if (link?.type === "resource_link" && typeof link.uri === "string" && typeof link.name === "string") links.set(link.uri, link);
  }
  return [...links.values()].slice(0, 128);
}
function isSettledToolStatus(status) {
  return status === "completed" || status === "failed";
}
function applyUpdate(messages, notification) {
  const upd = notification.update;
  const retiredParent = "parentToolId" in upd && upd.parentToolId ? messages.some((m) => m.kind === "text" && m.retractedToolCallId === upd.parentToolId) : false;
  if (retiredParent && upd.sessionUpdate !== "message_parent_update") return messages;
  switch (upd.sessionUpdate) {
    case "user_message_recorded": {
      const message = upd.message;
      if (!message || message.kind !== "text" || message.role !== "user" || typeof message.id !== "string" || !message.id)
        return messages;
      const index = messages.findIndex((m) => m.id === message.id);
      if (index < 0) return [...messages, message];
      const previous = messages[index];
      const next = [...messages];
      next[index] = previous.kind === "text" && previous.messageId !== void 0 && message.messageId === void 0 ? { ...message, messageId: previous.messageId } : message;
      return next;
    }
    case "wakeup_notice": {
      if (!upd.noticeId || upd.source !== "loop_wakeup" && upd.source !== "schedule_wakeup") return messages;
      const messageId = `wakeup-${upd.noticeId}`;
      if (messages.some((message) => message.id === messageId || message.kind === "text" && message.messageId === messageId)) return messages;
      const info = {
        source: upd.source,
        ...typeof upd.reason === "string" && upd.reason.trim() ? { reason: upd.reason.trim() } : {},
        ...typeof upd.scheduledFor === "number" && Number.isFinite(upd.scheduledFor) && upd.scheduledFor > 0 && upd.scheduledFor <= 864e13 ? { scheduledFor: upd.scheduledFor } : {}
      };
      return [...messages, {
        id: messageId,
        messageId,
        kind: "text",
        role: "agent",
        phase: "commentary",
        text: wakeupNoticeText(info),
        wakeupNotice: info,
        createdAt: Date.now()
      }];
    }
    case "model_fallback": {
      const messageId = `model-fallback-${upd.noticeId}`;
      const { provider, fromModel, toModel, scope, reason, fromSettings, toSettings } = upd;
      const info = {
        provider,
        fromModel,
        toModel,
        scope,
        reason,
        ...fromSettings ? { fromSettings } : {},
        ...toSettings ? { toSettings } : {}
      };
      const index = messages.findIndex((m) => m.kind === "text" && m.messageId === messageId);
      if (index >= 0) {
        const previous = messages[index];
        if (previous.retracted || JSON.stringify(previous.modelFallback) === JSON.stringify(info) && (!upd.parentToolId || upd.parentToolId === previous.parentToolId)) return messages;
        const next = [...messages];
        next[index] = { ...previous, text: modelFallbackText(info), modelFallback: info, updatedAt: Date.now(), parentToolId: upd.parentToolId ?? previous.parentToolId };
        return next;
      }
      return [...messages, {
        id: messageId,
        messageId,
        kind: "text",
        role: "agent",
        phase: "commentary",
        text: modelFallbackText(info),
        modelFallback: info,
        parentToolId: upd.parentToolId,
        createdAt: Date.now()
      }];
    }
    case "user_message_chunk": {
      const last = messages[messages.length - 1];
      const incomingId = typeof upd.messageId === "string" ? upd.messageId : void 0;
      if (last && last.kind === "text" && last.role === "user" && last.messageId === void 0 && incomingId !== void 0) {
        const adopted = {
          ...last,
          messageId: incomingId
        };
        return [...messages.slice(0, -1), adopted];
      }
      return appendText(messages, "user", upd.content, incomingId);
    }
    case "agent_message_chunk":
      return appendText(
        messages,
        "agent",
        upd.content,
        upd.messageId ?? void 0,
        void 0,
        upd.parentToolId ?? void 0,
        void 0,
        upd.phase ?? void 0,
        upd.textMode
      );
    case "agent_thought_chunk":
      return appendText(
        messages,
        "thought",
        upd.content,
        upd.messageId ?? void 0,
        upd.redacted ?? void 0,
        upd.parentToolId ?? void 0,
        upd.durationMs ?? void 0,
        void 0,
        upd.textMode
      );
    case "tool_call": {
      const tc = upd;
      if (messages.some((m) => m.kind === "text" && m.retractedToolCallId === tc.toolCallId)) return messages;
      const status = tc.status ?? "pending";
      const at = typeof tc.at === "number" ? tc.at : Date.now();
      const msg = {
        id: `tool-${tc.toolCallId}`,
        kind: "tool",
        toolCallId: tc.toolCallId,
        nativeToolCallId: tc.nativeToolCallId ?? void 0,
        title: tc.title ?? tc.toolCallId,
        toolKind: tc.kind ?? void 0,
        status,
        content: tc.content ?? void 0,
        locations: tc.locations ?? void 0,
        rawInput: tc.rawInput,
        rawOutput: tc.rawOutput,
        mergeKey: tc.mergeKey ?? void 0,
        parentToolId: tc.parentToolId ?? void 0,
        // Replay carries the original event time via `at`; live turns omit
        // it so we stamp now. Keeps resumed-chat durations accurate.
        createdAt: at,
        updatedAt: at,
        ...isSettledToolStatus(status) ? { settledAt: at } : {}
      };
      return [...messages, msg];
    }
    case "tool_call_update": {
      const upd2 = upd;
      return messages.map((m) => {
        if (m.kind !== "tool" || m.toolCallId !== upd2.toolCallId) return m;
        const status = upd2.status ?? m.status;
        const updatedAt = typeof upd2.at === "number" ? upd2.at : Date.now();
        const reopenedTask = m.toolKind === "background_task" && status === "in_progress" && isSettledToolStatus(m.status);
        return {
          ...m,
          status,
          resultRetracted: upd2.status === "completed" || upd2.status === "failed" ? false : m.resultRetracted,
          nativeToolCallId: upd2.nativeToolCallId ?? m.nativeToolCallId,
          title: upd2.title ?? m.title,
          toolKind: upd2.kind ?? m.toolKind,
          content: upd2.content ?? (reopenedTask ? void 0 : m.content),
          resourceLinks: m.resultRetracted || reopenedTask ? void 0 : mergeResourceLinks(m.resourceLinks, upd2.resourceLinks),
          locations: upd2.locations ?? m.locations,
          rawInput: upd2.rawInput ?? m.rawInput,
          rawOutput: mergeRawOutput(reopenedTask ? void 0 : m.rawOutput, upd2.rawOutput),
          mergeKey: upd2.mergeKey ?? m.mergeKey,
          updatedAt,
          settledAt: reopenedTask ? void 0 : m.settledAt ?? (isSettledToolStatus(status) ? updatedAt : void 0)
        };
      });
    }
    case "message_parent_update": {
      const ids = new Set(upd.messageIds);
      let changed = false;
      const next = messages.map((message) => {
        const key = message.kind === "tool" ? message.toolCallId : message.kind === "text" ? message.messageId : message.id;
        if (!key || !ids.has(key) || "parentToolId" in message && message.parentToolId === upd.parentToolId) return message;
        changed = true;
        return { ...message, parentToolId: upd.parentToolId };
      });
      if (retiredParent) return applyUpdate(next, { ...notification, update: {
        sessionUpdate: "message_retraction",
        messageIds: [upd.parentToolId]
      } });
      return changed ? next : messages;
    }
    case "message_retraction": {
      const ids = new Set(upd.messageIds);
      const children = /* @__PURE__ */ new Map();
      for (const m of messages) {
        if (!("parentToolId" in m) || !m.parentToolId) continue;
        const siblings = children.get(m.parentToolId) ?? [];
        siblings.push(m);
        children.set(m.parentToolId, siblings);
      }
      const retiredIds = /* @__PURE__ */ new Set();
      const owners = [...ids];
      const visited = /* @__PURE__ */ new Set();
      for (let i = 0; i < owners.length; i++) {
        const owner = owners[i];
        if (visited.has(owner)) continue;
        visited.add(owner);
        for (const child of children.get(owner) ?? []) {
          retiredIds.add(child.id);
          if (child.kind === "tool") owners.push(child.toolCallId);
        }
      }
      let changed = false;
      const next = messages.map((m) => {
        const key = m.kind === "tool" ? m.toolCallId : m.kind === "text" ? m.messageId : void 0;
        if (!retiredIds.has(m.id) && (!key || !ids.has(key)) || m.kind === "text" && (m.retracted || m.role === "user")) return m;
        changed = true;
        return {
          id: m.id,
          kind: "text",
          role: "agent",
          text: "",
          retracted: true,
          messageId: m.kind === "text" ? m.messageId : void 0,
          ...m.kind === "tool" ? { retractedToolCallId: m.toolCallId } : {},
          createdAt: m.createdAt,
          updatedAt: Date.now()
        };
      });
      return changed ? next : messages;
    }
    case "tool_result_retraction": {
      const ids = new Set(upd.toolCallIds);
      let changed = false;
      const next = messages.map((m) => {
        if (m.kind !== "tool" || !ids.has(m.toolCallId) || m.resultRetracted) return m;
        changed = true;
        return {
          ...m,
          content: void 0,
          resourceLinks: void 0,
          rawOutput: void 0,
          status: "pending",
          settledAt: void 0,
          resultRetracted: true,
          resultRevision: (m.resultRevision ?? 0) + 1,
          updatedAt: Date.now()
        };
      });
      return changed ? next : messages;
    }
    // Mode / commands updates are handled at the provider level
    // (they change session slots other than `messages`), so skip here.
    case "current_mode_update":
    case "available_commands_update":
    case "turn_state":
      return messages;
    case "mode_switch": {
      const m = upd;
      const at = typeof m.at === "number" ? m.at : Date.now();
      const banner = {
        id: `mode-${at}-${m.to}`,
        kind: "mode_switch",
        axis: m.axis,
        from: m.from ?? "",
        to: m.to,
        source: m.source,
        reason: m.reason,
        createdAt: at
      };
      return [...messages, banner];
    }
    case "error_notice": {
      const n = upd;
      if (!n.noticeId || !n.message) return messages;
      const id = `notice-${n.noticeId}`;
      if (messages.some((m) => m.id === id)) return messages;
      const notice = {
        id,
        kind: "error_notice",
        severity: n.severity === "error" ? "error" : "warning",
        message: n.message,
        ...n.turnFailure ? { turnFailure: n.turnFailure } : {},
        ...n.failureKind ? { failureKind: n.failureKind } : {},
        recoverable: n.recoverable === true,
        code: n.code,
        ...n.parentToolId ? { parentToolId: n.parentToolId } : {},
        createdAt: typeof n.at === "number" ? n.at : Date.now()
      };
      return [...messages, notice];
    }
    default:
      return messages;
  }
}
var FALLBACK_EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultracode: "Ultracode"
};
function modelSettingsText(settings, effortLabel = (effort) => FALLBACK_EFFORT_LABELS[effort] ?? effort) {
  const parts = [
    settings?.effort ? effortLabel(settings.effort) : null,
    settings?.fast ? "Fast" : null
  ].filter((part) => !!part);
  return parts.length > 0 ? parts.join(" ") : null;
}
function wakeupNoticeText(info, formatTime) {
  const loop = info.source === "loop_wakeup";
  if (!info.reason) return loop ? "Woke up on schedule" : "Scheduled task started";
  const label = `${loop ? "Woke up for" : "Scheduled task"} \u201C${info.reason}\u201D`;
  return formatTime && info.scheduledFor !== void 0 ? `${label} \xB7 due ${formatTime(info.scheduledFor)}` : label;
}
function modelFallbackText(info, model = info.toModel, fromModel = info.fromModel, effortLabel) {
  if (info.provider === "codex" && info.reason === "cybersecurity")
    return `Model fallback to ${model} because of a cybersecurity-related safety check`;
  if (info.reason === "unavailable" && fromModel)
    return `Model fallback to ${model} because ${fromModel} isn't available for this account`;
  if (info.reason === "settings") {
    const ran = modelSettingsText(info.toSettings, effortLabel);
    const refused = modelSettingsText(info.fromSettings, effortLabel);
    const provider = info.provider === "cursor" ? "Cursor" : info.provider === "codex" ? "Codex" : "Claude";
    return `Model fallback to ${model} ${ran ?? "default settings"} because ${provider} rejected ${refused ?? "the selected settings"}`;
  }
  return info.scope === "session" ? `Model switched to ${model}` : `Model fallback used ${model}`;
}
function appendText(messages, role, content2, messageId, redacted, parentToolId, durationMs, phase, textMode) {
  if (!content2 || content2.type !== "text" || typeof content2.text !== "string") {
    return messages;
  }
  const chunkText = content2.text;
  if (messageId && messages.some((m) => m.kind === "text" && m.messageId === messageId && m.retracted)) return messages;
  if (textMode === "replace" && messageId) {
    let found = false;
    let changed = false;
    const next = messages.flatMap((message) => {
      if (message.kind !== "text" || message.role !== role || message.messageId !== messageId || message.parentToolId !== parentToolId) return [message];
      if (found) {
        if (!message.text) return [message];
        changed = true;
        return [{ ...message, text: "" }];
      }
      found = true;
      if (message.text === chunkText && (!phase || message.phase === phase)) return [message];
      changed = true;
      return [
        {
          ...message,
          text: chunkText,
          updatedAt: Date.now(),
          ...phase ? { phase } : {}
        }
      ];
    });
    if (found) return changed ? next : messages;
  }
  if (chunkText.length === 0) {
    let targetIndex2 = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.kind === "text" && message.role === role && message.parentToolId === parentToolId && sameMessageId(message.messageId, messageId)) {
        targetIndex2 = index;
        break;
      }
    }
    if (targetIndex2 < 0) return messages;
    const target = messages[targetIndex2];
    const next = [...messages];
    next[targetIndex2] = {
      ...target,
      ...redacted ? { redacted: true } : {},
      ...typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {},
      ...phase ? { phase } : {}
    };
    return next;
  }
  const targetIndex = messageId ? messages.findIndex((message) => message.kind === "text" && message.role === role && message.messageId === messageId && message.parentToolId === parentToolId) : messages.length - 1;
  const last = messages[targetIndex];
  if (last && last.kind === "text" && last.role === role && last.parentToolId === parentToolId && sameMessageId(last.messageId, messageId)) {
    return [
      ...messages.slice(0, targetIndex),
      {
        ...last,
        text: last.text + chunkText,
        updatedAt: Date.now(),
        // Once a message has been flagged redacted (any block in it),
        // keep the flag set — Anthropic interleaves redacted/plain
        // blocks within a single thinking message and we want the
        // composite to render as redacted.
        ...redacted ? { redacted: true } : {},
        ...typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {},
        ...phase ? { phase } : {}
      },
      ...messages.slice(targetIndex + 1)
    ];
  }
  return [
    ...messages,
    {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "text",
      role,
      text: chunkText,
      createdAt: Date.now(),
      messageId,
      ...redacted ? { redacted: true } : {},
      ...parentToolId ? { parentToolId } : {},
      ...typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {},
      ...phase ? { phase } : {}
    }
  ];
}
function sameMessageId(a, b) {
  if (a === void 0 && b === void 0) return true;
  return a === b;
}

// previous-cloud-decoders.ts
init_runtime_client();
init_cloud_runtime_wire();

// previous:apps/desktop/src/renderer/features/agent/agent-history-client.ts
function fromPersistedMessage(p) {
  try {
    return JSON.parse(p.payload);
  } catch (err) {
    console.warn(
      `[Zeros agent-history] dropping unreadable message ${p.msgId}:`,
      err
    );
    return null;
  }
}
export {
  CloudV2ControlFrameSchema,
  CloudV2PromptOutcomeSchema,
  CloudV2PromptStatusSchema,
  CloudV2WorkerFrameSchema,
  CloudV2WorkerHistorySchema,
  applyUpdate,
  cloudIncoming,
  fromPersistedMessage,
  parseInboundBridgeWebSocketFrame
};
