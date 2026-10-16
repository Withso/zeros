import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import { designCssUrlReferences } from "@zeros/design-web";
import { zerosChannelDataDir } from "../db/paths";
import { DESIGN_FONT_MIME_TYPES } from "./assets";
import { readSafeRegularFile } from "./safe-files";

// App fonts for Design frames. Fonts the application loads from Google
// Fonts — a CSS @import of fonts.googleapis.com inside a style source, or a
// font a Next.js layout loads with next/font/google that meta/canvas.json
// `fonts` declares — download once from Google's two font hosts into one
// cache every workspace on this machine shares, then embed like local fonts.
// Fonts stored in the checkout (`provider: "local"`) are read from it.
// Rendering never waits for the network: frames show the fallback font until
// a download lands, then the canvas refreshes. Downloaded CSS stays on disk;
// memory keeps only each URL's state, and callers memoize what they embed.

const GOOGLE_CSS_HOST = "fonts.googleapis.com";
const GOOGLE_FONT_HOST = "fonts.gstatic.com";
const MAX_FONT_CSS_BYTES = 512 * 1024;
export const MAX_DESIGN_FONT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REMEMBERED_URLS = 128;
const MAX_DECLARED_FONTS = 32;
// Google serves woff2 with unicode-range subsets to current browsers only.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/;
const VARIABLE = /^--[A-Za-z0-9_-]{1,128}$/;
const WEIGHTS = /^(?:\d{3}(?:\.\.\d{3})?)(?:;\d{3}(?:\.\.\d{3})?)*$/;
const SUBSET = /^[a-z][a-z0-9-]{0,40}$/;

export type DesignFontState =
  | { state: "ready"; css: string; bytes: number }
  | { state: "pending" }
  | { state: "failed"; error: string };
type RememberedState = { state: "ready" } | Exclude<DesignFontState, { state: "ready" }>;

export interface DesignFontDeclaration {
  family: string;
  provider: "google" | "local";
  /** The custom property the application sets, such as next/font's
   * `--font-geist-sans`; frames receive it naming this family. */
  variable?: string;
  /** Google: "400;700" or a variable range "100..900". */
  weights?: string;
  italic?: boolean;
  /** Google: the subsets to embed (default latin). */
  subsets?: string[];
  /** Local: a font file inside the checkout. */
  path?: string;
  weight?: string;
  style?: "normal" | "italic";
  fallback?: string;
}

export interface DesignFontCatalog {
  fonts: DesignFontDeclaration[];
  errors: string[];
}

/** meta/canvas.json `fonts`, without failing the canvas. */
export function readDesignFontCatalog(canvas: object): DesignFontCatalog {
  const raw = (canvas as Record<string, unknown>).fonts;
  if (raw === undefined) return { fonts: [], errors: [] };
  if (!Array.isArray(raw)) return { fonts: [], errors: ["meta/canvas.json `fonts` must be a list."] };
  const fonts: DesignFontDeclaration[] = [];
  const errors: string[] = [];
  for (const [index, entry] of raw.slice(0, MAX_DECLARED_FONTS).entries()) {
    const value = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const family = typeof value?.family === "string" ? value.family.trim() : "";
    const provider = value?.provider;
    if (!value || !FAMILY.test(family) || (provider !== "google" && provider !== "local")) {
      errors.push(`Font ${index + 1} needs a family (letters, digits, spaces, _ or -) and a provider, "google" or "local".`);
      continue;
    }
    const variable = typeof value.variable === "string" && VARIABLE.test(value.variable) ? value.variable : undefined;
    const fallback = typeof value.fallback === "string" && /^[A-Za-z0-9 ,'"_-]{1,200}$/.test(value.fallback) ? value.fallback : undefined;
    if (provider === "google") {
      const weights = typeof value.weights === "string" && WEIGHTS.test(value.weights) ? value.weights : undefined;
      const subsets = Array.isArray(value.subsets) ? value.subsets.filter((subset): subset is string => typeof subset === "string" && SUBSET.test(subset)).slice(0, 8) : undefined;
      fonts.push({ family, provider, ...(variable ? { variable } : {}), ...(weights ? { weights } : {}), ...(value.italic === true ? { italic: true } : {}), ...(subsets?.length ? { subsets } : {}), ...(fallback ? { fallback } : {}) });
      continue;
    }
    const file = typeof value.path === "string" ? value.path : "";
    const extension = path.posix.extname(file).toLowerCase();
    if (!file || file.startsWith("/") || file.split("/").some((part) => part === ".." || part === "" || part === ".git" || part === ".zeros") || !DESIGN_FONT_MIME_TYPES[extension]) {
      errors.push(`Font ${JSON.stringify(family)}: a local font names a .woff2, .woff, .ttf or .otf file inside the repository.`);
      continue;
    }
    fonts.push({
      family, provider, path: file,
      ...(variable ? { variable } : {}),
      ...(typeof value.weight === "string" && /^\d{3}(?: \d{3})?$/.test(value.weight) ? { weight: value.weight } : {}),
      ...(value.style === "italic" || value.style === "normal" ? { style: value.style } : {}),
      ...(fallback ? { fallback } : {}),
    });
  }
  if (raw.length > MAX_DECLARED_FONTS) errors.push(`Only the first ${MAX_DECLARED_FONTS} fonts are used.`);
  return { fonts, errors };
}

/** A Google Fonts stylesheet URL frames may embed. */
export function isGoogleFontsCssUrl(value: string): boolean {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname === GOOGLE_CSS_HOST && /^\/css2?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** The CSS2 API URL for a declared Google font. */
export function googleFontsCssUrl(font: DesignFontDeclaration): string {
  const family = font.family.replace(/ /g, "+");
  const weights = font.weights ?? "400";
  const axes = font.italic
    ? `ital,wght@${weights.split(";").flatMap((weight) => [`0,${weight}`, `1,${weight}`]).join(";")}`
    : `wght@${weights}`;
  return `https://${GOOGLE_CSS_HOST}/css2?family=${family}:${axes}&display=swap`;
}

function normalizedUrl(value: string): string {
  const url = new URL(value.startsWith("//") ? `https:${value}` : value);
  url.protocol = "https:";
  return url.toString();
}

interface Waiters {
  roots: Set<string>;
}
const states = new Map<string, RememberedState>();
const downloads = new Map<string, Promise<void>>();
const waiters = new Map<string, Waiters>();
let onFontsReady: ((roots: readonly string[]) => void) | null = null;
/** Bumps whenever a download starts, lands or fails, so callers can reuse a
 * result built from the same font states. */
let generation = 0;
export function designFontsGeneration(): number {
  return generation;
}
let fetchFont: typeof fetch = (...args) => fetch(...args);
let cacheDirectory: () => string = () => path.join(zerosChannelDataDir(), "design-fonts");

/** The engine refreshes the canvases waiting on a download. */
export function configureDesignFonts(options: {
  onReady?: ((roots: readonly string[]) => void) | null;
  fetch?: typeof fetch;
  cacheDirectory?: () => string;
}): void {
  if ("onReady" in options) onFontsReady = options.onReady ?? null;
  if (options.fetch) fetchFont = options.fetch;
  if (options.cacheDirectory) cacheDirectory = options.cacheDirectory;
}

export function resetDesignFontsForTests(): void {
  states.clear();
  downloads.clear();
  waiters.clear();
  onFontsReady = null;
  fetchFont = (...args) => fetch(...args);
  cacheDirectory = () => path.join(zerosChannelDataDir(), "design-fonts");
}

/** Update: forget failures so the next read downloads again. */
export function retryDesignFonts(): void {
  for (const [url, state] of states) {
    if (state.state !== "failed") continue;
    states.delete(url);
    generation += 1;
  }
}

function remember(url: string, state: RememberedState): void {
  generation += 1;
  states.delete(url);
  states.set(url, state);
  while (states.size > MAX_REMEMBERED_URLS) states.delete(states.keys().next().value!);
}

/** One sentence for the theme editor. */
function downloadError(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `Google Fonts did not answer within ${DOWNLOAD_TIMEOUT_MS / 1000} seconds.`;
  }
  if (error instanceof TypeError && error.message === "fetch failed") return "Could not reach Google Fonts.";
  const text = (error instanceof Error ? error.message : String(error)).trim() || "The download failed";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function cacheFile(key: string): string {
  return path.join(cacheDirectory(), `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.css`);
}

async function download(url: string, limit: number, expectedHost: string, kind: "css" | "font"): Promise<Buffer> {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== expectedHost) throw new Error(`${target.hostname} is not a Google Fonts host.`);
  const response = await fetchFont(target, {
    headers: { "User-Agent": USER_AGENT, Accept: kind === "css" ? "text/css,*/*;q=0.1" : "font/woff2,*/*;q=0.1" },
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Fonts answered ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google Fonts sent nothing.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("A Google Fonts response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Keep the requested subsets: Google labels each @font-face with a comment
 * naming its subset, such as `/* latin *\/`. */
function keepSubsets(root: postcss.Root, subsets: readonly string[] | undefined): void {
  if (!subsets?.length) return;
  let label: string | null = null;
  root.each((node) => {
    if (node.type === "comment") {
      label = node.text.trim();
      return;
    }
    if (node.type === "atrule" && node.name.toLowerCase() === "font-face" && label !== null && !subsets.includes(label)) node.remove();
    label = null;
  });
}

async function fetchGoogleFonts(url: string, subsets?: readonly string[]): Promise<{ css: string; bytes: number }> {
  const stylesheet = (await download(url, MAX_FONT_CSS_BYTES, GOOGLE_CSS_HOST, "css")).toString("utf8");
  const root = postcss.parse(stylesheet);
  keepSubsets(root, subsets);
  let bytes = 0;
  const declarations: postcss.Declaration[] = [];
  root.walkAtRules(/^font-face$/i, (rule) => rule.walkDecls(/^src$/i, (declaration) => { declarations.push(declaration); }));
  for (const declaration of declarations) {
    let value = declaration.value;
    for (const reference of designCssUrlReferences(value).reverse()) {
      const fontUrl = reference.url.trim();
      const font = await download(fontUrl, MAX_DESIGN_FONT_FILE_BYTES, GOOGLE_FONT_HOST, "font");
      bytes += font.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error("The fonts are larger than 16 MiB.");
      const type = DESIGN_FONT_MIME_TYPES[path.posix.extname(new URL(fontUrl).pathname).toLowerCase()] ?? "font/woff2";
      value = `${value.slice(0, reference.functionStart)}url("data:${type};base64,${font.toString("base64")}")${value.slice(reference.functionEnd)}`;
    }
    declaration.value = value;
  }
  root.walkComments((comment) => { comment.remove(); });
  return { css: root.toString(), bytes };
}

/** The embedded CSS for a Google Fonts stylesheet, from memory or the shared
 * cache; otherwise starts its download and reports it pending. `root` is
 * refreshed when the download lands. */
export async function googleFontsCss(rawUrl: string, root: string, subsets?: readonly string[]): Promise<DesignFontState> {
  let url: string;
  try {
    url = normalizedUrl(rawUrl);
  } catch {
    return { state: "failed", error: "The Google Fonts URL is not valid." };
  }
  // The same stylesheet filtered to other subsets is another download.
  const kept = subsets?.length ? [...new Set(subsets)].sort() : null;
  const key = kept ? `${url}#subsets=${kept.join(",")}` : url;
  const known = states.get(key);
  if (known?.state === "failed") return known;
  if (!known || known.state === "ready") {
    try {
      const css = await readFile(cacheFile(key), "utf8");
      if (!known) remember(key, { state: "ready" });
      return { state: "ready", css, bytes: Buffer.byteLength(css, "utf8") };
    } catch {
      // Not downloaded yet, or the cache was cleared: download it again.
      if (known) states.delete(key);
    }
  }
  const watching = waiters.get(key) ?? { roots: new Set<string>() };
  watching.roots.add(root);
  waiters.set(key, watching);
  if (!downloads.has(key)) {
    remember(key, { state: "pending" });
    downloads.set(key, (async () => {
      try {
        const fonts = await fetchGoogleFonts(url, kept ?? undefined);
        const file = cacheFile(key);
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, fonts.css);
        await rename(temporary, file);
        remember(key, { state: "ready" });
      } catch (error) {
        remember(key, { state: "failed", error: downloadError(error) });
      } finally {
        downloads.delete(key);
        const roots = [...(waiters.get(key)?.roots ?? [])];
        waiters.delete(key);
        if (roots.length) onFontsReady?.(roots);
      }
    })());
  }
  return { state: "pending" };
}

/** Wait for every download in flight, for tests and shutdown. */
export async function settleDesignFontDownloadsForTests(): Promise<void> {
  while (downloads.size > 0) await Promise.allSettled([...downloads.values()]);
}

function fontFamilyValue(font: DesignFontDeclaration): string {
  return `"${font.family}", ${font.fallback ?? "sans-serif"}`;
}

/** The CSS a declared local font contributes, read from the checkout. */
export async function localFontCss(workspacePath: string, font: DesignFontDeclaration): Promise<{ css: string; bytes: number } | null> {
  const root = path.resolve(workspacePath);
  const file = await readSafeRegularFile(root, path.join(root, ...font.path!.split("/")), MAX_DESIGN_FONT_FILE_BYTES);
  if (!file) return null;
  const extension = path.posix.extname(font.path!).toLowerCase();
  const format = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" }[extension] ?? "woff2";
  return {
    css: `@font-face { font-family: "${font.family}"; src: url("data:${DESIGN_FONT_MIME_TYPES[extension]};base64,${file.body.toString("base64")}") format("${format}"); font-weight: ${font.weight ?? "400"}; font-style: ${font.style ?? "normal"}; font-display: swap; }`,
    bytes: file.size,
  };
}

/** The custom properties declared fonts set, as next/font sets them. */
export function fontVariablesCss(fonts: readonly DesignFontDeclaration[]): string {
  const declarations = fonts.filter((font) => font.variable).map((font) => `${font.variable}: ${fontFamilyValue(font)};`);
  return declarations.length ? `:root { ${declarations.join(" ")} }` : "";
}
