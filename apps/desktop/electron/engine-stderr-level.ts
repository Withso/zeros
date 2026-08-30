export type EngineStderrLevel = "log" | "warn" | "error";

/** The engine process has one byte stderr channel, so Node's console.warn and
 * console.error arrive at Electron without their original severity. Keep the
 * small set of product-owned, successful diagnostics out of app.jsonl's error
 * bucket; unknown stderr remains an error (the conservative default). */
export function classifyEngineStderrLine(line: string): EngineStderrLevel {
  const text = line.trim();

  if (/^\[workspace\] \S+ took \d+ms$/.test(text)) return "warn";
  if (
    /^\[workspace\] (?:slow operations detected|slow-operation summary)\b/.test(
      text,
    )
  ) {
    return "warn";
  }
  if (/^\[zsr\] retired \S+ in \d+ms \(/.test(text)) return "log";
  if (/^\[codex\/binary-resolver\] no bundled codex resolved\b/.test(text)) {
    return "warn";
  }
  if (
    /^\[codex-app-server\] thread\/resume found no rollout\b/.test(text) &&
    /auto-starting a fresh thread$/.test(text)
  ) {
    return "warn";
  }
  if (/^\[cursor-sdk\] first model output after \d+ms\b/.test(text)) {
    return "log";
  }

  // The subprocess transport normalizes host stderr to exactly one
  // [cursor-host] prefix (formatHostStderrLines); older lines could carry two.
  // Strip either one or both before matching.
  const cursor = text.replace(/^(?:\[cursor-host\]\s*)+/, "");
  if (
    /^(?:ready in|workspace prewarmed in) \d+ms\b/.test(cursor) ||
    /^run \S+ first model output after \d+ms\b/.test(cursor) ||
    /^\(set ZEROS_CURSOR_TRANSPORT_DEBUG=1\b/.test(cursor) ||
    /^[∑↳](?:\s|$)/.test(cursor) ||
    /^proxy tunnel .+ connected in \d+ms\b/.test(cursor) ||
    /^slow .+ took \d+ms \((?:ok|connected|tcp-connected|tls-ready|\d{3})\)$/.test(
      cursor,
    )
  ) {
    return "log";
  }
  // @cursor/sdk's own startup notice: it could not load its tree-sitter
  // natives and falls back to unparsed shell analysis. Degraded, not failed —
  // and it prints on every host, so leaving it in the error bucket buried the
  // real ones.
  if (/^shell-parser: tree-sitter natives are unavailable\b/.test(cursor)) {
    return "warn";
  }

  return "error";
}
