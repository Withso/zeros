// Ported from apps/desktop/src/engine/agents/adapters/shared/model-availability.ts
// at 4baf69ec (Zeros, MIT). Keep native presentation parity with the Local mapper.
// This copy has no Local-engine runtime dependency.

// ──────────────────────────────────────────────────────────
// Model-unavailable error classifier (shared)
// ──────────────────────────────────────────────────────────
//
// Every provider validates the model id a session or turn names, and every one
// rejects a retired or plan-gated id with its own wording:
//
//   Cursor   "Cannot use this model: grok-4.5. Available models: default, …"
//   Anthropic '404 {"type":"error","error":{"type":"not_found_error",
//             "message":"model: claude-opus-3"}}'
//   Codex    "unsupported model: gpt-4.9" / "The model `x` does not exist or
//             you do not have access to it."
//
// The engine cannot prevent the pick from going stale — a persisted chat, a
// curated catalog entry, or a hand-edited settings file can all name a model the
// provider no longer offers, and a retired id bumps no version number. What it
// CAN do is recognise the rejection, tell the user which model to change (the
// toast layer drops technical `message` detail, so `advice` is the only channel
// that reaches them), and — where the provider lists what it DOES offer — recover
// the session on a model that exists.
//
// Consumed by the Claude (Agent SDK), Codex (app-server), and Cursor
// (@cursor/sdk) adapters. Pure; every export is unit-tested.
// ──────────────────────────────────────────────────────────

/** Provider wordings for "the model you named cannot be used". Kept narrow on
 *  purpose: an auth, network, or rate-limit error that merely MENTIONS a model
 *  must not match, because those are classified (and recovered) differently. */
export const MODEL_UNAVAILABLE_RX =
  /cannot\s+use\s+this\s+model|not_found_error[^\n]{0,80}\bmodel\b|\bmodel\b[^\n]{0,80}?\b(?:not\s+found|does\s+not\s+exist|not\s+supported|unsupported|not\s+available|unavailable|is\s+not\s+a\s+valid|is\s+invalid|has\s+been\s+(?:retired|deprecated|removed))\b|\b(?:unsupported|unknown|invalid|unrecognized|retired|deprecated)\s+model\b/i;

export function isModelUnavailableError(message: string): boolean {
  return MODEL_UNAVAILABLE_RX.test(message);
}
