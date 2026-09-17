import { SESSION_EXPIRED_KEYWORDS } from "./session-expiry";
import { claudeStartupRecovery } from "../claude/startup-failure";
import {
  extractUnavailableModelId,
  isModelUnavailableError,
  modelUnavailableAdvice,
} from "./model-availability";
import { AgentFailureError, type AgentFailureStage } from "../../types";

type Provider = "claude" | "cursor" | "codex";
export type ProviderErrorCategory =
  | "auth-required"
  | "verification-required"
  | "cloud-credentials-unavailable"
  | "rate-limited"
  | "model-unavailable"
  | "session-expired"
  | "transport-closed"
  | "protocol-error";

export interface ProviderError {
  message: string;
  code?: string;
  status?: number;
  category: ProviderErrorCategory;
}

// Classify provider evidence only. In particular, `advice`, stacks, prompts,
// and tool output are never inspected. Keep this independent of UI copy.
const AUTH =
  /\b(?:not\s+(?:logged|signed)\s*in|please\s+(?:run\s*\/?login|sign\s+in)|sign[- ]in\s+required|unauthori[sz]ed|unauthenticated|authentication\s+(?:failed|required)|invalid\s+(?:api[- ]?key|credentials?|[\w-]*token)|(?:api[- ]?key|credentials?|(?:access|refresh|oauth)\s+token)\s+(?:is\s+|was\s+|has\s+)?(?:invalid|expired|revoked|missing|required|already\s+used)|(?:oauth|login|authentication)\s+session\s+expired|token[_ -]invalidated|access\s+token\s+could\s+not\s+be\s+refreshed|log\s+out\s+and\s+sign\s+in)\b/i;
const RATE =
  /\b(?:429|rate[\s_-]*limit(?:ed|_error|\s+exceeded)?|too many requests|resource exhausted|usage limit exceeded)\b/i;
const NETWORK =
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|fetch\s+failed|socket\s+hang\s?up|getaddrinfo|network\s+(?:error|failure|timeout|unreachable)|connection\s+(?:error|closed|reset|refused|failed|lost)|timed?\s+out|api\s+error[:\s(]*5\d\d\b|overloaded_error|\boverloaded\b/i;
const MODEL_ACCESS =
  /\bmodel\b[^\n.]{0,100}\b(?:access\s+(?:denied|required)|not\s+(?:enabled|permitted)|requires\s+(?:a\s+)?(?:different|paid|pro|max)|(?:do\s+not|don't)\s+have\s+access)\b|\bmax\s*mode\b/i;

const codeKey = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
const codes = (values: string[]) => new Set(values.map(codeKey));
/** Explicit native Claude tags requiring account/provider action. */
export function claudeActionCategory(code: string) {
  switch (codeKey(code)) {
    case "verificationrequired":
      return "verification-required";
    case "cloudcredentialerror":
      return "cloud-credentials-unavailable";
    default:
      return undefined;
  }
}
const AUTH_CODES = codes([
  "authentication_failed",
  "authentication_error",
  "unauthenticated",
  "unauthorized",
  "invalid_api_key",
  "invalid_auth_token",
  "token_expired",
  "invalid_token",
  "token_invalidated",
]);
const RATE_CODES = codes([
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "resource_exhausted",
  "usage_limit_exceeded",
  "too_many_requests",
]);
const MODEL_CODES = codes([
  "model_not_found",
  "model_not_available",
  "model_unavailable",
  "model_access_denied",
  "model_not_supported",
  "unsupported_model",
  "invalid_model",
  "model_not_enabled",
]);
const SESSION_CODES = codes([
  "agent_not_found",
  "thread_not_found",
  "session_not_found",
  "session_expired",
  "conversation_not_found",
  "conversation_expired",
]);
const NETWORK_CODES = codes([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "internalServerError",
  "server_error",
  "overloaded",
  "overloaded_error",
  "unavailable",
  "deadline_exceeded",
  "NetworkError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);
const TERMINAL_CODES = codes([
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "sandboxError",
  "repository_access",
  "integration_not_connected",
  "billing_error",
  "account_on_hold",
  "oauth_org_not_allowed",
  "agent_busy",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Accept SDK Errors, run results' native error objects, JSON-RPC data, and
 * Claude's JSON-in-a-string API errors. Bounded traversal also tolerates a
 * malformed/cyclic cause. Do not serialize the whole payload into the UI. */
export function normalizeProviderError(
  provider: Provider,
  value: unknown,
): ProviderError {
  const nativeCodes: string[] = [];
  const statuses: number[] = [];
  const names: string[] = [];
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let visits = 0;
  const visit = (input: unknown, depth: number): void => {
    if (depth > 5 || visits++ >= 24 || input == null || seen.has(input)) return;
    seen.add(input);
    if (typeof input === "string") {
      const text = string(input);
      if (!text) return;
      // Some terminal errors contain only the SDK's scalar error tag. Never
      // infer these categories from an incidental mention in provider prose.
      if (
        provider === "claude" &&
        (text === "verification_required" || text === "cloud_credential_error")
      ) {
        nativeCodes.push(text);
        return;
      }
      messages.push(text);
      // Result.errors may contain several independent API errors/diagnostics.
      // Their joined display text is not necessarily one valid JSON document.
      if (text.includes("\n")) {
        for (const line of text.split("\n").slice(0, 16))
          visit(line, depth + 1);
      }
      // SDK errors may prefix a JSON error body with "API Error: 401".
      // Bound parsing, and only inspect an object that looks like an error.
      const start = text.indexOf("{");
      if (start >= 0 && text.length <= 64_000) {
        try {
          const parsed = record(JSON.parse(text.slice(start)));
          if (
            parsed &&
            (parsed.error || parsed.code || parsed.type === "error")
          )
            visit(parsed, depth + 1);
        } catch {
          /* ordinary provider prose or incomplete JSON */
        }
      }
      const http = /^(?:API Error:\s*|HTTP\s+)?(4\d\d|5\d\d)\b/i.exec(text);
      if (http) statuses.push(Number(http[1]));
      return;
    }
    const obj = record(input);
    if (!obj) return;
    // The innermost provider error outranks generic transport/RPC wrappers.
    visit(obj.error, depth + 1);
    visit(obj.data, depth + 1);
    visit(obj.cause, depth + 1);
    // Anthropic's 403 verification response wraps the actionable code in a
    // generic permission_error. Read only the documented classification key.
    if (provider === "claude") {
      const startupReason = string(obj.startup_failure_reason);
      if (startupReason) nativeCodes.push(startupReason);
      const detailCode = string(record(obj.details)?.error_code);
      if (detailCode) nativeCodes.push(detailCode);
    }
    for (const raw of [obj.code, obj.errorCode, obj.type]) {
      const code = string(raw);
      if (code) nativeCodes.push(code);
    }
    const info = obj.codexErrorInfo;
    if (typeof info === "string") nativeCodes.push(info);
    else if (record(info)) {
      const [tag, detail] =
        Object.entries(info as Record<string, unknown>)[0] ?? [];
      if (tag) nativeCodes.push(tag);
      const status = record(detail)?.httpStatusCode;
      if (typeof status === "number") statuses.push(status);
    }
    for (const raw of [obj.status, obj.statusCode, obj.httpStatusCode]) {
      if (typeof raw === "number" && raw >= 100 && raw < 600)
        statuses.push(raw);
    }
    if (typeof obj.name === "string") names.push(obj.name);
    visit(obj.message, depth + 1);
    visit(obj.additionalDetails, depth + 1);
  };
  visit(value, 0);

  // Retain the outer explanation and any distinct nested provider details.
  // Generic RPC/startup wrappers must not hide the actual provider's message.
  const outer = record(value);
  const primary = string(value) ?? string(outer?.message) ?? messages[0];
  const explanations = primary ? [primary] : [];
  for (const detail of messages) {
    if (!explanations.some((text) => text.includes(detail)))
      explanations.push(detail);
  }
  const message =
    explanations.join("\n") ||
    `${provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Cursor"} reported an error${nativeCodes[0] ? ` (${nativeCodes[0]})` : " without an explanation"}.`;
  const status = statuses[0];
  const finish = (
    category: ProviderErrorCategory,
    code = nativeCodes[0],
  ): ProviderError => ({
    message,
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    category,
  });
  // The SDK's explicit action names the credential/account layer to fix, even
  // when its underlying cause is invalid_token, HTTP 401, or a connection error.
  if (provider === "claude") {
    for (const code of nativeCodes) {
      const recovery = claudeStartupRecovery(code);
      if (recovery) return finish(recovery.category, code);
    }
    for (const code of nativeCodes) {
      const category = claudeActionCategory(code);
      if (category) return finish(category, code);
    }
  }
  for (const code of nativeCodes) {
    const key = codeKey(code);
    if (AUTH_CODES.has(key)) return finish("auth-required", code);
    if (RATE_CODES.has(key)) return finish("rate-limited", code);
    if (MODEL_CODES.has(key)) return finish("model-unavailable", code);
    if (SESSION_CODES.has(key)) return finish("session-expired", code);
    if (TERMINAL_CODES.has(key)) return finish("protocol-error", code);
    if (key === "serveroverloaded")
      return finish(
        provider === "codex" ? "rate-limited" : "transport-closed",
        code,
      );
  }
  if (status === 429) return finish("rate-limited");
  if (status === 401) return finish("auth-required");
  // Connection variants can wrap a 4xx provider response. Its model/permission
  // explanation still matters; genuine connection codes and 5xx responses
  // outrank incidental model or sign-in wording and must not swap models.
  const networkCode = nativeCodes.find((code) =>
    NETWORK_CODES.has(codeKey(code)),
  );
  if (networkCode && (status === undefined || status >= 500))
    return finish("transport-closed", networkCode);
  if (status !== undefined && status >= 500) return finish("transport-closed");
  const detail = messages.join("\n");
  const modelUnavailable =
    isModelUnavailableError(detail) || MODEL_ACCESS.test(detail);
  if (names.includes("RateLimitError")) return finish("rate-limited");
  if (names.includes("AgentNotFoundError")) return finish("session-expired");
  // Some SDK versions use AuthenticationError for model access 403s too.
  if (
    names.includes("AuthenticationError") &&
    !(status === 403 && modelUnavailable)
  )
    return finish("auth-required");
  if (
    status === undefined &&
    names.some((name) =>
      /^(?:NetworkError|APIConnectionError|APIConnectionTimeoutError)$/.test(
        name,
      ),
    )
  )
    return finish("transport-closed");
  if (
    RATE.test(detail) ||
    (provider === "codex" && /server overloaded/i.test(detail))
  )
    return finish("rate-limited");
  if (modelUnavailable) return finish("model-unavailable");
  if (
    status === 403 ||
    nativeCodes.some((code) =>
      ["permissiondenied", "permissionerror"].includes(codeKey(code)),
    )
  )
    return finish("protocol-error");
  if (AUTH.test(detail)) return finish("auth-required");
  if (SESSION_EXPIRED_KEYWORDS.test(detail)) return finish("session-expired");
  if (NETWORK.test(detail)) return finish("transport-closed");
  return finish("protocol-error");
}

/** Add recovery copy only after classification. Keep the native explanation
 * in `message`, which is also what the persisted failure card displays. */
export function providerErrorFailure(
  provider: Provider,
  error: ProviderError,
  stage: AgentFailureStage,
): AgentFailureError {
  const label =
    provider === "claude"
      ? "Claude"
      : provider === "codex"
        ? "Codex"
        : "Cursor";
  const { category, message } = error;
  const startupRecovery = provider === "claude" ? claudeStartupRecovery(error.code) : undefined;
  const actionAdvice =
    startupRecovery?.advice ?? (category === "verification-required"
      ? "Complete the account or organization verification requested by Anthropic, then retry."
      : category === "cloud-credentials-unavailable"
        ? "Check or refresh the credentials for your configured cloud provider, then retry."
        : undefined);
  const advice =
    actionAdvice ??
    (category === "model-unavailable"
      ? modelUnavailableAdvice(label, extractUnavailableModelId(message))
      : category === "rate-limited"
        ? `${label} is rate-limiting requests. Wait for the provider reset, then try again.`
        : category === "auth-required"
          ? `Sign in or update your credentials in Settings → Providers → ${label}, then try again.`
          : undefined);
  // A scalar error code (or generic SDK subtype) is not an explanation. Use
  // useful copy only in that case; native prose, provider names and links win.
  const missingActionExplanation = actionAdvice && (
    !message.trim() ||
    message === error.code ||
    message === "error_during_execution" ||
    message === `Claude reported an error (${error.code}).`
  );
  const explanation = missingActionExplanation
    ? `${startupRecovery ? "Claude could not start." : category === "verification-required" ? "Claude requires verification." : "Claude could not load the configured cloud provider's credentials."} ${actionAdvice}`
    : category === "model-unavailable"
      ? `${label} model unavailable: ${message}`
      : category === "rate-limited"
        ? `${label} rate limit: ${message}`
        : category === "transport-closed"
          ? `${label} network failure: ${message}`
          : category === "session-expired"
            ? `${label} session expired${stage === "prompt" ? " mid-turn" : ""}: ${message}${stage === "loadSession" ? " Start a fresh chat to continue." : ""}`
            : message;
  return new AgentFailureError({
    kind: category === "model-unavailable" ? "protocol-error" : category,
    message: explanation,
    stage,
    agentId: provider,
    ...(advice ? { advice } : {}),
  });
}
