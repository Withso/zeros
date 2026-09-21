import { publishCloudWorkspacePath } from "../files/cloud-workspace-ownership";
import { readDirectoryDesignManifest } from "./metadata";
import { TOKENS_SEED } from "./document-seeds";
import { escapeText, escapeAttribute } from "./source";
import {
  listDesignAssets,
  readSafeDesignText,
  safeLocalReference,
} from "./assets";
import { designNodeRecords, isDesignNodeElement } from "./node-identities";
import {
  DesignRenderBudgetError,
  MAX_DESIGN_TEXT_BYTES,
} from "./render-budget";
import {
  composeFrameSrcDoc,
  prepareFrameRenderSource,
} from "./render-preparation";
import { elementRecords } from "./source";
// ──────────────────────────────────────────────────────────
// Design document — authored HTML/CSS frames and canvas metadata
// ──────────────────────────────────────────────────────────
//
// A design workspace is still a Git worktree, but its authored surface is one
// deliberately small directory:
//
//   Zeros Design/*.html      one top-level file per frame
//   Zeros Design/*.css       shared authored styles
//   Zeros Design/tokens.css  typed design tokens + layout reset
//   Zeros Design/design.toml  engine-managed directory registration
//   Zeros Design/canvas.json  editable scene, frame and Foundation metadata
//   Zeros Design/rules.md     short native-authoring instructions
//
// This module is the single engine-side interpretation of that format. The
// renderer and first-party MCP server both consume these functions, so frame
// discovery, OID healing, constraints, and token parsing cannot drift.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { migrateDesignFoundationManifest } from "@zeros/design-core";
import { designTokenThemeName } from "@zeros/design-web";
import type { ParserError } from "parse5";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { withDesignDocumentWrite as withDocumentWrite } from "./document-write-lock";
import { ensureDesignMetadataLayout } from "./metadata";

import { expandDesignComponents } from "./components";
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
} from "./document-model";
import {
  assertFrameFile,
  atomicWriteDesignSource,
  designDirectory,
  discoverFrameFiles,
  finiteBetween,
  nextFrameGeometry,
  readBoundedDesignFrameSource,
  readCanvas,
  readFrameMeta,
  writeCanvas,
} from "./document-storage";
import {
  DESIGN_TOKENS_FILE,
  ensureSafeDesignRoot,
  initializeDesignDocumentUnlocked,
  recoverPendingDesignTransactionUnlocked,
  writeIfMissing,
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
import {
  designDirectoryEntry,
  recoverDesignMetadataMigration,
} from "./metadata";
import { getDesignRuntimeAudit } from "./runtime-audits";
import { readSafeRegularFile } from "./safe-files";

export { listDesignAssets,type DesignAssetSummary } from "./assets";
export { designDirectoryNameFor } from "./directory-registry";
export { type DesignCanvasFrame,type DesignElementOffset,type DesignFrameChange,type DesignFrameDocument,type DesignFrameGeometry,type DesignFrameRenderIdentity,type DesignFrameRenderSource,type DesignFrameRestorePoint,type DesignFrameSelectionIdentity,type DesignFrameSummary,type DesignFrameTreeNode,type DesignLintReport,type DesignLintSeverity,type DesignLintViolation,type DesignMutationResult,type DesignSourceSpan,type DesignTokenMutationResult,type DesignTokenSummary,type DesignTokensDocument,type DesignWorkspaceSnapshot } from "./document-model";
export { DESIGN_TOKENS_FILE,DESIGN_TRANSACTION_JOURNAL_FILE,commitDesignWebDocumentState,designTransactionJournalPath,designTransactionRecoveryDirectory,designWebDocumentId,readDesignWebDocumentState,recoverDesignStorageForArchive,recoverPendingDesignTransaction } from "./document-transactions";
export { captureDesignFrameRestorePoint,createDesignFrame,deleteDesignFrame,duplicateDesignFrame,healDesignOids,listDesignFrames,readDesignFrameRenderIdentityFromSource,renameDesignFrame,replaceDesignFrameFromHistory,restoreDesignFrame,restoreDesignFrameChanges,sameDesignFrameRestorePoint,transferDesignNode,updateDesignFrameGeometry } from "./frame-lifecycle";
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
  return withDocumentWrite(workspacePath, async () => {
    const directory = designDirectory(workspacePath);
    await ensureSafeDesignRoot(workspacePath);
    await Promise.all([
      mkdir(path.join(directory, "assets"), { recursive: true }),
      mkdir(path.join(directory, "components"), { recursive: true }),
    ]);
    publishCloudWorkspacePath(path.join(directory, "assets"));
    publishCloudWorkspacePath(path.join(directory, "components"));
    const created: string[] = [];
    await writeIfMissing(
      path.join(directory, DESIGN_TOKENS_FILE),
      TOKENS_SEED,
      created,
      workspacePath,
    );
    recoverDesignMetadataMigration(
      workspacePath,
      designDirectoryNameFor(workspacePath),
    );
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    const canvas = await readCanvas(workspacePath);
    if (
      !designDirectoryEntry(
        workspacePath,
        designDirectoryNameFor(workspacePath),
      )
    )
      created.push(...(await writeCanvas(workspacePath, canvas)));
    else
      created.push(
        ...ensureDesignMetadataLayout(
          workspacePath,
          designDirectoryNameFor(workspacePath),
        ),
      );
    return { created };
  });
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
    const local = safeLocalReference(designDirectory(workspacePath), reference);
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
  const meta = readFrameMeta(document, file, await readCanvas(workspacePath));
  const canvas = await readCanvas(workspacePath);
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
  });
  const knownTokens = await knownTokenNames(workspacePath);
  const linted = await lintFrame(
    workspacePath,
    file,
    { healOids: false },
    knownTokens,
    source,
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
    });
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
      const knownTokens = await knownTokenNames(workspacePath);
      const [baseline, linted] = await Promise.all([
        lintFrame(
          workspacePath,
          file,
          { healOids: false },
          knownTokens,
          source,
        ),
        lintFrame(
          workspacePath,
          file,
          { healOids: false },
          knownTokens,
          healed,
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
        : validateCssMutationValue(workspacePath, property, rawValue),
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
  const offsets = await readDesignElementOffsetMap(workspacePath, input.frame);
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
  return {
    nodeId: root.oid,
    html: `<img data-oid="${oid}" src="./${escapeAttribute(asset.path)}" alt="${escapeAttribute(path.basename(asset.name, path.extname(asset.name)))}" style="position:absolute; left:${x}px; top:${y}px; max-width:320px; height:auto;">`,
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
        ? element.childNodes
            .filter(
              (node): node is DefaultTreeAdapterTypes.Element =>
                "tagName" in node && isDesignNodeElement(node),
            )
            .map((child) => visit(child, remaining - 1))
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
export async function readDesignElementOffsetMap(
  workspacePath: string,
  frame: string,
): Promise<DesignElementOffset[]> {
  await designFrameTarget(workspacePath, frame);
  const source = await readBoundedDesignFrameSource(workspacePath, frame);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const identified = designNodeRecords(parse(healDesignOids(source).html));
  const offsets: DesignElementOffset[] = [];
  let index = 0;
  for (const { element } of designNodeRecords(document)) {
    const oid = identified[index++]?.oid;
    const location = element.sourceCodeLocation;
    if (!oid || !location?.startTag) continue;
    offsets.push({
      oid,
      tag: element.tagName,
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
): Promise<DesignFrameRenderSource> {
  const file = assertFrameFile(frame);
  const render = await prepareFrameRenderSourceForFile(
    workspacePath,
    file,
    source,
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
  const document = parse(healDesignOids(source).html, { sourceCodeLocationInfo: true });
  const composed = await composeFrameSrcDoc(workspacePath, source, {
    width: summary.width,
    height: summary.height,
  });
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
): Promise<DesignCanvasFrame> {
  const source = await readBoundedDesignFrameSource(
    workspacePath,
    summary.file,
  );
  const render = await prepareFrameRenderSource(workspacePath, source, {
    width: summary.width,
    height: summary.height,
  });
  return { ...summary, sourceVersion: render.sourceVersion };
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
    const lint = await lintDesignDocumentUnlocked(workspacePath, undefined, {
      healOids: writeBack,
      includeRuntimeAudits: false,
    });
    const summaries = await listDesignFramesUnlocked(workspacePath, writeBack);
    const renderBudgetViolations: DesignLintViolation[] = [];
    const [renderedFrames, tokensDocument, assets] = await Promise.all([
      mapDesignFramesBounded(summaries, (summary) =>
        readDesignCanvasFrameFromSummary(workspacePath, summary).catch(
          (error: unknown) => {
            if (!(error instanceof DesignRenderBudgetError)) throw error;
            renderBudgetViolations.push(
              designRenderBudgetViolation(summary.file, error),
            );
            return null;
          },
        ),
      ),
      readDesignTokensDocument(workspacePath),
      listDesignAssets(workspacePath),
    ]);
    const frames = renderedFrames.filter(
      (frame): frame is DesignCanvasFrame => frame !== null,
    );
    const runtimeViolations = frames.flatMap((frame) =>
      getDesignRuntimeAudit(workspacePath, frame.file, frame.sourceVersion),
    );
    return {
      frames,
      tokens: tokensDocument.tokens,
      tokenSourceVersion: tokensDocument.sourceVersion,
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

async function cssSourceFiles(workspacePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(designDirectory(workspacePath), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.css$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function knownTokenNames(workspacePath: string): Promise<Set<string>> {
  const names = new Set(
    (await readDesignTokens(workspacePath)).map((token) => token.name),
  );
  const directory = designDirectory(workspacePath);
  for (const file of await cssSourceFiles(workspacePath)) {
    const source = await readSafeDesignText(
      directory,
      path.join(directory, file),
    );
    if (source) collectDeclaredCustomProperties(source, names);
  }
  return names;
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

async function lintFrame(
  workspacePath: string,
  file: string,
  options: { healOids: boolean },
  knownTokens: Set<string>,
  sourceOverride?: string,
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
          { severity: "error", oid: oid ?? undefined, fix: "Remove <script>." },
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
              fix: `Remove ${attribute.name}; interactivity belongs to Prototype mode.`,
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
  for (const match of source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    const token = match[1];
    if (availableTokens.has(token)) continue;
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
  );
  const usedComponents = new Set(componentExpansion.usedComponents);
  const componentRecords = designNodeRecords(document).filter(({ element }) =>
    element.tagName.startsWith("zd-"),
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
  }
  return { violations, healedOids };
}

async function lintDesignDocumentUnlocked(
  workspacePath: string,
  frame?: string,
  options: { healOids?: boolean; includeRuntimeAudits?: boolean } = {},
): Promise<DesignLintReport> {
  const files = frame
    ? [(await designFrameTarget(workspacePath, frame)).file]
    : await discoverFrameFiles(workspacePath);
  const knownTokens = await knownTokenNames(workspacePath);
  const violations: DesignLintViolation[] = [];
  let healedOids = 0;
  for (const file of files) {
    let result: Awaited<ReturnType<typeof lintFrame>>;
    try {
      result = await lintFrame(
        workspacePath,
        file,
        { healOids: options.healOids !== false },
        knownTokens,
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
    : withDocumentWrite(workspacePath, lint);
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

export async function readDesignTokensDocument(
  workspacePath: string,
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
  root.walkRules((rule) => {
    const theme = designTokenThemeName(rule.selector);
    const base = rule.selector.trim() === ":root";
    if (!base && !theme) return;
    if (theme) themes.add(theme);
    rule.walkDecls(/^--/, (declaration) => {
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
    });
  });

  const sources = [
    ...(await discoverFrameFiles(workspacePath)),
    ...(await cssSourceFiles(workspacePath)),
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
  frame: `One top-level .html file is one frame. Link ./tokens.css and keep the body as the design. Frame titles, kinds, geometry and foundation metadata are stored separately in this Design folder’s design.toml; use the Design API to change them. Give every rendered element inside body a stable unique data-oid, but leave html, head, body, meta, link, title, style, script, and template as non-selectable document plumbing.`,
  layout: `Use normal HTML flow and flexbox for structural layout. Prefer flex containers, gap, padding, alignment, and intrinsic sizing over absolute positioning inside a frame.`,
  tokens: `Use var(--token) from tokens.css whenever a matching color, spacing, radius, or type token exists. Add typed @property declarations before introducing a new token.`,
  workflow: `Inspect the live element selection and frames and make targeted HTML/CSS edits only under Zeros Design/. Call lint_design, re-read the affected frame, use screenshot_frame to visually verify it, then call lint_design again so exact-generation browser contrast, overflow, and spacing checks are included. Resolve errors and review non-blocking advisories. JavaScript and external URLs are not part of design documents.`,
  components: `Define a reusable component as one direct components/name.html file and instantiate it with <zd-name data-oid="stable-instance">. Give every selectable definition-body element except <slot> a unique, stable data-zid, for example <article data-zid="surface">. The definition body expands only at render time; <slot> accepts instance children and <slot data-zd-attr="label"> accepts escaped attributes. Keep scripts, event handlers, external URLs, and data-oid attributes out of definitions—the authored zd-* wrapper owns selection and editing. Legacy definitions with no data-zid remain renderable, but new component.create operations require complete definition-local identity.`,
});

export type DesignGuideTopic = keyof typeof DESIGN_GUIDES;
