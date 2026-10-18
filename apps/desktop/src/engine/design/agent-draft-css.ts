// ──────────────────────────────────────────────────────────
// In-flight Design stylesheet text for live previews
// ──────────────────────────────────────────────────────────
//
// While an agent writes `tokens.css` or a page stylesheet, live frames that
// link it show the CSS received so far. A rule still being written never
// applies, and a rewrite that has not reached a rule yet keeps that rule's
// saved form, so frames never lose styling mid-stream.

/** The longest prefix of streaming CSS that ends after a complete top-level
 * rule or statement. Strings, escapes and comments are respected; an
 * unfinished comment ends the prefix before it. */
export function completeCssPrefix(css: string): string {
  let depth = 0;
  let end = 0;
  let quote: string | null = null;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote || char === "\n") quote = null;
      continue;
    }
    if (char === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      if (close < 0) break;
      index = close + 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0) end = index + 1;
    } else if (char === ";" && depth === 0) end = index + 1;
  }
  return css.slice(0, end);
}

/** The stylesheet text a live preview applies. A finished input is the new
 * file itself. A streaming rewrite follows the saved file with its complete
 * rules, so later rules win where they are rewritten and untouched rules keep
 * their saved form until the save. */
export function designAgentStylesheetPreviewText(
  saved: string | null,
  text: string,
  complete: boolean,
): string {
  if (complete) return text;
  const prefix = completeCssPrefix(text);
  return saved ? `${saved}\n${prefix}` : prefix;
}
