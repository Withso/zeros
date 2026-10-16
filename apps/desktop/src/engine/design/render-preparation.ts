import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "parse5";
import postcss from "postcss";
import { designCssUrlReferences, designSrcsetReferences, rebaseDesignCssReferences } from "@zeros/design-web";
import { expandDesignComponents } from "./components";
import { designDirectoryNameFor } from "./directory-registry";
import {
  applyDesignSourceEdits,
  createDesignRuntimeScript,
  elementRecords,
  insertDesignHeadMarkup,
  insertDesignRuntimeScript,
  sanitizeDesignFrameMarkup,
  type DesignSourceEdit,
} from "./source";
import { stripNonDesignOidsForRender, healDesignOids } from "./node-identities";
import type { CanvasDocument } from "./document-model";
import { readCanvas } from "./document-storage";
import { frameStyleSources } from "./style-sources";
import { designTailwindVariables } from "./style-tailwind";
import { inspectSafeRegularFile } from "./safe-files";
import {
  MAX_ASSET_BYTES,
  DESIGN_ASSET_MIME_TYPES,
  DESIGN_FONT_MIME_TYPES,
  readSafeDesignText,
  readSafeDesignBuffer,
  safeLocalReference,
} from "./assets";
import {
  DesignRenderBudgetError,
  utf8Bytes,
  assertRenderByteLimit,
  MAX_DESIGN_TEXT_BYTES,
  MAX_INLINE_ASSET_BYTES_PER_FRAME,
  MAX_STYLESHEETS_PER_FRAME,
  MAX_SANITIZED_RENDER_BYTES,
  MAX_COMPOSED_FRAME_BYTES,
} from "./render-budget";
function designDirectory(workspacePath: string): string {
  return path.join(
    workspacePath,
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
}
/** Immutable snapshot readers can supply assets without materializing a tree. */
export type DesignRenderAssetReader = (directory: string, resolved: string) => Promise<Buffer | null>;
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
// Shared stylesheets. A linked stylesheet is prepared once per file revision
// and page folder (references rebased to that folder, local raster assets
// inlined), then frames receive it as a placeholder that carries its content
// hash. Frame identity hashes the placeholders, so snapshots never build or
// hash a full document per frame; documents splice the cached CSS back in.
// Frames still receive inline <style> text: the sandboxed runtime reads
// cssRules for the inspector, which a linked cross-origin sheet would forbid.

interface PreparedStylesheet {
  /** CSS with `</style` escaped, ready to place inside a style element. */
  css: string;
  hash: string;
  assetBytes: number;
  variables: string[];
}
interface StylesheetCacheEntry {
  /** Each file the result depends on, with its size and mtime before reading. */
  dependencies: Array<{ file: string; signature: string }>;
  prepared: PreparedStylesheet;
}
const MAX_PREPARED_STYLESHEETS = 64;
const MAX_PREPARED_STYLESHEET_BYTES = 32 * 1024 * 1024;
const preparedStylesheets = new Map<string, StylesheetCacheEntry>();
let preparedStylesheetBytes = 0;
const preparedStylesheetStats = { hits: 0, misses: 0 };

async function fileSignature(directory: string, file: string): Promise<string> {
  const metadata = await inspectSafeRegularFile(directory, file, MAX_ASSET_BYTES);
  return metadata ? `${metadata.size}:${metadata.modifiedAt}` : "missing";
}

function evictPreparedStylesheet(key: string): void {
  const entry = preparedStylesheets.get(key);
  if (!entry) return;
  preparedStylesheets.delete(key);
  preparedStylesheetBytes -= entry.prepared.css.length;
}

/** Test hooks: cache effectiveness and isolation between cases. */
export function designStylesheetCacheStatsForTests(): { hits: number; misses: number } {
  return { ...preparedStylesheetStats };
}
export function resetDesignStylesheetCacheForTests(): void {
  for (const key of [...preparedStylesheets.keys()]) evictPreparedStylesheet(key);
  preparedStylesheetStats.hits = 0;
  preparedStylesheetStats.misses = 0;
}

async function prepareStylesheet(
  directory: string,
  resolved: string,
  cssFile: string,
  entryFile: string,
  sources?: Readonly<Record<string, string>>,
  readAsset?: DesignRenderAssetReader,
): Promise<PreparedStylesheet | null> {
  // Immutable snapshot reads bring their own files; only live disk reads share.
  const cacheable = !sources && !readAsset;
  const key = `${resolved}\0${path.posix.dirname(entryFile)}`;
  if (cacheable) {
    const entry = preparedStylesheets.get(key);
    if (entry) {
      const current = await Promise.all(
        entry.dependencies.map(({ file }) => fileSignature(directory, file)),
      );
      if (current.every((signature, index) => signature === entry.dependencies[index]!.signature)) {
        preparedStylesheetStats.hits += 1;
        preparedStylesheets.delete(key);
        preparedStylesheets.set(key, entry);
        return entry.prepared;
      }
      evictPreparedStylesheet(key);
    }
  }
  preparedStylesheetStats.misses += 1;
  // Signatures are taken before each read, so a change during preparation
  // can only make the cached entry miss later, never serve stale content.
  const dependencies: StylesheetCacheEntry["dependencies"] = [];
  if (cacheable) dependencies.push({ file: resolved, signature: await fileSignature(directory, resolved) });
  const css = sources ? (sources[cssFile] ?? null) : await readSafeDesignText(directory, resolved);
  if (css === null) return null;
  let rebased = css;
  try { rebased = rebaseDesignCssReferences(css, cssFile, entryFile); }
  catch { /* Lint reports malformed authored CSS; keep its repair preview. */ }
  const reader: DesignRenderAssetReader = async (assetDirectory, asset) => {
    if (cacheable) dependencies.push({ file: asset, signature: await fileSignature(directory, asset) });
    return (readAsset ?? readSafeDesignBuffer)(assetDirectory, asset);
  };
  const budget = { inlineAssetBytes: 0 };
  // Escape before asset inlining: postcss would otherwise rewrite a comment's
  // `</style` itself, changing the established `<\/style` form.
  const processed = await inlineCssLocalAssets(
    directory,
    rebased.replace(/<\/style/gi, "<\\/style"),
    budget,
    reader,
    entryFile,
  );
  const prepared: PreparedStylesheet = {
    css: processed,
    hash: createHash("sha256").update(processed).digest("hex").slice(0, 24),
    assetBytes: budget.inlineAssetBytes,
    variables: designTailwindVariables(processed),
  };
  if (cacheable && prepared.css.length <= MAX_PREPARED_STYLESHEET_BYTES) {
    preparedStylesheets.set(key, { dependencies, prepared });
    preparedStylesheetBytes += prepared.css.length;
    while (
      preparedStylesheets.size > MAX_PREPARED_STYLESHEETS ||
      preparedStylesheetBytes > MAX_PREPARED_STYLESHEET_BYTES
    ) {
      evictPreparedStylesheet(preparedStylesheets.keys().next().value!);
    }
  }
  return prepared;
}

interface LinkedStylesheet {
  /** Unique within the frame: `data-zeros-sheet` on its placeholder. */
  token: string;
  css: string;
  variables?: readonly string[];
  /** Identity only: the size of CSS left empty here. */
  bytes?: number;
}

/** Replace each local stylesheet link with an empty, hash-tagged placeholder. */
async function linkLocalStylesheets(
  workspacePath: string,
  source: string,
  sources?: Readonly<Record<string, string>>,
  readAsset?: DesignRenderAssetReader,
  entryFile = "",
): Promise<{ html: string; sheets: LinkedStylesheet[]; assetBytes: number }> {
  const directory = designDirectory(workspacePath);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const links = elementRecords(document)
    .map(({ element }) => element)
    .filter((element) => {
      if (element.tagName !== "link" || !element.sourceCodeLocation) {
        return false;
      }
      const rel =
        element.attrs.find((attribute) => attribute.name === "rel")?.value ??
        "";
      return rel
        .split(/\s+/)
        .some((token) => token.toLowerCase() === "stylesheet");
    });
  if (links.length > MAX_STYLESHEETS_PER_FRAME) {
    throw new DesignRenderBudgetError(
      `A frame may link at most ${MAX_STYLESHEETS_PER_FRAME} stylesheets.`,
    );
  }
  const edits: DesignSourceEdit[] = [];
  const sheets: LinkedStylesheet[] = [];
  let assetBytes = 0;
  let resultBytes = utf8Bytes(source);
  for (const [index, element] of links.entries()) {
    const location = element.sourceCodeLocation!;
    const href =
      element.attrs.find((attribute) => attribute.name === "href")?.value ?? "";
    const resolved = safeLocalReference(directory, href, entryFile);
    let replacement = "";
    if (resolved?.toLowerCase().endsWith(".css")) {
      const cssFile = path.relative(directory, resolved).split(path.sep).join("/");
      const prepared = await prepareStylesheet(directory, resolved, cssFile, entryFile, sources, readAsset);
      if (prepared) {
        assetBytes += prepared.assetBytes;
        if (assetBytes > MAX_INLINE_ASSET_BYTES_PER_FRAME) {
          throw new DesignRenderBudgetError(
            "Local assets exceeded the 12 MiB per-frame inline budget.",
          );
        }
        const token = `${index}-${prepared.hash}`;
        sheets.push({ token, css: prepared.css, variables: prepared.variables });
        replacement = `<style data-zeros-source="${escapeAttribute(cssFile)}" data-zeros-sheet="${token}"></style>`;
        resultBytes += utf8Bytes(prepared.css);
      }
    }
    resultBytes +=
      utf8Bytes(replacement) -
      utf8Bytes(source.slice(location.startOffset, location.endOffset));
    if (resultBytes > MAX_SANITIZED_RENDER_BYTES) {
      throw new DesignRenderBudgetError(
        "Linked styles exceeded the 15 MiB per-frame render limit.",
      );
    }
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      text: replacement,
    });
  }
  return { html: applyDesignSourceEdits(source, edits), sheets, assetBytes };
}

/** Put each sheet's CSS inside its empty placeholder. Sanitizing edits the
 * skeleton by source location, so placeholders survive byte for byte. */
function spliceStylesheets(skeleton: string, sheets: readonly LinkedStylesheet[]): string {
  let result = skeleton;
  for (const sheet of sheets) {
    const marker = result.indexOf(`data-zeros-sheet="${sheet.token}"`);
    const close = marker < 0 ? -1 : result.indexOf("></style>", marker);
    if (close < 0) continue;
    result = `${result.slice(0, close + 1)}${sheet.css}${result.slice(close + 1)}`;
  }
  return result;
}

function designAssetMimeType(reference: string): string | null {
  const pathname = reference.trim().split(/[?#]/, 1)[0] ?? "";
  return DESIGN_ASSET_MIME_TYPES[path.extname(pathname).toLowerCase()] ?? null;
}

/** CSS may also embed fonts, for @font-face `src`; HTML attributes may not. */
function designCssAssetMimeType(reference: string): string | null {
  const pathname = reference.trim().split(/[?#]/, 1)[0] ?? "";
  return designAssetMimeType(reference) ?? DESIGN_FONT_MIME_TYPES[path.extname(pathname).toLowerCase()] ?? null;
}

async function inlineCssUrlValue(
  directory: string,
  value: string,
  budget: { inlineAssetBytes: number },
  readAsset: DesignRenderAssetReader = readSafeDesignBuffer,
  sourceFile = "",
): Promise<string> {
  const matches = designCssUrlReferences(value);
  let result = value;
  let resultBytes = utf8Bytes(value);
  for (const match of matches.reverse()) {
    const reference = match.url;
    const mimeType = designCssAssetMimeType(reference);
    const resolved = mimeType ? safeLocalReference(directory, reference, sourceFile) : null;
    if (!resolved || !mimeType) continue;
    const data = await readAsset(directory, resolved);
    if (!data || data.length > MAX_ASSET_BYTES) continue;
    if (
      budget.inlineAssetBytes + data.length >
      MAX_INLINE_ASSET_BYTES_PER_FRAME
    ) {
      throw new DesignRenderBudgetError(
        "Local assets exceeded the 12 MiB per-frame inline budget.",
      );
    }
    budget.inlineAssetBytes += data.length;
    const start = match.functionStart;
    const replacement = `url("data:${mimeType};base64,${data.toString("base64")}")`;
    resultBytes += utf8Bytes(replacement) - utf8Bytes(value.slice(start, match.functionEnd));
    if (resultBytes > MAX_SANITIZED_RENDER_BYTES) {
      throw new DesignRenderBudgetError(
        "Inlined CSS exceeded the 15 MiB per-frame render limit.",
      );
    }
    result = `${result.slice(0, start)}${replacement}${result.slice(match.functionEnd)}`;
  }
  return result;
}

async function inlineCssLocalAssets(
  directory: string,
  source: string,
  budget: { inlineAssetBytes: number },
  readAsset?: DesignRenderAssetReader,
  sourceFile = "",
): Promise<string> {
  let root: postcss.Root;
  try {
    root = postcss.parse(source);
  } catch {
    return source;
  }
  const declarations: postcss.Declaration[] = [];
  root.walkDecls((declaration) => {
    declarations.push(declaration);
  });
  for (const declaration of declarations) {
    declaration.value = await inlineCssUrlValue(
      directory,
      declaration.value,
      budget,
      readAsset,
      sourceFile,
    );
  }
  const result = root.toString();
  assertRenderByteLimit(
    result,
    MAX_SANITIZED_RENDER_BYTES,
    "Inlined CSS exceeded the 15 MiB per-frame render limit.",
  );
  return result;
}

async function inlineLocalAssets(
  workspacePath: string,
  source: string,
  readAsset: DesignRenderAssetReader = readSafeDesignBuffer,
  sourceFile = "",
  /** Assets already inlined into this frame's shared stylesheets. */
  initialAssetBytes = 0,
): Promise<string> {
  const directory = designDirectory(workspacePath);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const budget = { inlineAssetBytes: initialAssetBytes };
  let resultBytes = utf8Bytes(source);
  const reserveEdit = (start: number, end: number, text: string) => {
    resultBytes += utf8Bytes(text) - utf8Bytes(source.slice(start, end));
    if (resultBytes > MAX_SANITIZED_RENDER_BYTES) {
      throw new DesignRenderBudgetError(
        "Inlined assets exceeded the 15 MiB per-frame render limit.",
      );
    }
    edits.push({ start, end, text });
  };
  for (const { element } of elementRecords(document)) {
    if (
      element.tagName === "style" &&
      element.sourceCodeLocation?.startTag &&
      element.sourceCodeLocation.endTag
    ) {
      const start = element.sourceCodeLocation.startTag.endOffset;
      const end = element.sourceCodeLocation.endTag.startOffset;
      const css = source.slice(start, end);
      const inlined = await inlineCssLocalAssets(directory, css, budget, readAsset, sourceFile);
      if (inlined !== css) reserveEdit(start, end, inlined);
    }
    for (const attribute of element.attrs) {
      if (attribute.name === "style") {
        const location = element.sourceCodeLocation?.attrs?.[attribute.name];
        if (!location) continue;
        const inlined = await inlineCssUrlValue(
          directory,
          attribute.value,
          budget,
          readAsset,
          sourceFile,
        );
        if (inlined !== attribute.value) {
          reserveEdit(
            location.startOffset,
            location.endOffset,
            `style="${escapeAttribute(inlined)}"`,
          );
        }
        continue;
      }
      if (attribute.name === "srcset") {
        const location = element.sourceCodeLocation?.attrs?.[attribute.name];
        if (!location) continue;
        let value = attribute.value;
        for (const reference of designSrcsetReferences(value).reverse()) {
          const mimeType = designAssetMimeType(reference.url);
          const resolved = mimeType ? safeLocalReference(directory, reference.url, sourceFile) : null;
          if (!mimeType || !resolved) continue;
          const data = await readAsset(directory, resolved);
          if (!data || data.length > MAX_ASSET_BYTES) continue;
          if (budget.inlineAssetBytes + data.length > MAX_INLINE_ASSET_BYTES_PER_FRAME)
            throw new DesignRenderBudgetError("Local assets exceeded the 12 MiB per-frame inline budget.");
          budget.inlineAssetBytes += data.length;
          value = value.slice(0, reference.start) + `data:${mimeType};base64,${data.toString("base64")}` + value.slice(reference.end);
        }
        if (value !== attribute.value) reserveEdit(location.startOffset, location.endOffset, `srcset="${escapeAttribute(value)}"`);
        continue;
      }
      if (attribute.name !== "src" && attribute.name !== "poster") continue;
      const mimeType = designAssetMimeType(attribute.value);
      const resolved = mimeType
        ? safeLocalReference(directory, attribute.value, sourceFile)
        : null;
      const location = element.sourceCodeLocation?.attrs?.[attribute.name];
      if (!resolved || !location || !mimeType) continue;
      const data = await readAsset(directory, resolved);
      if (!data || data.length > MAX_ASSET_BYTES) continue;
      if (
        budget.inlineAssetBytes + data.length >
        MAX_INLINE_ASSET_BYTES_PER_FRAME
      ) {
        throw new DesignRenderBudgetError(
          "Local assets exceeded the 12 MiB per-frame inline budget.",
        );
      }
      budget.inlineAssetBytes += data.length;
      reserveEdit(
        location.startOffset,
        location.endOffset,
        `${attribute.name}="data:${mimeType};base64,${data.toString("base64")}"`,
      );
    }
  }
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  assertRenderByteLimit(
    result,
    MAX_SANITIZED_RENDER_BYTES,
    "Inlined assets exceeded the 15 MiB per-frame render limit.",
  );
  return result;
}

/** Imported repository styles come first in head, so the frame's own CSS
 * overrides them. An unreadable canvas leaves the frame on its own styles. */
async function importedStylesheets(
  workspacePath: string,
  entryFile: string,
  canvas: CanvasDocument | undefined,
  html: string,
  linked: readonly LinkedStylesheet[],
  identityOnly: boolean,
): Promise<{ markup: string; sheets: LinkedStylesheet[] }> {
  const document = canvas ?? (await readCanvas(workspacePath).catch(() => null));
  if (!document) return { markup: "", sheets: [] };
  const sheets: LinkedStylesheet[] = [];
  let markup = "";
  // Each imported source is pruned to what this frame can use, including the
  // fonts and variables the frame's own stylesheets name.
  const sources = await frameStyleSources(workspacePath, document, entryFile, {
    html,
    stylesheetVariables: linked.flatMap((sheet) => sheet.variables ?? []),
    stylesheets: linked.map((sheet) => sheet.css),
    build: !identityOnly,
  });
  for (const [index, source] of sources.entries()) {
    const token = `s${index}-${source.revision}`;
    sheets.push({ token, css: source.css.replace(/<\/style/gi, "<\\/style"), ...(source.bytes === undefined ? {} : { bytes: source.bytes }) });
    markup += `<style data-zeros-style-source="${source.id}" data-zeros-sheet="${token}"></style>`;
  }
  return { markup, sheets };
}

export interface FrameRenderOptions {
  /** Return only the generation; `sanitized` is then a skeleton whose
   * stylesheet placeholders are empty. Snapshots need no document. */
  identityOnly?: boolean;
}

export async function prepareFrameRenderSource(
  workspacePath: string,
  source: string,
  viewport: { width: number; height: number },
  sources?: Readonly<Record<string, string>>,
  readAsset?: DesignRenderAssetReader,
  entryFile = "",
  canvas?: CanvasDocument,
  options: FrameRenderOptions = {},
): Promise<{ sanitized: string; sourceVersion: string }> {
  assertRenderByteLimit(
    source,
    MAX_DESIGN_TEXT_BYTES,
    "Authored frame HTML exceeded the 2 MiB source limit.",
  );
  const expanded = await expandDesignComponents(workspacePath, healDesignOids(source).html, sources, entryFile);
  assertRenderByteLimit(
    expanded.html,
    MAX_SANITIZED_RENDER_BYTES,
    "Expanded components exceeded the 15 MiB per-frame render limit.",
  );
  const linked = await linkLocalStylesheets(
    workspacePath,
    expanded.html,
    sources,
    readAsset,
    entryFile,
  );
  // Tailwind needs classes from the expanded frame and variables read by its
  // linked sheets. The latter are extracted once per prepared stylesheet.
  const imported = await importedStylesheets(workspacePath, entryFile, canvas, expanded.html,
    linked.sheets, options.identityOnly === true);
  const withImported = imported.markup
    ? insertDesignHeadMarkup(linked.html, imported.markup)
    : linked.html;
  const inlined = await inlineLocalAssets(
    workspacePath,
    withImported,
    readAsset,
    entryFile,
    linked.assetBytes,
  );
  const skeleton = stripNonDesignOidsForRender(sanitizeDesignFrameMarkup(inlined));
  // Placeholders carry each stylesheet's content hash, so the generation
  // still changes with any stylesheet or asset it depends on.
  const sourceVersion = createHash("sha256")
    .update(source)
    .update("\0")
    .update(skeleton)
    .update("\0")
    .update(`${viewport.width}x${viewport.height}`)
    .digest("hex")
    .slice(0, 24);
  const sheets = [...imported.sheets, ...linked.sheets];
  if (options.identityOnly) {
    // Splicing fills empty placeholders, so the document's size is known
    // without building it; identity and document fail the same frames.
    const bytes = sheets.reduce((total, sheet) => total + (sheet.bytes ?? utf8Bytes(sheet.css)), utf8Bytes(skeleton));
    if (bytes > MAX_SANITIZED_RENDER_BYTES) {
      throw new DesignRenderBudgetError("Sanitized frame HTML exceeded the 15 MiB per-frame render limit.");
    }
    return { sanitized: skeleton, sourceVersion };
  }
  const sanitized = spliceStylesheets(skeleton, sheets);
  assertRenderByteLimit(
    sanitized,
    MAX_SANITIZED_RENDER_BYTES,
    "Sanitized frame HTML exceeded the 15 MiB per-frame render limit.",
  );
  return { sanitized, sourceVersion };
}

export async function composeFrameSrcDoc(
  workspacePath: string,
  source: string,
  viewport: { width: number; height: number },
  entryFile = "",
): Promise<{ sourceVersion: string; srcDoc: string }> {
  const { sanitized, sourceVersion } = await prepareFrameRenderSource(
    workspacePath,
    source,
    viewport,
    undefined,
    undefined,
    entryFile,
  );
  const runtime = createDesignRuntimeScript(sourceVersion);
  const csp =
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="default-src 'none'; script-src ${runtime.cspSource}; ` +
    `style-src 'unsafe-inline'; img-src data: blob:; font-src data:; ` +
    `connect-src 'none'; worker-src 'none'; frame-src 'none'; ` +
    `object-src 'none'; base-uri 'none'; form-action 'none';">`;
  const withPolicy = insertDesignHeadMarkup(sanitized, csp);
  const srcDoc = insertDesignRuntimeScript(withPolicy, sourceVersion).html;
  assertRenderByteLimit(
    srcDoc,
    MAX_COMPOSED_FRAME_BYTES,
    "Runtime-enabled frame HTML exceeded the 16 MiB render limit.",
  );
  return {
    sourceVersion,
    srcDoc,
  };
}
