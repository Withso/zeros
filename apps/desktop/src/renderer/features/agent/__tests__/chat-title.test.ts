// The AI chat-title reply is used VERBATIM as the tab title, so the
// sanitizer is the last line of defense for the 2–3 word contract: strip
// quote wrapping / trailing punctuation / extra lines, clamp to 3 words,
// and reject unusable replies (null ⇒ the snippet title stays).

import { describe, expect, it } from "vitest";

import { sanitizeAiTitle, settledFirstPromptForTitle } from "../chat-title";

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

describe("sanitizeAiTitle", () => {
  it("passes a clean 2–3 word title through unchanged", () => {
    expect(sanitizeAiTitle("Fix login bug")).toBe("Fix login bug");
    expect(sanitizeAiTitle("Deep research")).toBe("Deep research");
  });

  it("strips wrapping quotes, backticks, and trailing punctuation", () => {
    expect(sanitizeAiTitle('"Fix login bug"')).toBe("Fix login bug");
    expect(sanitizeAiTitle("`Deep research`")).toBe("Deep research");
    expect(sanitizeAiTitle("Deep research.")).toBe("Deep research");
    expect(sanitizeAiTitle("“Project audit”")).toBe("Project audit");
  });

  it("keeps only the first line of a multi-line reply", () => {
    expect(sanitizeAiTitle("Deep research\n\nHere is why…")).toBe(
      "Deep research",
    );
  });

  it("clamps a rambling reply to 3 words", () => {
    expect(sanitizeAiTitle("Fix the login bug in the auth module")).toBe(
      "Fix the login",
    );
  });

  it("collapses odd whitespace", () => {
    expect(sanitizeAiTitle("  Fix   login\tbug  ")).toBe("Fix login bug");
  });

  it("rejects unusable replies", () => {
    expect(sanitizeAiTitle("")).toBeNull();
    expect(sanitizeAiTitle("   \n  ")).toBeNull();
    expect(sanitizeAiTitle('"…"')).toBeNull();
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
