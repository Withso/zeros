// Pins the shared per-model context window (packages/protocol/src/model-context.ts).
//
// This exists because the rule used to be duplicated in two places that rotted
// independently — the engine's gauge fallback (claude/translator.ts) and the
// renderer's attachment budget (agent-attachments.ts). On 2026-07-25 the first
// reported 200K for Fable 5 / Sonnet 5 / Opus 5 (it only matched
// /opus-4-[78].*\[1m\]/) and the second had no row at all for Sonnet 5 or
// Opus 5, so they got the 100K unknown-model fallback. Both are 1M models.
//
// The catalog-walk test at the bottom is the anti-rot gate: add a Claude model
// to catalogs/models-v1.json without teaching model-context.ts about it and
// this suite fails.

import { describe, expect, it } from "vitest";

import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  claudeContextWindow,
} from "../model-context";
import catalog from "../../../../catalogs/models-v1.json";

const ONE_M = 1_000_000;

describe("claudeContextWindow", () => {
  it("reports 1M for the natively-1M family, suffixed or bare", () => {
    // registry `native_1m: true` — the window does not depend on the suffix.
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
    // The registry lists supports_1m_suffix on Haiku but NO supports_1m_beta
    // and a 200k window, so a [1m] there buys nothing. Haiku is checked before
    // the generic suffix rule for exactly this reason.
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
    // The user-visible contract behind removing "1M" from the labels: the size
    // is redundant precisely BECAUSE this holds. If a future model lands that
    // isn't 1M, the label change needs revisiting — so fail loudly here.
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
