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
import {
  MAX_ASSET_BYTES,
  DESIGN_ASSET_MIME_TYPES,
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
async function inlineLocalStyles(
  workspacePath: string,
  source: string,
  sources?: Readonly<Record<string, string>>,
  entryFile = "",
): Promise<string> {
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
  let resultBytes = utf8Bytes(source);
  for (const element of links) {
    const location = element.sourceCodeLocation!;
    const href =
      element.attrs.find((attribute) => attribute.name === "href")?.value ?? "";
    const resolved = safeLocalReference(directory, href, entryFile);
    let replacement = "";
    if (resolved?.toLowerCase().endsWith(".css")) {
      const css = sources
        ? (sources[
            path.relative(directory, resolved).split(path.sep).join("/")
          ] ?? null)
        : await readSafeDesignText(directory, resolved);
      if (css !== null) {
        const cssFile = path.relative(directory, resolved).split(path.sep).join("/");
        let rebased = css;
        try { rebased = rebaseDesignCssReferences(css, cssFile, entryFile); }
        catch { /* Lint reports malformed authored CSS; keep its repair preview. */ }
        replacement = `<style data-zeros-source="${escapeAttribute(cssFile)}">${rebased.replace(/<\/style/gi, "<\\/style")}</style>`;
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
  return applyDesignSourceEdits(source, edits);
}

function designAssetMimeType(reference: string): string | null {
  const pathname = reference.trim().split(/[?#]/, 1)[0] ?? "";
  return DESIGN_ASSET_MIME_TYPES[path.extname(pathname).toLowerCase()] ?? null;
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
    const mimeType = designAssetMimeType(reference);
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
): Promise<string> {
  const directory = designDirectory(workspacePath);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const budget = { inlineAssetBytes: 0 };
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

export async function prepareFrameRenderSource(
  workspacePath: string,
  source: string,
  viewport: { width: number; height: number },
  sources?: Readonly<Record<string, string>>,
  readAsset?: DesignRenderAssetReader,
  entryFile = "",
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
  const withStyles = await inlineLocalStyles(
    workspacePath,
    expanded.html,
    sources,
    entryFile,
  );
  const inlined = await inlineLocalAssets(workspacePath, withStyles, readAsset, entryFile);
  const sanitized = stripNonDesignOidsForRender(
    sanitizeDesignFrameMarkup(inlined),
  );
  assertRenderByteLimit(
    sanitized,
    MAX_SANITIZED_RENDER_BYTES,
    "Sanitized frame HTML exceeded the 15 MiB per-frame render limit.",
  );
  const sourceVersion = createHash("sha256")
    .update(source)
    .update("\0")
    .update(sanitized)
    .update("\0")
    .update(`${viewport.width}x${viewport.height}`)
    .digest("hex")
    .slice(0, 24);
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
