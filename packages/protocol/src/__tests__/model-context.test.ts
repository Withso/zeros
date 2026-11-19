import { describe, expect, it } from "vitest";

import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  claudeContextWindow,
} from "../model-context";
import catalog from "../../../../catalogs/models-v1.json";

const ONE_M = 1_000_000;

describe("claudeContextWindow", () => {
  it("reports 1M for the natively-1M family, suffixed or bare", () => {
    for (const id of [
      "claude-fable-5",
      "claude-fable-5[1m]",
      "claude-mythos-5",
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
      "claude-opus-4-7",
      "claude-opus-4-7[1m]",
      "claude-sonnet-5",
      "claude-sonnet-5[1m]",
    ]) {
      expect(claudeContextWindow(id), id).toBe(ONE_M);
    }
  });

  it("reports 200k for the 200k-base models when no long-context variant is asked for", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4-0",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4-0",
      "claude-3-5-sonnet-20241022",
    ]) {
      expect(claudeContextWindow(id), id).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW);
    }
  });

  it("honours an explicit [1m] / -1m on a 200k-base model that supports the beta", () => {
    expect(claudeContextWindow("claude-opus-4-6[1m]")).toBe(ONE_M);
    expect(claudeContextWindow("claude-sonnet-4-6[1m]")).toBe(ONE_M);
    expect(claudeContextWindow("claude-sonnet-4-6-1m")).toBe(ONE_M);
  });

  it("never gives Haiku 1M — it has no 1M beta despite declaring the suffix", () => {
    // Haiku advertises the suffix but not the 1M beta; the suffix must not widen its budget.
    expect(claudeContextWindow("claude-haiku-4-5")).toBe(
      CLAUDE_DEFAULT_CONTEXT_WINDOW,
    );
    expect(claudeContextWindow("claude-haiku-4-5[1m]")).toBe(
      CLAUDE_DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("tolerates dated snapshots and surrounding whitespace", () => {
    expect(claudeContextWindow("claude-opus-5-20260714")).toBe(ONE_M);
    expect(claudeContextWindow("  claude-sonnet-5[1m]  ")).toBe(ONE_M);
  });

  it("falls back to 200k for null / unknown ids rather than over-promising", () => {
    for (const id of [null, undefined, "", "definitely-not-a-model"]) {
      expect(claudeContextWindow(id)).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW);
    }
  });

  it("ANTI-ROT: every curated Claude model resolves to 1M except Haiku", () => {
    // Curated non-Haiku labels can omit context size only while this 1M invariant holds.
    const claude = catalog.families.claude as Array<{
      value: string;
      label: string;
    }>;
    expect(claude.length).toBeGreaterThan(1);
    for (const m of claude) {
      const expected = /haiku/i.test(m.value)
        ? CLAUDE_DEFAULT_CONTEXT_WINDOW
        : ONE_M;
      expect(claudeContextWindow(m.value), m.value).toBe(expected);
    }
  });
});
