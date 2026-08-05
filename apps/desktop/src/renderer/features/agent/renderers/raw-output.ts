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
//   - plain result object ({exitCode,stdout})→ pretty-print, but skip base64
//                                              payloads + oversized envelopes
// ──────────────────────────────────────────────────────────

export const RAW_OUTPUT_MAX = 20_000;

/** Coerce a tool's raw output into a displayable string, or null when there
 *  is nothing human-readable (so the caller falls through to rawInput). */
export function asDisplayString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.length > 0 ? clip(value) : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const text = readableTextFromArray(value);
    return text.length > 0 ? clip(text) : null;
  }
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value, null, 2);
      if (!s || s === "{}" || s === "null") return null;
      // Skip binary/base64 blobs and oversized protocol envelopes — noise,
      // not output the user wants to read.
      if (/"(?:data|blob|base64)"\s*:\s*"[A-Za-z0-9+/=\\]{200,}"/.test(s)) {
        return null;
      }
      if (s.length > RAW_OUTPUT_MAX) return null;
      return s;
    } catch {
      return null;
    }
  }
  return null;
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
