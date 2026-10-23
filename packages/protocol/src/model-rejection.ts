import catalog from "../../../catalogs/models-v1.json";

/** Presentation only, after the adapter classifies a model-access refusal.
 * Native error evidence stays with the adapter. Use catalog labels (or a
 * restricted OpenAI model id for a retired/unknown selection), never arbitrary
 * prose: it can include project ids, proxy URLs and request ids. */
export function codexModelUnavailableMessage(nativeMessage: string): string {
  let label = "the selected model";
  for (const match of nativeMessage.slice(0, 64_000).matchAll(/\bmodel\s*:?\s*(?:[`'"]([^`'"]{1,128})[`'"]|([A-Za-z0-9][A-Za-z0-9._-]{0,127}))/gi)) {
    const id = match[1] ?? match[2]?.replace(/\.+$/, "");
    const name = catalog.families.codex.find(model => model.value === id)?.label ??
      (id && /^(?:gpt-\d|o\d|codex-)[a-zA-Z0-9._-]{0,120}$/.test(id) ? id : undefined);
    if (name) { label = name; break; }
  }
  const connection = /\b(?:project|api[- ]?key)\b/i.test(nativeMessage) ? "OpenAI key" : "Codex connection";
  return `Your ${connection} can't use ${label}. Pick another model.`;
}

/** Compatibility for already persisted Codex refusals. Recognize only this
 * native model-access envelope; other provider explanations and links retain
 * their existing presentation. Never rewrite the diagnostic/history record. */
export function modelRejectionDisplayText(message: string): string {
  return /^(?:Codex(?::| model unavailable:)|unexpected status 403 Forbidden:)/i.test(message) &&
    /\b(?:does\s+not|do\s+not|doesn't|don't)\s+have\s+access\s+to\s+(?:the\s+)?model\b/i.test(message)
    ? codexModelUnavailableMessage(message) : message;
}
