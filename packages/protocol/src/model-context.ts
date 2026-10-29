// Per-model context-window truth, in one place because two hand-maintained
// tables drifted (the gauge read 200K for 1M models; attachment budgets fell to
// a 100K fallback). Adding a model means editing this file, and
// model-context.test.ts walks the curated catalog so a missing row fails CI.
//
// Values verified 2026-07-25 against the bundled agent SDK's model registry
// (@anthropic-ai/claude-agent-sdk 0.3.220):
//
//   model              window   native_1m  1m_suffix  1m_beta
//   claude-fable-5       1e6      yes         -        yes
//   claude-mythos-5      1e6      yes         -        yes
//   claude-opus-5        1e6      yes        yes       yes
//   claude-opus-4-8      1e6      yes        yes       yes
//   claude-opus-4-7      1e6      yes        yes       yes
//   claude-sonnet-5      1e6      yes         -         -
//   claude-opus-4-6      200k      -        yes       yes
//   claude-sonnet-4-6    200k      -        yes       yes
//   claude-sonnet-4-5    200k      -        yes       yes
//   claude-sonnet-4-0    200k      -        yes       yes
//   claude-opus-4-5      200k      -        yes        -
//   claude-opus-4-1      200k      -        yes        -
//   claude-opus-4-0      200k      -        yes        -
//   claude-haiku-4-5     200k      -        yes        -
//
// Two traps:
//   1. Fable 5 and Sonnet 5 declare no `supports_1m_suffix` because they are
//      natively 1M, so the catalog's `[1m]` ids for them are redundant, not
//      broken. Keep those ids: persisted chats reference them.
//   2. Haiku declares the suffix but has no 1M beta and a 200k window, so it is
//      pinned to 200k ahead of the generic suffix rule.

/** Prompt-side context window for a model we can't identify. 200k is the
 *  floor across the whole Claude 3.x/4.x family, so it never over-promises. */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;

const ONE_MILLION = 1_000_000;

/** Claude models whose window is 1M with OR without a `[1m]` suffix
 *  (registry `native_1m: true`). Matched on the dateless base id, so dated
 *  snapshots (`claude-opus-5-20260714`) and suffixed ids both land here. */
const CLAUDE_NATIVE_1M =
  /claude-(?:fable-5|mythos-5|opus-5|opus-4-[78]|sonnet-5)/i;

/** An explicit long-context request: `claude-…[1m]` or `claude-…-1m`. */
const CLAUDE_1M_SUFFIX = /(?:\[1m\]|-1m)\s*$/i;

/** Haiku is 200k and has no 1M beta — a `[1m]` on it buys nothing. */
const CLAUDE_HAIKU = /claude-haiku/i;

/** Prompt-side context window (tokens) for a Claude model id.
 *
 *  Note this is the STATIC answer. When the agent CLI reports a real window at
 *  runtime — `query.getContextUsage().maxTokens` for Claude, `tokenUsage
 *  .modelContextWindow` for Codex — that value is authoritative and should win;
 *  this function is the pre-first-turn / feature-unavailable fallback. */
export function claudeContextWindow(modelId: string | null | undefined): number {
  if (!modelId) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  const id = modelId.trim();
  // Haiku first: it declares a 1m suffix but can't actually use one.
  if (CLAUDE_HAIKU.test(id)) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  if (CLAUDE_NATIVE_1M.test(id)) return ONE_MILLION;
  // 200k-base models (Opus 4.6, Sonnet 4.6/4.5/4.0) reach 1M only when the
  // caller explicitly asks for the long-context variant.
  if (CLAUDE_1M_SUFFIX.test(id)) return ONE_MILLION;
  return CLAUDE_DEFAULT_CONTEXT_WINDOW;
}
