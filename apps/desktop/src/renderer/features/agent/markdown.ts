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
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A") {
    const a = node as HTMLAnchorElement;
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
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
  const wrapped = wrapTablesInScroller(raw);
  return DOMPurify.sanitize(wrapped, {
    ADD_ATTR: ["target"],
  });
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

export function renderMarkdownSegments(text: string): MarkdownSegment[] {
  if (!text) return [];
  let input = text;
  if (input.length > MARKDOWN_MAX_INPUT_BYTES) {
    input =
      input.slice(0, MARKDOWN_MAX_INPUT_BYTES) +
      "\n\n*[…content truncated; open the originating tool card for the full output]*";
  }
  const tokens = marked.lexer(input);
  const segments: MarkdownSegment[] = [];
  let prose: Token[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    // Reference-style links ([x][1]) resolve against the lexer's link table at
    // parse time; the table lives on the full token array, so copy it onto the
    // slice or those links would render as literal text.
    const slice = prose as unknown as TokensList;
    slice.links = tokens.links;
    const html = wrapTablesInScroller(marked.parser(slice));
    segments.push({
      type: "html",
      html: DOMPurify.sanitize(linkifyFilePaths(html), {
        ADD_ATTR: ["target"],
      }),
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
 *      `<a>` is dropped). External / non-file links are left untouched (still
 *      `--blue-primary`). Runs before DOMPurify's hook adds target=_blank.
 *   2. Inline `<code>` spans that ARE a file path → chip. Only inline code is
 *      matched: block code is `<pre><code class="language-…">` (has a class, so
 *      the no-attribute match skips it) or `<pre><code>` (skipped by the
 *      lookbehind).
 *
 *  `data-file-path` drives the renderer's click handler; DOMPurify keeps the
 *  class / data-* / role / tabindex by default. */
function linkifyFilePaths(html: string): string {
  let out = html;
  if (out.includes("<a ")) {
    out = out.replace(
      /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
      (full, href: string, inner: string) => {
        const path = fileRefPath(href);
        return path == null ? full : fileChip(path, inner);
      },
    );
  }
  if (out.includes("<code>")) {
    out = out.replace(
      /(?<!<pre>)<code>([^<]+)<\/code>/g,
      (full, inner: string) => {
        const path = fileRefPath(inner);
        return path == null ? full : fileChip(path, inner);
      },
    );
  }
  return out;
}

function fileChip(path: string, inner: string): string {
  return `<code class="zeros-md-filepath" data-file-path="${path}" role="link" tabindex="0">${inner}</code>`;
}
