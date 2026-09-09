// The cross-provider "model cannot be used" classifier. Every adapter routes its
// provider's rejection wording through these helpers, so the fixtures here are
// the real strings each provider emits — a wording change that stops matching
// shows up here, not as a raw "Agent error" toast.

import { describe, expect, it } from "vitest";

import {
  extractUnavailableModelId,
  isModelUnavailableError,
  modelUnavailableAdvice,
  parseAvailableModelsFromError,
} from "../model-availability";

const CURSOR =
  "Cannot use this model: grok-4.5. Available models: default, grok-4.6, composer-2.5, claude-opus-5, gpt-5.5, kimi-k2.7-code. Use Cursor.models.list() to discover valid selections.";
const ANTHROPIC =
  '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-3"}}';
const CODEX_UNSUPPORTED = "unsupported model: gpt-4.9";
const CODEX_ACCESS =
  "The model `gpt-4.9` does not exist or you do not have access to it.";

describe("isModelUnavailableError", () => {
  it("matches each provider's model-rejection wording", () => {
    for (const msg of [CURSOR, ANTHROPIC, CODEX_UNSUPPORTED, CODEX_ACCESS]) {
      expect(isModelUnavailableError(msg), msg).toBe(true);
    }
  });

  it("does NOT match auth, network, rate-limit, or stale-session errors", () => {
    for (const msg of [
      "401 Unauthorized: invalid api key",
      "getaddrinfo ENOTFOUND api2.cursor.sh",
      "429 rate limit exceeded for model claude-opus-5",
      "no rollout found for thread ABC",
      "Agent 123 not found",
      "Local SDK agents require an explicit `model`",
    ]) {
      expect(isModelUnavailableError(msg), msg).toBe(false);
    }
  });
});

describe("extractUnavailableModelId", () => {
  it("names the rejected model for each provider shape", () => {
    expect(extractUnavailableModelId(CURSOR)).toBe("grok-4.5");
    expect(extractUnavailableModelId(ANTHROPIC)).toBe("claude-opus-3");
    expect(extractUnavailableModelId(CODEX_ACCESS)).toBe("gpt-4.9");
  });

  it("keeps a dotted id intact and strips only the sentence period", () => {
    expect(
      extractUnavailableModelId("Cannot use this model: gpt-5.5. Available models: x"),
    ).toBe("gpt-5.5");
  });

  it("returns null when the message names no model", () => {
    expect(extractUnavailableModelId("unsupported model")).toBeNull();
  });
});

describe("parseAvailableModelsFromError", () => {
  it("parses Cursor's list, keeping dotted ids and dropping the trailing hint", () => {
    expect(parseAvailableModelsFromError(CURSOR)).toEqual([
      "default",
      "grok-4.6",
      "composer-2.5",
      "claude-opus-5",
      "gpt-5.5",
      "kimi-k2.7-code",
    ]);
  });

  it("handles a list with no trailing hint sentence", () => {
    expect(
      parseAvailableModelsFromError("Available models: a, b, c."),
    ).toEqual(["a", "b", "c"]);
  });

  it("returns [] when the message has no list", () => {
    expect(parseAvailableModelsFromError(ANTHROPIC)).toEqual([]);
    expect(parseAvailableModelsFromError(CODEX_UNSUPPORTED)).toEqual([]);
  });
});

describe("modelUnavailableAdvice", () => {
  it("names the model and the fix", () => {
    const advice = modelUnavailableAdvice("Cursor", "grok-4.5");
    expect(advice).toContain('"grok-4.5"');
    expect(advice).toContain("Cursor");
    expect(advice).toMatch(/model menu/);
  });
  it("degrades to generic copy when the model is unknown", () => {
    expect(modelUnavailableAdvice("Codex", null)).toMatch(
      /^The selected model isn't available/,
    );
  });
});
