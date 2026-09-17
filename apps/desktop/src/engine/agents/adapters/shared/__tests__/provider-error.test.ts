import { describe, expect, it } from "vitest";
import { normalizeProviderError, providerErrorFailure } from "../provider-error";

describe("normalizeProviderError", () => {
  it.each([
    ["verification_required", "verification-required"],
    ["cloud_credential_error", "cloud-credentials-unavailable"],
  ] as const)("keeps Claude's %s separate from login, model and transport recovery", (code, category) => {
    const message = "The model is unavailable. Invalid credentials. See https://example.com/provider-help";
    for (const value of [
      { code, message },
      { error: code, message },
      { code, message, status: 401, name: "AuthenticationError" },
      { code, message, cause: { code: "invalid_token", message: "Expired credential." } },
      { code, message, cause: { code: "ECONNRESET" } },
      new Error(message, { cause: { code } }),
    ]) {
      const normalized = normalizeProviderError("claude", value);
      expect(normalized).toMatchObject({ category, code });
      const { failure } = providerErrorFailure("claude", normalized, "prompt");
      expect(failure.kind).toBe(category);
      expect(failure.message).toContain(message);
      expect(failure.advice).not.toMatch(/Settings|sign in|model menu/i);
    }
  });

  it("uses the API verification detail before its generic permission wrapper", () => {
    const body = { error: { type: "permission_error", message: "Verify at https://example.com/verify", details: { error_code: "verification_required", privateDetail: "do-not-display" } } };
    for (const value of [
      { status: 403, ...body },
      new Error(`API Error: 403 ${JSON.stringify(body)}`),
    ]) {
      const normalized = normalizeProviderError("claude", value);
      expect(normalized).toMatchObject({ category: "verification-required", code: "verification_required", status: 403 });
      expect(normalized.message).toContain("https://example.com/verify");
    }
    expect(normalizeProviderError("claude", body).message).not.toContain("do-not-display");
  });

  it.each([
    ["verification_required", "verification-required", /verification/i],
    ["cloud_credential_error", "cloud-credentials-unavailable", /cloud provider.*credentials/i],
  ] as const)("gives a missing explanation for %s useful fallback copy", (code, kind, copy) => {
    for (const value of [code, { code }, { code, message: code }, { error: code }, { code, message: "error_during_execution" }]) {
      const { failure } = providerErrorFailure("claude", normalizeProviderError("claude", value), "prompt");
      expect(failure.kind).toBe(kind);
      expect(failure.message).toMatch(copy);
      expect(failure.message).toMatch(/retry/i);
      expect(failure.message).not.toContain(code);
    }
  });

  it("does not infer new Claude categories from advice or change other providers", () => {
    for (const provider of ["codex", "cursor"] as const) {
      expect(normalizeProviderError(provider, { code: "verification_required", message: "Request failed." }).category).toBe("protocol-error");
      expect(normalizeProviderError(provider, { code: "cloud_credential_error", status: 401, message: "Invalid credentials." }).category).toBe("auth-required");
    }
    for (const value of [
      { message: "A tool mentioned verification_required in its documentation." },
      { message: "Request failed.", advice: "cloud_credential_error" },
      { message: "Request failed.", details: { unrelated: "verification_required" } },
    ]) expect(normalizeProviderError("claude", value).category).toBe("protocol-error");
  });

  it.each(["claude", "cursor", "codex"] as const)(
    "keeps %s error categories independent",
    (provider) => {
      for (const [error, category] of [
        [
          { code: "unauthenticated", message: "Credential rejected." },
          "auth-required",
        ],
        [
          { code: "rate_limit_exceeded", message: "Check your API key." },
          "rate-limited",
        ],
        [
          {
            code: "model_not_found",
            status: 403,
            message: "Selection rejected.",
          },
          "model-unavailable",
        ],
        [
          { code: "session_expired", message: "Conversation was removed." },
          "session-expired",
        ],
        [
          { code: "ECONNRESET", message: "Request interrupted." },
          "transport-closed",
        ],
        [
          { code: "future_code", message: "Check your API key." },
          "protocol-error",
        ],
        [
          {
            code: "repository_access",
            status: 403,
            message: "Permission denied.",
          },
          "protocol-error",
        ],
        [
          { message: "OAuth session expired. Please sign in again." },
          "auth-required",
        ],
        [{ status: 403, message: "Forbidden." }, "protocol-error"],
        [
          { status: 429, message: "Authentication request timed out." },
          "rate-limited",
        ],
        [
          {
            code: "permission_error",
            status: 403,
            message: "The model `restricted` is not available.",
          },
          "model-unavailable",
        ],
        [
          {
            name: "RateLimitError",
            message: "The model is unavailable while requests are limited.",
          },
          "rate-limited",
        ],
        [
          { code: "NetworkError", message: "Request interrupted." },
          "transport-closed",
        ],
        [
          {
            code: "ECONNRESET",
            message: "The model is unavailable while reconnecting.",
          },
          "transport-closed",
        ],
        [
          {
            name: "NetworkError",
            status: 503,
            message: "The model is unavailable while reconnecting.",
          },
          "transport-closed",
        ],
      ] as const) {
        const normalized = normalizeProviderError(provider, error);
        expect(normalized.category, JSON.stringify(error)).toBe(category);
        expect(normalized.message).toBe(error.message);
      }
    },
  );

  it("reads structured errors inside SDK strings without discarding the explanation", () => {
    const message =
      'API Error: 429 {"error":{"type":"rate_limit_error","message":"Check your API key."}}';
    expect(normalizeProviderError("claude", new Error(message))).toMatchObject({
      message,
      code: "rate_limit_error",
      category: "rate-limited",
    });
  });

  it("reads JSON-RPC error data and nested causes before wrapper wording", () => {
    const cause = {
      data: { error: { code: "model_not_found", message: "Model retired." } },
    };
    const error = new Error("Request refused. Check credentials.", { cause });
    expect(normalizeProviderError("codex", error)).toMatchObject({
      code: "model_not_found",
      category: "model-unavailable",
    });
    expect(normalizeProviderError("codex", error).message).toContain(
      "Model retired.",
    );
  });

  it("reads native codes from individual entries of Claude's joined errors array", () => {
    const message =
      'Request failed.\nAPI Error: 401 {"error":{"type":"authentication_error","message":"Credential rejected."}}\nProvider diagnostic.';
    expect(normalizeProviderError("claude", { message })).toMatchObject({
      message,
      category: "auth-required",
      code: "authentication_error",
    });
  });

  it("preserves additional provider details and never classifies generated advice", () => {
    const error = {
      message: "Unexpected response.",
      additionalDetails: "Provider explanation.",
      advice: "Invalid API key. Sign in again.",
    };
    expect(normalizeProviderError("codex", error)).toMatchObject({
      message: "Unexpected response.\nProvider explanation.",
      category: "protocol-error",
    });
  });

  it("handles empty, malformed, and cyclic error payloads", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    for (const value of [
      null,
      undefined,
      {},
      cyclic,
      { message: {} },
      { message: "{broken JSON" },
    ]) {
      const error = normalizeProviderError("cursor", value);
      expect(error.category).toBe("protocol-error");
      expect(error.message).not.toContain("[object Object]");
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("Claude startup reason recovery", () => {
  it.each([
    ["gateway_signin_required", "auth-required", /sign in/i],
    ["gateway_access_denied", "protocol-error", /administrator/i],
    ["org_pin_api_key_conflict", "protocol-error", /credential/i],
    ["org_verify_failed", "protocol-error", /organization/i],
    ["org_pin_mismatch", "protocol-error", /organization/i],
    ["managed_settings_invalid", "protocol-error", /administrator/i],
    ["remote_settings_required_unavailable", "protocol-error", /settings/i],
    ["proxy_invalid", "protocol-error", /proxy/i],
    ["temp_dir_unusable", "protocol-error", /temporary/i],
    ["cwd_unavailable", "protocol-error", /directory/i],
    ["shell_tool_missing", "protocol-error", /shell/i],
    ["session_held_by_background", "protocol-error", /background/i],
    ["worktree_resume_refused", "protocol-error", /worktree/i],
    ["worktree_unverified", "protocol-error", /worktree/i],
    ["cli_version_too_old", "protocol-error", /update/i],
    ["bypass_root", "protocol-error", /root/i],
  ] as const)("uses %s before incidental sign-in or transport advice", (code, category, advice) => {
    for (const value of [{ code }, { startup_failure_reason: code }]) {
      const error = normalizeProviderError("claude", { ...value, message: "Native explanation: please sign in or check the network error.", cause: { code: "invalid_token" } });
      expect(error).toMatchObject({ code, category });
      const { failure } = providerErrorFailure("claude", error, "prompt");
      expect(failure.advice).toMatch(advice);
      expect(failure.message).toBe("Native explanation: please sign in or check the network error.");
    }
  });

  it("does not classify other providers or prose as Claude startup reasons", () => {
    for (const provider of ["cursor", "codex"] as const) {
      expect(normalizeProviderError(provider, { code: "proxy_invalid", message: "Invalid credentials." }).category).toBe("auth-required");
    }
    expect(normalizeProviderError("claude", { message: "Documentation says gateway_signin_required" }).category).toBe("protocol-error");
    expect(normalizeProviderError("claude", { startup_failure_reason: "future_kind", message: "An unfamiliar startup failure" })).toMatchObject({ code: "future_kind", category: "protocol-error" });
  });

  it("supplies useful copy for a startup error containing only a generic subtype", () => {
    const { failure } = providerErrorFailure("claude", normalizeProviderError("claude", { code: "cwd_unavailable", message: "error_during_execution" }), "prompt");
    expect(failure.message).toMatch(/directory/i);
    expect(failure.message).not.toBe("error_during_execution");
  });
});
