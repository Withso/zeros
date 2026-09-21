/** Opt-in automation contract. Ordinary interactive sessions retain their
 * existing availability recovery. Paid qualification must not spend on an
 * account default or silently recover on a different model. */
export function requiresExactModel(
  env: Readonly<Record<string, string>> | undefined,
): boolean {
  return env?.ZEROS_REQUIRE_EXACT_MODEL === "1";
}

export function requireExplicitModel(
  env: Readonly<Record<string, string>> | undefined,
  modelVariable: "ANTHROPIC_MODEL" | "OPENAI_MODEL" | "CURSOR_MODEL",
): string | null {
  if (!requiresExactModel(env)) return null;
  const model = env?.[modelVariable];
  if (
    !model ||
    model !== model.trim() ||
    model.length > 256 ||
    /[\s\0]/.test(model) ||
    /^(?:auto|default)$/i.test(model)
  ) {
    throw new Error(
      "Exact model selection requires an explicit model identifier",
    );
  }
  return model;
}

/** Native providers may announce rerouting even when the host did not request
 * fallback. Stop that qualification and never persist the substitute choice. */
export function exactModelFallbackError(
  env: Readonly<Record<string, string>> | undefined,
  modelVariable: "ANTHROPIC_MODEL" | "OPENAI_MODEL" | "CURSOR_MODEL",
  observedModel: string,
): Error | null {
  const expected = requireExplicitModel(env, modelVariable);
  const canonical = (value: string) => modelVariable === "ANTHROPIC_MODEL"
    ? value.replace(/-\d{8}$/, "")
    : value;
  return expected !== null && canonical(observedModel) !== canonical(expected)
    ? new Error("Exact model selection changed in the provider; qualification stopped")
    : null;
}
