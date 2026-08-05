// ──────────────────────────────────────────────────────────
// Shared syntax highlighter — shiki singleton, lazy-loaded
// ──────────────────────────────────────────────────────────
//
// Edit and Read cards need code highlighting. Shiki runs off the main thread
// in a Web Worker (./syntax.worker.ts)
// so a long streaming response with many code blocks doesn't pin the
// main thread. The `highlightCode` async signature is unchanged so
// callers don't need to know.
//
// Fallback paths (in order):
//   1. Web Worker via `new Worker(new URL("./syntax.worker.ts", …))`
//      — primary path under Vite + Electron.
//   2. Main-thread shiki — if Worker construction fails (test
//      harness, jsdom, server-render). Same singleton pattern.
//   3. Plain `<pre>` — if the language isn't loaded or shiki
//      isn't available at all.
//
// Lazy-init pattern: shiki + grammars are big, so we don't import
// them on the initial paint of agent-chat.tsx. The first call to
// highlightCode() spawns the worker (or main-thread highlighter)
// and stashes the promise. Subsequent calls reuse it.
// ──────────────────────────────────────────────────────────

// `shiki` types are imported as type-only so the dynamic
// import below is the only thing that pulls in runtime code.
import type { Highlighter, ThemedToken, BundledLanguage } from "shiki";
import { getPrefs } from "@/renderer/shared/theme/store";
import { resolveCodeTheme } from "@/renderer/shared/theme/code-themes";

/** Languages we ship in the singleton. Adding more here costs
 *  bundle size (shiki grammars are TextMate JSON, ~30-100KB
 *  each gzipped). Keep this list tight and let `getLang()`
 *  fall back to `text` for anything we haven't pre-loaded. */
const LANGUAGES = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "bash",
  "shell",
  "css",
  "scss",
  "html",
  "markdown",
  "python",
  "rust",
  "go",
  "yaml",
  "toml",
  "sql",
  "sh",
] as const;

/** The active Shiki theme name, resolved LIVE from the user's codeTheme setting
 *  so a theme switch takes effect on the next highlight. */
function currentThemeName(): string {
  return resolveCodeTheme(getPrefs().codeTheme).shiki;
}

/** Ensure `theme` is loaded into the highlighter before use (shiki loads bundled
 *  themes on demand). Safe to call repeatedly. */
async function ensureTheme(hl: Highlighter, theme: string): Promise<void> {
  if (!hl.getLoadedThemes().includes(theme)) {
    await hl.loadTheme(theme as Parameters<typeof hl.loadTheme>[0]);
  }
}

// ─── result cache (shared by the sync + async paths) ──────
// Highlighting the same (code, lang) twice — a re-render, a file re-open, a
// scroll that remounts a row — should be instant, not another worker round-trip.
// Capped LRU-ish: oldest entry evicted past the cap; pathologically large inputs
// aren't cached (one-off cost, keeps the map small).
// Cap the INPUT we cache (anything larger highlights in the worker off the main
// thread — see SYNC_HL_MAX); bound the TOTAL cached HTML by bytes so RAM stays
// flat regardless of file sizes (the user cares about memory).
const HTML_CACHE_MAX_INPUT = 300_000;
const HTML_CACHE_MAX_BYTES = 8_000_000;
// Above this input length, codeToHtml blocks the main thread for hundreds of ms
// — defer to the worker so opening a big file stays snappy.
const SYNC_HL_MAX = 50_000;
const htmlCache = new Map<string, string>();
let htmlCacheBytes = 0;

// Separator is a plain SPACE, not a NUL: shiki theme + language ids come from a
// fixed registry and never contain whitespace, so a space is just as
// collision-proof — and a NUL byte anywhere in this file makes git treat the
// whole module as binary (unreviewable diffs) and trips tooling that assumes
// UTF-8 text.
function cacheKey(code: string, lang: string, theme: string): string {
  return `${theme} ${lang} ${code}`;
}
/** What one entry really pins: the key string embeds the entire source (up to
 *  HTML_CACHE_MAX_INPUT chars), so charging only the HTML would let true usage
 *  run about twice the stated byte budget. */
function entryBytes(key: string, html: string): number {
  return key.length + html.length;
}
function cacheGet(
  code: string,
  lang: string,
  theme: string,
): string | undefined {
  return htmlCache.get(cacheKey(code, lang, theme));
}
function cachePut(
  code: string,
  lang: string,
  theme: string,
  html: string,
): void {
  if (code.length > HTML_CACHE_MAX_INPUT) return;
  const key = cacheKey(code, lang, theme);
  const prev = htmlCache.get(key);
  if (prev !== undefined) {
    htmlCacheBytes -= entryBytes(key, prev);
    htmlCache.delete(key);
  }
  htmlCache.set(key, html);
  htmlCacheBytes += entryBytes(key, html);
  // Evict oldest (insertion order) until back under the byte budget.
  while (htmlCacheBytes > HTML_CACHE_MAX_BYTES && htmlCache.size > 1) {
    const oldest = htmlCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = htmlCache.get(oldest);
    if (evicted !== undefined) htmlCacheBytes -= entryBytes(oldest, evicted);
    htmlCache.delete(oldest);
  }
}

// ─── token cache (the editor's Shiki color layer) ─────────
//
// The CodeMirror editor paints from shiki TOKENS rather than HTML, and it needs
// them SYNCHRONOUSLY while its EditorState is built so the first painted frame
// is already themed instead of flashing plain text (see
// code-editor/shiki-highlight.ts). Tokenizing a ~950-line TSX file costs ~25ms,
// so switching back to a file you just had open must not pay it again — hence
// this cache.
//
// Keyed by the code STRING itself (outer map) so the key costs no extra
// allocation the way `${theme} ${lang} ${code}` would, then by theme+lang
// (inner, almost always a single entry). Bounded by the total retained TOKEN
// count, which is what actually drives the memory.
const TOKEN_CACHE_MAX_INPUT = 200_000;
const TOKEN_CACHE_MAX_TOKENS = 60_000;
/** Full main-thread tokenization stays inside ~40ms up to this input size.
 *  Bigger files tokenize their LEADING lines synchronously (an instantly themed
 *  viewport) and get the complete pass right after. */
export const SYNC_TOKENIZE_MAX = 60_000;

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg?: string;
  bg?: string;
  /** True when `tokens` cover only the LEADING lines of `code` — a big file's
   *  first paint. The caller keeps its async full pass. */
  partial?: boolean;
}

const tokenCache = new Map<string, Map<string, TokenizedCode>>();
let tokenCacheTokens = 0;

/** Inner-map key: theme + language (see the cacheKey note on the separator). */
function tokenVariantKey(lang: string, theme: string): string {
  return `${theme} ${lang}`;
}

function countTokens(tokens: ThemedToken[][]): number {
  let n = 0;
  for (const line of tokens) n += line.length;
  return n;
}

function tokenCacheGet(
  code: string,
  lang: string,
  theme: string,
): TokenizedCode | undefined {
  const byVariant = tokenCache.get(code);
  if (!byVariant) return undefined;
  const hit = byVariant.get(tokenVariantKey(lang, theme));
  if (hit) {
    // Refresh recency: a file the user keeps returning to stays hot.
    tokenCache.delete(code);
    tokenCache.set(code, byVariant);
  }
  return hit;
}

function tokenCachePut(
  code: string,
  lang: string,
  theme: string,
  value: TokenizedCode,
): void {
  // Head-only paints are cheap to redo and must never shadow the full pass.
  if (value.partial) return;
  if (code.length > TOKEN_CACHE_MAX_INPUT) return;
  const variant = tokenVariantKey(lang, theme);
  let byVariant = tokenCache.get(code);
  if (byVariant) {
    tokenCache.delete(code);
    const prev = byVariant.get(variant);
    if (prev) tokenCacheTokens -= countTokens(prev.tokens);
  } else {
    byVariant = new Map();
  }
  byVariant.set(variant, value);
  tokenCache.set(code, byVariant);
  tokenCacheTokens += countTokens(value.tokens);
  // Evict oldest (insertion order) until back under the token budget.
  while (tokenCacheTokens > TOKEN_CACHE_MAX_TOKENS && tokenCache.size > 1) {
    const oldest = tokenCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = tokenCache.get(oldest);
    if (evicted) {
      for (const entry of evicted.values())
        tokenCacheTokens -= countTokens(entry.tokens);
    }
    tokenCache.delete(oldest);
  }
}

/** Index of the `n`-th `\n` in `s`, or -1 when there are fewer than `n`. Slices
 *  the leading lines without splitting the whole (possibly huge) string. */
export function nthNewlineIndex(s: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = s.indexOf("\n", idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

// ─── Worker path (primary) ────────────────────────────────

interface WorkerResponse {
  id: number;
  html: string | null;
  error?: string;
}

let workerPromise: Promise<Worker | null> | null = null;
const pendingWorkerCalls = new Map<
  number,
  { resolve: (html: string | null) => void; reject: (err: Error) => void }
>();
let nextWorkerCallId = 0;

/** Lazy-create the worker. Returns null when Worker isn't usable in
 *  this environment (tests, jsdom). The caller falls back to the
 *  main-thread path. */
function getWorker(): Promise<Worker | null> {
  if (!workerPromise) {
    workerPromise = (async () => {
      try {
        if (typeof Worker === "undefined") return null;
        const worker = new Worker(
          new URL("./syntax.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.addEventListener(
          "message",
          (e: MessageEvent<WorkerResponse>) => {
            const { id, html, error } = e.data;
            const pending = pendingWorkerCalls.get(id);
            if (!pending) return;
            pendingWorkerCalls.delete(id);
            if (error) pending.reject(new Error(error));
            else pending.resolve(html);
          },
        );
        worker.addEventListener("error", (e) => {
          // A worker-level error breaks all in-flight calls. Fail
          // them so callers can fall back to plain-pre rendering.
          const err = new Error(`syntax worker error: ${e.message}`);
          for (const [, pending] of pendingWorkerCalls) pending.reject(err);
          pendingWorkerCalls.clear();
        });
        return worker;
      } catch {
        // Worker construction failed (CSP, file URL, jsdom) — null
        // signals "use main-thread fallback".
        return null;
      }
    })();
  }
  return workerPromise;
}

// ─── Main-thread highlighter (also powers the SYNC path) ──
//
// Once this is loaded, `highlightSync` can colorize on the spot — no worker
// round-trip, so views render highlighted on FIRST paint with no white flash.
// `warmHighlighter()` loads it at idle; until then callers fall back to the
// async worker path + a plain placeholder.

let highlighterPromise: Promise<Highlighter> | null = null;
let mainHighlighter: Highlighter | null = null;

function loadHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const shiki = await import("shiki");
      const hl = await shiki.createHighlighter({
        themes: [currentThemeName()],
        langs: [...LANGUAGES],
      });
      mainHighlighter = hl;
      return hl;
    })();
  }
  return highlighterPromise;
}

/** Preload the main-thread highlighter so subsequent highlights are synchronous
 *  (zero async frames → no flash). Idempotent; safe to call eagerly at idle. */
export function warmHighlighter(): Promise<void> {
  return loadHighlighter().then(
    () => undefined,
    () => undefined,
  );
}

/** Synchronous highlight. Returns the cached/instantly-rendered HTML once the
 *  highlighter is warm; `null` while it's still cold (the caller shows a plain
 *  placeholder and awaits `highlightCode`). `text` and unknown langs return the
 *  plain `<pre>` shape so the caller can render it identically. */
export function highlightSync(
  code: string,
  lang: string,
  theme: string = currentThemeName(),
): string | null {
  if (lang === "text") return wrapPlain(code);
  const hit = cacheGet(code, lang, theme);
  if (hit) return hit;
  if (!mainHighlighter) return null;
  if (!mainHighlighter.getLoadedLanguages().includes(lang))
    return wrapPlain(code);
  // Theme not loaded yet (e.g. just switched) → null routes the caller to the
  // async path, which loads the theme before highlighting.
  if (!mainHighlighter.getLoadedThemes().includes(theme)) return null;
  // Big file → don't block the main thread; null sends the caller to the worker
  // (it renders plain, then swaps in colour when the async result lands).
  if (code.length > SYNC_HL_MAX) return null;
  try {
    const html = mainHighlighter.codeToHtml(code, { lang, theme });
    cachePut(code, lang, theme, html);
    return html;
  } catch {
    return wrapPlain(code);
  }
}

/** Map a file path or extension to a shiki language id. Falls back
 *  to `text` (no highlighting, just `<pre>` output) for unknowns. */
export function getLang(pathOrExt: string | null | undefined): string {
  if (!pathOrExt) return "text";
  const lower = pathOrExt.toLowerCase();
  // Strip trailing slash + everything after a `?` (URL-like inputs).
  const ext = lower.split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "json":
    case "css":
    case "scss":
    case "html":
    case "md":
    case "py":
    case "rs":
    case "go":
    case "yaml":
    case "yml":
    case "toml":
    case "sql":
      return ext === "md"
        ? "markdown"
        : ext === "py"
          ? "python"
          : ext === "rs"
            ? "rust"
            : ext === "yml"
              ? "yaml"
              : ext;
    case "sh":
    case "zsh":
    case "bash":
      return "bash";
    default:
      return "text";
  }
}

/** Render `code` to HTML. Returns the original text wrapped in a
 *  `<pre>` if the language isn't loaded yet (first-paint case) or
 *  is `text`. The DOM consumer drops the HTML in via
 *  `dangerouslySetInnerHTML` — shiki escapes everything itself, so
 *  this is safe.
 *
 *  The primary path runs through the Web Worker
 *  (off the main thread); falls back to main-thread shiki if the
 *  worker can't be created (test harness, etc.). */
export async function highlightCode(
  code: string,
  lang: string,
  theme: string = currentThemeName(),
): Promise<string> {
  if (lang === "text") return wrapPlain(code);

  const hit = cacheGet(code, lang, theme);
  if (hit) return hit;

  // If the main-thread highlighter is already warm, colorize synchronously —
  // skips the worker round-trip entirely (and its extra render frame).
  if (mainHighlighter) {
    const sync = highlightSync(code, lang, theme);
    if (sync !== null) return sync;
  }

  // Worker path (primary for the cold start). The active theme rides every
  // message; the worker loads it on demand.
  try {
    const worker = await getWorker();
    if (worker) {
      const id = nextWorkerCallId++;
      const html = await new Promise<string | null>((resolve, reject) => {
        pendingWorkerCalls.set(id, { resolve, reject });
        worker.postMessage({ id, code, lang, theme });
      });
      if (html === null) return wrapPlain(code); // language not loaded
      cachePut(code, lang, theme, html);
      return html;
    }
  } catch {
    // Worker call failed mid-flight — fall through to main-thread.
  }

  // Main-thread fallback.
  try {
    const hl = await loadHighlighter();
    if (!hl.getLoadedLanguages().includes(lang)) return wrapPlain(code);
    await ensureTheme(hl, theme);
    const html = hl.codeToHtml(code, { lang, theme });
    cachePut(code, lang, theme, html);
    return html;
  } catch {
    return wrapPlain(code);
  }
}

/** Tokenize on the spot with an already-prepared highlighter, caching the
 *  result. `partial` marks a head-only slice (never cached). */
function tokenizeNow(
  hl: Highlighter,
  code: string,
  shikiLang: string,
  theme: string,
  partial: boolean,
): TokenizedCode | null {
  try {
    const { tokens, fg, bg } = hl.codeToTokens(code, {
      lang: shikiLang as BundledLanguage,
      theme,
    });
    const out: TokenizedCode = partial
      ? { tokens, fg, bg, partial: true }
      : { tokens, fg, bg };
    tokenCachePut(code, shikiLang, theme, out);
    return out;
  } catch {
    return null;
  }
}

/** Load the shared highlighter and make sure `shikiLang` + `theme` are both in
 *  it. Null when shiki is unavailable or the grammar isn't in its bundle. */
async function prepareTokenizer(
  shikiLang: string,
  theme: string,
): Promise<Highlighter | null> {
  try {
    const hl = await loadHighlighter();
    if (!hl.getLoadedLanguages().includes(shikiLang)) {
      try {
        await hl.loadLanguage(
          shikiLang as Parameters<typeof hl.loadLanguage>[0],
        );
      } catch {
        return null; // language not in shiki's bundle
      }
    }
    await ensureTheme(hl, theme);
    return hl;
  } catch {
    return null;
  }
}

/** SYNCHRONOUS tokenize for the editor's first paint — the whole point is that
 *  a file opens already wearing the code theme instead of flashing the chrome
 *  foreground and repainting. Returns null (caller falls back to the async pass)
 *  when a cache miss can't be served on the spot:
 *    • the shared highlighter is still cold (see warmHighlighter / prewarmSyntax),
 *    • the grammar or theme isn't loaded yet,
 *    • the input is above SYNC_TOKENIZE_MAX and `headLines` is unset or the file
 *      has fewer than that many lines (minified: one enormous line).
 *  With `headLines` a too-large input tokenizes just its leading lines and comes
 *  back `partial` — enough to theme the viewport in ~5ms. */
export function tokenizeSync(
  code: string,
  shikiLang: string | null,
  theme: string,
  opts?: { headLines?: number },
): TokenizedCode | null {
  if (!shikiLang || shikiLang === "text") return null;
  const hit = tokenCacheGet(code, shikiLang, theme);
  if (hit) return hit;
  const hl = mainHighlighter;
  if (!hl) return null;
  if (!hl.getLoadedLanguages().includes(shikiLang)) return null;
  if (!hl.getLoadedThemes().includes(theme)) return null;
  if (code.length > SYNC_TOKENIZE_MAX) {
    const headLines = opts?.headLines ?? 0;
    if (headLines <= 0) return null;
    const cut = nthNewlineIndex(code, headLines);
    if (cut === -1) return null; // fewer lines than the budget → nothing cheap to slice
    return tokenizeNow(hl, code.slice(0, cut), shikiLang, theme, true);
  }
  return tokenizeNow(hl, code, shikiLang, theme, false);
}

/** Tokenize `code` for the CodeMirror editor's Shiki color layer. Ensures the
 *  language + theme are loaded into the shared main-thread highlighter, then
 *  returns shiki's themed tokens (per line; absolute UTF-16 offsets that match
 *  CodeMirror positions) plus the theme foreground/background. Returns null when
 *  the language is unknown to shiki or highlighting fails (the editor then shows
 *  plain text and keeps its Lezer structure). */
export async function highlightToTokens(
  code: string,
  shikiLang: string,
  theme: string,
): Promise<TokenizedCode | null> {
  if (!shikiLang || shikiLang === "text") return null;
  const hit = tokenCacheGet(code, shikiLang, theme);
  if (hit && !hit.partial) return hit;
  const hl = await prepareTokenizer(shikiLang, theme);
  if (!hl) return null;
  return tokenizeNow(hl, code, shikiLang, theme, false);
}

// ─── Prewarm ──────────────────────────────────────────────
//
// tokenizeSync can only answer once the grammar + theme are in the shared
// highlighter, so the surfaces that know a file is ABOUT to open (the tree
// click, the Changes row, workspace intent prefetch) warm the exact pair while
// the file's own read IPC is still in flight. By the time the editor mounts, its
// first paint is themed.

const prewarmedVariants = new Map<string, Promise<void>>();
const MAX_PREWARMED_VARIANTS = 256;

/** Warm the shared highlighter for one (language, theme) pair. Idempotent and
 *  deduplicated — repeat calls join the first attempt's promise, including a
 *  failed one (a grammar missing from shiki's bundle is permanent; retrying it
 *  on every hover would just re-import for nothing). A null/`text` language
 *  still warms the highlighter itself. */
export function prewarmSyntax(
  shikiLang: string | null,
  theme: string = currentThemeName(),
): Promise<void> {
  if (!shikiLang || shikiLang === "text") return warmHighlighter();
  const key = tokenVariantKey(shikiLang, theme);
  let pending = prewarmedVariants.get(key);
  if (!pending) {
    pending = prepareTokenizer(shikiLang, theme).then(
      () => undefined,
      () => undefined,
    );
    prewarmedVariants.set(key, pending);
    while (prewarmedVariants.size > MAX_PREWARMED_VARIANTS) {
      const oldest = prewarmedVariants.keys().next().value;
      if (oldest === undefined) break;
      prewarmedVariants.delete(oldest);
    }
  }
  return pending;
}

// ─── Theme colors (bg / fg / ANSI palette) ────────────────
//
// Some surfaces need MORE than per-token spans: the terminal wants the theme's
// 16-color ANSI palette (terminal-session-view), and the editor's Shiki layer
// paints the theme's base foreground for uncolored text (shiki-highlight.ts).
// Both read from the shared highlighter's RESOLVED theme registration, which
// shiki exposes via `getTheme(name)` once the theme is loaded.

/** xterm ANSI slots, in xterm's own theme-key order. */
export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeColors {
  /** Theme editor background (shiki `bg`). */
  bg: string;
  /** Theme editor foreground (shiki `fg`). */
  fg: string;
  /** Light vs dark — drives whether a surface repaints its bg. */
  type: "light" | "dark";
  /** 16-color ANSI palette when the theme defines `terminal.ansi*`; null when it
   *  doesn't (caller then lets xterm use its built-in ANSI defaults). */
  ansi: AnsiPalette | null;
}

/** xterm slot → VS Code theme color key. Every shiki bundled theme we ship was
 *  verified to define all 16 (see scripts/check + the audit), but we still fail
 *  safe to null if any are missing. */
const ANSI_KEYS: ReadonlyArray<readonly [keyof AnsiPalette, string]> = [
  ["black", "terminal.ansiBlack"],
  ["red", "terminal.ansiRed"],
  ["green", "terminal.ansiGreen"],
  ["yellow", "terminal.ansiYellow"],
  ["blue", "terminal.ansiBlue"],
  ["magenta", "terminal.ansiMagenta"],
  ["cyan", "terminal.ansiCyan"],
  ["white", "terminal.ansiWhite"],
  ["brightBlack", "terminal.ansiBrightBlack"],
  ["brightRed", "terminal.ansiBrightRed"],
  ["brightGreen", "terminal.ansiBrightGreen"],
  ["brightYellow", "terminal.ansiBrightYellow"],
  ["brightBlue", "terminal.ansiBrightBlue"],
  ["brightMagenta", "terminal.ansiBrightMagenta"],
  ["brightCyan", "terminal.ansiBrightCyan"],
  ["brightWhite", "terminal.ansiBrightWhite"],
];

/** Pull bg / fg / type / ANSI from a resolved shiki theme registration. Exported
 *  for unit testing with a synthetic registration (no highlighter load). */
export function extractThemeColors(reg: {
  bg?: string;
  fg?: string;
  type?: string;
  colors?: Record<string, string>;
}): ThemeColors {
  const colors = reg.colors ?? {};
  const ansi = {} as AnsiPalette;
  let complete = true;
  for (const [slot, key] of ANSI_KEYS) {
    const v = colors[key];
    if (typeof v === "string" && v.length > 0) ansi[slot] = v;
    else {
      complete = false;
      break;
    }
  }
  return {
    bg: reg.bg ?? "",
    fg: reg.fg ?? "",
    type: reg.type === "light" ? "light" : "dark",
    ansi: complete ? ansi : null,
  };
}

/** Theme colors if the theme is ALREADY loaded in the warm highlighter; null
 *  while it's cold (the caller awaits ensureThemeColors). Synchronous — a warm
 *  consumer (most paints) gets the colors during render with no async frame. */
export function getThemeColorsSync(theme: string): ThemeColors | null {
  if (!mainHighlighter) return null;
  if (!mainHighlighter.getLoadedThemes().includes(theme)) return null;
  try {
    return extractThemeColors(mainHighlighter.getTheme(theme));
  } catch {
    return null;
  }
}

/** Ensure the shared highlighter + theme are loaded, then return the theme's
 *  colors. Null only when shiki is unavailable (tests/SSR) or the theme fails to
 *  load — callers fall back to their token-based defaults. */
export async function ensureThemeColors(
  theme: string,
): Promise<ThemeColors | null> {
  try {
    const hl = await loadHighlighter();
    await ensureTheme(hl, theme);
    return extractThemeColors(hl.getTheme(theme));
  } catch {
    return null;
  }
}

/** Plain `<pre>` shape (escaped, no highlighting) — the placeholder a consumer
 *  renders while the highlighter is still cold. Mirrors shiki's wrapper so the
 *  surrounding CSS targets bind identically. */
export function plainCode(code: string): string {
  return wrapPlain(code);
}

function wrapPlain(code: string): string {
  // Mirror shiki's wrapping shape so the parent's CSS targets work
  // identically whether highlighted or not.
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre class="shiki"><code>${escaped}</code></pre>`;
}

// Warm the highlighter at idle (renderer only) so the first file open / tool
// expand renders highlighted on first paint instead of flashing plain. The
// `timeout` matters: without it a busy startup can defer idle work for seconds,
// and every file opened in that window paints unthemed first. Guarded so it
// no-ops in the worker, in tests (jsdom), and during SSR.
if (
  typeof window !== "undefined" &&
  typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback ===
    "function"
) {
  (
    window as unknown as {
      requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void;
    }
  ).requestIdleCallback(
    () => {
      void warmHighlighter();
    },
    { timeout: 2_000 },
  );
}
