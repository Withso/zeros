import { type DesignAssetSummary } from "./assets";
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
//   Zeros Design/design.toml  stable identity, frame and Foundation metadata
//   Zeros Design/rules.md     short Design API ownership instructions
//
// This module is the single engine-side interpretation of that format. The
// renderer and first-party MCP server both consume these functions, so frame
// discovery, OID healing, constraints, and token parsing cannot drift.

import { type DesignFoundationManifest } from "@zeros/design-core";
import { type DesignMetadataSnapshot } from "./metadata";






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
  metadata?: Pick<FrameMeta, "title" | "kind">;
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

export interface DesignReadOptions {
  /** Local canvas/MCP reads may heal OIDs and persist auto-placement. Remote
   * reads are strictly observational and pass false at the service boundary. */
  writeBack?: boolean;
}

export const canvasReadSnapshot = Symbol("canvasReadSnapshot");
export interface CanvasDocument {
  [canvasReadSnapshot]?: DesignMetadataSnapshot;
  version: 3;
  frames: Record<string, DesignFrameGeometry>;
  frame_info: Record<string, Pick<FrameMeta, "title" | "kind">>;
  foundation: DesignFoundationManifest;
  view?: {
    x: number;
    y: number;
    zoom: number;
  };
}

export interface FrameMeta {
  title: string;
  width: number;
  height: number;
  kind: "frame" | "text";
}

export type DesignStyleMutationValue = string | null;

export interface DesignFrameMutationInput {
  frame: string;
  nodeId: string;
  sourceVersion: string;
}

export interface InlineStyleDeclaration {
  property: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

export interface DesignTransactionJournal {
  version: 1;
  documentId: string;
  entryFile: string;
  nextRevision: string;
  files: Array<{ file: string; content: string | null }>;
  foundation: DesignFoundationManifest;
  geometry: DesignFrameGeometry;
  /** New journals compare every changed source before replaying across restarts. */
  before?: Record<string, string | null>;
  canvasBeforeHash?: string;
  canvasAfterHash?: string;
}

export interface DesignFrameChange {
  before: DesignFrameRestorePoint | null;
  after: DesignFrameRestorePoint | null;
}
