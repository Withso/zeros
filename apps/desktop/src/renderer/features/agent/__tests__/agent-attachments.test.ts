// Context-window resolver coverage. The attachment byte budget scales with
// the picked model's context window, so a new model whose id isn't registered
// silently falls back to the conservative default — under-budgeting large-
// context models. That is exactly what happened before 2026-07-25: the local
// Claude table had rows for fable-5[1m] and opus-4-8[1m] but NONE for
// claude-sonnet-5 or claude-opus-5, so both 1M models resolved to the 100K
// unknown-model fallback. The Claude arm now delegates to the shared
// `claudeContextWindow` in @zeros/protocol (same rule the engine's context gauge
// uses), so the two can't drift apart again.

import { describe, expect, it } from "vitest";

import { modelContextTokens } from "../agent-attachments";
import catalog from "../../../../../../../catalogs/models-v1.json";

describe("modelContextTokens", () => {
  it("resolves every 1M Claude model, suffixed or bare", () => {
    // Per the bundled agent SDK registry these are all `native_1m: true`, so
    // the window does NOT depend on the [1m] suffix. (An earlier revision of
    // this test asserted bare → 200K; that encoded a wrong belief — the suffix
    // is redundant on the natively-1M family, not load-bearing.)
    for (const id of [
      "claude-fable-5[1m]",
      "claude-fable-5",
      "claude-opus-5[1m]",
      "claude-opus-5",
      "claude-opus-4-8[1m]",
      "claude-opus-4-8",
      "claude-sonnet-5[1m]",
      "claude-sonnet-5",
    ]) {
      expect(modelContextTokens(id), id).toBe(1_000_000);
    }
  });

  it("REGRESSION: Sonnet 5 / Opus 5 are not left on the 100K fallback", () => {
    // The measured bug (2026-07-25): both fell through every pattern to
    // FALLBACK_CONTEXT_TOKENS, a 10x under-budget on a 1M model.
    expect(modelContextTokens("claude-sonnet-5[1m]")).not.toBe(100_000);
    expect(modelContextTokens("claude-opus-5[1m]")).not.toBe(100_000);
  });

  it("keeps 200K for the 200K-base Claude models and Haiku", () => {
    expect(modelContextTokens("claude-sonnet-4-6")).toBe(200_000);
    expect(modelContextTokens("claude-opus-4-6")).toBe(200_000);
    expect(modelContextTokens("claude-haiku-4-5")).toBe(200_000);
  });

  it("still resolves the gpt / cursor families", () => {
    // Official GPT-6 Astra model metadata: 1,050,000-token context window and
    // 128,000 max output. This resolver budgets prompt-side attachments only;
    // tokenUsage.modelContextWindow remains authoritative once Codex reports it.
    expect(modelContextTokens("gpt-6-astra")).toBe(1_050_000);
    expect(modelContextTokens("gpt-5.5")).toBe(256_000);
    // The `^gpt-5` catch-all answers for the curated 5.6 ids. Not independently
    // verifiable in-repo (codex ships no static per-model context table) — the
    // authoritative figure is tokenUsage.modelContextWindow at runtime.
    expect(modelContextTokens("gpt-5.6-sol")).toBe(256_000);
    expect(modelContextTokens("gpt-5.6-terra")).toBe(256_000);
    expect(modelContextTokens("gpt-5.6-luna")).toBe(256_000);
    expect(modelContextTokens("composer-2.5")).toBe(200_000);
  });

  it("leaves Cursor Grok on the conservative fallback (nothing to verify against)", () => {
    // @cursor/sdk's turn-ended usage carries token counts only — no context
    // window — and Cursor's official Grok 4.6 page does not publish one. A
    // constant here would therefore be a guess. Under-budgeting is the safe
    // direction: it rejects a file the model might have handled, rather than
    // overflowing the window. Documented, not silently missing.
    for (const id of ["grok-4.5", "grok-4.6"]) {
      expect(modelContextTokens(id), id).toBe(
        modelContextTokens("totally-unknown-model"),
      );
    }
  });

  it("keeps Cursor Auto on the conservative fallback", () => {
    // The runtime supplies Auto's actual model choice per turn; there is
    // no stable context window to encode before a live provider admits it.
    expect(modelContextTokens("default")).toBe(
      modelContextTokens("totally-unknown-model"),
    );
  });

  it("falls back for unknown / empty ids without throwing", () => {
    expect(modelContextTokens(null)).toBeGreaterThan(0);
    expect(modelContextTokens("totally-unknown-model")).toBeGreaterThan(0);
  });

  it("ANTI-ROT: no curated model silently lands on the unknown-model fallback", () => {
    // The original failure mode was a NEW model nobody added a row for. Walk
    // the real catalog so that can't pass CI again. Cursor Auto and the two Grok
    // versions are explicit documented exceptions above; do not skip every
    // liveRequired row, because that would let a new model evade this gate.
    const fallback = modelContextTokens("totally-unknown-model");
    for (const [family, list] of Object.entries(catalog.families)) {
      for (const m of list as Array<{ value: string }>) {
        if (["default", "grok-4.5", "grok-4.6"].includes(m.value)) continue;
        expect(modelContextTokens(m.value), `${family}/${m.value}`).not.toBe(
          fallback,
        );
      }
    }
  });
});
