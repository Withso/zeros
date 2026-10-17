import { createHash } from "node:crypto";
import path from "node:path";
import postcss from "postcss";
import { designCssUrlReferences, designTokenThemeName, resolveDesignLocalReference } from "@zeros/design-web";
import { DESIGN_ASSET_MIME_TYPES, DESIGN_FONT_MIME_TYPES, MAX_ASSET_BYTES } from "./assets";
import type { CanvasDocument } from "./document-model";
import { DesignRenderBudgetError, MAX_INLINE_ASSET_BYTES_PER_FRAME } from "./render-budget";
import { readDesignThemeCatalog } from "./themes";
import {
  designFontsGeneration,
  MAX_DESIGN_FONT_FILE_BYTES,
  fontVariablesCss,
  googleFontsCss,
  googleFontsCssUrl,
  isGoogleFontsCssUrl,
  localFontCss,
  readDesignFontCatalog,
  type DesignFontState,
} from "./style-fonts";
import { diagnoseSafeRegularFile, inspectSafeRegularFile, readSafeRegularFile, type SafeRegularFileProblem } from "./safe-files";
import {
  DEFAULT_DESIGN_STYLE_BUILD_TIMEOUT_SECONDS,
  designStyleBuildStatus,
  designWorkspaceSetupState,
  readDesignStyleBuildPreferences,
  type DesignStyleBuildPreferences,
  type DesignStyleBuildSetting,
  type DesignStyleBuildStatus,
  type DesignWorkspaceSetupState,
} from "./style-builds";
import { DESIGN_STYLE_BUILD_DIRECTORY, designBuildInputPathError, designBuildOutputPathError, designSassSourcePathError, designStyleSourcePathError } from "./style-source-path";
import { compileDesignSass, DesignSassImportError } from "./style-sass";
import { designStyleCache, designStyleCacheKey } from "./style-cache";
import {
  concatDesignCssIndexes,
  designFrameFeatures,
  indexDesignCss,
  measureDesignFrameSources,
  parseAndIndexDesignCss,
  pruneDesignFrameSources,
  splitDesignCss,
  type DesignCssIndex,
} from "./style-prune";
import {
  compileDesignTailwind,
  designTailwindCandidates,
  DESIGN_TAILWIND_PLUGIN_VERSIONS,
  DESIGN_TAILWIND_VERSION,
  type DesignTailwindImportProblem,
  type DesignTailwindSkippedImport,
} from "./style-tailwind";

// Imported style sources: stylesheets elsewhere in the repository that frames
// use without copying them. They are declared in meta/canvas.json's top-level
// `styles` list, which older engines preserve and ignore. A source is read as
// plain CSS or compiled by Zeros' own bundled Tailwind; nothing from the
// repository executes.

export { designStyleSourcePathError };
export const MAX_DESIGN_STYLE_SOURCES = 16;
/** One stylesheet a source reads. Frames receive only the rules they can
 * use, so a large design system costs its size once, in the engine. */
export const MAX_DESIGN_STYLE_SOURCE_BYTES = 32 * 1024 * 1024;
/** Fonts one source may embed. Frames keep only the faces they use. */
export const MAX_DESIGN_STYLE_SOURCE_FONT_BYTES = 16 * 1024 * 1024;
export const DESIGN_STYLE_SOURCE_KINDS = ["css", "tailwind", "sass", "build"] as const;
export type DesignStyleSourceKind = (typeof DESIGN_STYLE_SOURCE_KINDS)[number];

const SOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const THEME_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;
// Directives that only a build tool understands. Their output cannot exist
// without running that tool, so plain-CSS import skips them.
const BUILD_DIRECTIVES = new Set([
  "apply",
  "config",
  "custom-variant",
  "plugin",
  "reference",
  "screen",
  "source",
  "tailwind",
  "utility",
  "variant",
]);

export type DesignStyleSourceMessageLevel = "info" | "warning" | "error";
export interface DesignStyleSourceMessage {
  level: DesignStyleSourceMessageLevel;
  text: string;
  /** What resolves it: "update" once the workspace has what is missing (the
   * theme editor's Update), "agent" when the declaration itself must change
   * (Ask agent to fix). Absent for information. */
  action?: "update" | "agent";
}

export interface DesignStyleSourceToken {
  name: string;
  value: string;
  themeValues: Record<string, string>;
}

/** What the theme editor shows for one source. */
export interface DesignStyleSourceStatus {
  id: string;
  title: string;
  kind: string;
  path: string;
  status: "ready" | "warning" | "error";
  messages: DesignStyleSourceMessage[];
  themes: string[];
  tokens: DesignStyleSourceToken[];
  bytes: number;
  /** Content hash of the imported CSS; null when nothing can be imported. */
  revision: string | null;
}

export interface ResolvedDesignStyleSource extends DesignStyleSourceStatus {
  css: string | null;
  /** Google Fonts stylesheets the source imports; App fonts embeds them. */
  fontImports?: string[];
}

/** The App fonts source: declared fonts and the Google Fonts other sources
 * import. Its id cannot collide with a declared source's. */
export const DESIGN_FONTS_SOURCE_ID = "@fonts";

export interface DesignStyleSourceDeclaration {
  id: string;
  title: string;
  kind: string;
  path: string;
  themes: Record<string, string>;
  /** A build source's command. Every checkout of the repository runs it while
   * Design is open, unless the person turned repository builds off or set up
   * their own command for this output. */
  command?: string;
  /** The command keeps running and rebuilds by itself. */
  watch?: boolean;
  /** Files or folders whose changes re-run a one-shot command. */
  inputs?: string[];
  timeoutSeconds?: number;
}

export interface DesignStyleSourceCatalog {
  declarations: DesignStyleSourceDeclaration[];
  /** Problems with the list itself; individual sources report their own. */
  errors: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read the declared list without failing the canvas: a malformed entry is
 * kept so the theme editor can show why it does not apply. */
export function readDesignStyleSourceCatalog(canvas: object): DesignStyleSourceCatalog {
  const raw = (canvas as Record<string, unknown>).styles;
  if (raw === undefined) return { declarations: [], errors: [] };
  if (!Array.isArray(raw)) {
    return { declarations: [], errors: ["meta/canvas.json `styles` must be a list."] };
  }
  const errors: string[] = [];
  if (raw.length > MAX_DESIGN_STYLE_SOURCES) {
    errors.push(`Only the first ${MAX_DESIGN_STYLE_SOURCES} style sources are used.`);
  }
  const declarations: DesignStyleSourceDeclaration[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.slice(0, MAX_DESIGN_STYLE_SOURCES).entries()) {
    const value = record(entry);
    const id = typeof value?.id === "string" ? value.id : "";
    if (!value || !SOURCE_ID.test(id)) {
      errors.push(`Style source ${index + 1} needs an id that starts with a letter (letters, digits, _ or -).`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Style source id ${JSON.stringify(id)} is declared more than once.`);
      continue;
    }
    seen.add(id);
    const themes: Record<string, string> = {};
    for (const [theme, selector] of Object.entries(record(value.themes) ?? {})) {
      if (!THEME_NAME.test(theme) || typeof selector !== "string" || !selector.trim() || selector.length > 256) continue;
      if (selector.trim().startsWith("@") && !colorSchemeMapping(selector)) {
        errors.push(`Style source ${JSON.stringify(id)} theme ${JSON.stringify(theme)}: only @media (prefers-color-scheme: dark) or @media (prefers-color-scheme: light) can map a theme; use a selector otherwise.`);
        continue;
      }
      themes[theme] = selector.trim();
    }
    const command = typeof value.command === "string" ? value.command.trim() : "";
    const inputs = Array.isArray(value.inputs)
      ? value.inputs.filter((input): input is string => typeof input === "string" && designBuildInputPathError(input) === null).slice(0, 32)
      : [];
    const timeoutSeconds =
      typeof value.timeoutSeconds === "number" && Number.isInteger(value.timeoutSeconds) && value.timeoutSeconds >= 1 && value.timeoutSeconds <= 600
        ? value.timeoutSeconds
        : undefined;
    declarations.push({
      id,
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim().slice(0, 120)
          : id,
      kind: typeof value.kind === "string" ? value.kind : "",
      path: typeof value.path === "string" ? value.path : "",
      themes,
      ...(command && command.length <= 4096 ? { command } : {}),
      ...(value.watch === true ? { watch: true } : {}),
      ...(inputs.length > 0 ? { inputs } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    });
  }
  return { declarations, errors };
}

/** The sources a frame receives, in order. A frame's own `styles` list wins;
 * otherwise every declared source applies. */
export function frameStyleSourceIds(
  canvas: Pick<CanvasDocument, "frame_info">,
  catalog: DesignStyleSourceCatalog,
  frameFile: string,
): string[] {
  const declared = catalog.declarations.map((declaration) => declaration.id);
  const chosen = (canvas.frame_info[frameFile] as Record<string, unknown> | undefined)?.styles;
  if (!Array.isArray(chosen)) return declared;
  const known = new Set(declared);
  return [...new Set(chosen.filter((id): id is string => typeof id === "string" && known.has(id)))];
}

interface ImportedCss {
  css: string;
  messages: DesignStyleSourceMessage[];
  tokens: DesignStyleSourceToken[];
  /** Remote stylesheets its `@import` rules named; frames never load them. */
  remoteImports: string[];
  /** The Google Fonts stylesheets among them, which App fonts embeds. */
  fontImports: string[];
}

/** The URL or path an `@import` rule names. */
function importTarget(params: string): string | null {
  const match = /^\s*(?:url\(\s*)?(["']?)([^"')\s]+)\1/i.exec(params);
  return match?.[2] ?? null;
}

function isRemoteReference(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The scheme a theme mapping such as `@media (prefers-color-scheme: dark)`
 * names, or null for a selector mapping. */
export function colorSchemeMapping(mapping: string): "dark" | "light" | null {
  const match = /^@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i.exec(mapping.trim());
  return match ? (match[1]!.toLowerCase() as "dark" | "light") : null;
}

/** A media query that tests one color scheme, and the rest of its condition.
 * Lists and negations change what the query means, so they stay as written. */
function splitColorScheme(params: string): { scheme: string; rest: string } | null {
  if (/,|\bnot\b|\bonly\b|\bor\b/i.test(params)) return null;
  const feature = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/i.exec(params);
  if (!feature) return null;
  const rest = `${params.slice(0, feature.index)} ${params.slice(feature.index + feature[0].length)}`
    .trim()
    .replace(/^and\s+|\s+and$/i, "")
    .replace(/\s+and\s+and\s+/i, " and ")
    .trim();
  return { scheme: feature[1]!.toLowerCase(), rest };
}

/** Rules a theme applies to, without changing specificity: the canvas sets
 * `data-zd-theme` on the frame's root element, as a media query would match. */
function themeScopedSelector(selector: string, theme: string): string {
  const scope = `:where([data-zd-theme="${theme}"])`;
  const trimmed = selector.trim();
  const rootElement = /^(:root|html)(?![\w-])/i.exec(trimmed);
  return rootElement
    ? `${rootElement[1]}${scope}${trimmed.slice(rootElement[1]!.length)}`
    : `${scope} ${trimmed}`;
}

function scopeRules(container: postcss.Container, theme: string): void {
  container.each((node) => {
    if (node.type === "rule") {
      node.selectors = node.selectors.map((selector) => themeScopedSelector(selector, theme));
    } else if (node.type === "atrule" && !/^(?:-[a-z]+-)?(?:keyframes|font-face|property|counter-style|page)$/i.test(node.name)) {
      scopeRules(node, theme);
    }
  });
}

/** Turn `@media (prefers-color-scheme: <scheme>)` blocks into rules scoped to
 * a Design theme. Returns whether the stylesheet had any. */
function mapColorScheme(root: postcss.Root, scheme: string, theme: string): boolean {
  let matched = false;
  root.walkAtRules(/^media$/i, (media) => {
    const split = splitColorScheme(media.params);
    if (!split || split.scheme !== scheme) return;
    matched = true;
    let replacement: postcss.ChildNode[];
    if (media.parent?.type === "rule") {
      // Match both the themed root and its descendants without adding
      // specificity. An ancestor-only scope cannot match nested :root/html.
      const scope = `[data-zd-theme="${theme}"]`;
      replacement = [postcss.rule({ selector: `&:where(${scope}, ${scope} *)`, nodes: media.nodes ?? [], raws: { between: " " } })];
    } else {
      scopeRules(media, theme);
      replacement = [...(media.nodes ?? [])];
    }
    if (split.rest) {
      media.params = split.rest;
      media.removeAll();
      media.append(replacement);
    } else {
      media.replaceWith(replacement);
    }
  });
  return matched;
}

/** The theme a rule's custom properties belong to: `[data-zd-theme]` or the
 * scoped form a mapped media query becomes. */
function tokenTheme(selector: string): string | null {
  return designTokenThemeName(selector) ??
    /^\s*(?::root|html)?:where\(\[data-zd-theme="([a-z][a-z0-9_-]{0,63})"\]\)\s*$/.exec(selector)?.[1] ?? null;
}

function insideMedia(node: postcss.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && (parent as postcss.AtRule).name.toLowerCase() === "media") return true;
  }
  return false;
}

/** What plain-CSS import found, gathered across the pieces of a large
 * stylesheet. */
interface PlainCssFacts {
  imports: number;
  directives: number;
  remoteImports: string[];
  /** Themes whose mapping rewrote at least one rule. */
  matchedThemes: Set<string>;
  tokens: Map<string, DesignStyleSourceToken>;
}

function plainCssFacts(): PlainCssFacts {
  return { imports: 0, directives: 0, remoteImports: [], matchedThemes: new Set(), tokens: new Map() };
}

/** Plain-CSS import: keep what a browser can use as written, map the source's
 * theme selectors onto Design themes, and list its custom properties. */
export function importPlainDesignCss(
  source: string,
  themes: Record<string, string>,
): ImportedCss {
  const facts = plainCssFacts();
  const root = importPlainDesignPiece(source, themes, facts);
  return { ...plainCssResult(facts, themes), css: root.toString() };
}

/** Large stylesheets are parsed this many characters at a time, which bounds
 * the parser's memory to one piece. */
const DESIGN_CSS_PIECE = 512 * 1024;

/** Import plain CSS a piece at a time, embed its assets and index it for
 * pruning. The index's CSS is what frames receive. */
async function importAndIndexDesignCss(
  source: string,
  themes: Record<string, string>,
  embed?: (root: postcss.Root) => Promise<unknown>,
): Promise<Omit<ImportedCss, "css"> & { index: DesignCssIndex }> {
  const facts = plainCssFacts();
  const pieces: DesignCssIndex[] = [];
  for (const piece of splitDesignCss(source, DESIGN_CSS_PIECE)) {
    const root = importPlainDesignPiece(piece, themes, facts);
    if (embed) await embed(root);
    pieces.push(indexDesignCss(root));
  }
  return { ...plainCssResult(facts, themes), index: concatDesignCssIndexes(pieces) };
}

function plainCssResult(facts: PlainCssFacts, themes: Record<string, string>): Omit<ImportedCss, "css"> {
  const messages: DesignStyleSourceMessage[] = [];
  for (const [theme, selector] of Object.entries(themes)) {
    if (facts.matchedThemes.has(theme)) continue;
    messages.push({
      level: "warning",
      text: colorSchemeMapping(selector)
        ? `Theme ${JSON.stringify(theme)}: the stylesheet has no ${selector} rule.`
        : `Theme ${JSON.stringify(theme)}: no rule uses the selector ${selector}.`,
      action: "agent",
    });
  }
  if (facts.imports > 0) {
    messages.push({ level: "info", text: `Skipped ${plural(facts.imports, "@import rule")}; declare each imported file as its own source.` });
  }
  const fontImports = facts.remoteImports.filter(isGoogleFontsCssUrl);
  const otherRemote = facts.remoteImports.filter((url) => !isGoogleFontsCssUrl(url));
  if (otherRemote.length > 0) {
    messages.push(remoteImportMessage(otherRemote));
  }
  if (facts.directives > 0) {
    messages.push({ level: "info", text: `Skipped ${plural(facts.directives, "build-tool directive")} (@tailwind, @source, @plugin, @apply, …); only plain CSS is imported.` });
  }
  return { messages, tokens: [...facts.tokens.values()], remoteImports: facts.remoteImports, fontImports };
}

/** Import one stylesheet, or one piece of a large one, recording what it
 * found in `facts`. */
function importPlainDesignPiece(
  source: string,
  themes: Record<string, string>,
  facts: PlainCssFacts,
): postcss.Root {
  const root = postcss.parse(source);
  const hoisted: postcss.Declaration[] = [];
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (name === "import") {
      const target = importTarget(rule.params);
      if (target && isRemoteReference(target)) facts.remoteImports.push(target);
      else facts.imports += 1;
      rule.remove();
    } else if (name === "theme") {
      // Tailwind @theme tokens are ordinary custom properties to a frame.
      rule.each((node) => {
        if (node.type === "decl" && CUSTOM_PROPERTY.test(node.prop) && node.value.trim() !== "initial") {
          hoisted.push(postcss.decl({ prop: node.prop, value: node.value }));
        } else if (node.type === "atrule" && node.name.toLowerCase() === "keyframes") {
          root.append(node.clone());
        }
      });
      rule.remove();
    } else if (BUILD_DIRECTIVES.has(name)) {
      facts.directives += 1;
      rule.remove();
    }
  });
  if (hoisted.length > 0) root.prepend(postcss.rule({ selector: ":root", nodes: hoisted }));
  // Every frame receives this text; comments only add bytes.
  root.walkComments((comment) => {
    comment.remove();
  });
  for (const [theme, selector] of Object.entries(themes)) {
    const scheme = colorSchemeMapping(selector);
    if (scheme) {
      if (mapColorScheme(root, scheme, theme)) facts.matchedThemes.add(theme);
      continue;
    }
    // `.dark` must not also rewrite `.darker`.
    const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
    root.walkRules((rule) => {
      const mapped = rule.selector.replace(pattern, `[data-zd-theme="${theme}"]`);
      if (mapped === rule.selector) return;
      rule.selector = mapped;
      facts.matchedThemes.add(theme);
    });
  }
  const token = (name: string) => {
    const existing = facts.tokens.get(name);
    if (existing) return existing;
    const created: DesignStyleSourceToken = { name, value: "", themeValues: {} };
    facts.tokens.set(name, created);
    return created;
  };
  root.walkRules((rule) => {
    // A media query that still applies conditionally sets no theme's values.
    if (insideMedia(rule)) return;
    const base = rule.selectors.some((selector) => selector.trim() === ":root");
    const theme = base ? null : tokenTheme(rule.selector);
    if (!base && !theme) return;
    rule.walkDecls(/^--/, (declaration) => {
      // Shown on one line: `hsl(\n  0 0% 7%\n)` reads as `hsl(0 0% 7%)`.
      const value = declaration.value
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .trim();
      if (base) token(declaration.prop).value = value;
      else token(declaration.prop).themeValues[theme!] = value;
    });
  });
  return root;
}

function remoteImportMessage(urls: readonly string[]): DesignStyleSourceMessage {
  return {
    level: "warning",
    action: "agent",
    text: `Skipped ${plural(urls.length, "remote stylesheet")}: ${listed(urls)}. Frames read only files inside this checkout.`,
  };
}

/** One file a resolved source depends on: size:mtime when read, or
 * "missing", so a file that appears later (say, after an install) counts. */
interface FileDependency {
  target: string;
  limit: number;
  signature: string;
  allowCanonicalPath?: (relativePath: string) => boolean;
}

async function fileSignature(root: string, dependency: FileDependency): Promise<string> {
  const metadata = await inspectSafeRegularFile(root, dependency.target, dependency.limit, dependency.allowCanonicalPath);
  return metadata ? `${metadata.size}:${metadata.modifiedAt}` : "missing";
}

async function unchanged(root: string, dependencies: readonly FileDependency[]): Promise<boolean> {
  const current = await Promise.all(dependencies.map((dependency) => fileSignature(root, dependency)));
  return current.every((signature, index) => signature === dependencies[index]!.signature);
}

/** Asset embedding shared by every stylesheet one source reads. */
interface AssetEmbedding {
  bytes: number;
  embedded: number;
  skipped: string[];
  files: Map<string, Buffer | null>;
  dependencies: Map<string, FileDependency>;
}

function assetEmbedding(): AssetEmbedding {
  return { bytes: 0, embedded: 0, skipped: [], files: new Map(), dependencies: new Map() };
}

function sourceAssets() {
  return { fonts: assetEmbedding(), images: assetEmbedding() };
}

/** Frames cannot fetch repository files, so source assets are embedded as
 * data: URLs. References resolve against the original stylesheet that
 * names them and must stay inside the repository. */
async function embedStyleSourceAssets(
  root: string,
  sourcePath: string,
  css: string,
  assets: ReturnType<typeof sourceAssets>,
): Promise<string> {
  const parsed = postcss.parse(css);
  return (await embedStyleSourceAssetsInRoot(root, sourcePath, parsed, assets)) ? parsed.toString() : css;
}

/** Embed into a parsed stylesheet. Returns whether it had declarations. */
async function embedStyleSourceAssetsInRoot(
  root: string,
  sourcePath: string,
  parsed: postcss.Root,
  assets: ReturnType<typeof sourceAssets>,
): Promise<boolean> {
  const privateOutput = sourcePath.startsWith(`${DESIGN_STYLE_BUILD_DIRECTORY}/`);
  const allowedAssetPath = (file: string) => {
    const top = file.split("/")[0];
    return top !== ".git" && (top !== ".zeros" || (privateOutput && file.startsWith(`${DESIGN_STYLE_BUILD_DIRECTORY}/`)));
  };
  const declarations: postcss.Declaration[] = [];
  parsed.walkDecls((declaration) => { declarations.push(declaration); });
  if (declarations.length === 0) return false;
  for (const declaration of declarations) {
    const isFont = declaration.prop.toLowerCase() === "src" &&
      declaration.parent?.type === "atrule" && declaration.parent.name.toLowerCase() === "font-face";
    const state = isFont ? assets.fonts : assets.images;
    const types = isFont ? DESIGN_FONT_MIME_TYPES : DESIGN_ASSET_MIME_TYPES;
    const fileLimit = isFont ? MAX_DESIGN_STYLE_SOURCE_FONT_BYTES : MAX_ASSET_BYTES;
    const totalLimit = isFont ? MAX_DESIGN_STYLE_SOURCE_FONT_BYTES : MAX_INLINE_ASSET_BYTES_PER_FRAME;
    const value = declaration.value;
    // Earlier URLs in a src list are preferred, so they claim the budget first.
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const reference of designCssUrlReferences(value)) {
      const url = reference.url.trim();
      if (/^data:/i.test(url) || url.startsWith("#")) continue;
      const local = resolveDesignLocalReference(url, sourcePath);
      const type = local ? types[path.posix.extname(local).toLowerCase()] : undefined;
      if (!local || !type || !allowedAssetPath(local)) {
        state.skipped.push(url);
        continue;
      }
      const target = path.join(root, ...local.split("/"));
      if (!state.files.has(target)) {
        const file = await readSafeRegularFile(root, target, fileLimit, allowedAssetPath);
        state.files.set(target, file?.body ?? null);
        state.dependencies.set(target, {
          target,
          limit: fileLimit,
          signature: file ? `${file.size}:${file.modifiedAt}` : "missing",
          allowCanonicalPath: allowedAssetPath,
        });
      }
      const data = state.files.get(target);
      if (!data || state.bytes + data.length > totalLimit) {
        state.skipped.push(url);
        continue;
      }
      state.bytes += data.length;
      state.embedded += 1;
      edits.push({ start: reference.functionStart, end: reference.functionEnd, text: `url("data:${type};base64,${data.toString("base64")}")` });
    }
    if (edits.length === 0) continue;
    let next = value;
    for (const edit of edits.reverse()) next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
    declaration.value = next;
  }
  return true;
}

function listed(values: readonly string[]): string {
  const more = values.length > 3 ? ` and ${values.length - 3} more` : "";
  return `${values.slice(0, 3).join(", ")}${more}`;
}

function fontMessages(state: AssetEmbedding): DesignStyleSourceMessage[] {
  const messages: DesignStyleSourceMessage[] = [];
  if (state.embedded > 0) {
    messages.push({
      level: "info",
      text: `Embeds ${plural(state.embedded, "font file")} (${Math.ceil(state.bytes / 1024)} KB); each frame receives only the faces it uses.`,
    });
  }
  if (state.skipped.length > 0) {
    messages.push({
      level: "warning",
      text: `Could not embed ${plural(state.skipped.length, "font reference")}: ${listed(state.skipped)}. Only .woff2, .woff, .ttf and .otf files inside the repository can be embedded, up to ${MAX_DESIGN_STYLE_SOURCE_FONT_BYTES / 1024 / 1024} MiB per source. Frames use the next font in each font-family list instead.`,
    });
  }
  return messages;
}

function imageMessages(state: AssetEmbedding): DesignStyleSourceMessage[] {
  const messages: DesignStyleSourceMessage[] = [];
  if (state.embedded > 0) {
    messages.push({
      level: "info",
      text: `Embeds ${plural(state.embedded, "image reference")} (${Math.ceil(state.bytes / 1024)} KB); each frame receives only the rules it uses.`,
    });
  }
  if (state.skipped.length > 0) {
    messages.push({
      level: "warning",
      text: `Could not embed ${plural(state.skipped.length, "image reference")}: ${listed(state.skipped)}. Only local .avif, .gif, .jpeg, .jpg, .png and .webp files inside the repository can be embedded, up to 10 MiB per file and 12 MiB per source.`,
    });
  }
  return messages;
}

function statusLevel(messages: readonly DesignStyleSourceMessage[]): DesignStyleSourceStatus["status"] {
  return messages.some((message) => message.level === "warning") ? "warning" : "ready";
}

interface CacheEntry {
  dependencies: FileDependency[];
  result: ResolvedDesignStyleSource;
}

/** Each resolved source's index, for pruning frames. Kept beside the cached
 * result rather than in it, so it never reaches a snapshot. */
const designStyleIndexes = new WeakMap<ResolvedDesignStyleSource, DesignCssIndex>();

function failure(declaration: DesignStyleSourceDeclaration, text: string): ResolvedDesignStyleSource {
  return {
    ...declaration,
    themes: Object.keys(declaration.themes),
    status: "error",
    messages: [{ level: "error", text, action: "agent" }],
    tokens: [],
    bytes: 0,
    revision: null,
    css: null,
  };
}

function isAre(count: number): string {
  return count === 1 ? "is" : "are";
}

/** Package files exist only once the workspace's dependencies are installed;
 * the wording follows its setup, read when the status is shown. */
function notInstalledMessage(names: readonly string[], setup: DesignWorkspaceSetupState): DesignStyleSourceMessage {
  if (setup === "running") {
    return { level: "warning", text: `Waiting for the workspace setup to install ${listed(names)}.`, action: "update" };
  }
  return {
    level: "warning",
    action: "update",
    text: setup === "failed"
      ? `${listed(names)} ${isAre(names.length)} not installed because the workspace setup failed. Rerun setup, then press Update.`
      : `${listed(names)} ${isAre(names.length)} not installed in this workspace. Run the workspace setup or install its dependencies, then press Update.`,
  };
}

/** Why imports were skipped, as a clause after "Could not import <names>:". */
const IMPORT_PROBLEM_TEXT: Record<Exclude<DesignTailwindImportProblem, "not-installed">, (one: boolean) => string> = {
  outside: (one) => `${one ? "it resolves" : "they resolve"} outside this checkout, through a linked package or a shared package store. Frames read only files inside the checkout.`,
  missing: (one) => `${one ? "it does" : "they do"} not exist.`,
  link: (one) => `${one ? "it is a symbolic link" : "they are symbolic links"}; import the ${one ? "file it points" : "files they point"} to instead.`,
  absolute: (one) => `${one ? "it uses" : "they use"} an absolute path; import ${one ? "it" : "them"} relative to the stylesheet.`,
  remote: (one) => `${one ? "it is" : "they are"} remote, and frames read only files inside this checkout.`,
  alias: (one) => `${one ? "it uses" : "they use"} a path alias that only the application's bundler understands; import ${one ? "it" : "them"} with a relative path.`,
  "not-css": (one) => `${one ? "it does" : "they do"} not provide a stylesheet.`,
  "too-large": (one) => `${one ? "it is" : "they are"} larger than ${MAX_DESIGN_STYLE_SOURCE_BYTES / 1024 / 1024} MiB.`,
  unreadable: (one) => `${one ? "it" : "they"} could not be read.`,
};

/** One message per reason, in a stable order. */
export function designStyleImportMessages(
  skipped: readonly DesignTailwindSkippedImport[],
  setup: DesignWorkspaceSetupState,
): DesignStyleSourceMessage[] {
  const byProblem = new Map<DesignTailwindImportProblem, string[]>();
  for (const { id, problem } of skipped) byProblem.set(problem, [...(byProblem.get(problem) ?? []), id]);
  const messages: DesignStyleSourceMessage[] = [];
  for (const [problem, ids] of [...byProblem].sort(([left], [right]) => left.localeCompare(right))) {
    messages.push(problem === "not-installed"
      ? notInstalledMessage(ids, setup)
      : { level: "warning", text: `Could not import ${listed(ids)}: ${IMPORT_PROBLEM_TEXT[problem](ids.length === 1)}`, action: "agent" });
  }
  return messages;
}

/** Why a declared file could not be read, as its status. A package's file is
 * waiting, not broken, while setup installs dependencies. */
function unreadableSource(
  declaration: DesignStyleSourceDeclaration,
  problem: SafeRegularFileProblem,
  setup: DesignWorkspaceSetupState,
): ResolvedDesignStyleSource {
  const file = declaration.path;
  if (problem === "missing" && file.split("/").includes("node_modules")) {
    const message = notInstalledMessage([file], setup);
    if (setup === "running") return { ...failure(declaration, ""), status: "warning", messages: [message] };
    return { ...failure(declaration, message.text), messages: [{ ...message, level: "error" }] };
  }
  return failure(declaration, {
    missing: `${file} does not exist.`,
    outside: `${file} is a link to a location outside this checkout. Frames read only files inside the checkout.`,
    link: `${file} is a symbolic link; declare the file it points to instead.`,
    "too-large": `${file} is larger than ${MAX_DESIGN_STYLE_SOURCE_BYTES / 1024 / 1024} MiB.`,
    unreadable: `${file} could not be read.`,
  }[problem]);
}

/** Resolve one declared source against the workspace checkout. Results are
 * cached until the file, or any file it embeds or imports, changes. */
export async function resolveDesignStyleSource(
  workspacePath: string,
  declaration: DesignStyleSourceDeclaration,
): Promise<ResolvedDesignStyleSource> {
  if (!(DESIGN_STYLE_SOURCE_KINDS as readonly string[]).includes(declaration.kind)) {
    return failure(declaration, declaration.kind
      ? `Kind ${JSON.stringify(declaration.kind)} is not available; use "css", "tailwind", "sass" or "build".`
      : 'Set kind to "css", "tailwind", "sass" or "build".');
  }
  const pathError = declaration.kind === "build"
    ? designBuildOutputPathError(declaration.path)
    : declaration.kind === "sass"
      ? designSassSourcePathError(declaration.path)
      : designStyleSourcePathError(declaration.path);
  if (pathError) return failure(declaration, pathError);
  if (declaration.kind === "sass") return sassStatus(await sassGeneration(workspacePath, declaration), declaration, designWorkspaceSetupState(workspacePath));
  if (declaration.kind === "tailwind") {
    return tailwindStatus(await tailwindGeneration(workspacePath, declaration), declaration, designWorkspaceSetupState(workspacePath));
  }
  if (declaration.kind === "build") return resolveBuildStyleSource(workspacePath, declaration);
  return importCssSource(workspacePath, declaration);
}

/** Import a validated CSS file: a `css` source, or a build source's output. */
async function importCssSource(
  workspacePath: string,
  declaration: DesignStyleSourceDeclaration,
): Promise<ResolvedDesignStyleSource> {
  const root = path.resolve(workspacePath);
  const target = path.join(root, ...declaration.path.split("/"));
  const key = designStyleCacheKey(root, "css", JSON.stringify(declaration));
  const cached = designStyleCache.get<CacheEntry>(key);
  if (cached && (await unchanged(root, cached.dependencies))) return cached.result;
  const file = await readSafeRegularFile(root, target, MAX_DESIGN_STYLE_SOURCE_BYTES);
  if (!file) {
    const problem = await diagnoseSafeRegularFile(root, target, MAX_DESIGN_STYLE_SOURCE_BYTES);
    return unreadableSource(declaration, problem, designWorkspaceSetupState(workspacePath));
  }
  const assets = sourceAssets();
  let imported: Awaited<ReturnType<typeof importAndIndexDesignCss>>;
  try {
    imported = await importAndIndexDesignCss(file.body.toString("utf8"), declaration.themes,
      (parsed) => embedStyleSourceAssetsInRoot(root, declaration.path, parsed, assets));
  } catch (error) {
    return failure(declaration, `${declaration.path} is not valid CSS: ${error instanceof Error ? error.message : String(error)}`);
  }
  const index = imported.index;
  const css = index.css;
  const messages = [...imported.messages, ...fontMessages(assets.fonts), ...imageMessages(assets.images)];
  const result: ResolvedDesignStyleSource = {
    ...declaration,
    themes: Object.keys(declaration.themes),
    status: statusLevel(messages),
    messages,
    tokens: imported.tokens,
    bytes: Buffer.byteLength(css, "utf8"),
    revision: createHash("sha256").update(css).digest("hex").slice(0, 24),
    css,
    ...(imported.fontImports.length ? { fontImports: imported.fontImports } : {}),
  };
  designStyleIndexes.set(result, index);
  designStyleCache.set(key, {
    dependencies: [
      { target, limit: MAX_DESIGN_STYLE_SOURCE_BYTES, signature: `${file.size}:${file.modifiedAt}` },
      ...assets.fonts.dependencies.values(),
      ...assets.images.dependencies.values(),
    ],
    result,
  }, index.bytes);
  return result;
}

// Compiled Tailwind sources. A generation records every file one compile of
// the entry read, so frames replay it from memory; each frame then gets its
// own compile and build for the classes it uses (Tailwind's builds are
// cumulative, so one compiler cannot serve two frames).

/** Stylesheets one compiled source (Tailwind or Sass) may read, excluding
 * embedded assets. */
export const MAX_DESIGN_STYLE_SOURCE_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_DESIGN_TAILWIND_FRAME_CSS_BYTES = 8 * 1024 * 1024;

interface TailwindGeneration {
  dependencies: FileDependency[];
  /** Repository-relative file → contents as compiled (assets embedded). */
  files: Map<string, string | null>;
  /** Status without the parts that depend on the workspace's setup state. */
  result: ResolvedDesignStyleSource;
  /** Why the entry itself could not be read, if it could not. */
  entryProblem: SafeRegularFileProblem | null;
  skippedImports: DesignTailwindSkippedImport[];
}
const tailwindLoads = new Map<string, Promise<TailwindGeneration>>();

function generationBytes(generation: TailwindGeneration): number {
  let bytes = 4096;
  for (const content of generation.files.values()) bytes += content?.length ?? 0;
  return bytes;
}

function readableRepositoryFile(file: string): boolean {
  if (!file || file.length > 1024 || /[\\\0]/.test(file) || file.startsWith("/")) return false;
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (segments[0] === ".git" || segments[0] === ".zeros") return false;
  return file.endsWith(".css") || file.endsWith(".scss") || file.endsWith(".sass") || file.endsWith("/package.json");
}

function sourceTokens(contents: readonly string[], themes: Record<string, string>): DesignStyleSourceToken[] {
  const tokens = new Map<string, DesignStyleSourceToken>();
  for (const content of contents) {
    let imported: ImportedCss;
    try {
      imported = importPlainDesignCss(content, themes);
    } catch {
      continue;
    }
    for (const token of imported.tokens) {
      const existing = tokens.get(token.name);
      tokens.set(token.name, existing
        ? { name: token.name, value: token.value || existing.value, themeValues: { ...existing.themeValues, ...token.themeValues } }
        : token);
    }
  }
  return [...tokens.values()];
}

async function loadTailwindGeneration(
  root: string,
  declaration: DesignStyleSourceDeclaration,
): Promise<TailwindGeneration> {
  const files = new Map<string, string | null>();
  const dependencies = new Map<string, FileDependency>();
  const assets = sourceAssets();
  let inputBytes = 0;
  const read = async (file: string): Promise<string | null> => {
    if (files.has(file)) return files.get(file)!;
    if (!readableRepositoryFile(file)) return null;
    const target = path.join(root, ...file.split("/"));
    const body = await readSafeRegularFile(root, target, MAX_DESIGN_STYLE_SOURCE_BYTES);
    dependencies.set(target, {
      target,
      limit: MAX_DESIGN_STYLE_SOURCE_BYTES,
      signature: body ? `${body.size}:${body.modifiedAt}` : "missing",
    });
    let content = body ? body.body.toString("utf8") : null;
    if (content !== null && file.endsWith(".css")) {
      inputBytes += body!.size;
      if (inputBytes > MAX_DESIGN_STYLE_SOURCE_INPUT_BYTES) {
        throw new Error(`Its stylesheets exceed ${MAX_DESIGN_STYLE_SOURCE_INPUT_BYTES / 1024 / 1024} MiB.`);
      }
      try {
        content = await embedStyleSourceAssets(root, file, content, assets);
      } catch {
        // Tailwind reports CSS it cannot parse; keep the file as written.
      }
    }
    files.set(file, content);
    return content;
  };
  const diagnose = async (file: string) => readableRepositoryFile(file)
    ? diagnoseSafeRegularFile(root, path.join(root, ...file.split("/")), MAX_DESIGN_STYLE_SOURCE_BYTES)
    : "unreadable" as const;
  const generation = (
    result: ResolvedDesignStyleSource,
    facts: Partial<Pick<TailwindGeneration, "entryProblem" | "skippedImports">> = {},
  ): TailwindGeneration => ({
    dependencies: [...dependencies.values(), ...assets.fonts.dependencies.values(), ...assets.images.dependencies.values()],
    files,
    result,
    entryProblem: facts.entryProblem ?? null,
    skippedImports: facts.skippedImports ?? [],
  });
  const entry = await read(declaration.path);
  if (entry === null) {
    const entryProblem = await diagnose(declaration.path);
    return generation(failure(declaration, `${declaration.path} could not be read.`), { entryProblem });
  }
  let compiler: Awaited<ReturnType<typeof compileDesignTailwind>>;
  let base: Awaited<ReturnType<typeof importAndIndexDesignCss>>;
  try {
    compiler = await compileDesignTailwind({ file: declaration.path, content: entry }, read, diagnose);
    base = await importAndIndexDesignCss(compiler.build([]), declaration.themes);
  } catch (error) {
    return generation(failure(declaration, `Tailwind could not compile ${declaration.path}: ${error instanceof Error ? error.message : String(error)}`));
  }
  const messages: DesignStyleSourceMessage[] = [
    { level: "info", text: `Compiled with Tailwind CSS ${DESIGN_TAILWIND_VERSION} for the classes each frame uses.` },
  ];
  // Tailwind keeps remote imports in its output; frames drop them, and App
  // fonts embeds the Google Fonts among them.
  const otherRemote = base.remoteImports.filter((url) => !isGoogleFontsCssUrl(url));
  if (otherRemote.length > 0) messages.push(remoteImportMessage(otherRemote));
  if (compiler.bundledModules.length > 0) {
    const named = compiler.bundledModules.map((directive) => {
      const id = directive.replace(/^@plugin /, "");
      return `${id} ${DESIGN_TAILWIND_PLUGIN_VERSIONS[id] ?? ""}`.trim();
    });
    messages.push({ level: "info", text: `Ran Zeros' own ${listed(named)}; the application's installed ${named.length === 1 ? "version" : "versions"} may differ.` });
  }
  if (compiler.skippedModules.length > 0) {
    messages.push({
      level: "warning",
      text: `Did not run ${listed(compiler.skippedModules)}: plugins and JavaScript configs execute code, so what they add is missing from frames.`,
      action: "agent",
    });
  }
  messages.push(...fontMessages(assets.fonts), ...imageMessages(assets.images));
  const loaded = [...files.values()].filter((content): content is string => content !== null);
  for (const [theme, selector] of Object.entries(declaration.themes)) {
    const scheme = colorSchemeMapping(selector);
    if (scheme) {
      // Tailwind's own dark variant is this media query unless the entry
      // redefines it with @custom-variant.
      const feature = new RegExp(`prefers-color-scheme\\s*:\\s*${scheme}`, "i");
      const variant = scheme === "dark" && !loaded.some((content) => /@custom-variant\s+dark\b/.test(content));
      if (!variant && !loaded.some((content) => feature.test(content))) {
        messages.push({ level: "warning", text: `Theme ${JSON.stringify(theme)}: the stylesheet has no ${selector} rule.`, action: "agent" });
      }
    } else if (!loaded.some((content) => content.includes(selector))) {
      messages.push({ level: "warning", text: `Theme ${JSON.stringify(theme)}: no rule uses the selector ${selector}.`, action: "agent" });
    }
  }
  // Tokens the application declares, not Tailwind's or packages' defaults.
  const own = [declaration.path, ...compiler.imports.filter((file) => !file.split("/").includes("node_modules"))];
  const revision = createHash("sha256")
    .update(`${DESIGN_TAILWIND_VERSION}\0${JSON.stringify(declaration.themes)}\0${declaration.path}`);
  for (const [file, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    revision.update(`\0${file}\0${content === null ? "\u0001missing" : content}`);
  }
  return generation({
    ...declaration,
    themes: Object.keys(declaration.themes),
    status: statusLevel(messages),
    messages,
    tokens: sourceTokens(own.map((file) => files.get(file) ?? "").filter(Boolean), declaration.themes),
    bytes: Buffer.byteLength(base.index.css, "utf8"),
    revision: revision.digest("hex").slice(0, 24),
    css: null,
    ...(base.fontImports.length ? { fontImports: base.fontImports } : {}),
  }, { skippedImports: compiler.skippedImports });
}

/** A generation's status with the wording that depends on setup. */
function tailwindStatus(
  generation: TailwindGeneration,
  declaration: DesignStyleSourceDeclaration,
  setup: DesignWorkspaceSetupState,
): ResolvedDesignStyleSource {
  if (generation.entryProblem) return unreadableSource(declaration, generation.entryProblem, setup);
  if (generation.skippedImports.length === 0) return generation.result;
  const [compiled, ...rest] = generation.result.messages;
  const messages = [...(compiled ? [compiled] : []), ...designStyleImportMessages(generation.skippedImports, setup), ...rest];
  return { ...generation.result, status: statusLevel(messages), messages };
}

async function tailwindGeneration(
  workspacePath: string,
  declaration: DesignStyleSourceDeclaration,
): Promise<TailwindGeneration> {
  const root = path.resolve(workspacePath);
  const key = designStyleCacheKey(root, "tailwind", JSON.stringify(declaration));
  const cached = designStyleCache.get<TailwindGeneration>(key);
  if (cached && (await unchanged(root, cached.dependencies))) return cached;
  let pending = tailwindLoads.get(key);
  if (!pending) {
    pending = loadTailwindGeneration(root, declaration).finally(() => tailwindLoads.delete(key));
    tailwindLoads.set(key, pending);
  }
  const generation = await pending;
  designStyleCache.set(key, generation, generationBytes(generation));
  return generation;
}

/** One frame's CSS from a Tailwind source, indexed for pruning: comments
 * dropped, remote @import rules removed, theme selectors mapped onto Design
 * themes. Its revision derives from the generation and the frame's
 * candidates, so identity needs no compile. */
async function tailwindFrameSource(
  workspacePath: string,
  declaration: DesignStyleSourceDeclaration,
  candidates: readonly string[],
  build: boolean,
): Promise<{ index: DesignCssIndex | null; revision: string; fontImports: string[] } | null> {
  const generation = await tailwindGeneration(workspacePath, declaration);
  if (generation.result.revision === null) return null;
  const fontImports = generation.result.fontImports ?? [];
  const revision = createHash("sha256")
    .update(`${generation.result.revision}\0${candidates.join("\n")}`)
    .digest("hex")
    .slice(0, 24);
  if (!build) return { index: null, revision, fontImports };
  const key = designStyleCacheKey(path.resolve(workspacePath), "tailwind-frame", `${JSON.stringify(declaration)}\0${revision}`);
  const cached = designStyleCache.get<DesignCssIndex>(key);
  if (cached) return { index: cached, revision, fontImports };
  const compiler = await compileDesignTailwind(
    { file: declaration.path, content: generation.files.get(declaration.path) ?? "" },
    async (file) => generation.files.get(file) ?? null,
  );
  const { index } = await importAndIndexDesignCss(compiler.build(candidates), declaration.themes);
  designStyleCache.set(key, index, index.bytes);
  return { index, revision, fontImports };
}

// Compiled Sass sources. A generation records every file one compile read,
// including lookups that found nothing, and is reused while all of them keep
// their size and modification time. Its CSS is then imported as plain CSS.

interface SassGeneration {
  dependencies: FileDependency[];
  result: ResolvedDesignStyleSource;
  /** Imports that failed the compile, worded at read time by setup state. */
  skippedImports: DesignTailwindSkippedImport[];
  entryProblem: SafeRegularFileProblem | null;
}
const sassLoads = new Map<string, Promise<SassGeneration>>();
let sassVersion: string | null = null;

async function loadSassGeneration(root: string, declaration: DesignStyleSourceDeclaration): Promise<SassGeneration> {
  const dependencies = new Map<string, FileDependency>();
  const assets = sourceAssets();
  let inputBytes = 0;
  const read = async (file: string): Promise<string | null> => {
    if (!readableRepositoryFile(file)) return null;
    const target = path.join(root, ...file.split("/"));
    const body = await readSafeRegularFile(root, target, MAX_DESIGN_STYLE_SOURCE_BYTES);
    dependencies.set(target, { target, limit: MAX_DESIGN_STYLE_SOURCE_BYTES, signature: body ? `${body.size}:${body.modifiedAt}` : "missing" });
    if (body && !file.endsWith("/package.json")) {
      inputBytes += body.size;
      if (inputBytes > MAX_DESIGN_STYLE_SOURCE_INPUT_BYTES) {
        throw new Error(`Its stylesheets exceed ${MAX_DESIGN_STYLE_SOURCE_INPUT_BYTES / 1024 / 1024} MiB.`);
      }
    }
    return body ? body.body.toString("utf8") : null;
  };
  const diagnose = async (file: string) => readableRepositoryFile(file)
    ? diagnoseSafeRegularFile(root, path.join(root, ...file.split("/")), MAX_DESIGN_STYLE_SOURCE_BYTES)
    : "unreadable" as const;
  const installed = async () => (await inspectSafeRegularFile(root, path.join(root, "node_modules", ".modules.yaml"), MAX_DESIGN_STYLE_SOURCE_BYTES)) !== null ||
    (await inspectSafeRegularFile(root, path.join(root, "node_modules", ".package-lock.json"), MAX_DESIGN_STYLE_SOURCE_BYTES)) !== null ||
    (await inspectSafeRegularFile(root, path.join(root, "node_modules", ".yarn-state.yml"), MAX_DESIGN_STYLE_SOURCE_BYTES)) !== null;
  const generation = (result: ResolvedDesignStyleSource, facts: Partial<Pick<SassGeneration, "skippedImports" | "entryProblem">> = {}): SassGeneration => ({
    dependencies: [...dependencies.values(), ...assets.fonts.dependencies.values(), ...assets.images.dependencies.values()],
    result,
    skippedImports: facts.skippedImports ?? [],
    entryProblem: facts.entryProblem ?? null,
  });
  const entry = await read(declaration.path);
  if (entry === null) return generation(failure(declaration, `${declaration.path} could not be read.`), { entryProblem: await diagnose(declaration.path) });
  let compiled: string;
  try {
    compiled = (await compileDesignSass({ file: declaration.path, content: entry }, read, { diagnose, installed })).css;
    sassVersion ??= /\b(\d+\.\d+\.\d+)\b/.exec((await import("sass")).info)?.[1] ?? null;
  } catch (error) {
    if (error instanceof DesignSassImportError) {
      return generation(failure(declaration, `Sass could not compile ${declaration.path}.`), { skippedImports: error.skipped });
    }
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
    return generation(failure(declaration, `Sass could not compile ${declaration.path}: ${first}`));
  }
  let imported: Awaited<ReturnType<typeof importAndIndexDesignCss>>;
  try {
    imported = await importAndIndexDesignCss(compiled, declaration.themes,
      (parsed) => embedStyleSourceAssetsInRoot(root, declaration.path, parsed, assets));
  } catch (error) {
    return generation(failure(declaration, `Sass compiled ${declaration.path} to CSS frames cannot use: ${error instanceof Error ? error.message : String(error)}`));
  }
  const index = imported.index;
  const css = index.css;
  const messages: DesignStyleSourceMessage[] = [
    { level: "info", text: `Compiled with Sass${sassVersion ? ` ${sassVersion}` : ""}.` },
    ...imported.messages,
    ...fontMessages(assets.fonts),
    ...imageMessages(assets.images),
  ];
  const result: ResolvedDesignStyleSource = {
    ...declaration,
    themes: Object.keys(declaration.themes),
    status: statusLevel(messages),
    messages,
    tokens: imported.tokens,
    bytes: Buffer.byteLength(css, "utf8"),
    revision: createHash("sha256").update(css).digest("hex").slice(0, 24),
    css,
    ...(imported.fontImports.length ? { fontImports: imported.fontImports } : {}),
  };
  designStyleIndexes.set(result, index);
  return generation(result);
}

async function sassGeneration(workspacePath: string, declaration: DesignStyleSourceDeclaration): Promise<SassGeneration> {
  const root = path.resolve(workspacePath);
  const key = designStyleCacheKey(root, "sass", JSON.stringify(declaration));
  const cached = designStyleCache.get<SassGeneration>(key);
  if (cached && (await unchanged(root, cached.dependencies))) return cached;
  let pending = sassLoads.get(key);
  if (!pending) {
    pending = loadSassGeneration(root, declaration).finally(() => sassLoads.delete(key));
    sassLoads.set(key, pending);
  }
  const generation = await pending;
  const index = designStyleIndexes.get(generation.result);
  designStyleCache.set(key, generation, (index?.bytes ?? 0) + 4096);
  return generation;
}

/** A Sass generation's status with the wording that depends on setup. */
function sassStatus(generation: SassGeneration, declaration: DesignStyleSourceDeclaration, setup: DesignWorkspaceSetupState): ResolvedDesignStyleSource {
  if (generation.entryProblem) return unreadableSource(declaration, generation.entryProblem, setup);
  if (generation.skippedImports.length === 0) return generation.result;
  const messages = designStyleImportMessages(generation.skippedImports, setup);
  // Only a dependency setup is still installing leaves the source waiting.
  const waiting = setup === "running" && generation.skippedImports.every((skipped) => skipped.problem === "not-installed");
  return {
    ...generation.result,
    status: waiting ? "warning" : "error",
    messages: [generation.result.messages[0]!, ...messages.map((message) => (waiting ? message : { ...message, level: "error" as const }))],
  };
}

// Build sources import the CSS file an approved command writes. Frames read
// only that file; the status reads the person's settings and starts a build
// that is due (see style-builds.ts).

function outputDeclaration(declaration: DesignStyleSourceDeclaration): DesignStyleSourceDeclaration {
  return { id: declaration.id, title: declaration.title, kind: "css", path: declaration.path, themes: declaration.themes };
}

function seconds(durationMs: number | null): string {
  return `${((durationMs ?? 0) / 1000).toFixed(1)} s`;
}

type StyleBuildOrigin = "settings" | "repository";

/** The person's own entry for this output wins; otherwise the declaration's
 * command, unless they turned repository builds off. */
function effectiveStyleBuild(
  declaration: DesignStyleSourceDeclaration,
  preferences: DesignStyleBuildPreferences,
): { setting: DesignStyleBuildSetting; origin: StyleBuildOrigin } | null {
  const personal = preferences.personal.get(declaration.path);
  if (personal) return { setting: personal, origin: "settings" };
  if (!declaration.command || !preferences.repositoryBuilds) return null;
  return {
    origin: "repository",
    setting: {
      output: declaration.path,
      command: declaration.command,
      timeoutSeconds: declaration.timeoutSeconds ?? DEFAULT_DESIGN_STYLE_BUILD_TIMEOUT_SECONDS,
      watch: declaration.watch === true,
      inputs: declaration.inputs ?? [],
    },
  };
}

function setupText(declaration: DesignStyleSourceDeclaration, preferences: DesignStyleBuildPreferences): string {
  if (declaration.command && !preferences.repositoryBuilds) {
    return `Repository style builds are off in your settings (design.repository_style_builds = false); add your own [[design.style_builds]] entry for ${JSON.stringify(declaration.path)} to build it.`;
  }
  return 'To build it, ask your agent to sync styles, or add the build "command" to this source in meta/canvas.json.';
}

function liveText(status: DesignStyleBuildStatus, origin: StyleBuildOrigin): string {
  const command = JSON.stringify(status.command);
  const from = origin === "repository" ? " (from meta/canvas.json)" : " (from your settings)";
  if (status.watch) return `Live: Zeros keeps ${command} running while Design is open${from}.`;
  if (status.inputs.length > 0) return `Live: Zeros runs ${command} when ${status.inputs.join(", ")} change, while Design is open${from}.`;
  return `Built with ${command} in ${seconds(status.durationMs)} when Design opened${from}.`;
}

function buildMessages(
  declaration: DesignStyleSourceDeclaration,
  preferences: DesignStyleBuildPreferences,
  status: DesignStyleBuildStatus | undefined,
  hasOutput: boolean,
): DesignStyleSourceMessage[] {
  const output = declaration.path;
  const build = effectiveStyleBuild(declaration, preferences);
  if (!build) {
    return [{
      level: hasOutput ? "warning" : "error",
      text: `${hasOutput ? `Using the existing ${output}.` : `${output} does not exist yet.`} ${setupText(declaration, preferences)}`,
      action: "agent",
    }];
  }
  const { setting, origin } = build;
  // A setting whose command or mode changed is not running yet.
  const current = status && status.command === setting.command && status.watch === setting.watch ? status : undefined;
  if (!current || current.state === "stopped") {
    return [{ level: hasOutput ? "info" : "warning", text: hasOutput ? "Paused until you open Design." : `Builds ${output} when you open Design.` }];
  }
  if (current.state === "waiting") {
    return [{ level: hasOutput ? "info" : "warning", text: "Waiting for the workspace setup to finish before building." }];
  }
  if (current.state === "starting" || current.state === "building") {
    return [{ level: hasOutput ? "info" : "warning", text: `Building ${output} with ${JSON.stringify(setting.command)}…` }];
  }
  if (current.state === "failed") {
    const retry = setting.watch ? "Zeros restarts it shortly, and again when you reopen Design." : "Zeros retries when its inputs change or you reopen Design.";
    return [{
      level: hasOutput ? "warning" : "error",
      text: `The build failed: ${(current.error ?? "").replace(/[.\s]*$/, ".")}${hasOutput ? ` Showing the previous ${output}.` : ""} ${retry}`,
      action: "agent",
    }];
  }
  if (!hasOutput) {
    return [{ level: "error", text: `${JSON.stringify(setting.command)} is running but has not written ${output}.` }];
  }
  return [{ level: "info", text: liveText(current, origin) }];
}

async function resolveBuildStyleSource(
  workspacePath: string,
  declaration: DesignStyleSourceDeclaration,
): Promise<ResolvedDesignStyleSource> {
  // Status only: builds start while a Design tab shows the checkout.
  const preferences = readDesignStyleBuildPreferences(workspacePath);
  const status = designStyleBuildStatus(workspacePath, declaration.path);
  const imported = await importCssSource(workspacePath, outputDeclaration(declaration));
  const hasOutput = imported.css !== null;
  const build = buildMessages(declaration, preferences, status, hasOutput);
  const messages = [...build, ...(hasOutput ? imported.messages : [])];
  return {
    ...imported,
    ...declaration,
    themes: Object.keys(declaration.themes),
    status: messages.some((message) => message.level === "error") ? "error" : statusLevel(messages),
    messages,
  };
}

/** The builds a Design directory's sources need: the person's own entries and
 * the commands the directory declares, from one settings read. */
export function designStyleBuildSettings(workspacePath: string, canvas: object): DesignStyleBuildSetting[] {
  const declarations = readDesignStyleSourceCatalog(canvas).declarations.filter(
    (declaration) => declaration.kind === "build" && !designBuildOutputPathError(declaration.path),
  );
  if (declarations.length === 0) return [];
  const preferences = readDesignStyleBuildPreferences(workspacePath);
  const settings: DesignStyleBuildSetting[] = [];
  for (const declaration of declarations) {
    const build = effectiveStyleBuild(declaration, preferences);
    if (build && !settings.some((existing) => existing.output === build.setting.output)) settings.push(build.setting);
  }
  return settings;
}

/** The theme editor's Update: drop every cached result for this checkout so
 * the next read re-reads each source from disk, even when a file's size and
 * modification time look unchanged. */
export function forgetDesignStyleSourceCaches(workspacePath: string): void {
  designStyleCache.deletePrefix(`${path.resolve(workspacePath)}\0`);
}

/** What `zeros-engine design styles` prints: each source's status without
 * its CSS or token values, so an agent can confirm a sync setup. */
export interface DesignStyleCheckReport {
  directory: string;
  sources: Array<Pick<DesignStyleSourceStatus, "id" | "title" | "kind" | "path" | "status" | "messages" | "themes" | "bytes"> & { tokens: number }>;
  errors: string[];
  summary: Record<DesignStyleSourceStatus["status"], number>;
}

export function designStyleCheckReport(
  directory: string,
  sources: readonly DesignStyleSourceStatus[],
  errors: readonly string[],
): DesignStyleCheckReport {
  const summary = { ready: 0, warning: 0, error: 0 };
  for (const source of sources) summary[source.status] += 1;
  return {
    directory,
    sources: sources.map(({ id, title, kind, path: file, status, messages, themes, bytes, tokens }) => ({
      id, title, kind, path: file, status, tokens: tokens.length, themes, bytes, messages,
    })),
    errors: [...errors],
    summary,
  };
}

function googleFamilies(url: string): string {
  try {
    const families = new URL(url.startsWith("//") ? `https:${url}` : url).searchParams.getAll("family")
      .map((family) => family.split(":")[0]!.replace(/\+/g, " ").trim())
      .filter(Boolean);
    return families.length ? families.join(", ") : "Google Fonts";
  } catch {
    return "Google Fonts";
  }
}

const LOCAL_FONT_PROBLEM: Record<SafeRegularFileProblem, string> = {
  missing: "it does not exist",
  outside: "it resolves outside this checkout",
  link: "it is a symbolic link; name the file it points to",
  "too-large": `it is larger than ${MAX_DESIGN_FONT_FILE_BYTES / 1024 / 1024} MiB`,
  unreadable: "it could not be read",
};

// One embedded result per directory and font set; downloaded CSS otherwise
// stays on disk.
interface AppFontsMemo {
  key: string;
  result: ResolvedDesignStyleSource;
}

/** App fonts: the fonts meta/canvas.json declares and the Google Fonts the
 * given sources import, embedded from the shared download cache or the
 * checkout. Built from memory, so frame identity reads stay cheap. */
async function appFontsSource(
  workspacePath: string,
  canvas: object,
  fontImports: readonly string[],
): Promise<ResolvedDesignStyleSource | null> {
  const catalog = readDesignFontCatalog(canvas);
  const imports = [...new Set(fontImports)].sort();
  if (catalog.fonts.length === 0 && imports.length === 0) return null;
  const root = path.resolve(workspacePath);
  const locals = await Promise.all(catalog.fonts.filter((font) => font.provider === "local").map(async (font) => {
    const metadata = await inspectSafeRegularFile(root, path.join(root, ...font.path!.split("/")), MAX_DESIGN_FONT_FILE_BYTES);
    return metadata ? `${metadata.size}:${metadata.modifiedAt}` : "missing";
  }));
  const memoKey = designStyleCacheKey(root, "fonts", `${JSON.stringify(catalog.fonts)}\0${imports.join("\n")}`);
  const key = `${designFontsGeneration()}\0${locals.join(",")}`;
  const memo = designStyleCache.get<AppFontsMemo>(memoKey);
  if (memo?.key === key) return memo.result;

  const parts: string[] = [];
  const ready: string[] = [];
  const pending: string[] = [];
  const failed: string[] = [];
  let failure: string | null = null;
  const localReady: string[] = [];
  const localMissing: string[] = [];
  let googleBytes = 0;
  const take = (name: string, state: DesignFontState) => {
    if (state.state === "ready") {
      parts.push(state.css);
      ready.push(name);
      googleBytes += state.bytes;
    } else if (state.state === "pending") {
      pending.push(name);
    } else {
      failed.push(name);
      failure ??= state.error;
    }
  };
  for (const font of catalog.fonts) {
    if (font.provider === "google") {
      take(font.family, await googleFontsCss(googleFontsCssUrl(font), root, font.subsets ?? ["latin"]));
      continue;
    }
    const local = await localFontCss(root, font);
    if (local) {
      parts.push(local.css);
      localReady.push(font.family);
    } else {
      const problem = await diagnoseSafeRegularFile(root, path.join(root, ...font.path!.split("/")), MAX_DESIGN_FONT_FILE_BYTES);
      localMissing.push(`${font.path!} (${LOCAL_FONT_PROBLEM[problem]})`);
    }
  }
  for (const url of imports) take(googleFamilies(url), await googleFontsCss(url, root));
  const variables = fontVariablesCss(catalog.fonts);
  if (variables) parts.push(variables);
  const messages: DesignStyleSourceMessage[] = [];
  if (ready.length) messages.push({ level: "info", text: `Embeds ${listed(ready)} from Google Fonts (${Math.ceil(googleBytes / 1024)} KB), downloaded once for this machine.` });
  if (localReady.length) messages.push({ level: "info", text: `Embeds ${listed(localReady)} from this repository.` });
  if (pending.length) messages.push({ level: "info", text: `Downloading ${listed(pending)} from Google Fonts; frames use the fallback font until it arrives.` });
  if (failed.length) {
    messages.push({ level: "warning", action: "update", text: `Could not download ${listed(failed)} from Google Fonts: ${failure} Frames use the fallback font; press Update to retry.` });
  }
  if (localMissing.length) {
    messages.push({ level: "warning", action: "agent", text: `Could not embed ${listed(localMissing)}.` });
  }
  const index = parseAndIndexDesignCss(parts.join("\n"));
  const css = index.css;
  const result: ResolvedDesignStyleSource = {
    id: DESIGN_FONTS_SOURCE_ID,
    title: "App fonts",
    kind: "fonts",
    path: [...catalog.fonts.map((font) => font.path ?? font.family), ...imports.map(googleFamilies)].join(", ").slice(0, 200),
    themes: [],
    status: statusLevel(messages),
    messages,
    tokens: catalog.fonts.filter((font) => font.variable).map((font) => ({
      name: font.variable!,
      value: `"${font.family}", ${font.fallback ?? "sans-serif"}`,
      themeValues: {},
    })),
    bytes: Buffer.byteLength(css, "utf8"),
    revision: css ? createHash("sha256").update(css).digest("hex").slice(0, 24) : null,
    css: css || null,
  };
  designStyleIndexes.set(result, index);
  designStyleCache.set(memoKey, { key, result }, index.bytes);
  return result;
}

/** Every declared source with its status, for the theme editor. App fonts
 * comes first when the directory declares or imports any. */
export async function readDesignStyleSources(
  workspacePath: string,
  canvas: CanvasDocument,
): Promise<{ sources: ResolvedDesignStyleSource[]; errors: string[] }> {
  const catalog = readDesignStyleSourceCatalog(canvas);
  const sources = await Promise.all(
    catalog.declarations.map((declaration) => resolveDesignStyleSource(workspacePath, declaration)),
  );
  const fonts = await appFontsSource(workspacePath, canvas, sources.flatMap((source) => source.fontImports ?? []));
  // Theme and font names live beside the sources; their problems are listed with them.
  return {
    sources: fonts ? [fonts, ...sources] : sources,
    errors: [...catalog.errors, ...readDesignThemeCatalog(canvas).errors, ...readDesignFontCatalog(canvas).errors],
  };
}

export interface FrameStyleSourceOptions {
  /** The frame's expanded HTML. Tailwind sources compile its classes, and
   * every source is pruned to what the frame can use; without it, each
   * source is returned whole. */
  html?: string;
  /** var() references from prepared linked stylesheets, without reparsing CSS. */
  stylesheetVariables?: readonly string[];
  /** The frame's own prepared stylesheets: the fonts, animations and custom
   * properties they name keep the imported rules that define them. */
  stylesheets?: readonly string[];
  /** False when only the frame's identity is needed: sources then return
   * their revision and size with empty CSS. A Tailwind source is not
   * compiled for identity, so its size is unknown (0). */
  build?: boolean;
}

export interface FrameStyleSource {
  id: string;
  css: string;
  revision: string;
  /** Identity only: the CSS length a document render would carry. */
  bytes?: number;
}

/** Identity sizes by frame signature and source revisions, so snapshots do
 * not prune every frame again. */
const identitySizes = new Map<string, number[]>();
const MAX_IDENTITY_SIZES = 512;

function assertTailwindFrameBudget(css: string): void {
  if (Buffer.byteLength(css, "utf8") > MAX_DESIGN_TAILWIND_FRAME_CSS_BYTES) {
    throw new DesignRenderBudgetError(`Tailwind CSS for this frame exceeded the ${MAX_DESIGN_TAILWIND_FRAME_CSS_BYTES / 1024 / 1024} MiB limit.`);
  }
}

/** One frame's importable sources in order. Rendering places them before the
 * frame's own styles, so frame CSS and tokens.css override imported values. */
export async function frameStyleSources(
  workspacePath: string,
  canvas: CanvasDocument,
  frameFile: string,
  options: FrameStyleSourceOptions = {},
): Promise<FrameStyleSource[]> {
  const catalog = readDesignStyleSourceCatalog(canvas);
  const declaresFonts = readDesignFontCatalog(canvas).fonts.length > 0;
  if (catalog.declarations.length === 0 && !declaresFonts) return [];
  const byId = new Map(catalog.declarations.map((declaration) => [declaration.id, declaration]));
  const candidates = catalog.declarations.some((declaration) => declaration.kind === "tailwind")
    ? designTailwindCandidates(options.html ?? "", options.stylesheetVariables)
    : [];
  const chosen = frameStyleSourceIds(canvas, catalog, frameFile);
  // A frame that lists `styles: []` opts out of every source, fonts included.
  if (chosen.length === 0 && Array.isArray((canvas.frame_info[frameFile] as Record<string, unknown> | undefined)?.styles)) return [];
  const build = options.build !== false;
  const entries: Array<{ id: string; revision: string; index: DesignCssIndex | null; css: string | null; tailwind?: true }> = [];
  const fontImports: string[] = [];
  const indexOf = (resolved: ResolvedDesignStyleSource) => designStyleIndexes.get(resolved) ?? null;
  for (const id of chosen) {
    const declaration = byId.get(id)!;
    if (declaration.kind === "build") {
      if (designBuildOutputPathError(declaration.path)) continue;
      // The output as it is now; builds run while Design is open.
      const output = await importCssSource(workspacePath, outputDeclaration(declaration));
      fontImports.push(...(output.fontImports ?? []));
      if (output.css !== null && output.revision !== null) entries.push({ id, revision: output.revision, index: indexOf(output), css: output.css });
      continue;
    }
    if (declaration.kind === "tailwind" && !designStyleSourcePathError(declaration.path)) {
      const frame = await tailwindFrameSource(workspacePath, declaration, candidates, build);
      if (frame) {
        fontImports.push(...frame.fontImports);
        entries.push({ id, revision: frame.revision, index: frame.index, css: frame.index?.css ?? null, tailwind: true });
      }
      continue;
    }
    const resolved = await resolveDesignStyleSource(workspacePath, declaration);
    fontImports.push(...(resolved.fontImports ?? []));
    if (resolved.css === null || resolved.revision === null) continue;
    entries.push({ id, revision: resolved.revision, index: indexOf(resolved), css: resolved.css });
  }
  const fonts = await appFontsSource(workspacePath, canvas, fontImports);
  if (fonts?.css && fonts.revision) {
    entries.unshift({ id: DESIGN_FONTS_SOURCE_ID, revision: fonts.revision, index: indexOf(fonts), css: fonts.css });
  }
  if (options.html === undefined) {
    return entries.map((entry) => {
      const css = build ? entry.css ?? "" : "";
      if (entry.tailwind) assertTailwindFrameBudget(css);
      return { id: entry.id, css, revision: entry.revision };
    });
  }
  // Each source's frame CSS depends on the frame and on what the other
  // sources name (a font face kept for another source's font-family).
  const features = designFrameFeatures(options.html, { stylesheets: options.stylesheets, variables: options.stylesheetVariables });
  const bases = entries.map((entry) => entry.revision).join(",");
  const revisions = entries.map((entry) =>
    createHash("sha256").update(`${entry.revision}\0${features.signature}\0${bases}`).digest("hex").slice(0, 24));
  if (!build) {
    const sizeKey = `${path.resolve(workspacePath)}\0${bases}\0${features.signature}`;
    let sizes = identitySizes.get(sizeKey);
    if (!sizes) {
      const measured = entries.filter((entry) => entry.index);
      const lengths = measureDesignFrameSources(measured.map((entry) => entry.index!), features);
      sizes = entries.map((entry) => (entry.index ? lengths[measured.indexOf(entry)]! : 0));
      identitySizes.set(sizeKey, sizes);
      while (identitySizes.size > MAX_IDENTITY_SIZES) identitySizes.delete(identitySizes.keys().next().value!);
    }
    return entries.map((entry, at) => ({ id: entry.id, css: "", revision: revisions[at]!, bytes: sizes[at]! }));
  }
  const pruned = pruneDesignFrameSources(
    entries.map((entry) => entry.index ?? parseAndIndexDesignCss(entry.css ?? "")),
    features,
  );
  return entries.map((entry, at) => {
    const css = pruned[at]!;
    if (entry.tailwind) assertTailwindFrameBudget(css);
    return { id: entry.id, css, revision: revisions[at]! };
  });
}
