// ──────────────────────────────────────────────────────────
// markdown — agent-text → safe HTML, streaming-friendly
// ──────────────────────────────────────────────────────────
//
// Parse markdown on every render. Memoization at the renderer level (TextMessage
// + MessageView memo) ensures finalized messages parse exactly
// once; only the actively-streaming message re-parses on each
// chunk. Cost stays flat regardless of transcript length.
//
// Safety: marked output is run through DOMPurify before it
// reaches dangerouslySetInnerHTML. Agent replies sometimes
// contain HTML (intentional or not); sanitisation strips
// `<script>` / event handlers / javascript: URLs, leaving
// only the markdown-derived structure.
//
// Open code blocks (the `\`\`\`` fence hasn't closed yet on a
// streaming chunk) are tolerated by marked — it renders the
// in-flight content as an open code block which resolves
// cleanly once the closing fence lands.
// ──────────────────────────────────────────────────────────

import { marked, type Token, type TokensList } from "marked";
import DOMPurify from "dompurify";
import { fileRefPath } from "./markdown-file-path";
import { isLoopbackUrl } from "@/renderer/shell/workbench/tabs/localhost-url";
import { parseLocalLink } from "@zeros/protocol/local-orchestration";

// Re-exported so callers can keep importing it from the markdown barrel; the
// detection itself lives in markdown-file-path.ts (pure → unit-testable).
export { fileRefPath } from "./markdown-file-path";

// Configure marked once. GFM (tables, strikethrough, task lists)
// enabled because that's what most agent CLIs emit. `breaks: false`
// matches GitHub's behaviour — single newlines do NOT become <br>;
// agents rely on this for multi-line code/JSON without forced breaks.
marked.use({
  gfm: true,
  breaks: false,
});

// Hook DOMPurify to set safe link attributes — we want `target=_blank`
// + `rel=noopener noreferrer` on every <a>, and we want to keep the
// `target` attribute through sanitisation (DOMPurify strips it by
// default since `_blank` can be abused without `rel`). Configured
// once at module load.
// Keep validated Local links outside the DOM until attribute sanitization is
// complete. Raw data attributes must never impersonate renderer-owned links.
const sanitizedLocalLinks = new WeakMap<Node, string>();
DOMPurify.addHook("uponSanitizeElement", (node, _data, config) => {
  if (config.ALLOW_DATA_ATTR !== false || node.nodeName !== "INPUT") return;
  const input = node as HTMLInputElement;
  // GFM task lists are passive checkboxes. Prose cannot add active controls.
  if (input.type !== "checkbox" || !input.disabled) input.remove();
});
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.nodeName === "A" && data.attrName === "href" && parseLocalLink(data.attrValue))
    sanitizedLocalLinks.set(node, data.attrValue);
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A") {
    const a = node as HTMLAnchorElement;
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    const localLink = sanitizedLocalLinks.get(node);
    if (localLink) a.setAttribute("data-local-link", localLink);
    sanitizedLocalLinks.delete(node);
    if (isLoopbackUrl(a.getAttribute("href") ?? "")) a.setAttribute("data-local-preview", "");
  }
});

/** Synchronous-parser resource guard. An agent that accidentally cats a binary
 *  or emits a huge code block as a single message can drag
 *  marked + DOMPurify into a multi-second sync chew that freezes the
 *  renderer. 1MB is well above any natural reply (Claude's
 *  context-window-fill emits ~200KB max) but small enough to keep
 *  parsing cheap. Anything larger is truncated with a marker; the
 *  user can click into the underlying tool call (Read/Bash card) for
 *  the full content. */
const MARKDOWN_MAX_INPUT_BYTES = 1_000_000;

/** Prose has no authority over application styling or named controls. Apply
 * this before adding our own table wrappers/file chips; authored Design HTML
 * uses its separate preview policy. */
function sanitizeProse(html: string): string {
  // Bytes alone do not bound DOM construction: deeply nested raw HTML can
  // make the browser parser quadratic. Charge structural work before parsing.
  let tags = 0;
  let truncated = false;
  for (let index = 0; index < html.length; index++) {
    if (html[index] === "<" && ++tags > 2_048) {
      html = html.slice(0, index);
      truncated = true;
      break;
    }
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
      "ul", "ol", "li", "dl", "dt", "dd", "pre", "code", "a", "img",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
      "em", "strong", "b", "i", "s", "del", "sub", "sup", "kbd", "mark",
      "small", "abbr", "cite", "div", "span", "details", "summary", "input",
    ],
    ALLOWED_ATTR: ["href", "title", "src", "alt", "width", "height", "align", "start", "reversed", "checked", "disabled", "type", "open"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_ATTR: ["target"],
  }) + (truncated ? "<p>[…content truncated; open the originating tool card for the full output]</p>" : "");
}

/** Render markdown text to sanitised HTML. Returns a string suitable
 *  for `dangerouslySetInnerHTML`. The empty / undefined text shortcut
 *  avoids paying the parse cost on placeholder renders. */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  // Truncate pathologically long inputs before they hit marked. We
  // measure character length rather than UTF-8 bytes since the
  // pathological cases (large binary cat, raw logs) are
  // characterwise expensive in either dimension.
  let input = text;
  if (input.length > MARKDOWN_MAX_INPUT_BYTES) {
    input =
      input.slice(0, MARKDOWN_MAX_INPUT_BYTES) +
      "\n\n*[…content truncated; open the originating tool card for the full output]*";
  }
  // marked.parse can return Promise<string> when async extensions are
  // configured. We don't use any, but `async: false` makes the typing
  // explicit and avoids accidental misuse.
  const raw = marked.parse(input, { async: false }) as string;
  return wrapTablesInScroller(sanitizeProse(raw));
}

/** Wrap each `<table>` in a `<div class="zeros-md-table-wrap">` so wide
 *  tables can scroll horizontally without breaking out of the chat
 *  column, AND narrow tables can fill the column via plain `width:
 *  100%` table CSS (see styles/global/runtime-content.css).
 *
 *  Why this exists:
 *
 *   The previous approach put `display: block; overflow-x: auto;
 *   width: 100%` directly on the `<table>`. `display: block` on a
 *   table breaks the inner cell-layout context — cells size to their
 *   content rather than distributing across the table's width — so
 *   3-column tables with short cell text rendered narrow with a big
 *   empty gutter on a wide conversation pane. Moving overflow + border
 *   chrome to the wrapper lets the table itself render with normal
 *   `display: table` semantics, so cells distribute evenly to fill
 *   the column.
 *
 *  Implementation notes:
 *
 *   - Regex over HTML is OK here because marked's output is
 *     deterministic — `<table>` always appears as the literal opening
 *     tag (no attributes from GFM tables), and `</table>` is the
 *     closing tag. DOMPurify still sanitises the result downstream.
 *   - `<div>` and the `class` attribute are in DOMPurify's default
 *     allowlist, so the wrapper survives sanitisation without an
 *     explicit `ADD_TAGS` entry.
 *   - No-op if the rendered HTML contains no tables. */
function wrapTablesInScroller(html: string): string {
  if (!html.includes("<table>")) return html;
  return html
    .replace(/<table>/g, '<div class="zeros-md-table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

// ──────────────────────────────────────────────────────────
// Segmented rendering — agent-chat output
// ──────────────────────────────────────────────────────────
//
// The chat surface wants two things a single HTML string can't give:
//
//   1. Code FENCES rendered as React <MarkdownCodeBlock> — shiki
//      highlighting (the shared github-dark-default theme), a bordered
//      card, and a hover copy button — instead of an inert <pre>.
//   2. Inline file paths (`src/foo.ts`) turned into clickable chips that
//      open the file in workbench.
//
// renderMarkdownSegments splits the message at TOP-LEVEL code blocks. Each
// prose run is parsed + sanitised exactly like renderMarkdown (so every
// existing `.zeros-agent-md` style still holds), and each fence becomes a
// `{type:"code"}` segment the renderer mounts as a component. Code nested
// inside a list / blockquote is NOT a top-level token, so it stays inline in
// the prose HTML (styled <pre>) and its surrounding structure is preserved.
// renderMarkdown (string) is left untouched for its other callers (file
// viewer .md preview, plan-mode + subagent cards).

export type MarkdownSegment =
  | { type: "html"; html: string }
  | { type: "code"; lang: string; code: string };

/** One active Local message owns this parser; completed/hidden messages drop it. */
export function createStreamingMarkdownRenderer(): (text: string) => MarkdownSegment[] {
  let previousInput = "";
  let previousSegments: MarkdownSegment[] = [];
  let prefixChars = 0;
  let prefix: MarkdownSegment[] = [];
  return (text) => {
    const input = markdownSegmentInput(text);
    if (input === previousInput) return previousSegments;
    if (!input.startsWith(previousInput) || input.includes("\r")) {
      prefixChars = 0;
      prefix = [];
    }
    const tokens = marked.lexer(input.slice(prefixChars));
    // A top-level, closed fence followed by a newline cannot be extended by
    // later prose. Reference links are different: a later definition can alter
    // earlier prose, so any bracket-bearing prose keeps that suffix reparsable.
    // Definitions do not have raw tokens; never use raw offsets past one.
    let safe = !input.includes("\r") && Object.keys(tokens.links).length === 0;
    let consumed = 0, stableEnd = 0, stableChars = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      consumed += token.raw.length;
      if (token.type !== "code" && token.raw.includes("[")) safe = false;
      if (safe && token.type === "code" &&
          input[prefixChars + consumed] === "\n" && closedFence(token.raw)) {
        stableEnd = index + 1;
        stableChars = consumed;
      }
    }
    const slice = (start: number, end?: number): TokensList => {
      const part = tokens.slice(start, end) as TokensList;
      part.links = tokens.links;
      return part;
    };
    if (stableEnd) {
      prefix = [...prefix, ...renderMarkdownTokenSegments(slice(0, stableEnd))];
      prefixChars += stableChars;
    }
    const tail = renderMarkdownTokenSegments(stableEnd ? slice(stableEnd) : tokens);
    previousInput = input;
    previousSegments = prefix.length ? [...prefix, ...tail] : tail;
    return previousSegments;
  };
}

function closedFence(raw: string): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(raw);
  if (!opening) return false;
  const fence = opening[1];
  return new RegExp(`\\n {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(raw);
}

function markdownSegmentInput(text: string): string {
  return text.length > MARKDOWN_MAX_INPUT_BYTES
    ? text.slice(0, MARKDOWN_MAX_INPUT_BYTES) +
      "\n\n*[…content truncated; open the originating tool card for the full output]*"
    : text;
}

export function renderMarkdownSegments(text: string): MarkdownSegment[] {
  if (!text) return [];
  return renderMarkdownTokenSegments(marked.lexer(markdownSegmentInput(text)));
}

function renderMarkdownTokenSegments(tokens: TokensList): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let prose: Token[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    // Reference-style links ([x][1]) resolve against the lexer's link table at
    // parse time; the table lives on the full token array, so copy it onto the
    // slice or those links would render as literal text.
    const slice = prose as unknown as TokensList;
    slice.links = tokens.links;
    const html = wrapTablesInScroller(sanitizeProse(marked.parser(slice)));
    segments.push({
      type: "html",
      html: linkifyFilePaths(html),
    });
    prose = [];
  };
  for (const tok of tokens) {
    if (tok.type === "code") {
      flushProse();
      segments.push({
        type: "code",
        lang: typeof tok.lang === "string" ? tok.lang.trim() : "",
        code: tok.text ?? "",
      });
    } else {
      prose.push(tok);
    }
  }
  flushProse();
  return segments;
}

/** Rewrite file references into clickable chips so a path looks identical
 *  whether the agent wrote it as inline code or as a markdown link — and a file
 *  link never renders as a bare `--blue-primary` blue `<a>`. Two passes:
 *
 *   1. `[name](path)` links whose href is a workspace file → chip (the original
 *      `<a>` is dropped). External / non-file links retain their anchors. Runs before DOMPurify's hook adds target=_blank.
 *   2. Inline `<code>` spans that ARE a file path → chip. Only inline code is
 *      matched: block code is `<pre><code class="language-…">` (has a class, so
 *      the no-attribute match skips it) or `<pre><code>` (skipped by the
 *      protected preformatted section).
 *
 *  `data-file-path` drives the renderer's click handler; DOMPurify keeps the
 *  class / data-* / role / tabindex by default. */
function linkifyFilePaths(html: string): string {
  // Work on sanitized, normalized HTML. Each section is visited once; a
  // missing closer ends the scan instead of retrying every later opener.
  const tags = /<(a|pre|code)\b[^>]*>/g;
  const chunks: string[] = [];
  let offset = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    const tag = match[1];
    const end = html.indexOf(`</${tag}>`, tags.lastIndex);
    if (end < 0) break;
    const next = end + tag.length + 3;
    const inner = html.slice(tags.lastIndex, end);
    let replacement: string | null = null;
    if (tag === "a") {
      const href = /\shref="([^"]*)"/.exec(match[0])?.[1];
      const file = href === undefined ? null : fileRefPath(decodeLinkText(href), true);
      if (file) replacement = fileChip(file, inner);
    } else if (tag === "code" && match[0] === "<code>" && !inner.includes("<")) {
      const file = fileRefPath(decodeLinkText(inner));
      if (file) replacement = fileChip(file, inner);
    }
    chunks.push(html.slice(offset, match.index), replacement ?? html.slice(match.index, next));
    offset = next;
    tags.lastIndex = next;
  }
  chunks.push(html.slice(offset));
  return chunks.join("");
}

function decodeLinkText(value: string): string {
  if (!value.includes("&")) return value;
  const element = document.createElement("textarea");
  element.innerHTML = value;
  return element.value;
}

function fileChip(path: string, inner: string): string {
  const escaped = path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<code class="zeros-md-filepath" data-file-path="${escaped}" title="${escaped}" role="link" tabindex="0">${inner.replace(/^<code>([\s\S]*)<\/code>$/, "$1")}</code>`;
}
