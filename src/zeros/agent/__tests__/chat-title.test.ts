// The AI chat-title reply is used VERBATIM as the tab title, so the
// sanitizer is the last line of defense for the 2–3 word contract: strip
// quote wrapping / trailing punctuation / extra lines, clamp to 3 words,
// and reject unusable replies (null ⇒ the snippet title stays).

import { describe, expect, it } from "vitest";

import { sanitizeAiTitle } from "../chat-title";

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
    expect(
      sanitizeAiTitle("Fix the login bug in the auth module"),
    ).toBe("Fix the login");
  });

  it("collapses odd whitespace", () => {
    expect(sanitizeAiTitle("  Fix   login\tbug  ")).toBe("Fix login bug");
  });

  it("rejects unusable replies", () => {
    expect(sanitizeAiTitle("")).toBeNull();
    expect(sanitizeAiTitle("   \n  ")).toBeNull();
    expect(sanitizeAiTitle('"…"')).toBeNull();
  });
});
