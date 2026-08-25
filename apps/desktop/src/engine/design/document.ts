// ──────────────────────────────────────────────────────────
// Design document — portable HTML/CSS frames + app-owned canvas state
// ──────────────────────────────────────────────────────────
//
// A design workspace is still a Git worktree, but its authored surface is one
// deliberately small directory:
//
//   Zeros Design/*.html      one top-level file per frame
//   Zeros Design/*.css       shared authored styles
//   Zeros Design/tokens.css  typed design tokens + layout reset
//   .zeros-canvas.json       app-owned frame placement
//
// This module is the single engine-side interpretation of that format. The
// renderer and first-party MCP server both consume these functions, so frame
// discovery, OID healing, constraints, and token parsing cannot drift.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  realpath,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  DESIGN_FOUNDATION_SCHEMA_VERSION,
  migrateDesignFoundationManifest,
  type DesignFoundationManifest,
} from "@zeros/design-core";
import {
  createDesignWebDocumentState,
  DESIGN_WEB_MAX_FILES,
  DESIGN_WEB_MAX_TOTAL_BYTES,
  designTokenThemeName,
  type DesignWebDocumentState,
} from "@zeros/design-web";
import { DESIGN_RUNTIME_SOURCE } from "@zeros/protocol/design-runtime";
import { withDesignDocumentWrite as withDocumentWrite } from "./document-write-lock";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { ParserError } from "parse5";
import postcss from "postcss";

import { expandDesignComponents } from "./components";
import {
  DEFAULT_DESIGN_DIRECTORY_NAME,
  DESIGN_CANVAS_FILE as CANVAS_MARKER_FILE,
  designDirectoryNameFor,
} from "./directory-registry";
import { getDesignRuntimeAudit } from "./runtime-audits";
import { inspectSafeRegularFile, readSafeRegularFile } from "./safe-files";

/** The DEFAULT design folder name. Callers that need the folder for a
 *  SPECIFIC workspace must go through designDirectoryNameFor (the per-repo
 *  `[design] directory` pointer can rename or nest it); this constant remains
 *  for defaults, seeds, and pre-pointer compatibility. */
export const DESIGN_DIRECTORY_NAME = DEFAULT_DESIGN_DIRECTORY_NAME;
export { designDirectoryNameFor } from "./directory-registry";
export const DESIGN_CANVAS_FILE = CANVAS_MARKER_FILE;
export const DESIGN_TOKENS_FILE = "tokens.css";
export const DESIGN_TRANSACTION_JOURNAL_FILE = ".zeros-transaction.json";

const FRAME_MIN_WIDTH = 1;
const FRAME_MIN_HEIGHT = 1;
const FRAME_MAX_SIZE = 16_384;
const MAX_FRAME_COUNT = 256;
const DEFAULT_FRAME_WIDTH = 1_440;
const DEFAULT_FRAME_HEIGHT = 900;
const FRAME_GRID_GAP = 120;
const FRAME_GRID_COLUMNS = 3;
const MAX_DESIGN_ASSETS = 128;
const MAX_ASSET_DEPTH = 4;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_DESIGN_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DESIGN_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_DESIGN_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_INLINE_ASSET_BYTES_PER_FRAME = 12 * 1024 * 1024;
const MAX_STYLESHEETS_PER_FRAME = 128;
const MAX_SANITIZED_RENDER_BYTES = 15 * 1024 * 1024;
const MAX_COMPOSED_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_PREVIEW_BYTES = 512 * 1024;
const MAX_ASSET_PREVIEW_TOTAL_BYTES = 4 * 1024 * 1024;
const NON_DESIGN_NODE_TAGS = new Set([
  "base",
  "body",
  "head",
  "html",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

const DESIGN_ASSET_MIME_TYPES = Object.freeze<Record<string, string>>({
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

export class DesignRenderBudgetError extends Error {
  readonly code = "DESIGN_RENDER_BUDGET_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "DesignRenderBudgetError";
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertRenderByteLimit(
  value: string,
  maximum: number,
  message: string,
): void {
  if (utf8Bytes(value) > maximum) {
    throw new DesignRenderBudgetError(message);
  }
}

export type DesignLintSeverity = "error" | "warning";

export interface DesignLintViolation {
  ruleId:
    | "no-script"
    | "no-event-handlers"
    | "local-refs-only"
    | "frames-are-valid-html"
    | "oid-missing"
    | "oid-duplicate"
    | "unknown-token"
    | "no-external-url"
    | "component-undefined"
    | "component-invalid"
    | "render-budget"
    | "contrast"
    | "overflow"
    | "spacing-scale"
    | "audit-limit"
    | "layer-tree-limit";
  severity: DesignLintSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
  oid?: string;
  fix?: string;
}

export interface DesignLintReport {
  workspacePath: string;
  checkedFiles: string[];
  violations: DesignLintViolation[];
  healedOids: number;
}

export interface DesignFrameGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

/** Exact engine-owned restore point for one deleted frame. Undo history keeps
 * this bounded source record in memory; it is never accepted from a renderer
 * or written outside the active Design directory. */
export interface DesignFrameRestorePoint {
  file: string;
  source: string;
  geometry: DesignFrameGeometry;
}

export interface DesignFrameSummary {
  file: string;
  title: string;
  /** Text-backed frames give loose canvas text durable HTML ownership without
   * visually pretending that the text is a conventional artboard. */
  kind: "frame" | "text";
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
  nodeCount: number;
  modifiedAt: number;
}

/** Lightweight canvas record. Render/source payloads are hydrated only for
 * the bounded live-frame window through readDesignFrame(). */
export interface DesignCanvasFrame extends DesignFrameSummary {
  /** Hash of the rendered HTML, linked CSS/assets, and viewport dimensions. */
  sourceVersion: string;
}

export interface DesignFrameTreeNode {
  tag: string;
  oid: string | null;
  text: string | null;
  children: DesignFrameTreeNode[];
}

export interface DesignSourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface DesignElementOffset extends DesignSourceSpan {
  oid: string;
  tag: string;
  startTag: DesignSourceSpan;
  endTag: DesignSourceSpan | null;
}

export interface DesignFrameDocument extends DesignFrameSummary {
  /** Hash of the rendered HTML, linked CSS, and frame viewport dimensions. */
  sourceVersion: string;
  source: string;
  srcDoc: string;
  tree: DesignFrameTreeNode[];
}

export interface DesignFrameRenderIdentity {
  file: string;
  sourceVersion: string;
}

export interface DesignFrameRenderSource extends DesignFrameRenderIdentity {
  /** Sanitized, expanded HTML with local CSS and raster assets embedded. */
  html: string;
}

export interface DesignFrameSelectionIdentity extends DesignFrameRenderIdentity {
  title: string;
  width: number;
  height: number;
  x: number;
  y: number;
  nodeIds: readonly string[];
}

export interface DesignTokenSummary {
  name: string;
  syntax: string;
  inherits: boolean;
  initialValue: string;
  value: string;
  themeValues: Record<string, string>;
  usageCount: number;
  line: number;
}

export interface DesignTokensDocument {
  sourceVersion: string;
  themes: string[];
  tokens: DesignTokenSummary[];
}

export interface DesignTokenMutationResult {
  changed: boolean;
  document: DesignTokensDocument;
}

export interface DesignAssetSummary {
  /** POSIX path relative to Zeros Design/. */
  path: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  /** Bounded local preview used by the Assets panel and drag affordance. */
  dataUrl: string | null;
}

export interface DesignMutationResult {
  changed: boolean;
  frame: DesignFrameDocument;
  lint: DesignLintReport;
}

export interface DesignWorkspaceSnapshot {
  /** Lightweight frames in canvas z-order. The custom protocol hydrates only
   * the bounded live-frame set, avoiding an all-frame HTML/srcDoc IPC payload. */
  frames: DesignCanvasFrame[];
  tokens: DesignTokenSummary[];
  tokenSourceVersion: string;
  assets: DesignAssetSummary[];
  lint: DesignLintReport;
}

interface DesignReadOptions {
  /** Local canvas/MCP reads may heal OIDs and persist auto-placement. Remote
   * reads are strictly observational and pass false at the service boundary. */
  writeBack?: boolean;
}

interface CanvasDocument {
  version: 2;
  frames: Record<string, DesignFrameGeometry>;
  foundation: DesignFoundationManifest;
  view?: {
    x: number;
    y: number;
    zoom: number;
  };
}

interface FrameMeta {
  title: string;
  width: number;
  height: number;
  kind: "frame" | "text";
}

interface ElementRecord {
  element: DefaultTreeAdapterTypes.Element;
  oid: string | null;
}

const DEFAULT_CANVAS: CanvasDocument = Object.freeze({
  version: 2,
  frames: Object.freeze({}),
  foundation: {
    schemaVersion: DESIGN_FOUNDATION_SCHEMA_VERSION,
    parameters: [],
    variants: [],
    components: [],
  },
});

const TOKENS_SEED = `@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body { background: var(--bg1); color: var(--fg1); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  body [data-oid] { display: flex; flex-direction: column; flex-shrink: 0; position: relative; margin: 0; }
  h1, h2, h3, h4, h5, h6, p, span, a, strong, em, small, label { display: block; }
  img, svg { display: block; max-width: 100%; }
  button, input, textarea, select { font: inherit; }
}

@property --bg1 {
  syntax: "<color>";
  inherits: true;
  initial-value: #ffffff;
}
@property --bg2 {
  syntax: "<color>";
  inherits: true;
  initial-value: #f5f5f5;
}
@property --fg1 {
  syntax: "<color>";
  inherits: true;
  initial-value: #171717;
}
@property --fg2 {
  syntax: "<color>";
  inherits: true;
  initial-value: #737373;
}
@property --accent {
  syntax: "<color>";
  inherits: true;
  initial-value: #2563eb;
}
@property --border {
  syntax: "<color>";
  inherits: true;
  initial-value: #e5e5e5;
}
@property --space-1 {
  syntax: "<length>";
  inherits: true;
  initial-value: 4px;
}
@property --space-2 {
  syntax: "<length>";
  inherits: true;
  initial-value: 8px;
}
@property --space-3 {
  syntax: "<length>";
  inherits: true;
  initial-value: 12px;
}
@property --space-4 {
  syntax: "<length>";
  inherits: true;
  initial-value: 16px;
}
@property --space-6 {
  syntax: "<length>";
  inherits: true;
  initial-value: 24px;
}
@property --space-8 {
  syntax: "<length>";
  inherits: true;
  initial-value: 32px;
}
@property --radius-sm {
  syntax: "<length>";
  inherits: true;
  initial-value: 6px;
}
@property --radius-md {
  syntax: "<length>";
  inherits: true;
  initial-value: 10px;
}
@property --radius-lg {
  syntax: "<length>";
  inherits: true;
  initial-value: 16px;
}

:root {
  --bg1: #ffffff;
  --bg2: #f5f5f5;
  --fg1: #171717;
  --fg2: #737373;
  --accent: #2563eb;
  --border: #e5e5e5;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}
`;

/** New canvas frames keep one editable root for styles and future children,
 * but never seed visible content the designer did not create. */
const FRAME_SEED = (
  title: string,
  oid: string,
  width: number,
  height: number,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="zeros-frame" content="width=${width},height=${height},kind=frame,title=${escapeAttribute(title)}">
    <link rel="stylesheet" href="./tokens.css">
    <title>${escapeText(title)}</title>
  </head>
  <body>
    <main data-oid="${oid}-main" style="min-height:100%; padding:var(--space-8); gap:var(--space-4);"></main>
  </body>
</html>
`;

const TEXT_FRAME_SEED = (
  title: string,
  nodeId: string,
  text: string,
  width: number,
  height: number,
  fixedSize: boolean,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="zeros-frame" content="width=${width},height=${height},kind=text,title=${escapeAttribute(title)}">
    <link rel="stylesheet" href="./tokens.css">
    <title>${escapeText(title)}</title>
    <style>
      html, body { width: 100%; height: 100%; min-height: 0; margin: 0; background: transparent !important; overflow: visible; }
      body > [data-oid] { ${fixedSize ? "width:100%;min-height:100%;" : "width:max-content;max-width:none;"} margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <div data-oid="${escapeAttribute(nodeId)}">${escapeText(text)}</div>
  </body>
</html>
`;

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function designDirectory(workspacePath: string): string {
  // The active folder comes from the per-workspace registry (primed from the
  // `[design] directory` pointer); split on "/" so a nested name like
  // "apps/web/designs" joins as real path segments on every platform.
  return path.join(
    path.resolve(workspacePath),
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
}

async function ensureSafeDesignRoot(workspacePath: string): Promise<string> {
  const workspaceRoot = await realpath(path.resolve(workspacePath));
  const directory = designDirectory(workspacePath);
  await mkdir(directory, { recursive: true });
  const canonicalDirectory = await realpath(directory);
  // realpath the WORKSPACE root only; every design-dir segment below it must
  // be a real directory (no symlink hop), or the canonical spelling differs
  // from the expected join and the write is refused — same guard as before,
  // now covering each nested segment too.
  const expectedDirectory = path.join(
    workspaceRoot,
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
  if (canonicalDirectory !== expectedDirectory) {
    throw new Error("Refusing an unsafe design write directory.");
  }
  return canonicalDirectory;
}

async function assertSafeDesignWriteTarget(
  workspacePath: string,
  target: string,
): Promise<void> {
  const directory = designDirectory(workspacePath);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(directory, resolvedTarget);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Refusing an unsafe design write directory.");
  }
  const canonicalDirectory = await ensureSafeDesignRoot(workspacePath);
  const relativeParent = path.dirname(relative);
  const expectedParent = path.join(
    canonicalDirectory,
    relativeParent === "." ? "" : relativeParent,
  );
  let canonicalParent = canonicalDirectory;
  if (relativeParent !== ".") {
    for (const segment of relativeParent.split(path.sep)) {
      const candidate = path.join(canonicalParent, segment);
      try {
        await mkdir(candidate);
      } catch (error: unknown) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code !== "EEXIST") throw error;
      }
      const resolved = await realpath(candidate).catch(() => null);
      const info = resolved ? await stat(resolved).catch(() => null) : null;
      if (resolved !== candidate || !info?.isDirectory()) {
        throw new Error("Refusing an unsafe design write directory.");
      }
      canonicalParent = resolved;
    }
  }
  if (canonicalParent !== expectedParent) {
    throw new Error("Refusing an unsafe design write directory.");
  }
}

function canvasPath(workspacePath: string): string {
  return path.join(designDirectory(workspacePath), DESIGN_CANVAS_FILE);
}

function isFrameFile(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function assertFrameFile(value: string): string {
  if (!isFrameFile(value)) {
    throw new Error(`Invalid design frame file: ${value}`);
  }
  return value;
}

function comparePortableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteBetween(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function normalizeGeometry(
  value: Partial<DesignFrameGeometry> | null | undefined,
  fallback: DesignFrameGeometry,
): DesignFrameGeometry {
  return {
    x: finiteBetween(value?.x, fallback.x, -1_000_000, 1_000_000),
    y: finiteBetween(value?.y, fallback.y, -1_000_000, 1_000_000),
    w: finiteBetween(value?.w, fallback.w, FRAME_MIN_WIDTH, FRAME_MAX_SIZE),
    h: finiteBetween(value?.h, fallback.h, FRAME_MIN_HEIGHT, FRAME_MAX_SIZE),
    z: Math.round(finiteBetween(value?.z, fallback.z, 0, MAX_FRAME_COUNT)),
  };
}

async function readCanvas(workspacePath: string): Promise<CanvasDocument> {
  const directory = designDirectory(workspacePath);
  const target = canvasPath(workspacePath);
  const safe = await readSafeRegularFile(
    directory,
    target,
    MAX_DESIGN_METADATA_BYTES,
  );
  if (!safe) {
    if (existsSync(target)) {
      throw new Error(
        "Design canvas metadata is unsafe or exceeds the 16 MiB limit.",
      );
    }
    return {
      version: 2,
      frames: {},
      foundation: migrateDesignFoundationManifest(undefined),
    };
  }
  let raw: {
    version?: unknown;
    frames?: unknown;
    view?: unknown;
    foundation?: unknown;
  };
  try {
    raw = JSON.parse(safe.body.toString("utf8")) as typeof raw;
  } catch {
    throw new Error("Design canvas metadata contains invalid JSON.");
  }
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) {
    throw new Error(`Unsupported design canvas version: ${raw.version}`);
  }
  const sourceFrames =
    raw.frames && typeof raw.frames === "object"
      ? (raw.frames as Record<string, Partial<DesignFrameGeometry>>)
      : {};
  const frames: Record<string, DesignFrameGeometry> = {};
  for (const [file, geometry] of Object.entries(sourceFrames).slice(
    0,
    MAX_FRAME_COUNT,
  )) {
    if (!isFrameFile(file)) continue;
    frames[file] = normalizeGeometry(geometry, {
      x: 0,
      y: 0,
      w: DEFAULT_FRAME_WIDTH,
      h: DEFAULT_FRAME_HEIGHT,
      z: 0,
    });
  }
  const view =
    raw.view && typeof raw.view === "object"
      ? (raw.view as Partial<NonNullable<CanvasDocument["view"]>>)
      : null;
  return {
    version: 2,
    frames,
    foundation: migrateDesignFoundationManifest(raw.foundation),
    ...(view
      ? {
          view: {
            x: finiteBetween(view.x, 0, -1_000_000, 1_000_000),
            y: finiteBetween(view.y, 0, -1_000_000, 1_000_000),
            zoom: finiteBetween(view.zoom, 1, 0.02, 64),
          },
        }
      : {}),
  };
}

async function writeCanvas(
  workspacePath: string,
  canvas: CanvasDocument,
): Promise<void> {
  const target = canvasPath(workspacePath);
  await assertSafeDesignWriteTarget(workspacePath, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.zeros-tmp`;
  const source = `${JSON.stringify(canvas, null, 2)}\n`;
  if (utf8Bytes(source) > MAX_DESIGN_METADATA_BYTES) {
    throw new Error("Design canvas metadata exceeds the 16 MiB limit.");
  }
  await writeFile(temporary, source, "utf8");
  await rename(temporary, target);
}

async function writeIfMissing(
  file: string,
  content: string,
  created: string[],
  workspacePath: string,
): Promise<void> {
  let wrote = false;
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    wrote = true;
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "EEXIST") throw error;
  }
  if (wrote) {
    created.push(path.relative(workspacePath, file).split(path.sep).join("/"));
  }
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
    const created: string[] = [];
    await writeIfMissing(
      path.join(directory, DESIGN_TOKENS_FILE),
      TOKENS_SEED,
      created,
      workspacePath,
    );
    await writeIfMissing(
      path.join(directory, DESIGN_CANVAS_FILE),
      `${JSON.stringify(DEFAULT_CANVAS, null, 2)}\n`,
      created,
      workspacePath,
    );
    await writeIfMissing(
      path.join(directory, "assets", ".gitkeep"),
      "",
      created,
      workspacePath,
    );
    await writeIfMissing(
      path.join(directory, "components", ".gitkeep"),
      "",
      created,
      workspacePath,
    );
    return { created };
  });
}

function slugFrameTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "frame";
}

export async function createDesignFrame(
  workspacePath: string,
  input: {
    title?: string;
    geometry?: Partial<DesignFrameGeometry>;
    seed?: {
      kind: "text";
      nodeId: string;
      text: string;
      fixedSize: boolean;
    };
  } = {},
): Promise<DesignFrameSummary> {
  return withDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    const directory = designDirectory(workspacePath);
    const title = input.title?.trim().slice(0, 120) || "Frame";
    const base = slugFrameTitle(title);
    let file = `${base}.html`;
    for (let suffix = 2; existsSync(path.join(directory, file)); suffix++) {
      file = `${base}-${suffix}.html`;
    }
    const oid = `f-${createHash("sha256")
      .update(`${file}:${Date.now()}:${randomUUID()}`)
      .digest("hex")
      .slice(0, 8)}`;
    const canvas = await readCanvas(workspacePath);
    const automaticGeometry = nextFrameGeometry(Object.values(canvas.frames), {
      width: DEFAULT_FRAME_WIDTH,
      height: DEFAULT_FRAME_HEIGHT,
    });
    const geometry = input.geometry
      ? normalizeGeometry(input.geometry, automaticGeometry)
      : automaticGeometry;
    const textSeed = input.seed;
    if (textSeed && textSeed.text.length > 10_000) {
      throw new Error("Design text is too long.");
    }
    const source = textSeed
      ? TEXT_FRAME_SEED(
          title,
          assertDesignNodeId(textSeed.nodeId),
          textSeed.text,
          geometry.w,
          geometry.h,
          textSeed.fixedSize,
        )
      : FRAME_SEED(title, oid, geometry.w, geometry.h);
    await writeFile(path.join(directory, file), source, {
      encoding: "utf8",
      flag: "wx",
    });
    canvas.frames[file] = geometry;
    await writeCanvas(workspacePath, canvas);
    const info = await stat(path.join(directory, file));
    return {
      file,
      title,
      kind: textSeed ? "text" : "frame",
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: 1,
      modifiedAt: info.mtimeMs,
    };
  });
}

async function initializeDesignDocumentUnlocked(
  workspacePath: string,
): Promise<void> {
  const directory = designDirectory(workspacePath);
  await ensureSafeDesignRoot(workspacePath);
  await Promise.all([
    mkdir(path.join(directory, "assets"), { recursive: true }),
    mkdir(path.join(directory, "components"), { recursive: true }),
  ]);
  const ignored: string[] = [];
  await writeIfMissing(
    path.join(directory, DESIGN_TOKENS_FILE),
    TOKENS_SEED,
    ignored,
    workspacePath,
  );
  await writeIfMissing(
    path.join(directory, DESIGN_CANVAS_FILE),
    `${JSON.stringify(DEFAULT_CANVAS, null, 2)}\n`,
    ignored,
    workspacePath,
  );
}

function nextFrameGeometry(
  existing: DesignFrameGeometry[],
  meta: { width: number; height: number },
): DesignFrameGeometry {
  const index = existing.length;
  const column = index % FRAME_GRID_COLUMNS;
  const row = Math.floor(index / FRAME_GRID_COLUMNS);
  const widest = Math.max(
    meta.width,
    ...existing.map((geometry) => geometry.w),
  );
  const tallest = Math.max(
    meta.height,
    ...existing.map((geometry) => geometry.h),
  );
  return {
    x: column * (widest + FRAME_GRID_GAP),
    y: row * (tallest + FRAME_GRID_GAP),
    w: meta.width,
    h: meta.height,
    z: index,
  };
}

function elementRecords(
  document: DefaultTreeAdapterTypes.Document,
): ElementRecord[] {
  const records: ElementRecord[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("tagName" in node) {
      const oid =
        node.attrs.find((attribute) => attribute.name === "data-oid")?.value ??
        null;
      records.push({ element: node, oid });
      if (node.tagName === "template" && "content" in node) {
        visit(node.content);
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  return records;
}

type DesignAncestor =
  | DefaultTreeAdapterTypes.Document
  | DefaultTreeAdapterTypes.DocumentFragment
  | DefaultTreeAdapterTypes.Element;

/** A selectable design node is authored visual content inside body, never
 * document plumbing. One predicate shared by healing, lint, mutations, and
 * rendering keeps metadata nodes out of the canvas contract. */
function isDesignNodeElement(
  element: DefaultTreeAdapterTypes.Element,
): boolean {
  if (NON_DESIGN_NODE_TAGS.has(element.tagName)) return false;
  let current = element.parentNode as DesignAncestor | null;
  while (current) {
    if ("tagName" in current) {
      if (current.tagName === "head" || current.tagName === "template") {
        return false;
      }
      if (current.tagName === "body") return true;
    }
    current =
      "parentNode" in current
        ? (current.parentNode as DesignAncestor | null)
        : null;
  }
  return false;
}

function designNodeRecords(
  document: DefaultTreeAdapterTypes.Document,
): ElementRecord[] {
  return elementRecords(document).filter(({ element }) =>
    isDesignNodeElement(element),
  );
}

/** Legacy frames may carry data-oid on html/head/style/body. Strip those ids
 * from the composed render only: authored source remains intact, while an old
 * broad `[data-oid]` reset can no longer reveal head content or expose
 * document plumbing as selectable layers. */
export function stripNonDesignOidsForRender(source: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number }> = [];
  for (const { element } of elementRecords(document)) {
    if (isDesignNodeElement(element)) continue;
    const location = element.sourceCodeLocation?.attrs?.["data-oid"];
    const startTag = element.sourceCodeLocation?.startTag;
    if (!location || !startTag) continue;
    let start = location.startOffset;
    while (start > startTag.startOffset && /\s/.test(source[start - 1] ?? "")) {
      start -= 1;
    }
    edits.push({ start, end: location.endOffset });
  }
  let rendered = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rendered = `${rendered.slice(0, edit.start)}${rendered.slice(edit.end)}`;
  }
  return rendered;
}

function oidForElement(
  source: string,
  element: DefaultTreeAdapterTypes.Element,
): string {
  const offset = element.sourceCodeLocation?.startOffset ?? 0;
  return `o-${createHash("sha256")
    .update(`${element.tagName}:${offset}:${source.slice(offset, offset + 80)}`)
    .digest("hex")
    .slice(0, 9)}`;
}

export function healDesignOids(source: string): {
  html: string;
  changed: boolean;
  fixed: Array<{ kind: "missing" | "duplicate"; line: number; oid: string }>;
} {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = designNodeRecords(document);
  const used = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const fixed: Array<{
    kind: "missing" | "duplicate";
    line: number;
    oid: string;
  }> = [];
  for (const record of records) {
    const location = record.element.sourceCodeLocation;
    const startTag = location?.startTag;
    if (!startTag) continue;
    const usableOid =
      record.oid !== null && record.oid.trim().length > 0 ? record.oid : null;
    const duplicate = usableOid !== null && used.has(usableOid);
    if (usableOid !== null && !duplicate) {
      used.add(usableOid);
      continue;
    }
    const oidBase = oidForElement(source, record.element);
    let oid = oidBase;
    for (let suffix = 2; used.has(oid); suffix++) {
      oid = `${oidBase}-${suffix}`;
    }
    used.add(oid);
    const attrLocation = location?.attrs?.["data-oid"];
    if (attrLocation) {
      const original = source.slice(
        attrLocation.startOffset,
        attrLocation.endOffset,
      );
      const equalsAt = original.indexOf("=");
      if (equalsAt < 0) {
        edits.push({
          start: attrLocation.startOffset,
          end: attrLocation.endOffset,
          text: `${original}="${oid}"`,
        });
        fixed.push({
          kind: duplicate ? "duplicate" : "missing",
          line: attrLocation.startLine,
          oid,
        });
        continue;
      }
      let valueStart = equalsAt + 1;
      while (/\s/.test(original[valueStart] ?? "")) valueStart += 1;
      const quote = original[valueStart];
      let valueEnd = valueStart;
      if (quote === '"' || quote === "'") {
        valueStart += 1;
        valueEnd = original.indexOf(quote, valueStart);
      } else {
        while (
          valueEnd < original.length &&
          !/[\s"'`=<>]/.test(original[valueEnd] ?? "")
        ) {
          valueEnd += 1;
        }
      }
      if (valueEnd < valueStart) continue;
      const replacement = `${original.slice(0, valueStart)}${oid}${original.slice(valueEnd)}`;
      edits.push({
        start: attrLocation.startOffset,
        end: attrLocation.endOffset,
        text: replacement,
      });
      fixed.push({
        kind: duplicate ? "duplicate" : "missing",
        line: attrLocation.startLine,
        oid,
      });
    } else {
      const insertAt = source.lastIndexOf(">", startTag.endOffset - 1);
      if (insertAt < startTag.startOffset) continue;
      const slashAt = source.lastIndexOf("/", insertAt);
      const offset =
        slashAt >= startTag.startOffset &&
        source.slice(slashAt, insertAt).trim() === "/"
          ? slashAt
          : insertAt;
      edits.push({
        start: offset,
        end: offset,
        text: ` data-oid="${oid}"`,
      });
      fixed.push({ kind: "missing", line: startTag.startLine, oid });
    }
  }
  let html = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    html = `${html.slice(0, edit.start)}${edit.text}${html.slice(edit.end)}`;
  }
  return { html, changed: edits.length > 0, fixed };
}

function readFrameMeta(
  document: DefaultTreeAdapterTypes.Document,
  file: string,
): FrameMeta {
  let content = "";
  for (const { element } of elementRecords(document)) {
    if (element.tagName !== "meta") continue;
    const name = element.attrs.find((attribute) => attribute.name === "name");
    if (name?.value !== "zeros-frame") continue;
    content =
      element.attrs.find((attribute) => attribute.name === "content")?.value ??
      "";
    break;
  }
  const numberValue = (key: string, fallback: number): number => {
    const match = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([0-9.]+)`, "i").exec(
      content,
    );
    return finiteBetween(
      match ? Number(match[1]) : undefined,
      fallback,
      key === "width" ? FRAME_MIN_WIDTH : FRAME_MIN_HEIGHT,
      FRAME_MAX_SIZE,
    );
  };
  const titleMatch = /(?:^|,)\s*title\s*=\s*(.+)$/i.exec(content);
  const kindMatch = /(?:^|,)\s*kind\s*=\s*(frame|text)(?:\s*,|\s*$)/i.exec(
    content,
  );
  return {
    title:
      titleMatch?.[1]?.trim().slice(0, 120) ||
      file.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
    width: numberValue("width", DEFAULT_FRAME_WIDTH),
    height: numberValue("height", DEFAULT_FRAME_HEIGHT),
    kind: kindMatch?.[1]?.toLowerCase() === "text" ? "text" : "frame",
  };
}

async function discoverFrameFiles(workspacePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(designDirectory(workspacePath), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isFrameFile(entry.name))
    .map((entry) => entry.name)
    .sort(comparePortableNames)
    .slice(0, MAX_FRAME_COUNT);
}

async function designFrameTarget(
  workspacePath: string,
  frame: string,
): Promise<{ file: string; target: string }> {
  const file = assertFrameFile(frame);
  if (!(await discoverFrameFiles(workspacePath)).includes(file)) {
    throw new Error(`Design frame not found: ${file}`);
  }
  return {
    file,
    target: path.join(designDirectory(workspacePath), file),
  };
}

async function readBoundedDesignFrameSource(
  workspacePath: string,
  frame: string,
): Promise<string> {
  const file = assertFrameFile(frame);
  const directory = designDirectory(workspacePath);
  const safe = await readSafeRegularFile(
    directory,
    path.join(directory, file),
    MAX_DESIGN_TEXT_BYTES,
  );
  if (!safe) {
    throw new DesignRenderBudgetError(
      `Design frame is missing, unsafe, or exceeds 2 MiB: ${file}`,
    );
  }
  return safe.body.toString("utf8");
}

async function readAndHealFrame(
  workspacePath: string,
  file: string,
  heal = true,
): Promise<{ source: string; healed: number }> {
  const target = path.join(
    designDirectory(workspacePath),
    assertFrameFile(file),
  );
  const source = await readBoundedDesignFrameSource(workspacePath, file);
  if (!heal) return { source, healed: 0 };
  const healed = healDesignOids(source);
  if (healed.changed) await writeFile(target, healed.html, "utf8");
  return { source: healed.html, healed: healed.fixed.length };
}

async function listDesignFramesUnlocked(
  workspacePath: string,
  writeBack: boolean,
): Promise<DesignFrameSummary[]> {
  if (writeBack) await initializeDesignDocumentUnlocked(workspacePath);
  const files = await discoverFrameFiles(workspacePath);
  const canvas = await readCanvas(workspacePath);
  let canvasChanged = false;
  const summaries: DesignFrameSummary[] = [];
  for (const file of files) {
    let source: string;
    try {
      ({ source } = await readAndHealFrame(workspacePath, file, writeBack));
    } catch (error) {
      if (error instanceof DesignRenderBudgetError) continue;
      throw error;
    }
    const document = parse(source, { sourceCodeLocationInfo: true });
    const meta = readFrameMeta(document, file);
    let geometry = canvas.frames[file];
    if (!geometry) {
      geometry = nextFrameGeometry(Object.values(canvas.frames), meta);
      canvas.frames[file] = geometry;
      canvasChanged = true;
    }
    const info = await stat(path.join(designDirectory(workspacePath), file));
    summaries.push({
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
    });
  }
  const live = new Set(files);
  for (const file of Object.keys(canvas.frames)) {
    if (live.has(file)) continue;
    delete canvas.frames[file];
    canvasChanged = true;
  }
  if (writeBack && canvasChanged) await writeCanvas(workspacePath, canvas);
  return summaries.sort((left, right) => left.z - right.z);
}

export async function listDesignFrames(
  workspacePath: string,
  options: DesignReadOptions = {},
): Promise<DesignFrameSummary[]> {
  const writeBack = options.writeBack !== false;
  return writeBack
    ? withDocumentWrite(workspacePath, () =>
        listDesignFramesUnlocked(workspacePath, true),
      )
    : listDesignFramesUnlocked(workspacePath, false);
}

export async function updateDesignFrameGeometry(
  workspacePath: string,
  frame: string,
  geometry: Partial<DesignFrameGeometry>,
): Promise<DesignFrameGeometry> {
  return withDocumentWrite(workspacePath, async () => {
    const { file } = await designFrameTarget(workspacePath, frame);
    const canvas = await readCanvas(workspacePath);
    const current = canvas.frames[file] ?? {
      x: 0,
      y: 0,
      w: DEFAULT_FRAME_WIDTH,
      h: DEFAULT_FRAME_HEIGHT,
      z: Object.keys(canvas.frames).length,
    };
    const next = normalizeGeometry({ ...current, ...geometry }, current);
    canvas.frames[file] = next;
    await writeCanvas(workspacePath, canvas);
    return next;
  });
}

/** Change the human title without renaming the source file. The meta tag is
 * the frame contract's source of truth; an existing document <title> is kept in
 * sync for code view and accessibility. Both edits are byte-range splices so an
 * agent's surrounding formatting remains untouched. */
export async function renameDesignFrame(
  workspacePath: string,
  frame: string,
  nextTitle: string,
): Promise<DesignFrameSummary> {
  const file = assertFrameFile(frame);
  const title = nextTitle.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!title) throw new Error("Design frame title cannot be empty.");

  await withDocumentWrite(workspacePath, async () => {
    const { target } = await designFrameTarget(workspacePath, file);
    const source = await readBoundedDesignFrameSource(workspacePath, file);
    const document = parse(source, { sourceCodeLocationInfo: true });
    const edits: Array<{ start: number; end: number; text: string }> = [];
    let frameMetaFound = false;

    for (const { element } of elementRecords(document)) {
      if (element.tagName === "meta") {
        const name = element.attrs.find(
          (attribute) => attribute.name === "name",
        )?.value;
        if (name !== "zeros-frame") continue;
        frameMetaFound = true;
        const contentAttribute = element.attrs.find(
          (attribute) => attribute.name === "content",
        );
        const current = contentAttribute?.value ?? "";
        const content = /(?:^|,)\s*title\s*=/i.test(current)
          ? current.replace(
              /((?:^|,)\s*title\s*=\s*)[\s\S]*$/i,
              (_match, prefix: string) => `${prefix}${title}`,
            )
          : `${current}${current.trim() ? "," : ""}title=${title}`;
        const attributeLocation = element.sourceCodeLocation?.attrs?.content;
        if (attributeLocation) {
          edits.push({
            start: attributeLocation.startOffset,
            end: attributeLocation.endOffset,
            text: `content="${escapeAttribute(content)}"`,
          });
        } else {
          const startTag = element.sourceCodeLocation?.startTag;
          if (!startTag) continue;
          const close = source.lastIndexOf(">", startTag.endOffset - 1);
          if (close >= startTag.startOffset) {
            edits.push({
              start: close,
              end: close,
              text: ` content="${escapeAttribute(content)}"`,
            });
          }
        }
      }

      if (element.tagName === "title") {
        const location = element.sourceCodeLocation;
        if (location?.startTag && location.endTag) {
          edits.push({
            start: location.startTag.endOffset,
            end: location.endTag.startOffset,
            text: escapeText(title),
          });
        }
      }
    }

    if (!frameMetaFound) {
      throw new Error(
        `Design frame ${file} is missing its zeros-frame meta tag.`,
      );
    }
    let updated = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
    }
    if (updated !== source) await writeFile(target, updated, "utf8");
  });

  const summary = (await listDesignFrames(workspacePath)).find(
    (candidate) => candidate.file === file,
  );
  if (!summary) throw new Error(`Design frame not found: ${file}`);
  return summary;
}

type DesignStyleMutationValue = string | null;

interface DesignFrameMutationInput {
  frame: string;
  nodeId: string;
  sourceVersion: string;
}

interface InlineStyleDeclaration {
  property: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

function hasDesignControlCharacter(
  value: string,
  allowTextWhitespace = false,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127) return true;
    if (
      code < 32 &&
      (!allowTextWhitespace || (code !== 9 && code !== 10 && code !== 13))
    ) {
      return true;
    }
  }
  return false;
}

function assertDesignNodeId(value: string): string {
  const nodeId = value.trim();
  if (!nodeId || nodeId.length > 256 || hasDesignControlCharacter(nodeId)) {
    throw new Error("nodeId must be a stable non-empty data-oid.");
  }
  return nodeId;
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

async function atomicWriteDesignSource(
  target: string,
  source: string,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.zeros-tmp`;
  await writeFile(temporary, source, "utf8");
  await rename(temporary, target);
}

interface DesignTransactionJournal {
  version: 1;
  documentId: string;
  entryFile: string;
  nextRevision: string;
  files: Array<{ file: string; content: string | null }>;
  foundation: DesignFoundationManifest;
  geometry: DesignFrameGeometry;
}

function designTransactionJournalPath(workspacePath: string): string {
  return path.join(
    designDirectory(workspacePath),
    DESIGN_TRANSACTION_JOURNAL_FILE,
  );
}

function isDesignWebSourceFile(file: string, entryFile: string): boolean {
  return (
    file === entryFile ||
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(file) ||
    /^components\/[a-z][a-z0-9-]*\.html$/.test(file)
  );
}

export function designWebDocumentId(frame: string): string {
  return `frame:${assertFrameFile(frame)}`;
}

async function readDesignWebDocumentStateUnlocked(
  workspacePath: string,
  frame: string,
): Promise<DesignWebDocumentState> {
  const file = assertFrameFile(frame);
  const directory = designDirectory(workspacePath);
  const entry = await readSafeRegularFile(
    directory,
    path.join(directory, file),
    MAX_DESIGN_TEXT_BYTES,
  );
  if (!entry) throw new Error(`Design frame not found: ${file}`);
  const files: Record<string, string> = {
    [file]: entry.body.toString("utf8"),
  };
  let totalSourceBytes = entry.size;
  let retainedSourceFiles = 1;
  const retainSource = (
    sourceFile: string,
    safe: { body: Buffer; size: number },
  ) => {
    if (retainedSourceFiles >= DESIGN_WEB_MAX_FILES) {
      throw new Error(
        `Design document exceeds the ${DESIGN_WEB_MAX_FILES}-file limit.`,
      );
    }
    if (totalSourceBytes + safe.size > DESIGN_WEB_MAX_TOTAL_BYTES) {
      throw new Error("Design document exceeds the total source limit.");
    }
    totalSourceBytes += safe.size;
    retainedSourceFiles += 1;
    files[sourceFile] = safe.body.toString("utf8");
  };
  const topLevel = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const item of topLevel
    .filter(
      (candidate) =>
        candidate.isFile() &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(candidate.name),
    )
    .sort((left, right) => comparePortableNames(left.name, right.name))) {
    const safe = await readSafeRegularFile(
      directory,
      path.join(directory, item.name),
      MAX_DESIGN_TEXT_BYTES,
    );
    if (safe) retainSource(item.name, safe);
  }
  const componentDirectory = path.join(directory, "components");
  const componentEntries = await readdir(componentDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  for (const item of componentEntries
    .filter(
      (candidate) =>
        candidate.isFile() && /^[a-z][a-z0-9-]*\.html$/.test(candidate.name),
    )
    .sort((left, right) => comparePortableNames(left.name, right.name))) {
    const safe = await readSafeRegularFile(
      componentDirectory,
      path.join(componentDirectory, item.name),
      MAX_DESIGN_TEXT_BYTES,
    );
    if (safe) {
      retainSource(`components/${item.name}`, safe);
    }
  }
  const canvas = await readCanvas(workspacePath);
  const components = [...canvas.foundation.components];
  const registeredComponentFiles = new Set(
    components.map((component) => component.file),
  );
  const registeredComponentIds = new Set(
    components.map((component) => component.id),
  );
  for (const componentFile of Object.keys(files)
    .filter((sourceFile) => sourceFile.startsWith("components/"))
    .sort(comparePortableNames)) {
    if (registeredComponentFiles.has(componentFile)) continue;
    const id = path.basename(componentFile, ".html");
    if (registeredComponentIds.has(id)) {
      throw new Error(
        `Legacy design component id conflicts with registered metadata: ${id}`,
      );
    }
    registeredComponentFiles.add(componentFile);
    registeredComponentIds.add(id);
    components.push({
      id,
      name: id
        .split("-")
        .filter(Boolean)
        .map((part, index) =>
          index === 0
            ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
            : part,
        )
        .join(" "),
      file: componentFile,
      props: [],
      slots: [],
    });
  }
  const foundation = migrateDesignFoundationManifest({
    ...canvas.foundation,
    components,
  });
  const meta = readFrameMeta(
    parse(files[file]!, { sourceCodeLocationInfo: true }),
    file,
  );
  const geometry = canvas.frames[file] ?? {
    x: 0,
    y: 0,
    w: meta.width,
    h: meta.height,
    z: 0,
  };
  return createDesignWebDocumentState({
    documentId: designWebDocumentId(file),
    entryFile: file,
    files,
    manifest: foundation,
    frames: {
      [file]: {
        x: geometry.x,
        y: geometry.y,
        width: geometry.w,
        height: geometry.h,
        z: geometry.z,
      },
    },
  });
}

function parseDesignTransactionJournal(
  workspacePath: string,
  input: unknown,
): DesignTransactionJournal {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Malformed design transaction journal.");
  }
  const journal = input as Partial<DesignTransactionJournal>;
  const entryFile = assertFrameFile(String(journal.entryFile ?? ""));
  const documentId = designWebDocumentId(entryFile);
  if (
    journal.version !== 1 ||
    journal.documentId !== documentId ||
    typeof journal.nextRevision !== "string" ||
    !/^[a-f0-9]{24}$/.test(journal.nextRevision) ||
    !Array.isArray(journal.files) ||
    journal.files.length > DESIGN_WEB_MAX_FILES
  ) {
    throw new Error("Malformed design transaction journal.");
  }
  const files = journal.files.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("Malformed design transaction journal file.");
    }
    const record = candidate as { file?: unknown; content?: unknown };
    const file = String(record.file ?? "");
    if (!isDesignWebSourceFile(file, entryFile)) {
      throw new Error(`Invalid design transaction journal path: ${file}`);
    }
    if (
      record.content !== null &&
      (typeof record.content !== "string" ||
        Buffer.byteLength(record.content, "utf8") > MAX_DESIGN_TEXT_BYTES)
    ) {
      throw new Error(`Invalid design transaction journal content: ${file}`);
    }
    if (file === entryFile && record.content === null) {
      throw new Error("A design transaction cannot delete its entry frame.");
    }
    return { file, content: record.content as string | null };
  });
  if (new Set(files.map((file) => file.file)).size !== files.length) {
    throw new Error("Design transaction journal contains duplicate paths.");
  }
  const totalSourceBytes = files.reduce(
    (total, file) =>
      total + (file.content === null ? 0 : utf8Bytes(file.content)),
    0,
  );
  if (totalSourceBytes > 16 * 1024 * 1024) {
    throw new Error(
      "Design transaction journal exceeds the total source limit.",
    );
  }
  const foundation = migrateDesignFoundationManifest(journal.foundation);
  const geometry = normalizeGeometry(journal.geometry, {
    x: 0,
    y: 0,
    w: DEFAULT_FRAME_WIDTH,
    h: DEFAULT_FRAME_HEIGHT,
    z: 0,
  });
  return {
    version: 1,
    documentId,
    entryFile,
    nextRevision: journal.nextRevision,
    files,
    foundation,
    geometry,
  };
}

async function applyDesignTransactionJournalUnlocked(
  workspacePath: string,
  journal: DesignTransactionJournal,
): Promise<void> {
  const directory = designDirectory(workspacePath);
  await assertSafeDesignWriteTarget(
    workspacePath,
    designTransactionJournalPath(workspacePath),
  );
  await assertSafeDesignWriteTarget(workspacePath, canvasPath(workspacePath));
  for (const file of journal.files) {
    const target = path.join(directory, ...file.file.split("/"));
    await assertSafeDesignWriteTarget(workspacePath, target);
    if (file.content === null) {
      await unlink(target).catch((error: unknown) => {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          String(error.code) !== "ENOENT"
        ) {
          throw error;
        }
      });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWriteDesignSource(target, file.content);
  }
  const canvas = await readCanvas(workspacePath);
  canvas.foundation = journal.foundation;
  canvas.frames[journal.entryFile] = journal.geometry;
  await writeCanvas(workspacePath, canvas);
}

async function recoverPendingDesignTransactionUnlocked(
  workspacePath: string,
): Promise<boolean> {
  const target = designTransactionJournalPath(workspacePath);
  const directory = designDirectory(workspacePath);
  const safe = await readSafeRegularFile(
    directory,
    target,
    MAX_DESIGN_JOURNAL_BYTES,
  );
  if (!safe) {
    if (existsSync(target)) {
      throw new Error(
        "Design transaction journal is unsafe or exceeds the 32 MiB limit.",
      );
    }
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(safe.body.toString("utf8")) as unknown;
  } catch {
    throw new Error("Design transaction journal contains invalid JSON.");
  }
  const journal = parseDesignTransactionJournal(workspacePath, parsed);
  const current = await readDesignWebDocumentStateUnlocked(
    workspacePath,
    journal.entryFile,
  );
  const files = { ...current.files };
  for (const change of journal.files) {
    if (change.content === null) delete files[change.file];
    else files[change.file] = change.content;
  }
  const targetState = createDesignWebDocumentState({
    documentId: journal.documentId,
    entryFile: journal.entryFile,
    files,
    manifest: journal.foundation,
    frames: {
      ...current.frames,
      [journal.entryFile]: {
        x: journal.geometry.x,
        y: journal.geometry.y,
        width: journal.geometry.w,
        height: journal.geometry.h,
        z: journal.geometry.z,
      },
    },
  });
  if (targetState.revision !== journal.nextRevision) {
    throw new Error(
      `Design transaction journal target revision is invalid: expected ${journal.nextRevision}, derived ${targetState.revision}.`,
    );
  }
  await applyDesignTransactionJournalUnlocked(workspacePath, journal);
  const committed = await readDesignWebDocumentStateUnlocked(
    workspacePath,
    journal.entryFile,
  );
  if (committed.revision !== journal.nextRevision) {
    throw new Error(
      "Recovered design transaction did not reach its target revision.",
    );
  }
  await unlink(target).catch((error: unknown) => {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      String(error.code) !== "ENOENT"
    ) {
      throw error;
    }
  });
  return true;
}

export async function recoverPendingDesignTransaction(
  workspacePath: string,
): Promise<boolean> {
  return withDocumentWrite(workspacePath, () =>
    recoverPendingDesignTransactionUnlocked(workspacePath),
  );
}

export async function readDesignWebDocumentState(
  workspacePath: string,
  frame: string,
): Promise<DesignWebDocumentState> {
  return withDocumentWrite(workspacePath, async () => {
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    return readDesignWebDocumentStateUnlocked(workspacePath, frame);
  });
}

export async function commitDesignWebDocumentState(
  workspacePath: string,
  frame: string,
  expectedRevision: string,
  next: DesignWebDocumentState,
): Promise<void> {
  const file = assertFrameFile(frame);
  await withDocumentWrite(workspacePath, async () => {
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    const current = await readDesignWebDocumentStateUnlocked(
      workspacePath,
      file,
    );
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Design document changed: expected ${expectedRevision}, current ${current.revision}.`,
      );
    }
    if (
      next.documentId !== current.documentId ||
      next.entryFile !== current.entryFile
    ) {
      throw new Error(
        "Design transaction returned the wrong document identity.",
      );
    }
    const normalized = createDesignWebDocumentState({
      documentId: next.documentId,
      entryFile: next.entryFile,
      files: next.files,
      manifest: next.manifest,
      frames: next.frames,
    });
    if (normalized.revision !== next.revision) {
      throw new Error("Design transaction returned an invalid revision.");
    }
    const geometry = normalized.frames[file];
    if (!geometry)
      throw new Error(`Design transaction removed frame geometry: ${file}`);
    const componentFiles = new Set(
      normalized.manifest.components.map((component) => component.file),
    );
    for (const sourceFile of Object.keys(normalized.files)) {
      if (!isDesignWebSourceFile(sourceFile, file)) {
        throw new Error(
          `Design transaction returned an invalid source path: ${sourceFile}`,
        );
      }
      if (
        sourceFile.startsWith("components/") &&
        !componentFiles.has(sourceFile)
      ) {
        throw new Error(
          `Design component source is not registered: ${sourceFile}`,
        );
      }
    }
    for (const componentFile of componentFiles) {
      if (normalized.files[componentFile] === undefined) {
        throw new Error(
          `Registered design component source is missing: ${componentFile}`,
        );
      }
    }
    const nextComponentIds = new Set(
      normalized.manifest.components.map((component) => component.id),
    );
    const removedComponentIds = current.manifest.components
      .map((component) => component.id)
      .filter((componentId) => !nextComponentIds.has(componentId));
    if (removedComponentIds.length > 0) {
      const remainingHtml = Object.entries(normalized.files).filter(([name]) =>
        name.toLowerCase().endsWith(".html"),
      );
      const otherFrames = (await discoverFrameFiles(workspacePath)).filter(
        (candidate) => candidate !== file,
      );
      for (const otherFrame of otherFrames) {
        remainingHtml.push([
          otherFrame,
          await readBoundedDesignFrameSource(workspacePath, otherFrame),
        ]);
      }
      for (const componentId of removedComponentIds) {
        const owner = remainingHtml.find(([, source]) =>
          elementRecords(parse(source)).some(
            ({ element }) => element.tagName === `zd-${componentId}`,
          ),
        );
        if (owner) {
          throw new Error(
            `Design component ${componentId} still has instances in ${owner[0]}.`,
          );
        }
      }
    }
    for (const sourceFile of Object.keys(current.files)) {
      if (
        sourceFile !== file &&
        sourceFile.endsWith(".css") &&
        normalized.files[sourceFile] === undefined
      ) {
        throw new Error(
          `Design transaction cannot delete a stylesheet: ${sourceFile}`,
        );
      }
    }
    const changedFiles = new Set([
      ...Object.keys(current.files),
      ...Object.keys(normalized.files),
    ]);
    const journal: DesignTransactionJournal = {
      version: 1,
      documentId: normalized.documentId,
      entryFile: file,
      nextRevision: normalized.revision,
      files: [...changedFiles]
        .sort(comparePortableNames)
        .filter(
          (sourceFile) =>
            current.files[sourceFile] !== normalized.files[sourceFile],
        )
        .map((sourceFile) => ({
          file: sourceFile,
          content: normalized.files[sourceFile] ?? null,
        })),
      foundation: normalized.manifest,
      geometry: {
        x: geometry.x,
        y: geometry.y,
        w: geometry.width,
        h: geometry.height,
        z: geometry.z,
      },
    };
    const journalSource = `${JSON.stringify(journal)}\n`;
    if (utf8Bytes(journalSource) > MAX_DESIGN_JOURNAL_BYTES) {
      throw new Error("Design transaction journal exceeds the 32 MiB limit.");
    }
    await assertSafeDesignWriteTarget(
      workspacePath,
      designTransactionJournalPath(workspacePath),
    );
    await assertSafeDesignWriteTarget(workspacePath, canvasPath(workspacePath));
    for (const change of journal.files) {
      await assertSafeDesignWriteTarget(
        workspacePath,
        path.join(designDirectory(workspacePath), ...change.file.split("/")),
      );
    }
    await atomicWriteDesignSource(
      designTransactionJournalPath(workspacePath),
      journalSource,
    );
    try {
      await recoverPendingDesignTransactionUnlocked(workspacePath);
    } catch (firstError) {
      // Recovery overlays the journal's complete target state before deriving
      // its revision, then rewrites every changed file and canvas metadata to
      // exact contents. Reapplying the same validated journal is therefore
      // idempotent after a partial first pass and safely retries transient I/O.
      try {
        await recoverPendingDesignTransactionUnlocked(workspacePath);
      } catch {
        throw firstError;
      }
    }
    const committed = await readDesignWebDocumentStateUnlocked(
      workspacePath,
      file,
    );
    if (committed.revision !== normalized.revision) {
      throw new Error("Design transaction did not commit its exact revision.");
    }
  });
}

async function mutationResultUnlocked(
  workspacePath: string,
  file: string,
  source: string,
  changed: boolean,
): Promise<DesignMutationResult> {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const meta = readFrameMeta(document, file);
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
    const { target } = await designFrameTarget(workspacePath, file);
    const source = await readBoundedDesignFrameSource(workspacePath, file);
    const document = parse(source, { sourceCodeLocationInfo: true });
    const meta = readFrameMeta(document, file);
    const geometry = (await readCanvas(workspacePath)).frames[file];
    const current = await prepareFrameRenderSource(workspacePath, source, {
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
    const changed = healed !== source;
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
      await atomicWriteDesignSource(target, healed);
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

function rewriteFrameTitleSource(
  source: string,
  file: string,
  title: string,
): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let found = false;
  for (const { element } of elementRecords(document)) {
    if (element.tagName === "meta") {
      const name = element.attrs.find(
        (attribute) => attribute.name === "name",
      )?.value;
      if (name !== "zeros-frame") continue;
      found = true;
      const attribute = element.attrs.find((item) => item.name === "content");
      const current = attribute?.value ?? "";
      const content = /(?:^|,)\s*title\s*=/i.test(current)
        ? current.replace(
            /((?:^|,)\s*title\s*=\s*)[\s\S]*$/i,
            (_match, prefix: string) => `${prefix}${title}`,
          )
        : `${current}${current.trim() ? "," : ""}title=${title}`;
      const location = element.sourceCodeLocation?.attrs?.content;
      if (location) {
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          text: `content="${escapeAttribute(content)}"`,
        });
      }
    } else if (element.tagName === "title") {
      const location = element.sourceCodeLocation;
      if (location?.startTag && location.endTag) {
        edits.push({
          start: location.startTag.endOffset,
          end: location.endTag.startOffset,
          text: escapeText(title),
        });
      }
    }
  }
  if (!found)
    throw new Error(
      `Design frame ${file} is missing its zeros-frame meta tag.`,
    );
  let updated = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
  }
  return updated;
}

function reseedFrameOids(source: string, salt: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let index = 0;
  for (const { element, oid } of designNodeRecords(document)) {
    const location = element.sourceCodeLocation?.attrs?.["data-oid"];
    if (!oid || !location) continue;
    const next = `o-${createHash("sha256")
      .update(`${salt}:${index++}:${oid}`)
      .digest("hex")
      .slice(0, 9)}`;
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      text: `data-oid="${next}"`,
    });
  }
  let updated = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
  }
  return updated;
}

export async function duplicateDesignFrame(
  workspacePath: string,
  frame: string,
): Promise<DesignFrameSummary> {
  const originalFile = assertFrameFile(frame);
  return withDocumentWrite(workspacePath, async () => {
    await designFrameTarget(workspacePath, originalFile);
    const original = await readBoundedDesignFrameSource(
      workspacePath,
      originalFile,
    );
    const originalMeta = readFrameMeta(
      parse(original, { sourceCodeLocationInfo: true }),
      originalFile,
    );
    const title = `${originalMeta.title} copy`.slice(0, 120);
    const directory = designDirectory(workspacePath);
    const base = `${slugFrameTitle(originalMeta.title)}-copy`;
    let file = `${base}.html`;
    for (let suffix = 2; existsSync(path.join(directory, file)); suffix += 1) {
      file = `${base}-${suffix}.html`;
    }
    const source = reseedFrameOids(
      rewriteFrameTitleSource(original, file, title),
      `${file}:${randomUUID()}`,
    );
    await writeFile(path.join(directory, file), source, {
      encoding: "utf8",
      flag: "wx",
    });
    const canvas = await readCanvas(workspacePath);
    const geometry = nextFrameGeometry(
      Object.values(canvas.frames),
      originalMeta,
    );
    canvas.frames[file] = geometry;
    await writeCanvas(workspacePath, canvas);
    const info = await stat(path.join(directory, file));
    return {
      file,
      title,
      kind: originalMeta.kind,
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: designNodeRecords(parse(source)).length,
      modifiedAt: info.mtimeMs,
    };
  });
}

async function designFrameRestorePointUnlocked(
  workspacePath: string,
  frame: string,
): Promise<{ target: string; restorePoint: DesignFrameRestorePoint }> {
  const file = assertFrameFile(frame);
  const { target } = await designFrameTarget(workspacePath, file);
  const source = await readBoundedDesignFrameSource(workspacePath, file);
  const meta = readFrameMeta(
    parse(source, { sourceCodeLocationInfo: true }),
    file,
  );
  const canvas = await readCanvas(workspacePath);
  const geometry = canvas.frames[file] ?? {
    x: 0,
    y: 0,
    w: meta.width,
    h: meta.height,
    z: Object.keys(canvas.frames).length,
  };
  return {
    target,
    restorePoint: { file, source, geometry: { ...geometry } },
  };
}

function sameDesignFrameRestorePoint(
  left: DesignFrameRestorePoint,
  right: DesignFrameRestorePoint,
): boolean {
  return (
    left.file === right.file &&
    left.source === right.source &&
    left.geometry.x === right.geometry.x &&
    left.geometry.y === right.geometry.y &&
    left.geometry.w === right.geometry.w &&
    left.geometry.h === right.geometry.h &&
    left.geometry.z === right.geometry.z
  );
}

/** Capture the byte-exact source and canvas geometry needed by structural
 * history. This intentionally avoids render composition and OID healing. */
export async function captureDesignFrameRestorePoint(
  workspacePath: string,
  frame: string,
): Promise<DesignFrameRestorePoint> {
  return withDocumentWrite(
    workspacePath,
    async () =>
      (await designFrameRestorePointUnlocked(workspacePath, frame))
        .restorePoint,
  );
}

export async function deleteDesignFrame(
  workspacePath: string,
  frame: string,
  expected?: DesignFrameRestorePoint,
): Promise<DesignFrameRestorePoint> {
  const file = assertFrameFile(frame);
  return withDocumentWrite(workspacePath, async () => {
    const { target, restorePoint } = await designFrameRestorePointUnlocked(
      workspacePath,
      file,
    );
    if (expected && !sameDesignFrameRestorePoint(restorePoint, expected)) {
      throw new Error(`Design frame changed after this history entry: ${file}`);
    }
    const canvas = await readCanvas(workspacePath);
    await unlink(target);
    delete canvas.frames[file];
    try {
      await writeCanvas(workspacePath, canvas);
    } catch (error) {
      // Keep deletion atomic from the designer's perspective. The source was
      // already validated as a safe regular frame before unlinking it.
      await writeFile(target, restorePoint.source, {
        encoding: "utf8",
        flag: "wx",
      }).catch(() => undefined);
      throw error;
    }
    return restorePoint;
  });
}

/** Restore an exact frame deletion without generating new identities or
 * changing its source formatting. This is the inverse used by Command-Z. */
export async function restoreDesignFrame(
  workspacePath: string,
  restorePoint: DesignFrameRestorePoint,
): Promise<DesignFrameSummary> {
  const file = assertFrameFile(restorePoint.file);
  if (
    typeof restorePoint.source !== "string" ||
    utf8Bytes(restorePoint.source) > MAX_DESIGN_TEXT_BYTES
  ) {
    throw new Error(`Design frame restore source is invalid: ${file}`);
  }
  return withDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    const directory = designDirectory(workspacePath);
    const target = path.join(directory, file);
    await assertSafeDesignWriteTarget(workspacePath, target);
    if (existsSync(target)) {
      throw new Error(`Design frame already exists: ${file}`);
    }
    const document = parse(restorePoint.source, {
      sourceCodeLocationInfo: true,
    });
    const meta = readFrameMeta(document, file);
    const canvas = await readCanvas(workspacePath);
    if (
      !Object.prototype.hasOwnProperty.call(canvas.frames, file) &&
      Object.keys(canvas.frames).length >= MAX_FRAME_COUNT
    ) {
      throw new Error(`Design document exceeds ${MAX_FRAME_COUNT} frames.`);
    }
    const geometry = normalizeGeometry(restorePoint.geometry, {
      x: 0,
      y: 0,
      w: meta.width,
      h: meta.height,
      z: Object.keys(canvas.frames).length,
    });
    await writeFile(target, restorePoint.source, {
      encoding: "utf8",
      flag: "wx",
    });
    canvas.frames[file] = geometry;
    try {
      await writeCanvas(workspacePath, canvas);
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
    const info = await stat(target);
    return {
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
    };
  });
}

/** Replace one present frame with an exact prior/later history state. The
 * expected state makes stale undo/redo fail closed instead of overwriting an
 * out-of-band source change. */
export async function replaceDesignFrameFromHistory(
  workspacePath: string,
  expected: DesignFrameRestorePoint,
  replacement: DesignFrameRestorePoint,
): Promise<DesignFrameSummary> {
  const file = assertFrameFile(expected.file);
  if (assertFrameFile(replacement.file) !== file) {
    throw new Error("Design frame history cannot change file identity.");
  }
  if (
    typeof replacement.source !== "string" ||
    utf8Bytes(replacement.source) > MAX_DESIGN_TEXT_BYTES
  ) {
    throw new Error(`Design frame restore source is invalid: ${file}`);
  }
  return withDocumentWrite(workspacePath, async () => {
    const { target, restorePoint: current } =
      await designFrameRestorePointUnlocked(workspacePath, file);
    if (!sameDesignFrameRestorePoint(current, expected)) {
      throw new Error(`Design frame changed after this history entry: ${file}`);
    }
    const document = parse(replacement.source, {
      sourceCodeLocationInfo: true,
    });
    const meta = readFrameMeta(document, file);
    const geometry = normalizeGeometry(replacement.geometry, current.geometry);
    const canvas = await readCanvas(workspacePath);
    await atomicWriteDesignSource(target, replacement.source);
    canvas.frames[file] = geometry;
    try {
      await writeCanvas(workspacePath, canvas);
    } catch (error) {
      await atomicWriteDesignSource(target, current.source).catch(
        () => undefined,
      );
      throw error;
    }
    const info = await stat(target);
    return {
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
    };
  });
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
  const offsets: DesignElementOffset[] = [];
  for (const { element, oid } of designNodeRecords(document)) {
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

async function inlineLocalStyles(
  workspacePath: string,
  source: string,
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
    const resolved = safeLocalReference(directory, href);
    let replacement = "";
    if (resolved?.toLowerCase().endsWith(".css")) {
      const css = await readSafeDesignText(directory, resolved);
      if (css !== null) {
        replacement = `<style data-zeros-source="${escapeAttribute(href)}">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
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
): Promise<string> {
  const matches = [...value.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
  let result = value;
  let resultBytes = utf8Bytes(value);
  for (const match of matches.reverse()) {
    const reference = match[2] ?? "";
    const mimeType = designAssetMimeType(reference);
    const resolved = mimeType ? safeLocalReference(directory, reference) : null;
    if (!resolved || !mimeType) continue;
    const data = await readSafeDesignBuffer(directory, resolved);
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
    const start = match.index ?? 0;
    const replacement = `url("data:${mimeType};base64,${data.toString("base64")}")`;
    resultBytes += utf8Bytes(replacement) - utf8Bytes(match[0]);
    if (resultBytes > MAX_SANITIZED_RENDER_BYTES) {
      throw new DesignRenderBudgetError(
        "Inlined CSS exceeded the 15 MiB per-frame render limit.",
      );
    }
    result = `${result.slice(0, start)}${replacement}${result.slice(start + match[0].length)}`;
  }
  return result;
}

async function inlineCssLocalAssets(
  directory: string,
  source: string,
  budget: { inlineAssetBytes: number },
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
      const inlined = await inlineCssLocalAssets(directory, css, budget);
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
      if (attribute.name !== "src" && attribute.name !== "poster") continue;
      const mimeType = designAssetMimeType(attribute.value);
      const resolved = mimeType
        ? safeLocalReference(directory, attribute.value)
        : null;
      const location = element.sourceCodeLocation?.attrs?.[attribute.name];
      if (!resolved || !location || !mimeType) continue;
      const data = await readSafeDesignBuffer(directory, resolved);
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

interface DesignSourceEdit {
  start: number;
  end: number;
  text: string;
}

function applyDesignSourceEdits(
  source: string,
  edits: readonly DesignSourceEdit[],
): string {
  let result = source;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

function attributeRemovalStart(source: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && /\s/.test(source[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}

function activeUrl(value: string): boolean {
  const normalized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x20 && codePoint !== 0x7f;
    })
    .join("")
    .toLowerCase();
  if (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:")
  ) {
    return true;
  }
  if (!normalized.startsWith("data:")) return false;
  // Local design assets are inlined into these exact passive raster forms.
  // Every other data payload is authored active content and is removed,
  // including SVG and text MIME types that can carry markup or script.
  return !/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]*={0,2}$/i.test(
    normalized,
  );
}

/** Remove active authored markup using parse5's decoded attribute values and
 * exact source locations. Regex sanitizers inspect encoded text rather than
 * the DOM the browser executes, so `java&#115;cript:` and mixed/unquoted event
 * handlers bypass them. This parser-backed sanitizer is shared by srcDoc and
 * custom-protocol rendering. */
export function sanitizeDesignFrameMarkup(source: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: DesignSourceEdit[] = [];
  const urlAttributes = new Set([
    "action",
    "formaction",
    "href",
    "poster",
    "src",
  ]);
  for (const { element } of elementRecords(document)) {
    const location = element.sourceCodeLocation;
    const httpEquiv = element.attrs
      .find((attribute) => attribute.name === "http-equiv")
      ?.value.trim()
      .toLowerCase();
    const removeElement =
      element.tagName === "script" ||
      element.tagName === "base" ||
      element.tagName === "iframe" ||
      element.tagName === "object" ||
      element.tagName === "embed" ||
      (element.tagName === "meta" &&
        (httpEquiv === "content-security-policy" || httpEquiv === "refresh"));
    if (removeElement) {
      if (location) {
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          text: "",
        });
      }
      continue;
    }
    for (const attribute of element.attrs) {
      const name = attribute.name.toLowerCase();
      const dangerous =
        name.startsWith("on") ||
        name === "srcdoc" ||
        (urlAttributes.has(name) && activeUrl(attribute.value));
      if (!dangerous) continue;
      // parse5 decodes namespace-qualified attributes (`xlink:href`) to
      // name="href", prefix="xlink", while its location map retains the raw
      // qualified spelling. Check that spelling first so active SVG links are
      // removed from the exact authored range too.
      const qualifiedName = attribute.prefix
        ? `${attribute.prefix}:${attribute.name}`
        : attribute.name;
      const attributeLocation =
        location?.attrs?.[qualifiedName] ?? location?.attrs?.[attribute.name];
      if (!attributeLocation) continue;
      edits.push({
        start: attributeRemovalStart(source, attributeLocation.startOffset),
        end: attributeLocation.endOffset,
        text: "",
      });
    }
  }
  return applyDesignSourceEdits(source, edits);
}

export function createDesignRuntimeScript(sourceVersion: string): {
  markup: string;
  cspSource: string;
} {
  const body =
    `window.__zerosDesignSourceVersion=${JSON.stringify(sourceVersion)};` +
    DESIGN_RUNTIME_SOURCE;
  const digest = createHash("sha256").update(body).digest("base64");
  return {
    markup: `<script data-zeros-design-runtime>${body}</script>`,
    cspSource: `'sha256-${digest}'`,
  };
}

export function insertDesignRuntimeScript(
  source: string,
  sourceVersion: string,
): { html: string; cspSource: string } {
  const runtime = createDesignRuntimeScript(sourceVersion);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = elementRecords(document);
  const body = records.find(
    ({ element }) => element.tagName === "body",
  )?.element;
  const html = records.find(
    ({ element }) => element.tagName === "html",
  )?.element;
  const insertAt =
    body?.sourceCodeLocation?.endTag?.startOffset ??
    html?.sourceCodeLocation?.endTag?.startOffset ??
    source.length;
  return {
    html: `${source.slice(0, insertAt)}${runtime.markup}${source.slice(insertAt)}`,
    cspSource: runtime.cspSource,
  };
}

function insertDesignHeadMarkup(source: string, markup: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const head = elementRecords(document).find(
    ({ element }) => element.tagName === "head",
  )?.element;
  const insertAt = head?.sourceCodeLocation?.startTag?.endOffset;
  return insertAt === undefined
    ? `${markup}${source}`
    : `${source.slice(0, insertAt)}${markup}${source.slice(insertAt)}`;
}

async function prepareFrameRenderSource(
  workspacePath: string,
  source: string,
  viewport: { width: number; height: number },
): Promise<{ sanitized: string; sourceVersion: string }> {
  assertRenderByteLimit(
    source,
    MAX_DESIGN_TEXT_BYTES,
    "Authored frame HTML exceeded the 2 MiB source limit.",
  );
  const expanded = await expandDesignComponents(workspacePath, source);
  assertRenderByteLimit(
    expanded.html,
    MAX_SANITIZED_RENDER_BYTES,
    "Expanded components exceeded the 15 MiB per-frame render limit.",
  );
  const withStyles = await inlineLocalStyles(workspacePath, expanded.html);
  const inlined = await inlineLocalAssets(workspacePath, withStyles);
  const sanitized = stripNonDesignOidsForRender(
    sanitizeDesignFrameMarkup(inlined),
  );
  assertRenderByteLimit(
    sanitized,
    MAX_SANITIZED_RENDER_BYTES,
    "Sanitized frame HTML exceeded the 15 MiB per-frame render limit.",
  );
  const sourceVersion = createHash("sha256")
    .update(sanitized)
    .update("\0")
    .update(`${viewport.width}x${viewport.height}`)
    .digest("hex")
    .slice(0, 24);
  return { sanitized, sourceVersion };
}

async function prepareFrameRenderSourceForFile(
  workspacePath: string,
  file: string,
  source: string,
): Promise<{
  document: DefaultTreeAdapterTypes.Document;
  meta: FrameMeta;
  width: number;
  height: number;
  x: number;
  y: number;
  sanitized: string;
  sourceVersion: string;
}> {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const meta = readFrameMeta(document, file);
  const geometry = (await readCanvas(workspacePath)).frames[file];
  const width = geometry?.w ?? meta.width;
  const height = geometry?.h ?? meta.height;
  const render = await prepareFrameRenderSource(workspacePath, source, {
    width,
    height,
  });
  return {
    document,
    meta,
    width,
    height,
    x: geometry?.x ?? 0,
    y: geometry?.y ?? 0,
    ...render,
  };
}

async function composeFrameSrcDoc(
  workspacePath: string,
  source: string,
  viewport: { width: number; height: number },
): Promise<{ sourceVersion: string; srcDoc: string }> {
  const { sanitized, sourceVersion } = await prepareFrameRenderSource(
    workspacePath,
    source,
    viewport,
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

/** Hash the exact frame bytes already obtained from a verified descriptor. */
export async function readDesignFrameRenderIdentityFromSource(
  workspacePath: string,
  frame: string,
  source: string,
): Promise<DesignFrameRenderIdentity> {
  const file = assertFrameFile(frame);
  const render = await prepareFrameRenderSourceForFile(
    workspacePath,
    file,
    source,
  );
  return { file, sourceVersion: render.sourceVersion };
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
  const document = parse(source, { sourceCodeLocationInfo: true });
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
  const writeBack = options.writeBack !== false;
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

function safeLocalReference(
  directory: string,
  reference: string,
): string | null {
  const clean = reference.trim();
  if (!clean || clean.startsWith("#")) return null;
  if (
    clean.startsWith("/") ||
    clean.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(clean)
  ) {
    return null;
  }
  const withoutQuery = clean.split(/[?#]/, 1)[0] ?? "";
  const resolved = path.resolve(directory, withoutQuery);
  return resolved.startsWith(`${path.resolve(directory)}${path.sep}`)
    ? resolved
    : null;
}

/** Read only a regular file whose canonical target stays under the canonical
 * design directory. This rejects both direct symlinks and symlinked parent
 * directories, so renderer/MCP reads cannot turn a local CSS reference into a
 * host-filesystem disclosure. */
async function readSafeDesignText(
  directory: string,
  target: string,
): Promise<string | null> {
  const safe = await readSafeRegularFile(
    directory,
    target,
    MAX_DESIGN_TEXT_BYTES,
  );
  return safe?.body.toString("utf8") ?? null;
}

async function readSafeDesignBuffer(
  directory: string,
  target: string,
): Promise<Buffer | null> {
  return (
    (await readSafeRegularFile(directory, target, MAX_ASSET_BYTES))?.body ??
    null
  );
}

async function safeDesignFileMetadata(
  directory: string,
  target: string,
): Promise<{ size: number; modifiedAt: number } | null> {
  return inspectSafeRegularFile(directory, target, MAX_ASSET_BYTES);
}

/** Discover a bounded, symlink-free image catalog under assets/. Every path is
 * relative to the design directory so bridge and MCP callers never receive a
 * host path. Small previews are embedded once in the shared workspace snapshot. */
export async function listDesignAssets(
  workspacePath: string,
): Promise<DesignAssetSummary[]> {
  const directory = designDirectory(workspacePath);
  const assetsDirectory = path.join(directory, "assets");
  const files: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_ASSET_DEPTH || files.length >= MAX_DESIGN_ASSETS) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (files.length >= MAX_DESIGN_ASSETS) break;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (
        entry.isFile() &&
        DESIGN_ASSET_MIME_TYPES[path.extname(entry.name).toLowerCase()]
      ) {
        files.push(target);
      }
    }
  };
  await visit(assetsDirectory, 0);

  const summaries: DesignAssetSummary[] = [];
  let previewBytes = 0;
  for (const target of files) {
    const mimeType =
      DESIGN_ASSET_MIME_TYPES[path.extname(target).toLowerCase()];
    if (!mimeType) continue;
    const info = await safeDesignFileMetadata(directory, target);
    if (!info) continue;
    let dataUrl: string | null = null;
    if (
      info.size <= MAX_ASSET_PREVIEW_BYTES &&
      previewBytes + info.size <= MAX_ASSET_PREVIEW_TOTAL_BYTES
    ) {
      const data = await readSafeDesignBuffer(directory, target);
      if (!data) continue;
      previewBytes += data.length;
      dataUrl = `data:${mimeType};base64,${data.toString("base64")}`;
    }
    const relative = path.relative(directory, target).split(path.sep).join("/");
    summaries.push({
      path: relative,
      name: path.basename(target),
      mimeType,
      size: info.size,
      modifiedAt: info.modifiedAt,
      dataUrl,
    });
  }
  return summaries;
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
      await writeFile(target, source, "utf8");
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
  frame: `One top-level .html file is one frame. Include a zeros-frame meta tag, link ./tokens.css, and keep the body as the design. Give every rendered element inside body a stable unique data-oid, but leave html, head, body, meta, link, title, style, script, and template as non-selectable document plumbing.`,
  layout: `Use normal HTML flow and flexbox for structural layout. Prefer flex containers, gap, padding, alignment, and intrinsic sizing over absolute positioning inside a frame.`,
  tokens: `Use var(--token) from tokens.css whenever a matching color, spacing, radius, or type token exists. Add typed @property declarations before introducing a new token.`,
  workflow: `Inspect the live element selection and frames and make targeted HTML/CSS edits only under Zeros Design/. Call lint_design, re-read the affected frame, use screenshot_frame to visually verify it, then call lint_design again so exact-generation browser contrast, overflow, and spacing checks are included. Resolve errors and review non-blocking advisories. JavaScript and external URLs are not part of design documents.`,
  components: `Define a reusable component as one direct components/name.html file and instantiate it with <zd-name data-oid="stable-instance">. Give every selectable definition-body element except <slot> a unique, stable data-zid, for example <article data-zid="surface">. The definition body expands only at render time; <slot> accepts instance children and <slot data-zd-attr="label"> accepts escaped attributes. Keep scripts, event handlers, external URLs, and data-oid attributes out of definitions—the authored zd-* wrapper owns selection and editing. Legacy definitions with no data-zid remain renderable, but new component.create operations require complete definition-local identity.`,
});

export type DesignGuideTopic = keyof typeof DESIGN_GUIDES;
