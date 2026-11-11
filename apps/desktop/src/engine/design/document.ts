import { readDirectoryDesignManifest } from "./metadata";
import { designCatalogRevision, inspectDesignCatalog, readDesignCatalogMetadataWithContext, sameDesignCatalogInspection } from "./catalog-storage";
import type { DesignPageHashes } from "@zeros/protocol/design-catalog";
import { DesignCatalogError, designCatalogPageHashes, type DesignCatalogSnapshot } from "./catalog";
import { escapeText, escapeAttribute } from "./source";
import {
  listDesignAssets,
  readSafeDesignText,
  safeLocalReference,
} from "./assets";
import {
  designLayerCount,
  designNodeRecords,
  designRenderedChildElements,
  isDesignNodeElement,
  isShadowDesignNodeElement,
} from "./node-identities";
import {
  DesignRenderBudgetError,
  MAX_DESIGN_TEXT_BYTES,
} from "./render-budget";
import {
  composeFrameSrcDoc,
  prepareFrameRenderSource,
  type RetainedFrameRender,
} from "./render-preparation";
import { parseDesignSource, sharedDesignParse, withSharedDesignParses } from "./shared-parse";
import { designFrameIdentities, designFrameIdentityContext, type DesignFrameIdentity } from "./identity-cache";
import { captureDurableDesignDependencies, isDesignDependencyCaptureActive, type DurableDesignDependency } from "./dependency-read-set";
import { designRecordedCanvasActive, retainDesignFrame } from "./retained-frames";
import { designPreparationWorkerCount, prepareFrameIdentitiesInWorkers, type DesignWorkerFrameIdentity } from "./preparation-pool";
import { elementRecords } from "./source";
// ──────────────────────────────────────────────────────────
// Design document — authored HTML/CSS frames and canvas metadata
// ──────────────────────────────────────────────────────────
//
// A design workspace is still a Git worktree, but its authored surface is one
// deliberately small directory:
//
//   Zeros Design/<page>/*.html  registered frames in each page folder
//   Zeros Design/*.css          shared authored styles
//   Zeros Design/tokens.css     typed design tokens + layout reset
//   Zeros Design/meta/design.toml  engine-managed directory registration
//   Zeros Design/meta/canvas.json  editable pages, frames and Foundation metadata
//   Zeros Design/rules.md       short native-authoring instructions
//
// Legacy root metadata and flat sources remain readable. Explicit Design
// authoring upgrades them recoverably into the meta/pages layout.
//
// This module is the single engine-side interpretation of that format. The
// renderer and first-party MCP server both consume these functions, so frame
// discovery, OID healing, constraints, and token parsing cannot drift.

import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { migrateDesignFoundationManifest } from "@zeros/design-core";
import { designTokenThemeName } from "@zeros/design-web";
import type { ParserError } from "parse5";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { withDesignDocumentWrite as withDocumentWrite } from "./document-write-lock";

import { designSourceDeclaresOptions, expandDesignComponents } from "./components";
import { designComponentRegistry } from "./component-registry";
import {
  DESIGN_CANVAS_FILE as CANVAS_MARKER_FILE,
  DEFAULT_DESIGN_DIRECTORY_NAME,
  designDirectoryNameFor,
} from "./directory-registry";
import {
  type CanvasDocument,
  type DesignCanvasFrame,
  type DesignElementOffset,
  type DesignFrameDocument,
  type DesignFrameMutationInput,
  type DesignFrameRenderIdentity,
  type DesignFrameRenderSource,
  type DesignFrameSelectionIdentity,
  type DesignFrameSummary,
  type DesignFrameTreeNode,
  type DesignLintReport,
  type DesignLintViolation,
  type DesignMutationResult,
  type DesignReadOptions,
  type DesignSourceSpan,
  type DesignStyleMutationValue,
  type DesignTokenMutationResult,
  type DesignTokenSummary,
  type DesignTokensDocument,
  type DesignWorkspaceSnapshot,
  type InlineStyleDeclaration,
  canvasReadSnapshot,
} from "./document-model";
import { designCanvasPageCatalog } from "./pages";
import { readDirectoryDesignLayout } from "./metadata";
import {
  assertFrameFile,
  atomicWriteDesignSource,
  designDirectory,
  discoverFrameFiles,
  finiteBetween,
  nextFrameGeometry,
  readBoundedDesignFrameSource,
  freezeDeep,
  readCanvas,
  readCanvasContext,
  readSharedCanvasContext,
  type DesignCanvasReadContext,
  readFrameMeta,
  writeCanvas,
} from "./document-storage";
import {
  DESIGN_TOKENS_FILE,
  initializeDesignDocumentUnlocked,
  recoverPendingDesignTransactionUnlocked,
} from "./document-transactions";
import {
  assertDesignNodeId,
  designFrameTarget,
  hasDesignControlCharacter,
  healDesignOids,
  listDesignFrames,
  listDesignFramesUnlocked,
  prepareFrameRenderSourceForFile,
} from "./frame-lifecycle";
import { getDesignRuntimeAudit } from "./runtime-audits";
import { inspectSafeRegularFile, readSafeRegularFile, withDesignReadScope } from "./safe-files";
import {
  DESIGN_FONTS_SOURCE_ID,
  designStyleSourcesUseFonts,
  frameStyleSourceIds,
  readDesignStyleSourceCatalog,
  frameStyleSourceChoices,
  readDesignStyleSources,
} from "./style-sources";
import { readDesignFontCatalog } from "./style-fonts";
import { designKnownClasses, type DesignKnownClasses } from "./style-classes";
import { designTokenColorIndex, lintDesignAuthoringContract, type DesignTokenColorIndex } from "./authoring-lint";
import { mergeDesignThemes, readDesignThemeCatalog } from "./themes";

export { listDesignAssets,type DesignAssetSummary } from "./assets";
export { designDirectoryNameFor } from "./directory-registry";
export { createDesignPage, deleteDesignPage, renameDesignPage } from "./page-lifecycle";
export { type DesignCanvasFrame,type DesignElementOffset,type DesignFrameChange,type DesignFrameDocument,type DesignFrameGeometry,type DesignFrameRenderIdentity,type DesignFrameRenderSource,type DesignFrameRestorePoint,type DesignFrameSelectionIdentity,type DesignFrameSummary,type DesignFrameTreeNode,type DesignLintReport,type DesignLintSeverity,type DesignLintViolation,type DesignMutationResult,type DesignSourceSpan,type DesignTokenMutationResult,type DesignTokenSummary,type DesignTokensDocument,type DesignWorkspaceSnapshot } from "./document-model";
export { DESIGN_TOKENS_FILE,DESIGN_TRANSACTION_JOURNAL_FILE,commitDesignWebDocumentState,designTransactionJournalPath,designTransactionRecoveryDirectory,designWebDocumentId,readDesignWebDocumentState,recoverDesignStorageForArchive,recoverPendingDesignTransaction } from "./document-transactions";
export { captureDesignFrameRestorePoint,createDesignFrame,createDesignFrameWithRestorePoint,designFrameCreateBatchesForTests,deleteDesignFrame,duplicateDesignFrame,healDesignOids,listDesignFrames,moveDesignFrameGeometries,readDesignFrameRenderIdentityFromSource,renameDesignFrame,replaceDesignFrameFromHistory,restoreDesignFrame,restoreDesignFrameChanges,sameDesignFrameRestorePoint,transferDesignNode,updateDesignFrameGeometry } from "./frame-lifecycle";
export { stripNonDesignOidsForRender } from "./node-identities";
export { DesignRenderBudgetError } from "./render-budget";
export {
createDesignRuntimeScript,
insertDesignRuntimeScript,
sanitizeDesignFrameMarkup
} from "./source";

/** The DEFAULT design folder name. Callers that need the folder for a
 *  SPECIFIC workspace must go through designDirectoryNameFor (the per-repo
 *  `[design] directory` pointer can rename or nest it); this constant remains
 *  for defaults, seeds, and pre-pointer compatibility. */
export const DESIGN_DIRECTORY_NAME = DEFAULT_DESIGN_DIRECTORY_NAME;
export const DESIGN_CANVAS_FILE = CANVAS_MARKER_FILE;

/** Explicit folder adoption can rebuild metadata without healing or rewriting
 * authored HTML. Only the trusted Settings Design action calls this helper. */
export async function inspectDesignFilesForAdoption(
  workspace: string,
  directory: string,
): Promise<Record<string, unknown>> {
  return withDesignDirectoryNameLease(workspace, directory, async () => {
    const canvas: CanvasDocument = {
      version: 3,
      frames: {},
      frame_info: {},
      foundation: migrateDesignFoundationManifest(undefined),
    };
    for (const file of await discoverFrameFiles(workspace)) {
      const source = await readBoundedDesignFrameSource(workspace, file);
      const document = parse(source, { sourceCodeLocationInfo: true });
      const meta = readFrameMeta(document, file, canvas);
      canvas.frames[file] = nextFrameGeometry(
        Object.values(canvas.frames),
        meta,
      );
      canvas.frame_info[file] = { title: meta.title, kind: meta.kind };
    }
    return { ...canvas };
  });
}

/** Seed only missing app-owned foundations. Existing authored design files are
 * never overwritten, so creating a design workspace over a tracked
 * `Zeros Design/` directory is lossless. */
export async function initializeDesignDocument(
  workspacePath: string,
): Promise<{ created: string[] }> {
  return withDocumentWrite(workspacePath, async () => ({
    created: await initializeDesignDocumentUnlocked(workspacePath, {
      force: true,
    }),
  }));
}

function normalizeCssProperty(value: string): string {
  const normalized = value.startsWith("--")
    ? value.trim()
    : value
        .trim()
        .replace(/([A-Z])/g, "-$1")
        .toLowerCase();
  if (
    normalized.length > 128 ||
    (!/^--[A-Za-z0-9_-]+$/.test(normalized) &&
      !/^-?[a-z][a-z0-9-]*$/.test(normalized))
  ) {
    throw new Error(`Invalid CSS property: ${value}`);
  }
  return normalized;
}

function validateCssMutationValue(
  workspacePath: string,
  property: string,
  value: string,
  sourceFile: string,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(`a{${property}:${normalized}}`);
  } catch {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  const rule = root.first;
  const declarations =
    rule?.type === "rule"
      ? (rule.nodes?.filter((node) => node.type === "decl") ?? [])
      : [];
  if (
    root.nodes.length !== 1 ||
    rule?.type !== "rule" ||
    rule.nodes?.length !== 1 ||
    declarations.length !== 1 ||
    declarations[0]?.prop !== property
  ) {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  if (
    /(?:expression\s*\(|javascript\s*:|@import\b)/i.test(normalized) ||
    hasDesignControlCharacter(normalized, true)
  ) {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  for (const match of normalized.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const reference = match[2]?.trim() ?? "";
    const local = safeLocalReference(
      designDirectory(workspacePath),
      reference,
      sourceFile,
    );
    if (
      !local &&
      !/^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(reference)
    ) {
      throw new Error(`Invalid CSS value for ${property}: external URL.`);
    }
  }
  return normalized;
}

function inlineStyleDeclarations(value: string): InlineStyleDeclaration[] {
  const declarations: InlineStyleDeclaration[] = [];
  let segmentStart = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  const finish = (segmentEnd: number, end: number) => {
    let colon = -1;
    let localQuote = "";
    let localEscaped = false;
    let localDepth = 0;
    for (let index = segmentStart; index < segmentEnd; index += 1) {
      const character = value[index] ?? "";
      if (localEscaped) {
        localEscaped = false;
        continue;
      }
      if (character === "\\") {
        localEscaped = true;
        continue;
      }
      if (localQuote) {
        if (character === localQuote) localQuote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        localQuote = character;
        continue;
      }
      if (character === "(" || character === "[") localDepth += 1;
      else if (character === ")" || character === "]") {
        localDepth = Math.max(0, localDepth - 1);
      } else if (character === ":" && localDepth === 0) {
        colon = index;
        break;
      }
    }
    if (colon >= 0) {
      const property = value.slice(segmentStart, colon).trim();
      let valueStart = colon + 1;
      let valueEnd = segmentEnd;
      while (/\s/.test(value[valueStart] ?? "")) valueStart += 1;
      while (valueEnd > valueStart && /\s/.test(value[valueEnd - 1] ?? "")) {
        valueEnd -= 1;
      }
      if (property) {
        declarations.push({
          property: normalizeCssProperty(property),
          start: segmentStart,
          end,
          valueStart,
          valueEnd,
        });
      }
    }
    segmentStart = end;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
    } else if (character === ";" && depth === 0) {
      finish(index, index + 1);
    }
  }
  if (segmentStart < value.length) finish(value.length, value.length);
  return declarations;
}

function escapeStyleValue(value: string, quote: string): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === "'"
    ? escaped.replace(/'/g, "&#39;")
    : escaped.replace(/"/g, "&quot;");
}

function styleAttributeContent(raw: string): {
  before: string;
  content: string;
  after: string;
  quote: string;
} | null {
  const equal = raw.indexOf("=");
  if (equal < 0) return null;
  let contentStart = equal + 1;
  while (/\s/.test(raw[contentStart] ?? "")) contentStart += 1;
  const quote = raw[contentStart] === "'" ? "'" : '"';
  if (raw[contentStart] === quote) {
    const contentEnd = raw.lastIndexOf(quote);
    if (contentEnd <= contentStart) return null;
    return {
      before: raw.slice(0, contentStart + 1),
      content: raw.slice(contentStart + 1, contentEnd),
      after: raw.slice(contentEnd),
      quote,
    };
  }
  return {
    before: raw.slice(0, contentStart),
    content: raw.slice(contentStart),
    after: "",
    quote: '"',
  };
}

function elementForMutation(
  document: DefaultTreeAdapterTypes.Document,
  nodeId: string,
): DefaultTreeAdapterTypes.Element {
  const matches = designNodeRecords(document).filter(
    (record) => record.oid === nodeId,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      matches.length > 1
        ? `Design element is not unique: ${nodeId}`
        : `Design element not found: ${nodeId}`,
    );
  }
  return matches[0].element;
}

async function mutationResultUnlocked(
  workspacePath: string,
  file: string,
  source: string,
  changed: boolean,
): Promise<DesignMutationResult> {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const canvas = await readCanvas(workspacePath);
  const meta = readFrameMeta(document, file, canvas);
  const geometry = canvas.frames[file] ?? {
    x: 0,
    y: 0,
    w: meta.width,
    h: meta.height,
    z: 0,
  };
  const info = await stat(path.join(designDirectory(workspacePath), file));
  const composed = await composeFrameSrcDoc(workspacePath, source, {
    width: geometry.w,
    height: geometry.h,
  }, file);
  const knownTokens = await designKnownTokens(workspacePath);
  const knownClasses = await designKnownClasses(workspacePath);
  const linted = await lintFrame(
    workspacePath,
    file,
    { healOids: false },
    knownTokens.names(file),
    knownClasses,
    source,
    knownTokens.colors(file),
  );
  const violations = linted.violations.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  return {
    changed,
    frame: {
      file,
      title: meta.title,
      kind: meta.kind,
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: designNodeRecords(document).length,
      layerCount: designLayerCount(document),
      modifiedAt: info.mtimeMs,
      sourceVersion: composed.sourceVersion,
      source,
      srcDoc: composed.srcDoc,
      tree: frameTree(document, 4),
    },
    lint: {
      workspacePath: path.resolve(workspacePath),
      checkedFiles: [file],
      violations,
      healedOids: 0,
    },
  };
}

export async function readDesignMutationResult(
  workspacePath: string,
  frame: string,
  changed: boolean,
): Promise<DesignMutationResult> {
  const file = assertFrameFile(frame);
  await designFrameTarget(workspacePath, file);
  return mutationResultUnlocked(
    workspacePath,
    file,
    await readBoundedDesignFrameSource(workspacePath, file),
    changed,
  );
}

async function mutateDesignFrameSource(
  workspacePath: string,
  input: DesignFrameMutationInput,
  mutate: (
    source: string,
    document: DefaultTreeAdapterTypes.Document,
    element: DefaultTreeAdapterTypes.Element,
  ) => string,
): Promise<DesignMutationResult> {
  const file = assertFrameFile(input.frame);
  const nodeId = assertDesignNodeId(input.nodeId);
  if (!/^[a-f0-9]{24}$/.test(input.sourceVersion)) {
    throw new Error("sourceVersion must be an exact design render generation.");
  }
  return withDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    await designFrameTarget(workspacePath, file);
    const before = await readBoundedDesignFrameSource(workspacePath, file);
    const source = healDesignOids(before).html;
    const canvas = await readCanvas(workspacePath);
    const document = parse(source, { sourceCodeLocationInfo: true });
    const meta = readFrameMeta(document, file, canvas);
    const geometry = canvas.frames[file];
    const current = await prepareFrameRenderSource(workspacePath, before, {
      width: geometry?.w ?? meta.width,
      height: geometry?.h ?? meta.height,
    }, undefined, undefined, file, canvas, { identityOnly: true });
    if (current.sourceVersion !== input.sourceVersion) {
      throw new Error(
        `Design frame changed before the mutation: ${file}. Re-read it and retry.`,
      );
    }
    const element = elementForMutation(document, nodeId);
    const updated = mutate(source, document, element);
    const healed = healDesignOids(updated).html;
    const changed = updated !== source;
    if (changed) {
      // Only errors gate a mutation, so this comparison needs no token colours.
      const knownTokens = (await designKnownTokens(workspacePath)).names(file);
      const knownClasses = await designKnownClasses(workspacePath);
      const [baseline, linted] = await Promise.all([
        lintFrame(
          workspacePath,
          file,
          { healOids: false },
          knownTokens,
          knownClasses,
          source,
          undefined,
          null,
        ),
        lintFrame(
          workspacePath,
          file,
          { healOids: false },
          knownTokens,
          knownClasses,
          healed,
          undefined,
          null,
        ),
      ]);
      const baselineErrors = new Map<string, number>();
      for (const violation of baseline.violations) {
        if (violation.severity !== "error") continue;
        // Oid healing can attach an identity to the same legacy violation.
        // Compare the semantic finding (with multiplicity), not incidental
        // identity metadata, so healing does not make an old error look new.
        const key = `${violation.ruleId}\0${violation.message}`;
        baselineErrors.set(key, (baselineErrors.get(key) ?? 0) + 1);
      }
      const errors = linted.violations.filter((violation) => {
        if (violation.severity !== "error") return false;
        const key = `${violation.ruleId}\0${violation.message}`;
        const remaining = baselineErrors.get(key) ?? 0;
        if (remaining === 0) return true;
        baselineErrors.set(key, remaining - 1);
        return false;
      });
      if (errors.length > 0) {
        const ruleIds = [...new Set(errors.map((error) => error.ruleId))].join(
          ", ",
        );
        throw new Error(
          `Design mutation failed ${ruleIds}: ${errors[0]!.message}`,
        );
      }
      await writeCanvas(workspacePath, canvas, [{
        file: `${designDirectoryNameFor(workspacePath)}/${file}`, before, after: healed,
      }]);
    }
    return mutationResultUnlocked(workspacePath, file, healed, changed);
  });
}

/** Shared structured style writer used by both the inspector and MCP. Existing
 * declarations retain their exact surrounding whitespace/order; new values
 * are appended to the one selected inline style attribute. */
export async function updateDesignNodeStyles(
  workspacePath: string,
  input: DesignFrameMutationInput & {
    styles: Record<string, DesignStyleMutationValue>;
  },
): Promise<DesignMutationResult> {
  const file = assertFrameFile(input.frame);
  const entries = Object.entries(input.styles);
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("styles must contain between 1 and 64 properties.");
  }
  const styles = new Map<string, DesignStyleMutationValue>();
  for (const [rawProperty, rawValue] of entries) {
    const property = normalizeCssProperty(rawProperty);
    styles.set(
      property,
      rawValue === null
        ? null
        : validateCssMutationValue(workspacePath, property, rawValue, file),
    );
  }
  return mutateDesignFrameSource(
    workspacePath,
    input,
    (source, _document, element) => {
      const startTag = element.sourceCodeLocation?.startTag;
      if (!startTag)
        throw new Error(
          `Design element has no authored start tag: ${input.nodeId}`,
        );
      const styleLocation = element.sourceCodeLocation?.attrs?.style;
      if (!styleLocation) {
        const declarations = [...styles]
          .filter((entry): entry is [string, string] => entry[1] !== null)
          .map(
            ([property, value]) =>
              `${property}:${escapeStyleValue(value, '"')};`,
          )
          .join(" ");
        if (!declarations) return source;
        const close = source.lastIndexOf(">", startTag.endOffset - 1);
        if (close < startTag.startOffset)
          throw new Error("Malformed design start tag.");
        const slash = source.slice(startTag.startOffset, close).match(/\/\s*$/);
        const insertAt =
          slash?.index === undefined
            ? close
            : startTag.startOffset + slash.index;
        return `${source.slice(0, insertAt)} style="${declarations}"${source.slice(insertAt)}`;
      }
      const raw = source.slice(
        styleLocation.startOffset,
        styleLocation.endOffset,
      );
      const attribute = styleAttributeContent(raw);
      if (!attribute) throw new Error("Malformed design style attribute.");
      let content = attribute.content;
      const declarations = inlineStyleDeclarations(content);
      const edits: Array<{ start: number; end: number; text: string }> = [];
      const additions: Array<[string, string]> = [];
      for (const [property, value] of styles) {
        const matches = declarations.filter(
          (item) => item.property === property,
        );
        const existing = matches.at(-1);
        if (!existing) {
          if (value !== null) additions.push([property, value]);
          continue;
        }
        if (value === null) {
          for (const match of matches) {
            edits.push({ start: match.start, end: match.end, text: "" });
          }
        } else {
          edits.push({
            start: existing.valueStart,
            end: existing.valueEnd,
            text: escapeStyleValue(value, attribute.quote),
          });
        }
      }
      for (const edit of edits.sort(
        (left, right) => right.start - left.start,
      )) {
        content = `${content.slice(0, edit.start)}${edit.text}${content.slice(edit.end)}`;
      }
      if (additions.length > 0) {
        const separator = content.trim()
          ? content.trimEnd().endsWith(";")
            ? " "
            : "; "
          : "";
        content = `${content}${separator}${additions
          .map(
            ([property, value]) =>
              `${property}:${escapeStyleValue(value, attribute.quote)};`,
          )
          .join(" ")}`;
      }
      const replacement = `${attribute.before}${content}${attribute.after}`;
      return `${source.slice(0, styleLocation.startOffset)}${replacement}${source.slice(styleLocation.endOffset)}`;
    },
  );
}

export async function setDesignNodeText(
  workspacePath: string,
  input: DesignFrameMutationInput & { text: string },
): Promise<DesignMutationResult> {
  if (input.text.length > 10_000) throw new Error("Design text is too long.");
  return mutateDesignFrameSource(
    workspacePath,
    input,
    (source, _document, element) => {
      if (element.childNodes.some((node) => "tagName" in node)) {
        throw new Error(
          `Design element ${input.nodeId} contains element children; set_text would discard them.`,
        );
      }
      const location = element.sourceCodeLocation;
      if (!location?.startTag || !location.endTag) {
        throw new Error(`Design element cannot contain text: ${input.nodeId}`);
      }
      return `${source.slice(0, location.startTag.endOffset)}${escapeText(input.text)}${source.slice(location.endTag.startOffset)}`;
    },
  );
}

export async function writeDesignNodeHtml(
  workspacePath: string,
  input: DesignFrameMutationInput & {
    html: string;
    mode?: "append" | "replace-inner";
  },
): Promise<DesignMutationResult> {
  if (!input.html || input.html.length > 200_000) {
    throw new Error("html must contain between 1 and 200000 characters.");
  }
  const mode = input.mode ?? "replace-inner";
  if (mode !== "append" && mode !== "replace-inner") {
    throw new Error(`Unsupported HTML write mode: ${String(mode)}`);
  }
  return mutateDesignFrameSource(
    workspacePath,
    input,
    (source, _document, element) => {
      const location = element.sourceCodeLocation;
      if (!location?.startTag || !location.endTag) {
        throw new Error(`Design element cannot contain HTML: ${input.nodeId}`);
      }
      const start =
        mode === "append"
          ? location.endTag.startOffset
          : location.startTag.endOffset;
      return `${source.slice(0, start)}${input.html}${source.slice(location.endTag.startOffset)}`;
    },
  );
}

export async function prepareDesignAssetInsertion(
  workspacePath: string,
  input: Omit<DesignFrameMutationInput, "nodeId"> & {
    assetPath: string;
    x: number;
    y: number;
  },
): Promise<{ nodeId: string; html: string }> {
  const asset = (await listDesignAssets(workspacePath)).find(
    (candidate) => candidate.path === input.assetPath,
  );
  if (!asset) throw new Error(`Design asset not found: ${input.assetPath}`);
  // An asset joins light content: shadow roots are restyled, not rebuilt.
  const offsets = (await readDesignElementOffsetMap(workspacePath, input.frame)).filter(
    (element) => !element.shadow,
  );
  const root =
    offsets.find((element) => element.tag === "main") ?? offsets[0] ?? null;
  if (!root) {
    throw new Error(`Design frame has no editable root: ${input.frame}`);
  }
  const x = Math.round(finiteBetween(input.x, 0, -1_000_000, 1_000_000));
  const y = Math.round(finiteBetween(input.y, 0, -1_000_000, 1_000_000));
  const oid = `asset-${createHash("sha256")
    .update(`${input.frame}:${asset.path}:${Date.now()}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 9)}`;
  const relative = path.posix.relative(path.posix.dirname(assertFrameFile(input.frame)), asset.path);
  const reference = relative.startsWith(".") ? relative : "./" + relative;
  return {
    nodeId: root.oid,
    html: `<img data-oid="${oid}" src="${escapeAttribute(reference)}" alt="${escapeAttribute(path.basename(asset.name, path.extname(asset.name)))}" style="position:absolute; left:${x}px; top:${y}px; max-width:320px; height:auto;">`,
  };
}

/** Compatibility wrapper for older callers. New editor and headless writes
 * route the prepared semantic operation through DesignApi instead. */
export async function insertDesignAsset(
  workspacePath: string,
  input: Omit<DesignFrameMutationInput, "nodeId"> & {
    assetPath: string;
    x: number;
    y: number;
  },
): Promise<DesignMutationResult> {
  const prepared = await prepareDesignAssetInsertion(workspacePath, input);
  return writeDesignNodeHtml(workspacePath, {
    frame: input.frame,
    nodeId: prepared.nodeId,
    sourceVersion: input.sourceVersion,
    mode: "append",
    html: prepared.html,
  });
}

function textWithin(element: DefaultTreeAdapterTypes.Element): string | null {
  const pieces: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("value" in node) pieces.push(node.value);
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(element);
  const text = pieces.join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : null;
}

function frameTree(
  document: DefaultTreeAdapterTypes.Document,
  depth: number,
): DesignFrameTreeNode[] {
  const visit = (
    element: DefaultTreeAdapterTypes.Element,
    remaining: number,
  ): DesignFrameTreeNode => ({
    tag: element.tagName,
    oid:
      element.attrs.find((attribute) => attribute.name === "data-oid")?.value ??
      null,
    text: textWithin(element),
    children:
      remaining > 0
        ? designRenderedChildElements(element).map((child) =>
            visit(child, remaining - 1),
          )
        : [],
  });
  const body = elementRecords(document).find(
    ({ element }) => element.tagName === "body",
  )?.element;
  if (!body) return [];
  return body.childNodes
    .filter(
      (node): node is DefaultTreeAdapterTypes.Element =>
        "tagName" in node && isDesignNodeElement(node),
    )
    .map((element) => visit(element, depth));
}

function designSourceSpan(location: {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}): DesignSourceSpan {
  return {
    startOffset: location.startOffset,
    endOffset: location.endOffset,
    startLine: location.startLine,
    startColumn: location.startCol,
    endLine: location.endLine,
    endColumn: location.endCol,
  };
}

/** Stable oid → parse5 byte/line spans. Live selections validate against this
 * map, and source edits use the same exact offsets for minimal splices instead
 * of reserializing the document. */
export function readDesignElementOffsetMap(
  workspacePath: string,
  frame: string,
): Promise<DesignElementOffset[]> {
  return withSharedDesignParses(() => readSharedDesignElementOffsetMap(workspacePath, frame));
}

async function readSharedDesignElementOffsetMap(
  workspacePath: string,
  frame: string,
): Promise<DesignElementOffset[]> {
  await designFrameTarget(workspacePath, frame, await readSharedCanvasContext(workspacePath));
  const source = await readBoundedDesignFrameSource(workspacePath, frame);
  const document = parseDesignSource(source);
  const healed = healDesignOids(source).html;
  const identified = designNodeRecords(sharedDesignParse(healed) ?? parse(healed));
  const offsets: DesignElementOffset[] = [];
  let index = 0;
  for (const { element } of designNodeRecords(document)) {
    const oid = identified[index++]?.oid;
    const location = element.sourceCodeLocation;
    if (!oid || !location?.startTag) continue;
    offsets.push({
      oid,
      tag: element.tagName,
      ...(isShadowDesignNodeElement(element) ? { shadow: true as const } : {}),
      ...designSourceSpan(location),
      startTag: designSourceSpan(location.startTag),
      endTag: location.endTag ? designSourceSpan(location.endTag) : null,
    });
  }
  return offsets;
}

/** Read the exact render generation for one frame without discovering,
 * parsing, and composing every frame in the workspace. Screenshot
 * publications use this to stay linear as the canvas grows. */
export async function readDesignFrameRenderIdentity(
  workspacePath: string,
  frame: string,
): Promise<DesignFrameRenderIdentity> {
  const identity = await readDesignFrameSelectionIdentity(workspacePath, frame);
  return { file: identity.file, sourceVersion: identity.sourceVersion };
}

/** Build the exact self-contained HTML served to a sandboxed protocol frame.
 * Styles, element images, and CSS backgrounds retain their rendered pixels
 * without foreignObject subresource reads. */
export async function readDesignFrameRenderSourceFromSource(
  workspacePath: string,
  frame: string,
  source: string,
  canvas?: CanvasDocument,
): Promise<DesignFrameRenderSource> {
  const file = assertFrameFile(frame);
  const render = await prepareFrameRenderSourceForFile(
    workspacePath,
    file,
    source,
    {},
    canvas,
  );
  return {
    file,
    sourceVersion: render.sourceVersion,
    html: render.sanitized,
  };
}

/** One-frame selection identity. Unlike readDesignFrame(), this never scans,
 * heals, lints, or composes every frame in the workspace, and it reuses the
 * same parse for metadata plus valid node ids. */
export async function readDesignFrameSelectionIdentity(
  workspacePath: string,
  frame: string,
): Promise<DesignFrameSelectionIdentity> {
  const file = assertFrameFile(frame);
  const directory = designDirectory(workspacePath);
  const safe = await readSafeRegularFile(
    directory,
    path.join(directory, file),
    MAX_DESIGN_TEXT_BYTES,
  );
  if (!safe) throw new Error(`Design frame not found: ${file}`);
  return designFrameSelectionIdentityFromSource(
    workspacePath,
    file,
    safe.body.toString("utf8"),
  );
}

async function designFrameSelectionIdentityFromSource(
  workspacePath: string,
  file: string,
  source: string,
): Promise<DesignFrameSelectionIdentity> {
  const render = await prepareFrameRenderSourceForFile(
    workspacePath,
    file,
    source,
    // Selection and CAS need the same generation, not a full CSS build.
    { identityOnly: true },
  );
  return {
    file,
    sourceVersion: render.sourceVersion,
    title: render.meta.title,
    width: render.width,
    height: render.height,
    x: render.x,
    y: render.y,
    nodeIds: designNodeRecords(render.document)
      .map(({ oid }) => oid)
      .filter((oid): oid is string => Boolean(oid)),
  };
}

export async function readDesignFrame(
  workspacePath: string,
  frame: string,
  depth = 4,
  options: DesignReadOptions = {},
): Promise<DesignFrameDocument> {
  const file = assertFrameFile(frame);
  const context = options.writeBack ? await readCanvasContext(workspacePath) : await readSharedCanvasContext(workspacePath);
  if (!options.writeBack && context.layout?.canvasVersion === 2 && context.canvas.frames[file]) {
    const prepared = await prepareRegisteredDesignFrame(workspacePath, file, context.canvas);
    return readDesignFrameFromSummary(workspacePath, prepared, depth);
  }
  const summaries = await listDesignFrames(workspacePath, options);
  const summary = summaries.find((candidate) => candidate.file === file);
  if (!summary) {
    // Aggregate frame discovery intentionally omits an over-budget sibling.
    // An exact frame read still reports that frame's actionable budget error.
    await designFrameTarget(workspacePath, file);
    await readBoundedDesignFrameSource(workspacePath, file);
    throw new Error(`Design frame not found: ${file}`);
  }
  return readDesignFrameFromSummary(workspacePath, summary, depth);
}

async function readDesignFrameFromSummary(
  workspacePath: string,
  summary: DesignFrameSummary,
  depth: number,
): Promise<DesignFrameDocument> {
  const source = await readBoundedDesignFrameSource(
    workspacePath,
    summary.file,
  );
  const healed = healDesignOids(source);
  const document = healed.document ?? parse(healed.html, { sourceCodeLocationInfo: true });
  const composed = await composeFrameSrcDoc(workspacePath, source, {
    width: summary.width,
    height: summary.height,
  }, summary.file);
  return {
    ...summary,
    sourceVersion: composed.sourceVersion,
    source,
    srcDoc: composed.srcDoc,
    tree: frameTree(document, Math.max(0, Math.min(8, Math.round(depth)))),
  };
}

async function readDesignCanvasFrameFromSummary(
  workspacePath: string,
  summary: DesignFrameSummary,
  canvas: CanvasDocument,
): Promise<DesignCanvasFrame> {
  const source = await readBoundedDesignFrameSource(
    workspacePath,
    summary.file,
  );
  const render = await prepareFrameRenderSource(workspacePath, source, {
    width: summary.width,
    height: summary.height,
  }, undefined, undefined, summary.file, canvas, { identityOnly: true });
  return { ...summary, sourceVersion: render.sourceVersion, surfaceCost: render.surfaceCost };
}

async function mapDesignFramesBounded<T>(
  frames: readonly DesignFrameSummary[],
  mapper: (frame: DesignFrameSummary) => Promise<T>,
): Promise<T[]> {
  if (frames.length === 0) return [];
  const output = new Array<T>(frames.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(4, frames.length) },
    async () => {
      while (cursor < frames.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(frames[index]!);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

/** Metadata/controls for opening a registered Local canvas. Recovery keeps
 * the same transaction boundary as aggregate reads; no HTML is scanned. */
type DesignNavigationRead = Awaited<ReturnType<typeof readDesignNavigationSnapshotUnlocked>>;
const navigationReads = new Map<string, { started: boolean; read: Promise<DesignNavigationRead> }>();

export async function readDesignNavigationSnapshot(workspacePath: string, affectedFiles?: readonly string[],
  options: { pageHashes?: boolean } = {}): Promise<{
  snapshot: DesignWorkspaceSnapshot; catalogRevision: string; directoryId: string; pageHashes?: DesignPageHashes;
}> {
  if (affectedFiles !== undefined)
    return withDocumentWrite(workspacePath, () => readDesignNavigationSnapshotUnlocked(workspacePath, affectedFiles, options));
  // A read still waiting for the workspace lane is shared by every later
  // request for it: it runs after each of them was asked, so each sees state
  // at least as new as its own request. A renderer retrying after its own
  // timeout therefore joins the waiting read rather than queueing another
  // behind it. A read that has started is never joined.
  const key = JSON.stringify([path.resolve(workspacePath), options.pageHashes === true]);
  const waiting = navigationReads.get(key);
  if (waiting && !waiting.started) return waiting.read;
  const flight: { started: boolean; read: Promise<DesignNavigationRead> } = { started: false, read: Promise.resolve(null as never) };
  flight.read = withDocumentWrite(workspacePath, () => {
    flight.started = true;
    return readDesignNavigationSnapshotUnlocked(workspacePath, undefined, options);
  }).finally(() => {
    if (navigationReads.get(key) === flight) navigationReads.delete(key);
  });
  navigationReads.set(key, flight);
  return flight.read;
}

/** `known` holds each waiting client's page hashes: their acknowledgement
 * then names every page and resends only pages one of them lacks. */
async function readDesignNavigationSnapshotUnlocked(workspacePath: string, affectedFiles?: readonly string[],
  options: { pageHashes?: boolean; known?: readonly DesignPageHashes[] } = {}): Promise<{
  snapshot: DesignWorkspaceSnapshot; catalogRevision: string; directoryId: string; pageHashes?: DesignPageHashes;
}> {
  {
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    const directory = designDirectoryNameFor(workspacePath);
    // Navigation only reads the canvas; an acknowledgement follows a write and decodes the new canvas once.
    const { metadata, context, inspection } = await readDesignCatalogMetadataWithContext(workspacePath, directory, { shared: !affectedFiles });
    const affected = affectedFiles ? metadata.frames.filter(frame => affectedFiles.includes(frame.source)) : [];
    const pageIds = affected.length ? designFramePageIds(context.canvas) : undefined;
    const identities = designFrameIdentities(workspacePath, directory);
    const [tokens, assets, styles, frames] = await Promise.all([
      readDesignTokensDocument(workspacePath, context, { includeUsage: false }),
      listDesignAssets(workspacePath),
      readDesignStyleSources(workspacePath, context.canvas),
      Promise.all(affected.map(frame => prepareRegisteredDesignFrame(workspacePath, frame.source, context.canvas, pageIds, identities))),
    ]);
    if (!sameDesignCatalogInspection(inspection, inspectDesignCatalog(workspacePath, directory, { revision: false })))
      throw new DesignCatalogError("stale");
    const known = affectedFiles ? options.known : undefined;
    const view = designNavigationView(metadata, !!options.pageHashes || !!known);
    const hashes = view.hashes;
    const changed = known && new Set(metadata.pages.filter((page) =>
      known.some((pages) => pages[page.id] !== hashes!.get(page.id))).map((page) => page.id));
    return { catalogRevision: metadata.revision, directoryId: metadata.directoryId,
      ...(options.pageHashes ? { pageHashes: Object.fromEntries(hashes!) } : {}), snapshot: {
      ...(changed ? {} : { pages: view.pages }),
      frames, tokens: tokens.tokens, tokenSourceVersion: tokens.sourceVersion, assets,
      ...(affectedFiles && !changed ? { mutationCatalog: { revision: metadata.revision, frames: metadata.frames } } : {}),
      ...(changed ? { pageCatalog: { revision: metadata.revision,
        pages: metadata.pages.map((page) => ({ ...page, hash: hashes!.get(page.id)! })),
        frames: metadata.frames.filter((frame) => changed.has(frame.pageId)) } } : {}),
      styleSources: styles.sources.map(({ css: _css, fontImports: _fonts, ...status }) => status),
      styleSourceErrors: styles.errors,
      frameStyleSources: frameStyleSourceChoices(context.canvas, readDesignStyleSourceCatalog(context.canvas)),
      themes: mergeDesignThemes(readDesignThemeCatalog(context.canvas), [...tokens.themes, ...styles.sources.flatMap((source) => source.themes)]),
      lint: { workspacePath, checkedFiles: [], violations: [], healedOids: 0 },
    } };
  }
}

type NavigationPages = NonNullable<DesignWorkspaceSnapshot["pages"]>;
const navigationViews = new WeakMap<object, { pages: NavigationPages; hashes?: Map<string, string> }>();

/** Page summaries and hashes for a catalog projection, built in one pass;
 * a frozen (shared) projection keeps them for its next reader. */
function designNavigationView(metadata: Pick<DesignCatalogSnapshot, "pages" | "frames">, withHashes: boolean) {
  const shared = Object.isFrozen(metadata.frames);
  let view = shared ? navigationViews.get(metadata.frames) : undefined;
  if (!view) {
    const members = new Map(metadata.pages.map((page) => [page.id, { frameFiles: [] as string[], frameIds: [] as string[] }]));
    for (const frame of metadata.frames) {
      const page = members.get(frame.pageId);
      if (page) { page.frameFiles.push(frame.source); page.frameIds.push(frame.id); }
    }
    const pages = metadata.pages.map((page) => ({ id: page.id, title: page.title, folder: page.folder, ...members.get(page.id)! }));
    view = { pages: shared ? freezeDeep(pages) : pages };
    if (shared) navigationViews.set(metadata.frames, view);
  }
  if (withHashes) view.hashes ??= designCatalogPageHashes(metadata);
  return view;
}

const MAX_MUTATION_SNAPSHOT_FILES = 16;
/** Acknowledgements waiting for the lock share one read once it is admitted:
 * each joined only after its own write committed, so the shared read is
 * fresh for every one of them, and it prepares the union of their frames. */
const mutationSnapshotBatches = new Map<string, {
  files: Set<string>; known?: DesignPageHashes[]; sealed: boolean; snapshot: Promise<DesignWorkspaceSnapshot>;
}>();
let mutationSnapshotReads = 0;

export function designMutationSnapshotReadsForTests(): number {
  return mutationSnapshotReads;
}

/** A write acknowledgement never scans unrelated HTML on registered layouts.
 * Legacy documents retain the aggregate contract; metadata races re-read
 * authoritatively instead of turning an applied write into an apparent failure. */
export async function readDesignMutationSnapshot(workspacePath: string, files: readonly string[],
  knownPages?: DesignPageHashes): Promise<DesignWorkspaceSnapshot> {
  if (files.length > MAX_MUTATION_SNAPSHOT_FILES) return readDesignWorkspaceSnapshot(workspacePath);
  const key = JSON.stringify([path.resolve(workspacePath), designDirectoryNameFor(workspacePath), knownPages ? "page-scoped" : "complete"]);
  const open = mutationSnapshotBatches.get(key);
  if (open && !open.sealed && new Set([...open.files, ...files]).size <= MAX_MUTATION_SNAPSHOT_FILES) {
    for (const file of files) open.files.add(file);
    if (knownPages) open.known!.push(knownPages);
    return open.snapshot;
  }
  const batch = { files: new Set(files), ...(knownPages ? { known: [knownPages] } : {}), sealed: false,
    snapshot: Promise.resolve() as unknown as Promise<DesignWorkspaceSnapshot> };
  mutationSnapshotBatches.set(key, batch);
  batch.snapshot = (async () => {
    try {
      return await withDocumentWrite(workspacePath, async () => {
        batch.sealed = true;
        mutationSnapshotReads++;
        return (await readDesignNavigationSnapshotUnlocked(workspacePath, [...batch.files], { known: batch.known })).snapshot;
      });
    } catch (error) {
      if (!(error instanceof DesignCatalogError)) throw error;
      return readDesignWorkspaceSnapshot(workspacePath);
    } finally {
      if (mutationSnapshotBatches.get(key) === batch) mutationSnapshotBatches.delete(key);
    }
  })();
  return batch.snapshot;
}

/** Each frame id's page, built once per batch rather than scanned per frame. */
const framePageIds = new WeakMap<CanvasDocument, ReadonlyMap<string, string>>();
function designFramePageIds(canvas: CanvasDocument): ReadonlyMap<string, string> {
  const cached = framePageIds.get(canvas);
  if (cached) return cached;
  const ids = new Map<string, string>();
  for (const page of canvas.pages ?? []) for (const id of page.frames) if (!ids.has(id)) ids.set(id, page.id);
  // A shared canvas is frozen, so its page membership cannot change under the map.
  if (Object.isFrozen(canvas)) framePageIds.set(canvas, ids);
  return ids;
}

function prepareRegisteredDesignFrame(workspacePath: string, file: string, canvas: CanvasDocument,
  pageIds = designFramePageIds(canvas),
  identities = designFrameIdentities(workspacePath, designDirectoryNameFor(workspacePath))): Promise<DesignCanvasFrame> {
  return withSharedDesignParses(() => prepareSharedRegisteredDesignFrame(workspacePath, file, canvas, pageIds, identities));
}

function registeredFrameRecord(canvas: CanvasDocument, file: string, pageIds: ReadonlyMap<string, string>,
  identity: DesignFrameIdentity, modifiedAt: number): DesignCanvasFrame {
  const geometry = canvas.frames[file]!;
  const info = canvas.frame_info[file]!;
  return { file, frameId: info.id, pageId: info.id === undefined ? undefined : pageIds.get(info.id),
    title: info.title, kind: info.kind === "text" ? "text" : "frame",
    x: geometry.x, y: geometry.y, width: geometry.w, height: geometry.h, z: geometry.z,
    nodeCount: identity.nodeCount, layerCount: identity.layerCount,
    modifiedAt, sourceVersion: identity.sourceVersion, surfaceCost: identity.surfaceCost };
}

/** A registered frame's identity, from its saved source. Main and worker
 * preparation run exactly this. */
async function computeRegisteredFrameIdentity(workspacePath: string, file: string, canvas: CanvasDocument) {
  const geometry = canvas.frames[file];
  if (!geometry || !canvas.frame_info[file]) throw new Error("The registered Design frame changed.");
  const directory = designDirectory(workspacePath);
  const safe = await readSafeRegularFile(directory, path.join(directory, assertFrameFile(file)), MAX_DESIGN_TEXT_BYTES);
  if (!safe) throw new Error("The registered Design source is unavailable or exceeds its limit.");
  const source = safe.body.toString("utf8");
  const healed = healDesignOids(source);
  const document = healed.document ?? parseDesignSource(healed.html);
  const render = await prepareFrameRenderSource(workspacePath, source, { width: geometry.w, height: geometry.h },
    undefined, undefined, file, canvas, { identityOnly: true, retain: true });
  const identity: DesignFrameIdentity = { sourceVersion: render.sourceVersion, surfaceCost: render.surfaceCost,
    nodeCount: designNodeRecords(document).length, layerCount: designLayerCount(document) };
  return { identity, modifiedAt: safe.modifiedAt, retained: render.retained };
}

/** A frame's identity context on a canvas, as preparation records it. */
export function designFrameIdentityContextOf(canvas: CanvasDocument, file: string): string | null {
  const id = canvas.frame_info[file]?.id;
  return designFrameIdentityContext(canvas, file, id === undefined ? undefined : designFramePageIds(canvas).get(id));
}

/** Keep a captured identity read for this frame's capture, when its read
 * set is complete and storable: the capture checks the same set. */
function retainCapturedFrame(workspacePath: string, file: string, context: string | null,
  read: { complete: boolean; durable: DurableDesignDependency[] | null; value: { retained?: RetainedFrameRender } }, retain: boolean): void {
  if (!retain || context === null || !read.complete || !read.durable || !read.value.retained) return;
  retainDesignFrame(workspacePath, designDirectoryNameFor(workspacePath), file, { context, render: read.value.retained, durable: read.durable });
}

async function prepareSharedRegisteredDesignFrame(workspacePath: string, file: string, canvas: CanvasDocument,
  pageIds: ReadonlyMap<string, string>, identities: ReturnType<typeof designFrameIdentities>): Promise<DesignCanvasFrame> {
  const geometry = canvas.frames[file];
  const info = canvas.frame_info[file];
  if (!geometry || !info) throw new Error("The registered Design frame changed.");
  const pageId = info.id === undefined ? undefined : pageIds.get(info.id);
  const frame = (identity: DesignFrameIdentity, modifiedAt: number) => registeredFrameRecord(canvas, file, pageIds, identity, modifiedAt);
  const directory = designDirectory(workspacePath);
  const target = path.join(directory, assertFrameFile(file));
  // A capture already running (a movement guard) must record these reads itself.
  const context = isDesignDependencyCaptureActive() ? null : designFrameIdentityContext(canvas, file, pageId);
  if (context) {
    const cached = await identities.read(file, context);
    const metadata = cached && await inspectSafeRegularFile(directory, target, MAX_DESIGN_TEXT_BYTES);
    if (cached && metadata) return frame(cached, metadata.modifiedAt);
  }
  const compute = () => computeRegisteredFrameIdentity(workspacePath, file, canvas);
  if (!context) {
    const { identity, modifiedAt } = await compute();
    return frame(identity, modifiedAt);
  }
  const read = await captureDurableDesignDependencies(compute);
  identities.remember(file, context, read.value.identity, read);
  retainCapturedFrame(workspacePath, file, context, read, designRecordedCanvasActive(workspacePath));
  return frame(read.value.identity, read.value.modifiedAt);
}

/** One read of a registered frame for a capture: the record
 * design.frames.prepare returns, and the parts the capture composes, so a
 * frame not prepared yet is read and parsed once. Its identity comes from,
 * and is remembered in, the durable identity cache like any preparation. */
export async function prepareRegisteredDesignFrameParts(workspacePath: string, file: string, canvas: CanvasDocument,
  options: { deferTailwind?: boolean } = {}) {
  return withSharedDesignParses(async () => {
    const frame = await prepareSharedRegisteredDesignFrame(workspacePath, file, canvas, designFramePageIds(canvas),
      designFrameIdentities(workspacePath, designDirectoryNameFor(workspacePath)));
    const directory = designDirectory(workspacePath);
    const safe = await readSafeRegularFile(directory, path.join(directory, assertFrameFile(file)), MAX_DESIGN_TEXT_BYTES);
    if (!safe) throw new Error("The registered Design source is unavailable or exceeds its limit.");
    const geometry = canvas.frames[file]!;
    // The same source text in the same parse scope: a build after a fresh
    // identity read reuses every parse that read made.
    const render = await prepareFrameRenderSource(workspacePath, safe.body.toString("utf8"), { width: geometry.w, height: geometry.h },
      undefined, undefined, file, canvas, { parts: true, deferTailwind: options.deferTailwind === true });
    if (render.sourceVersion !== frame.sourceVersion) throw new Error("The registered Design frame changed.");
    return { frame, render };
  });
}

/** The canvas a worker read for the revision the engine checked. */
let workerCanvas: { root: string; directory: string; revision: string; canvas: CanvasDocument } | null = null;

/** A worker's share of a preparation batch: identities with the durable
 * reads behind them, for the engine to remember. It only reads: the engine
 * recovered, checked the catalog and holds the document lock meanwhile, and
 * its own check after the batch refuses it if the catalog moved. */
export async function prepareDesignFrameIdentitiesInWorker(workspacePath: string, catalogRevision: string, files: readonly string[],
  options: { retain?: boolean } = {}) {
  const root = path.resolve(workspacePath);
  const directory = designDirectoryNameFor(workspacePath);
  if (workerCanvas?.root !== root || workerCanvas.directory !== directory || workerCanvas.revision !== catalogRevision)
    workerCanvas = { root, directory, revision: catalogRevision, canvas: (await readSharedCanvasContext(workspacePath)).canvas };
  const { canvas } = workerCanvas;
  const results: DesignWorkerFrameIdentity[] = [];
  for (const file of files) {
    try {
      const read = await withSharedDesignParses(() => captureDurableDesignDependencies(() => computeRegisteredFrameIdentity(workspacePath, file, canvas)));
      // Kept here: this worker composes the frame's capture too.
      retainCapturedFrame(workspacePath, file, designFrameIdentityContextOf(canvas, file), read, options.retain === true);
      results.push({ file, identity: read.value.identity, modifiedAt: read.value.modifiedAt, complete: read.complete, durable: read.durable });
    } catch (error) {
      results.push({ file, error: error instanceof Error ? error.message : "Could not prepare this frame." });
    }
  }
  return results;
}

/** Cold frames of a batch prepared by workers beside the engine's thread,
 * when the pool is on and nothing a worker could see differently is in
 * play: App fonts (download state is per process) or a running dependency
 * capture. Anything a worker did not prepare, main prepares as before. */
async function prepareColdFramesInWorkers(workspacePath: string, catalogRevision: string, files: readonly string[],
  canvas: CanvasDocument, pageIds: ReadonlyMap<string, string>, identities: ReturnType<typeof designFrameIdentities>) {
  const prepared = new Map<string, DesignCanvasFrame>();
  if (designPreparationWorkerCount() === 0 || files.length < 2 || isDesignDependencyCaptureActive()) return prepared;
  if (await designStyleSourcesUseFonts(workspacePath, canvas)) return prepared;
  const cold: Array<{ file: string; context: string }> = [];
  for (const file of files) {
    const info = canvas.frame_info[file];
    const context = info ? designFrameIdentityContext(canvas, file, info.id === undefined ? undefined : pageIds.get(info.id)) : null;
    if (context !== null && !(await identities.read(file, context))) cold.push({ file, context });
  }
  if (cold.length < 2) return prepared;
  for (const result of await prepareFrameIdentitiesInWorkers(workspacePath, catalogRevision, cold.map(({ file }) => file))) {
    const entry = cold.find(({ file }) => file === result.file);
    if (!entry || !("identity" in result)) continue;
    if (result.durable) identities.remember(result.file, entry.context, result.identity, { complete: result.complete, durable: result.durable, current: () => false });
    prepared.set(result.file, registeredFrameRecord(canvas, result.file, pageIds, result.identity, result.modifiedAt));
  }
  return prepared;
}

/** The shared decoded canvas the last preparation batch read, by catalog
 * revision. A page opens in dozens of batches; they only read it, and it is
 * frozen so nothing can change it for the next batch. */
let preparationContext: {
  key: string; revision: string; inspection: ReturnType<typeof inspectDesignCatalog>; context: Awaited<ReturnType<typeof readCanvasContext>>;
} | null = null;

/** The canvas the last preparation batch of this checkout's active directory
 * read: what a connected renderer's frame records were prepared against. */
export function lastPreparedDesignCanvas(workspacePath: string): CanvasDocument | null {
  const key = JSON.stringify([path.resolve(workspacePath), designDirectoryNameFor(workspacePath)]);
  return preparationContext?.key === key ? preparationContext.context.canvas : null;
}

/** Every registered frame's identity context on a canvas: what its
 * remembered identity was computed for, besides the files it read. */
export function designFrameIdentityContexts(canvas: CanvasDocument): Map<string, string | null> {
  const pageIds = designFramePageIds(canvas);
  return new Map(Object.keys(canvas.frames).map((file) => {
    const id = canvas.frame_info[file]?.id;
    return [file, designFrameIdentityContext(canvas, file, id === undefined ? undefined : pageIds.get(id))];
  }));
}

/** Batches preparing frames at once, past their catalog check: a renderer
 * keeps a few in flight so the workers never idle between them, and any
 * more wait for a slot. */
const MAX_PREPARING_BATCHES = 4;
let preparingBatches = 0;
const waitingBatches: Array<() => void> = [];

export function designPreparingBatchesForTests(): { preparing: number; waiting: number } {
  return { preparing: preparingBatches, waiting: waitingBatches.length };
}

async function withPreparingBatch<T>(run: () => Promise<T>): Promise<T> {
  if (preparingBatches < MAX_PREPARING_BATCHES) preparingBatches++;
  else await new Promise<void>((resolve) => waitingBatches.push(resolve));
  try {
    return await run();
  } finally {
    // A waiting batch takes this slot over; otherwise it is freed.
    const next = waitingBatches.shift();
    if (next) next();
    else preparingBatches--;
  }
}

/** Bound the batch and validate metadata on both sides. Shared CSS, fonts,
 * assets and HTML are re-read by the existing exact render-identity path.
 * Only recovery and the catalog check hold the workspace's mutation lane:
 * preparing frames only reads, so batches overlap and writes never wait for
 * one. Like an external edit, a write may then be seen half applied; each
 * frame's identity is computed from the bytes it read, and the watcher
 * prepares it again. The directory is leased for the batch, and a batch whose
 * catalog or directory moved meanwhile is refused.
 * `forRenderer: false` (work ahead of an open, recording-ahead.ts) reuses a
 * matching context but never publishes one: change attribution diffs the
 * canvas it holds against the current one, as what renderers prepared against. */
export async function prepareDesignNavigationFrames(workspacePath: string, catalogRevision: string, files: readonly string[], directoryId?: string,
  options: { forRenderer?: boolean } = {}) {
  if (!files.length || files.length > 16 || new Set(files).size !== files.length) throw new Error("Invalid Design preparation batch.");
  const { directory, before, revision, context } = await withDocumentWrite(workspacePath, async () => {
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    const directory = designDirectoryNameFor(workspacePath);
    const key = JSON.stringify([path.resolve(workspacePath), directory]);
    const before = inspectDesignCatalog(workspacePath, directory, { revision: false });
    const reused = preparationContext?.key === key && sameDesignCatalogInspection(preparationContext.inspection, before)
      ? preparationContext : null;
    const revision = reused?.revision ?? designCatalogRevision(before);
    if (revision !== catalogRevision || (directoryId !== undefined && before.layout.manifest.id !== directoryId)) throw new DesignCatalogError("stale");
    let context = reused?.context ?? null;
    if (!context) {
      // The canvas navigation and identity reads share: one frozen copy per revision.
      context = await readSharedCanvasContext(workspacePath);
      const captured = context.canvas[canvasReadSnapshot];
      if (options.forRenderer !== false && captured?.source === before.source && captured.registration?.source === before.registration)
        preparationContext = { key, revision, inspection: before, context };
    }
    return { directory, before, revision, context };
  });
  // One read scope per batch: its frames share their stylesheet, font and package reads.
  const prepared = await withPreparingBatch(() => withDesignDirectoryNameLease(workspacePath, directory, () => withDesignReadScope(async () => {
    const frames: DesignCanvasFrame[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    const pageIds = designFramePageIds(context.canvas);
    const identities = designFrameIdentities(workspacePath, directory);
    const fromWorkers = await prepareColdFramesInWorkers(workspacePath, revision, files, context.canvas, pageIds, identities);
    // One native preparation at a time; optional demand must not fan out large
    // decoder/source buffers across every frame in a batch.
    for (const file of files) {
      try { frames.push(fromWorkers.get(file) ?? await prepareRegisteredDesignFrame(workspacePath, file, context.canvas, pageIds, identities)); }
      catch (error) { errors.push({ file, message: error instanceof Error ? error.message : "Could not prepare this frame." }); }
    }
    return { frames, errors };
  })));
  if (designDirectoryNameFor(workspacePath) !== directory ||
    !sameDesignCatalogInspection(before, inspectDesignCatalog(workspacePath, directory, { revision: false })))
    throw new DesignCatalogError("stale");
  return { directoryId: before.layout.manifest.id, catalogRevision, ...prepared };
}

/** Aggregate lightweight canvas metadata in one exact-key request. Exact
 * render identities are composed with bounded concurrency; full source/srcDoc
 * payloads remain one-frame reads and never scale with total canvas size.
 * This exported entry point owns the workspace write turn and must not be
 * called recursively from another withDesignDocumentWrite callback. */
export async function readDesignWorkspaceSnapshot(
  workspacePath: string,
  options: DesignReadOptions = {},
): Promise<DesignWorkspaceSnapshot> {
  const writeBack = options.writeBack === true;
  return withDocumentWrite(workspacePath, async () => {
    // Hold one semantic-owner turn from journal recovery through composition;
    // app-driven transactions cannot interleave lint from one generation with
    // frame/token payloads from another.
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    if (writeBack) await initializeDesignDocumentUnlocked(workspacePath);
    const context = await readCanvasContext(workspacePath);
    const lint = await lintDesignDocumentUnlocked(
      workspacePath,
      undefined,
      {
        healOids: writeBack,
        includeRuntimeAudits: false,
      },
      context,
    );
    const summaries = await listDesignFramesUnlocked(
      workspacePath,
      writeBack,
      true,
      context,
    );
    const pages = designCanvasPageCatalog(
      context.canvas,
      summaries.map((frame) => frame.file),
      context.layout?.canvasVersion === 2,
    );
    const renderBudgetViolations: DesignLintViolation[] = [];
    const [renderedFrames, tokensDocument, assets, styleSources] = await Promise.all([
      mapDesignFramesBounded(summaries, (summary) =>
        readDesignCanvasFrameFromSummary(workspacePath, summary, context.canvas).catch(
          (error: unknown) => {
            if (!(error instanceof DesignRenderBudgetError)) throw error;
            renderBudgetViolations.push(
              designRenderBudgetViolation(summary.file, error),
            );
            return null;
          },
        ),
      ),
      readDesignTokensDocument(workspacePath, context),
      listDesignAssets(workspacePath),
      readDesignStyleSources(workspacePath, context.canvas),
    ]);
    const frames = renderedFrames.filter(
      (frame): frame is DesignCanvasFrame => frame !== null,
    );
    const runtimeViolations = frames.flatMap((frame) =>
      getDesignRuntimeAudit(workspacePath, frame.file, frame.sourceVersion),
    );
    return {
      pages,
      frames: frames.map((frame) => ({ ...frame, pageId: pages.find((page) => page.frameFiles.includes(frame.file))!.id })),
      tokens: tokensDocument.tokens,
      tokenSourceVersion: tokensDocument.sourceVersion,
      // The CSS itself reaches frames through rendering, not the snapshot.
      styleSources: styleSources.sources.map(({ css: _css, fontImports: _fontImports, ...status }) => status),
      styleSourceErrors: styleSources.errors,
      frameStyleSources: frameStyleSourceChoices(context.canvas, readDesignStyleSourceCatalog(context.canvas)),
      themes: mergeDesignThemes(readDesignThemeCatalog(context.canvas), [
        ...tokensDocument.themes,
        ...styleSources.sources.flatMap((source) => source.themes),
      ]),
      assets,
      lint: {
        ...lint,
        violations: sortDesignLintViolations([
          ...lint.violations,
          ...renderBudgetViolations,
          ...runtimeViolations,
        ]),
      },
    };
  });
}

function violationAt(
  file: string,
  ruleId: DesignLintViolation["ruleId"],
  message: string,
  location: { startLine?: number; startCol?: number } | null | undefined,
  extras: Pick<DesignLintViolation, "severity" | "oid" | "fix"> = {
    severity: "error",
  },
): DesignLintViolation {
  return {
    ruleId,
    severity: extras.severity,
    message,
    file,
    line: location?.startLine ?? 1,
    column: location?.startCol ?? 1,
    ...(extras.oid ? { oid: extras.oid } : {}),
    ...(extras.fix ? { fix: extras.fix } : {}),
  };
}

function designRenderBudgetViolation(
  file: string,
  error: DesignRenderBudgetError,
): DesignLintViolation {
  return violationAt(file, "render-budget", error.message, null, {
    severity: "error",
    fix: "Reduce the frame HTML, linked stylesheets, or embedded local assets and lint again.",
  });
}

async function cssSourceFiles(
  workspacePath: string,
  context?: DesignCanvasReadContext,
): Promise<string[]> {
  const directory = designDirectory(workspacePath);
  const layout = context
    ? context.layout
    : readDirectoryDesignLayout(
        workspacePath,
        designDirectoryNameFor(workspacePath),
      );
  const folders =
    layout?.canvasVersion === 2
      ? (
          context?.canvas ?? (await readCanvas(workspacePath, layout))
        ).pages!.map((page) => page.folder!)
      : [];
  const files = await Promise.all(
    ["", ...folders].map(async (folder) => {
      const entries = await readdir(path.join(directory, folder), {
        withFileTypes: true,
      }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && /\.css$/i.test(entry.name))
        .map((entry) => (folder ? `${folder}/${entry.name}` : entry.name));
    }),
  );
  return files.flat().sort();
}

async function knownTokenNames(
  workspacePath: string,
  context?: DesignCanvasReadContext,
): Promise<{ names: Set<string>; tokens: DesignTokenSummary[] }> {
  // No usage counts: counting reads every frame's HTML, and this runs on
  // every single-frame mutation acknowledgement.
  const tokens = (await readDesignTokensDocument(workspacePath, context, { includeUsage: false })).tokens;
  const names = new Set(tokens.map((token) => token.name));
  const directory = designDirectory(workspacePath);
  for (const file of await cssSourceFiles(workspacePath, context)) {
    const source = await readSafeDesignText(
      directory,
      path.join(directory, file),
    );
    if (source) collectDeclaredCustomProperties(source, names);
  }
  return { names, tokens };
}

interface DesignKnownTokens {
  names(file: string): Set<string>;
  /** Colours tokens.css and the frame's imported sources hold, for the
   * literal-token-value advisory. */
  colors(file: string): DesignTokenColorIndex;
}

/** Tokens each frame can resolve: tokens.css and Design CSS, plus the tokens
 * declared by every imported style source that frame receives (Tailwind
 * `@theme` and `:root` declarations of the application's own files included).
 * Tailwind's stock theme and package defaults are not application tokens, so
 * they still warn. Lint is advisory: an unreadable catalog keeps the base set. */
async function designKnownTokens(
  workspacePath: string,
  context?: DesignCanvasReadContext,
): Promise<DesignKnownTokens> {
  const { names: base, tokens: baseTokens } = await knownTokenNames(workspacePath, context);
  const baseColors = designTokenColorIndex(baseTokens);
  const fixed: DesignKnownTokens = { names: () => base, colors: () => baseColors };
  let canvas: CanvasDocument;
  let sources: Awaited<ReturnType<typeof readDesignStyleSources>>["sources"];
  try {
    canvas = context?.canvas ?? (await readCanvas(workspacePath));
    if (
      readDesignStyleSourceCatalog(canvas).declarations.length === 0 &&
      readDesignFontCatalog(canvas).fonts.length === 0
    )
      return fixed;
    sources = (await readDesignStyleSources(workspacePath, canvas)).sources;
  } catch {
    return fixed;
  }
  const catalog = readDesignStyleSourceCatalog(canvas);
  const tokensById = new Map(sources.map((source) => [source.id, source.tokens]));
  const byFrame = new Map<string, { names: Set<string>; colors: DesignTokenColorIndex }>();
  const forFrame = (file: string) => {
    const ids = frameStyleSourceIds(canvas, catalog, file);
    const optedOut =
      ids.length === 0 &&
      Array.isArray(
        (canvas.frame_info[file] as Record<string, unknown> | undefined)?.styles,
      );
    const key = optedOut ? "" : ids.join("\0");
    let known = byFrame.get(key);
    if (!known) {
      const names = new Set(base);
      // tokens.css overrides an imported token of the same name, so it is
      // indexed last and an imported value it replaces is not suggested.
      const tokens = new Map<string, { name: string; value: string }>();
      if (!optedOut) {
        for (const id of [DESIGN_FONTS_SOURCE_ID, ...ids])
          for (const token of tokensById.get(id) ?? []) {
            names.add(token.name);
            tokens.set(token.name, token);
          }
      }
      for (const token of baseTokens) tokens.set(token.name, token);
      known = { names, colors: designTokenColorIndex(tokens.values()) };
      byFrame.set(key, known);
    }
    return known;
  };
  return { names: (file) => forFrame(file).names, colors: (file) => forFrame(file).colors };
}

function collectDeclaredCustomProperties(
  css: string,
  names: Set<string>,
  declarationList = false,
): void {
  try {
    const root = postcss.parse(declarationList ? `x{${css}}` : css);
    root.walkDecls((declaration) => {
      if (/^--[A-Za-z0-9_-]+$/.test(declaration.prop)) {
        names.add(declaration.prop);
      }
    });
  } catch {
    // The CSS parser's own lint path reports malformed authored CSS. A failed
    // advisory declaration scan must not invent or hide a blocking error.
  }
}

function frameCustomPropertyNames(
  document: DefaultTreeAdapterTypes.Document,
): Set<string> {
  const names = new Set<string>();
  for (const { element } of elementRecords(document)) {
    if (element.tagName === "style") {
      const css = element.childNodes
        .map((node) => ("value" in node ? node.value : ""))
        .join("");
      collectDeclaredCustomProperties(css, names);
    }
    const inline = element.attrs.find(
      (attribute) => attribute.name === "style",
    )?.value;
    if (inline) collectDeclaredCustomProperties(inline, names, true);
  }
  return names;
}

function lineAndColumnAt(
  source: string,
  offset: number,
): { startLine: number; startCol: number } {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split("\n");
  return {
    startLine: lines.length,
    startCol: (lines.at(-1)?.length ?? 0) + 1,
  };
}

/** Whether this frame's registration as a component holds, and whether a
 * frame declaring options is registered at all. */
async function designComponentRegistrationViolations(workspacePath: string, file: string, source: string, known?: CanvasDocument): Promise<DesignLintViolation[]> {
  let canvas: CanvasDocument;
  try {
    canvas = known ?? (await readSharedCanvasContext(workspacePath)).canvas;
  } catch {
    return [];
  }
  const registry = designComponentRegistry(canvas);
  const violations: DesignLintViolation[] = [];
  for (const problem of registry.problems) {
    if (problem.file !== file) continue;
    violations.push(violationAt(file, "component-invalid", problem.message, null, {
      severity: "error", fix: 'Give each registered frame its own "component" name in meta/canvas.json.' }));
  }
  const name = [...registry.files].find(([, registered]) => registered === file)?.[0];
  if (name && (await readSafeRegularFile(designDirectory(workspacePath), path.join(designDirectory(workspacePath), "components", `${name}.html`), MAX_DESIGN_TEXT_BYTES)))
    violations.push(violationAt(file, "component-invalid", `zd-${name} is both this frame's registration and components/${name}.html; rename one.`, null, {
      severity: "error", fix: `Change this frame's "component" in meta/canvas.json, or rename components/${name}.html.` }));
  if (!name && !registry.problems.some((problem) => problem.file === file) && designSourceDeclaresOptions(source)) {
    const suggested = path.posix.basename(file, ".html").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(?=\d)/, "c-") || "component";
    violations.push(violationAt(file, "component-unregistered",
      "This frame declares options but is not registered as a component, so no other frame can place it.", null, {
        severity: "warning",
        fix: `Add "component": "${suggested}" to this frame's record in meta/canvas.json, then place it as <zd-${suggested}>.`,
      }));
  }
  return violations;
}

async function lintFrame(
  workspacePath: string,
  file: string,
  options: { healOids: boolean },
  knownTokens: Set<string>,
  knownClasses: DesignKnownClasses,
  sourceOverride?: string,
  tokenColors?: DesignTokenColorIndex,
  /** The canvas this lint reads, for component registration; null skips
   * those checks (a mutation's before/after comparison of source errors). */
  canvas?: CanvasDocument | null,
): Promise<{ violations: DesignLintViolation[]; healedOids: number }> {
  const target = path.join(
    designDirectory(workspacePath),
    assertFrameFile(file),
  );
  let source =
    sourceOverride ?? (await readBoundedDesignFrameSource(workspacePath, file));
  let parseErrors: ParserError[] = [];
  const parseSource = (): DefaultTreeAdapterTypes.Document => {
    parseErrors = [];
    return parse(source, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => parseErrors.push(error),
    });
  };
  let document = parseSource();
  let healedOids = 0;
  if (options.healOids && sourceOverride === undefined) {
    const healed = healDesignOids(source);
    if (healed.changed) {
      source = healed.html;
      healedOids = healed.fixed.length;
      await atomicWriteDesignSource(target, source);
      document = parseSource();
    }
  }
  const violations: DesignLintViolation[] = parseErrors.map((error) =>
    violationAt(
      file,
      "frames-are-valid-html",
      `HTML parser: ${error.code}`,
      error,
      {
        severity: "error",
        fix: "Repair the malformed HTML and lint the frame again.",
      },
    ),
  );

  const records = elementRecords(document);
  const nativeIdentities = !!readDirectoryDesignManifest(workspacePath, designDirectoryNameFor(workspacePath))?.canvas;
  const seen = new Set<string>();
  for (const { element, oid } of records) {
    const location = element.sourceCodeLocation?.startTag;
    if (element.tagName === "script") {
      violations.push(
        violationAt(
          file,
          "no-script",
          "Design frames are HTML and CSS only; scripts are not allowed.",
          location,
          {
            severity: "error",
            oid: oid ?? undefined,
            fix: "Remove the script from this frame. Use CSS @keyframes for motion or represent the control state visually; application behavior belongs in application code.",
          },
        ),
      );
    }
    for (const attribute of element.attrs) {
      const attrLocation =
        element.sourceCodeLocation?.attrs?.[attribute.name] ?? location;
      if (/^on/i.test(attribute.name)) {
        violations.push(
          violationAt(
            file,
            "no-event-handlers",
            `Inline event handler "${attribute.name}" is not allowed.`,
            attrLocation,
            {
              severity: "error",
              oid: oid ?? undefined,
              fix: `Remove ${attribute.name} from this frame and represent the control state visually. Implement working interactions in application code.`,
            },
          ),
        );
      }
      if (
        ["href", "src", "action", "poster"].includes(attribute.name) &&
        attribute.value.trim() &&
        !attribute.value.trim().startsWith("#")
      ) {
        const external =
          attribute.value.startsWith("/") ||
          attribute.value.startsWith("//") ||
          /^[a-z][a-z0-9+.-]*:/i.test(attribute.value);
        const local = safeLocalReference(
          designDirectory(workspacePath),
          attribute.value,
          file,
        );
        if (external) {
          violations.push(
            violationAt(
              file,
              "no-external-url",
              `External URL "${attribute.value}" is not allowed in a design frame.`,
              attrLocation,
              {
                severity: "error",
                oid: oid ?? undefined,
                fix: "Use a supported file under Zeros Design/assets.",
              },
            ),
          );
        }
        if (!local) {
          violations.push(
            violationAt(
              file,
              "local-refs-only",
              `Reference "${attribute.value}" does not resolve inside Zeros Design/.`,
              attrLocation,
              {
                severity: "error",
                oid: oid ?? undefined,
                fix: "Use a relative path contained by Zeros Design/.",
              },
            ),
          );
        }
      }
    }
    if (!isDesignNodeElement(element)) continue;
    if (!oid || oid.trim().length === 0) {
      if (nativeIdentities) continue;
      violations.push(
        violationAt(
          file,
          "oid-missing",
          `<${element.tagName}> is missing a stable data-oid.`,
          location,
          {
            severity: "warning",
            fix: "Zeros can add a stable data-oid automatically.",
          },
        ),
      );
    } else if (seen.has(oid)) {
      violations.push(
        violationAt(
          file,
          "oid-duplicate",
          `data-oid "${oid}" is duplicated in this frame.`,
          location,
          {
            severity: "warning",
            oid,
            fix: "Zeros can replace this duplicate with a stable unique id.",
          },
        ),
      );
    } else {
      seen.add(oid);
    }
  }

  const availableTokens = new Set([
    ...knownTokens,
    ...frameCustomPropertyNames(document),
  ]);
  for (const match of source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g)) {
    const token = match[1];
    // A fallback marks an optional hook (the app's icons paint with
    // var(--zeros-fi, var(--zeros-fi-blue))); declaring it would change the
    // rendering, so only references without one can be unknown tokens.
    if (match[2] || availableTokens.has(token)) continue;
    violations.push(
      violationAt(
        file,
        "unknown-token",
        `Unknown design token "${token}".`,
        lineAndColumnAt(source, match.index ?? 0),
        {
          severity: "warning",
          fix: `Declare ${token} locally or in tokens.css, or use an existing token.`,
        },
      ),
    );
  }

  // Component definitions are loaded through the same bounded, symlink-free
  // expander used by the renderer. This keeps lint and preview availability
  // identical and surfaces cycles or unsafe component markup before save.
  const componentExpansion = await expandDesignComponents(
    workspacePath,
    source,
    undefined,
    file,
    canvas ? { registry: designComponentRegistry(canvas).files } : {},
  );
  const availableClasses = componentExpansion.errors.length === 0
    ? await knownClasses(file, componentExpansion.html, componentExpansion.html === source ? document : undefined)
    : null;
  if (availableClasses) {
    const unknown = new Map<string, (typeof records)[number]>();
    const checked = new Set<string>();
    for (const record of records) {
      const value = record.element.attrs.find((attribute) => attribute.name === "class")?.value;
      if (!value) continue;
      for (const name of value.split(/[\t\n\f\r ]+/)) {
        if (!name || checked.has(name)) continue;
        checked.add(name);
        if (!availableClasses.has(name)) unknown.set(name, record);
      }
    }
    for (const [index, [name, { element, oid }]] of [...unknown].entries()) {
      const remainder = unknown.size > 50 && index === 49;
      violations.push(violationAt(
        file,
        "unknown-class",
        remainder ? `${unknown.size - 49} more classes have no CSS in this frame.` : `Class "${name}" has no CSS in this frame's styles.`,
        element.sourceCodeLocation?.attrs?.class ?? element.sourceCodeLocation?.startTag,
        {
          severity: "warning",
          oid: oid ?? undefined,
          fix: remainder
            ? "Use existing classes or utilities from the application's styles, define them in the frame's <style> or a Design stylesheet, or remove them."
            : `Use an existing class or utility from the application's styles, define .${name} in the frame's <style> or a Design stylesheet, or remove it.`,
        },
      ));
      if (remainder) break;
    }
  }
  violations.push(...lintDesignAuthoringContract({
    file,
    source,
    records,
    tokenColors,
    lineAt: (offset) => lineAndColumnAt(source, offset),
  }));
  const usedComponents = new Set(componentExpansion.usedComponents);
  // Components expand in light content only; the expander never enters a
  // shadow root, so a zd-* tag there is not an instance.
  const componentRecords = designNodeRecords(document).filter(
    ({ element }) => element.tagName.startsWith("zd-") && !isShadowDesignNodeElement(element),
  );
  for (const { element, oid } of componentRecords) {
    if (!element.tagName.startsWith("zd-")) continue;
    const component = element.tagName.slice(3);
    const definition = `${component}.html`;
    if (usedComponents.has(component)) continue;
    violations.push(
      violationAt(
        file,
        "component-undefined",
        `Component <${element.tagName}> has no components/${definition} definition.`,
        element.sourceCodeLocation?.startTag,
        {
          severity: "error",
          oid: oid ?? undefined,
          fix: `Create components/${definition} or replace the component instance.`,
        },
      ),
    );
  }
  for (const error of componentExpansion.errors) {
    const record = componentRecords.find(
      ({ element }) => element.tagName === `zd-${error.component}`,
    );
    if (!error.code) {
      violations.push(
        violationAt(
          file,
          "component-invalid",
          error.message,
          record?.element.sourceCodeLocation?.startTag,
          {
            severity: "error",
            oid: record?.oid ?? undefined,
            fix: `Repair components/${error.component}.html and lint again.`,
          },
        ),
      );
      continue;
    }
    // A problem in this frame's own options or template sits where it is
    // written; one in a component it uses sits at the instance and names
    // the file and line to repair.
    const here = (error.file === undefined || error.file === file) && error.offset !== undefined;
    violations.push(
      violationAt(
        file,
        error.code,
        here || error.file === undefined || error.file === file
          ? error.message
          : `${error.file}${error.line ? `, line ${error.line}` : ""}: ${error.message}`,
        here ? lineAndColumnAt(source, error.offset!) : record?.element.sourceCodeLocation?.startTag,
        {
          severity: error.severity ?? "error",
          oid: here ? undefined : record?.oid ?? undefined,
          fix: error.code === "component-value-invalid"
            ? "Use a value the component's option allows, or remove the attribute to inherit it."
            : `Repair ${error.file ?? `components/${error.component}.html`} and lint again.`,
        },
      ),
    );
  }
  if (canvas !== null) violations.push(...await designComponentRegistrationViolations(workspacePath, file, source, canvas));
  return { violations, healedOids };
}

async function lintDesignDocumentUnlocked(
  workspacePath: string,
  frame?: string,
  options: { healOids?: boolean; includeRuntimeAudits?: boolean } = {},
  context?: DesignCanvasReadContext,
): Promise<DesignLintReport> {
  const files = frame
    ? [(await designFrameTarget(workspacePath, frame)).file]
    : await discoverFrameFiles(workspacePath, context);
  const knownTokens = await designKnownTokens(workspacePath, context);
  const knownClasses = await designKnownClasses(workspacePath, context);
  const violations: DesignLintViolation[] = [];
  let healedOids = 0;
  for (const file of files) {
    let result: Awaited<ReturnType<typeof lintFrame>>;
    try {
      result = await lintFrame(
        workspacePath,
        file,
        { healOids: options.healOids !== false },
        knownTokens.names(file),
        knownClasses,
        undefined,
        knownTokens.colors(file),
        context?.canvas,
      );
    } catch (error) {
      if (!(error instanceof DesignRenderBudgetError)) throw error;
      violations.push(designRenderBudgetViolation(file, error));
      continue;
    }
    violations.push(...result.violations);
    healedOids += result.healedOids;
    if (options.includeRuntimeAudits !== false) {
      let identity: DesignFrameRenderIdentity;
      try {
        identity = await readDesignFrameRenderIdentity(workspacePath, file);
      } catch (error) {
        if (!(error instanceof DesignRenderBudgetError)) throw error;
        violations.push(designRenderBudgetViolation(file, error));
        continue;
      }
      violations.push(
        ...getDesignRuntimeAudit(workspacePath, file, identity.sourceVersion),
      );
    }
  }
  return {
    workspacePath: path.resolve(workspacePath),
    checkedFiles: files,
    violations: sortDesignLintViolations(violations),
    healedOids,
  };
}

export function lintDesignDocument(
  workspacePath: string,
  frame?: string,
  options: { healOids?: boolean; includeRuntimeAudits?: boolean } = {},
): Promise<DesignLintReport> {
  const lint = () => lintDesignDocumentUnlocked(workspacePath, frame, options);
  return options.healOids === false
    ? lint()
    : withDocumentWrite(workspacePath, async () => {
        await initializeDesignDocumentUnlocked(workspacePath);
        return lint();
      });
}

function sortDesignLintViolations(
  violations: DesignLintViolation[],
): DesignLintViolation[] {
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

/** Themes the canvas Themes control offers: those tokens.css declares and
 * those imported style sources map. Unlike the tokens document, this reads no
 * frames. */
export async function readDesignThemeNames(
  workspacePath: string,
): Promise<string[]> {
  const directory = designDirectory(workspacePath);
  const tokenSource =
    (await readSafeDesignText(directory, path.join(directory, DESIGN_TOKENS_FILE))) ?? "";
  const themes = new Set<string>();
  try {
    postcss.parse(tokenSource).walkRules((rule) => {
      const theme = designTokenThemeName(rule.selector);
      if (theme) themes.add(theme);
    });
  } catch {
    // Unparseable tokens declare no themes, as in the theme editor.
  }
  const canvas = await readCanvas(workspacePath).catch(() => null);
  if (canvas) {
    // Declared mappings and names; nothing is compiled to list them.
    for (const declaration of readDesignStyleSourceCatalog(canvas).declarations) {
      for (const theme of Object.keys(declaration.themes)) themes.add(theme);
    }
    for (const theme of readDesignThemeCatalog(canvas).themes) themes.add(theme.id);
  }
  return [...themes].sort();
}

/** The refusal for a theme the canvas Themes control does not offer. */
export function designUnknownThemeMessage(theme: string, themes: readonly string[]): string {
  return themes.length
    ? `Unknown theme ${JSON.stringify(theme)}. Choose one of: ${themes.join(", ")}.`
    : `Unknown theme ${JSON.stringify(theme)}. This Design directory declares no themes.`;
}

/** Refuses a theme the canvas Themes control does not offer. */
export async function assertDesignThemeName(workspacePath: string, theme: string): Promise<void> {
  const themes = await readDesignThemeNames(workspacePath);
  if (!themes.includes(theme)) throw new Error(designUnknownThemeMessage(theme, themes));
}

/** The id of the named default theme, which frames carry when no other theme
 * is chosen; null when `:root` has no name. */
export async function readDesignBaseTheme(workspacePath: string): Promise<string | null> {
  const canvas = await readCanvas(workspacePath).catch(() => null);
  return canvas ? readDesignThemeCatalog(canvas).baseId : null;
}

const DESIGN_TOKEN_DESCRIPTION_LIMIT = 120;

/** The comment attached to a token declaration: a trailing comment on the
 * same line, else one ending on the line just above (no blank line between)
 * that is not itself another declaration's trailing comment. One line of
 * plain text; the inspector renders it as text, never as markup. */
function designTokenDescription(declaration: postcss.Declaration): string | undefined {
  const line = declaration.source?.end?.line ?? declaration.source?.start?.line;
  const startLine = declaration.source?.start?.line;
  if (line === undefined || startLine === undefined) return undefined;
  const text = (comment: postcss.Comment) => {
    const value = comment.text.replace(/\s+/g, " ").trim();
    return value ? value.slice(0, DESIGN_TOKEN_DESCRIPTION_LIMIT).trimEnd() : undefined;
  };
  const next = declaration.next();
  if (next?.type === "comment" && next.source?.start?.line === line) return text(next);
  const previous = declaration.prev();
  if (previous?.type !== "comment" || previous.source?.end?.line !== startLine - 1) return undefined;
  const before = previous.prev();
  if (before && before.source?.end?.line === previous.source?.start?.line) return undefined;
  return text(previous);
}

export async function readDesignTokensDocument(
  workspacePath: string,
  context?: DesignCanvasReadContext,
  options: { includeUsage?: boolean } = {},
): Promise<DesignTokensDocument> {
  const directory = designDirectory(workspacePath);
  const tokenFile = path.join(directory, DESIGN_TOKENS_FILE);
  const tokenSource = (await readSafeDesignText(directory, tokenFile)) ?? "";
  const sourceVersion = createHash("sha256")
    .update(tokenSource)
    .digest("hex")
    .slice(0, 24);
  let root: postcss.Root;
  try {
    root = postcss.parse(tokenSource, { from: tokenFile });
  } catch {
    return { sourceVersion, themes: [], tokens: [] };
  }
  const byName = new Map<string, DesignTokenSummary>();
  const themes = new Set<string>();
  root.walkAtRules("property", (rule) => {
    const name = rule.params.trim();
    if (!name.startsWith("--")) return;
    let syntax = "*";
    let inherits = true;
    let initialValue = "";
    rule.walkDecls((declaration) => {
      if (declaration.prop === "syntax") {
        syntax = declaration.value.replace(/^["']|["']$/g, "");
      } else if (declaration.prop === "inherits") {
        inherits = declaration.value.trim().toLowerCase() !== "false";
      } else if (declaration.prop === "initial-value") {
        initialValue = declaration.value.trim();
      }
    });
    byName.set(name, {
      name,
      syntax,
      inherits,
      initialValue,
      value: initialValue,
      themeValues: {},
      usageCount: 0,
      line: rule.source?.start?.line ?? 1,
    });
  });
  const describedByBase = new Set<string>();
  root.walkRules((rule) => {
    const theme = designTokenThemeName(rule.selector);
    const base = rule.selector.trim() === ":root";
    if (!base && !theme) return;
    if (theme) themes.add(theme);
    rule.walkDecls(/^--/, (declaration) => {
      const description = designTokenDescription(declaration);
      let token = byName.get(declaration.prop);
      if (!token) {
        token = {
          name: declaration.prop,
          syntax: "*",
          inherits: true,
          initialValue: base ? declaration.value.trim() : "",
          value: base ? declaration.value.trim() : "",
          themeValues: {},
          usageCount: 0,
          line: declaration.source?.start?.line ?? 1,
        };
        byName.set(declaration.prop, token);
      }
      if (base) token.value = declaration.value.trim();
      else if (theme) token.themeValues[theme] = declaration.value.trim();
      // The base declaration's comment describes the token; a theme's comment
      // does only while no base declaration carries one.
      if (description && (base || (!describedByBase.has(token.name) && !token.description))) {
        token.description = description;
        if (base) describedByBase.add(token.name);
      }
    });
  });

  const sources = options.includeUsage === false ? [] : [
    ...(await discoverFrameFiles(workspacePath, context)),
    ...(await cssSourceFiles(workspacePath, context)),
  ];
  for (const file of sources) {
    const source =
      (await readSafeDesignText(directory, path.join(directory, file))) ?? "";
    for (const match of source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const token = byName.get(match[1]);
      if (token) token.usageCount += 1;
    }
  }
  return {
    sourceVersion,
    themes: [...themes].sort(),
    tokens: [...byName.values()]
      .map((token) => ({
        ...token,
        ...(options.includeUsage === false ? { usageCountKnown: false } : {}),
        themeValues: Object.fromEntries(
          Object.entries(token.themeValues).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function readDesignTokens(
  workspacePath: string,
): Promise<DesignTokenSummary[]> {
  return (await readDesignTokensDocument(workspacePath)).tokens;
}

export async function updateDesignToken(
  workspacePath: string,
  input: {
    name: string;
    theme: string | null;
    value: string;
    sourceVersion: string;
  },
): Promise<DesignTokenMutationResult> {
  if (!/^--[A-Za-z0-9_-]{1,128}$/.test(input.name)) {
    throw new Error("Design token name is invalid.");
  }
  if (input.theme !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(input.theme)) {
    throw new Error("Design theme name is invalid.");
  }
  const value = input.value.trim();
  if (
    !value ||
    value.length > 1_024 ||
    /[;{}]/.test(value) ||
    value.includes("/*") ||
    value.includes("*/")
  ) {
    throw new Error("Design token value is invalid.");
  }
  try {
    const validation = postcss.parse(`:root { ${input.name}: ${value}; }`);
    const declarations: postcss.Declaration[] = [];
    validation.walkDecls((declaration) => {
      declarations.push(declaration);
    });
    if (declarations.length !== 1 || declarations[0]?.value !== value) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Design token value is invalid CSS.");
  }
  return withDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    const directory = designDirectory(workspacePath);
    const target = path.join(directory, DESIGN_TOKENS_FILE);
    const source = (await readSafeDesignText(directory, target)) ?? "";
    const current = await readDesignTokensDocument(workspacePath);
    if (current.sourceVersion !== input.sourceVersion) {
      throw new Error(
        "Design tokens changed before the mutation. Re-read them and retry.",
      );
    }
    if (!current.tokens.some((token) => token.name === input.name)) {
      throw new Error(`Design token not found: ${input.name}`);
    }
    const root = postcss.parse(source, { from: target });
    let targetRule: postcss.Rule | null = null;
    root.walkRules((rule) => {
      if (targetRule) return;
      if (
        (input.theme === null && rule.selector.trim() === ":root") ||
        (input.theme !== null &&
          designTokenThemeName(rule.selector) === input.theme)
      ) {
        targetRule = rule;
      }
    });
    if (!targetRule) {
      targetRule = postcss.rule({
        selector:
          input.theme === null ? ":root" : `[data-zd-theme="${input.theme}"]`,
      });
      root.append(targetRule);
    }
    let targetDeclaration: postcss.Declaration | null = null;
    targetRule.walkDecls(input.name, (declaration) => {
      targetDeclaration = declaration;
    });
    const declarationToUpdate = targetDeclaration as postcss.Declaration | null;
    if (declarationToUpdate) declarationToUpdate.value = value;
    else targetRule.append(postcss.decl({ prop: input.name, value }));
    const updated = root.toString();
    if (updated !== source) await atomicWriteDesignSource(target, updated);
    return {
      changed: updated !== source,
      document: await readDesignTokensDocument(workspacePath),
    };
  });
}

export const DESIGN_GUIDES = Object.freeze({
  frame: `One registered HTML file in a page folder is one frame. Link ../tokens.css and keep the body as the design. Frame titles, kinds, geometry, page membership and Foundation metadata live in the active Design directory's meta/canvas.json. Native agents write <page.folder>/<name>.html and add its stable frame ID to the frames map and that page's frames array; API agents supply pageId when creating or duplicating a frame in a directory with several pages. Preserve directory, page and frame IDs. Legacy root canvas.json and flat HTML remain readable. Give every rendered element inside body a stable unique data-oid, but leave html, head, body, meta, link, title, style, script, and template as non-selectable document plumbing.`,
  layout: `Use normal HTML flow and flexbox for structural layout. Prefer flex containers, gap, padding, alignment, and intrinsic sizing over absolute positioning inside a frame.`,
  tokens: `Use var(--token) from tokens.css whenever a matching color, spacing, radius, or type token exists. Add typed @property declarations before introducing a new token.`,
  workflow: `Read the active Design directory's rules.md, meta/canvas.json page catalog and relevant sources. Follow the active page named in context unless the user says otherwise; always supply an explicit pageId to frame API writes when several pages exist. Inspect the live element selection and frames and make targeted HTML/CSS edits in that directory. Call lint_design, re-read the affected frame using its full page-folder path, use screenshot_frame to visually verify it, then call lint_design again so exact-generation browser contrast, overflow, and spacing checks are included. Resolve errors and review non-blocking advisories. JavaScript and external URLs are not part of design documents.`,
  components: `Define a reusable component as one direct components/name.html file and instantiate it with <zd-name data-oid="stable-instance">. Give every selectable definition-body element except <slot> a unique, stable data-zid, for example <article data-zid="surface">. The definition body expands only at render time; <slot> accepts instance children and <slot data-zd-attr="label"> accepts escaped attributes. Keep scripts, event handlers, external URLs, and data-oid attributes out of definitions—the authored zd-* wrapper owns selection and editing. Legacy definitions with no data-zid remain renderable, but new component.create operations require complete definition-local identity.`,
});

export type DesignGuideTopic = keyof typeof DESIGN_GUIDES;
