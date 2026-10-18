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

describe("settledFirstPromptForTitle for long-running and coordinated chats", () => {
  const agent = { id: "a1", kind: "text" as const, role: "agent" as const, text: "On it.", createdAt: 2 };
  const tool = { id: "t1", kind: "tool" as const, toolCallId: "t1", title: "Run", toolKind: "execute", status: "in_progress" as const, createdAt: 2 };

  it("titles a first turn the agent is still working on once it answered", () => {
    expect(settledFirstPromptForTitle({ status: "streaming", messages: [userMessage(), agent] })).toEqual({ messageId: "first-user-message", prompt: "hi" });
    expect(settledFirstPromptForTitle({ status: "streaming", messages: [userMessage(), tool as never] })).toEqual({ messageId: "first-user-message", prompt: "hi" });
    // An error notice is not an answer.
    const notice = { id: "n", kind: "error_notice" as const, severity: "error" as const, message: "x", recoverable: false, createdAt: 2 };
    expect(settledFirstPromptForTitle({ status: "streaming", messages: [userMessage(), notice as never] })).toBeNull();
  });

  it("looks past notices and fallback rows that arrive before the first prompt", () => {
    // Codex reports config/deprecation warnings as notices at session start;
    // a provider may announce a model fallback before the first prompt.
    const warning = { id: "w", kind: "error_notice" as const, severity: "warning" as const, message: "Config: x", recoverable: true, createdAt: 0 };
    const fallback = { id: "f", kind: "text" as const, role: "agent" as const, text: "Using Composer 2", createdAt: 0, modelFallback: { provider: "cursor", fromModel: "grok-4.7", toModel: "composer-2" } };
    const divider = { id: "d", kind: "text" as const, role: "system" as const, text: "Continuing session", createdAt: 0, resumeBoundary: true };
    expect(settledFirstPromptForTitle({ status: "streaming", messages: [warning as never, fallback as never, divider, userMessage(), agent] })).toEqual({ messageId: "first-user-message", prompt: "hi" });
  });

  it("never titles from a tail window that starts mid-transcript", () => {
    const later = { ...userMessage(), id: "later", text: "a later prompt" };
    expect(settledFirstPromptForTitle({ status: "ready", messages: [tool as never, later, agent] })).toBeNull();
  });

  it("never titles from a Zeros Local note", () => {
    const note = {
      ...userMessage(),
      id: "note",
      text: 'Chat "Worker" finished its turn: completed.',
      localNote: { chatId: "w", title: "Worker", agentId: "codex", link: "zeros-dev://chat/w", event: "done" as const, status: "completed" },
    };
    expect(settledFirstPromptForTitle({ status: "ready", messages: [note, agent] })).toBeNull();
  });
});

describe("fallbackChatTitle", () => {
  it("names a chat from its prompt's opening words when no AI title arrives", async () => {
    const { fallbackChatTitle } = await import("../chat-title");
    expect(fallbackChatTitle("Fix the login redirect bug")).toBe("Fix the login redirect bug");
    expect(fallbackChatTitle("hi")).toBe("hi");
    expect(fallbackChatTitle("\n  Review zeros-dev://workspace/ws_x and report back today please now.")).toBe("Review and report back today please");
    expect(fallbackChatTitle("**Audit** the `components` and accessibility!")).toBe("Audit the components and accessibility");
    expect(fallbackChatTitle("   ")).toBeNull();
    expect(fallbackChatTitle("zeros-dev://chat/x")).toBeNull();
    expect(Array.from(fallbackChatTitle("a".repeat(200))!).length).toBeLessThanOrEqual(60);
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
