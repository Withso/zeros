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

/** The model id a rejection names, when the wording carries one. Handles
 *  "Cannot use this model: <id>." (Cursor), '"message":"model: <id>"' (Anthropic),
 *  "model `<id>`" / "model '<id>'" (Codex/OpenAI), and "<id>: model not found". */
export function extractUnavailableModelId(message: string): string | null {
  const patterns = [
    /cannot\s+use\s+this\s+model:\s*([^\s.,;]+(?:\.[^\s.,;]+)*)/i,
    /\bmodel:\s*([A-Za-z0-9][\w.:/[\]-]*)/i,
    /\bmodel\s+[`'"]([^`'"]+)[`'"]/i,
  ];
  for (const rx of patterns) {
    const m = rx.exec(message);
    const id = m?.[1]?.trim();
    if (id) return id.replace(/[.,;:]+$/, "");
  }
  return null;
}

/** Ids a provider enumerates after "Available models:" — the shape the Cursor
 *  SDK uses. Returns [] when the message carries no such list. Model ids contain
 *  dots (`gpt-5.5`), so the list is split on commas, and the sentence-ending
 *  period (plus any trailing "Use …" hint) is stripped from the last entry. */
export function parseAvailableModelsFromError(message: string): string[] {
  const m = /available\s+models?\s*(?:are|:)\s*([^\n]+)/i.exec(message);
  if (!m) return [];
  let list = m[1];
  // Drop a trailing hint sentence ("Use Cursor.models.list() to discover…").
  list = list.replace(/\.\s+[A-Z][^\n]*$/, "");
  const out: string[] = [];
  for (const raw of list.split(",")) {
    const id = raw.trim().replace(/[.;]+$/, "").trim();
    if (id.length === 0 || /\s/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** End-user copy for a model rejection. Names the model when known so the user
 *  knows which pill to change, and always says where the fix is. */
export function modelUnavailableAdvice(
  providerLabel: string,
  modelId: string | null,
): string {
  const which = modelId ? `The model "${modelId}"` : "The selected model";
  return (
    `${which} isn't available on your ${providerLabel} account any more. ` +
    `Pick a different model from the model menu and send again.`
  );
}
