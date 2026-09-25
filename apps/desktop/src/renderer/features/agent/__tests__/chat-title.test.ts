// First-message admission, Unicode-safe input limits, and 3–5 word titles.

import { describe, expect, it } from "vitest";

import {
  compactTitlePrompt,
  sanitizeAiTitle,
  settledFirstPromptForTitle,
} from "../chat-title";

const userMessage = (queued = false, text = "hi") => ({
  id: "first-user-message",
  kind: "text" as const,
  role: "user" as const,
  text,
  createdAt: 1,
  ...(queued ? { queued: true } : {}),
});

describe("settledFirstPromptForTitle", () => {
  it("waits until the actual first prompt is admitted and the turn settles", () => {
    for (const status of [
      "idle",
      "warming",
      "streaming",
      "reconnecting",
      "auth-required",
      "failed",
    ] as const) {
      expect(
        settledFirstPromptForTitle({ status, messages: [userMessage()] }),
      ).toBeNull();
    }
    expect(
      settledFirstPromptForTitle({
        status: "ready",
        messages: [userMessage(true)],
      }),
    ).toBeNull();
    expect(
      settledFirstPromptForTitle({
        status: "ready",
        messages: [userMessage()],
      }),
    ).toEqual({ messageId: "first-user-message", prompt: "hi" });
  });

  it("never titles a later prompt when the first user message is still queued or blank", () => {
    const later = { ...userMessage(), id: "later", text: "later prompt" };
    expect(
      settledFirstPromptForTitle({
        status: "ready",
        messages: [userMessage(true), later],
      }),
    ).toBeNull();
    expect(
      settledFirstPromptForTitle({
        status: "ready",
        messages: [userMessage(false, "  "), later],
      }),
    ).toBeNull();
  });
});

describe("compactTitlePrompt", () => {
  it("keeps short text and exactly 500 characters intact", () => {
    expect(compactTitlePrompt("  Fix login  ")).toBe("Fix login");
    expect(compactTitlePrompt("a".repeat(500))).toBe("a".repeat(500));
  });
  it("sends exactly the first 400 and last 100 characters of long input", () => {
    expect(
      compactTitlePrompt("a".repeat(400) + "omitted" + "z".repeat(100)),
    ).toBe("a".repeat(400) + "z".repeat(100));
  });
  it("counts Unicode characters without cutting surrogate pairs", () => {
    const prompt = "😀".repeat(400) + "omitted" + "終".repeat(100);
    expect(compactTitlePrompt(prompt)).toBe(
      "😀".repeat(400) + "終".repeat(100),
    );
  });
});

describe("sanitizeAiTitle", () => {
  it("passes a clean 3–5 word title through unchanged", () => {
    expect(sanitizeAiTitle("Fix login bug")).toBe("Fix login bug");
    expect(sanitizeAiTitle("Research the new API")).toBe(
      "Research the new API",
    );
  });

  it("strips wrapping quotes, backticks, and trailing punctuation", () => {
    expect(sanitizeAiTitle('"Fix login bug"')).toBe("Fix login bug");
    expect(sanitizeAiTitle("`Research the API`")).toBe("Research the API");
    expect(sanitizeAiTitle("Research the API.")).toBe("Research the API");
    expect(sanitizeAiTitle("“Audit the project”")).toBe("Audit the project");
  });

  it("keeps only the first line of a multi-line reply", () => {
    expect(sanitizeAiTitle("Research the API\n\nHere is why…")).toBe(
      "Research the API",
    );
  });

  it("clamps a rambling reply to 5 words", () => {
    expect(sanitizeAiTitle("Fix the login bug in the auth module")).toBe(
      "Fix the login bug in",
    );
  });

  it("collapses odd whitespace", () => {
    expect(sanitizeAiTitle("  Fix   login\tbug  ")).toBe("Fix login bug");
  });

  it("rejects unusable replies", () => {
    expect(sanitizeAiTitle("")).toBeNull();
    expect(sanitizeAiTitle("   \n  ")).toBeNull();
    expect(sanitizeAiTitle('"…"')).toBeNull();
    expect(sanitizeAiTitle("Hi")).toBeNull();
    expect(sanitizeAiTitle("Deep research")).toBeNull();
  });

  it("rejects provider diagnostics instead of naming the chat after them", () => {
    expect(sanitizeAiTitle("Failed to authenticate")).toBeNull();
    expect(sanitizeAiTitle("User authentication failed")).toBeNull();
    expect(sanitizeAiTitle("Error: Unauthorized")).toBeNull();
    expect(sanitizeAiTitle("Please sign in")).toBeNull();
    expect(sanitizeAiTitle("Request timed out")).toBeNull();
    expect(sanitizeAiTitle("Connection refused")).toBeNull();
  });
});
