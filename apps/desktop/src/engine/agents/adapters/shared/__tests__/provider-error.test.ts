import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../provider-error";

describe("normalizeProviderError", () => {
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
