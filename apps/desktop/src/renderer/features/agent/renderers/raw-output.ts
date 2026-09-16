// ──────────────────────────────────────────────────────────
// Tool rawOutput → displayable string (pure, no React)
// ──────────────────────────────────────────────────────────
//
// The fallback the live tool render path (event-row-renderer.tsx
// renderDetail) uses when a tool emits no canonical content blocks but DID
// populate `rawOutput`. Kept React-free so it's unit-testable.
//
// Deliberately conservative — adapters set `rawOutput` to wildly different
// shapes and we must never splat base64 image data or raw protocol envelopes
// into a card:
//   - string (shell/terminal output)        → show it (clipped)
//   - content-block array (Claude tool_result: text + image blocks)
//                                            → extract only readable text
//                                              (NEVER JSON-dump the array)
//   - plain result object ({exitCode,stdout})→ bounded readable preview, with
//                                              binary payloads omitted
// ──────────────────────────────────────────────────────────

export const RAW_OUTPUT_MAX = 20_000;

export function toolCompletionUnreported(rawOutput: unknown): boolean {
  return (
    !!rawOutput &&
    typeof rawOutput === "object" &&
    (rawOutput as Record<string, unknown>)._zerosToolCompletion === "unreported"
  );
}

/** Execution metadata can be inside Cursor's SDK wrapper. Keep the stored
 * result intact; only unwrap known command fields for the detail presenter. */
export function commandResultOutput(rawOutput: unknown): unknown {
  if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput))
    return rawOutput;
  const outer = rawOutput as Record<string, unknown>;
  if ("exitCode" in outer) return outer;
  const oneof =
    outer.result && typeof outer.result === "object"
      ? (outer.result as Record<string, unknown>)
      : {};
  const value = outer.value ?? outer.success ?? oneof.value;
  if (value && typeof value === "object" && "exitCode" in value) return value;
  return rawOutput;
}

/** Coerce a tool's raw output into a displayable string, or null when there
 *  is nothing human-readable. Input is displayed separately by the caller. */
export function asDisplayString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.length > 0 ? clip(value) : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const text = readableTextFromArray(value);
    if (text.length > 0) return clip(text);
    // Structured result lists (for example web hits) are useful output too.
    // Content-block arrays still omit binary-only / empty text records.
    const structured = value.filter(
      (entry) => entry && typeof entry === "object" && !("type" in entry),
    );
    return structured.length ? asDisplayString({ results: structured }) : null;
  }
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(readableValue(value), null, 2);
      if (!s || s === "{}" || s === "null") return null;
      // Keep a bounded preview of readable fields beside any omitted binary.
      return clip(s);
    } catch {
      return null;
    }
  }
  return null;
}

/** Bound work before JSON encoding, omit binary/private presentation fields,
 * and retain readable siblings. Malformed/cyclic output must never crash chat. */
function readableValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 1_024, characters: RAW_OUTPUT_MAX * 2 },
): unknown {
  if (budget.nodes-- <= 0 || budget.characters <= 0) return "[omitted]";
  if (typeof value === "string") {
    if (/^data:[^,]+;base64,/i.test(value)) return undefined;
    const text = clip(value.slice(0, budget.characters));
    budget.characters -= text.length;
    return text;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 8 || seen.has(value)) return "[omitted]";
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value))
    result = value
      .slice(0, 128)
      .map((entry) => readableValue(entry, depth + 1, seen, budget));
  else
    result = Object.fromEntries(
      Object.entries(value)
        .slice(0, 128)
        .flatMap(([key, entry]) => {
          if (
            key.startsWith("_zeros") ||
            key === "zerosQuestion" ||
            (typeof entry === "string" &&
              /^(?:data|blob|base64|encrypted_content)$/i.test(key))
          )
            return [];
          const readable = readableValue(entry, depth + 1, seen, budget);
          return readable === undefined ? [] : [[key, readable]];
        }),
    );
  seen.delete(value);
  return result;
}

/** Pull readable text out of a content-block / result array, skipping
 *  image/binary blocks. Handles string elements and `{text}` / `{output}`
 *  members (the shapes Claude/Codex/MCP tool results use). */
export function readableTextFromArray(arr: unknown[]): string {
  const parts: string[] = [];
  for (const el of arr) {
    if (typeof el === "string") {
      if (el) parts.push(el);
    } else if (el && typeof el === "object") {
      const o = el as Record<string, unknown>;
      if (typeof o.text === "string" && o.text) parts.push(o.text);
      else if (typeof o.output === "string" && o.output) parts.push(o.output);
      // image/audio/binary blocks contribute no readable text — skip them.
    }
  }
  return parts.join("\n");
}

function clip(s: string): string {
  return s.length > RAW_OUTPUT_MAX ? `${s.slice(0, RAW_OUTPUT_MAX)}…` : s;
}
