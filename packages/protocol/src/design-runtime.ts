// ──────────────────────────────────────────────────────────
// Design iframe runtime protocol
// ──────────────────────────────────────────────────────────
//
// Design frames execute in an opaque sandbox. This file is the one shared
// contract between the engine that injects the runtime and the renderer that
// speaks to it. Authored design files remain HTML/CSS-only: the script below is
// app-owned, nonce-gated, and removed from every screenshot clone.

import { DESIGN_RELOCATION_INHERITED_PROPERTIES, DESIGN_RELOCATION_MAX_INHERITED_STYLES, type DesignRuntimeRelocationContext } from "./design-relocation";
import { DESIGN_STILL_TIMELINES_SOURCE } from "./design-capture";

export const DESIGN_RUNTIME_PROTOCOL = "zeros-design-runtime";
export const DESIGN_RUNTIME_VERSION = 2;
/** Mirrors design-core's document-scoped style/append target. Never emitted as
 * a data-oid: the HTML body is document plumbing, not an authored layer. */
export const DESIGN_RUNTIME_DOCUMENT_BODY_ID = "::zeros-document-body";
/** Shared renderer/engine bound for one additive design selection. */
export const DESIGN_SELECTION_NODE_LIMIT = 32;
export const DESIGN_RUNTIME_AUDIT_WARNING_LIMIT = 128;
export const DESIGN_RUNTIME_TREE_NODE_LIMIT = 20000;
export const DESIGN_RUNTIME_TREE_DEPTH_LIMIT = 64;
/** Reserve one operation for the container in a 256-operation transaction. */
export const DESIGN_LAYOUT_CHILD_LIMIT = 255;
/** Computed snapshots mirror a fixed, app-owned style catalog. Leave bounded
 * headroom for new editor fields without invalidating otherwise-valid ready
 * events whenever that catalog crosses an arbitrary power-of-two boundary. */
const DESIGN_RUNTIME_STYLE_SNAPSHOT_LIMIT = 256;

export type DesignRuntimeErrorCode =
  | "BAD_REQUEST"
  | "SOURCE_VERSION_MISMATCH"
  | "METHOD_NOT_SUPPORTED"
  | "NODE_NOT_FOUND"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface DesignRuntimeError {
  code: DesignRuntimeErrorCode;
  message: string;
  retryable: boolean;
}

export interface DesignRuntimeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignRuntimeTreeNode {
  oid: string;
  tag: string;
  name: string;
  /** Explicit authored data-name, distinct from the inferred fallback name.
   * Optional so trees from older runtimes remain readable. */
  layerName?: string;
  text: string | null;
  visible: boolean;
  /** Lean computed layout identity used by Layers icons. Optional for runtime
   * compatibility with snapshots produced before this metadata existed. */
  display?: string;
  flexDirection?: string;
  /** Present on layers rendered inside an open shadow root (for example a
   * declarative `<template shadowrootmode>`); omitted for ordinary layers. */
  shadow?: true;
  children: DesignRuntimeTreeNode[];
}

export interface DesignRuntimeTextSizing {
  /** The authored/computed inline sizing behavior, before CSSOM resolves it
   * into the current pixel width. */
  width: "fixed" | "auto" | "min-content" | "max-content" | "fit-content";
  /** Whether content can change the element's block size. */
  height: "fixed" | "auto";
  /** Content-box room supplied by the current containing block. */
  availableWidth: number;
}

export type DesignRuntimeHitMode =
  | "top-level"
  | "deepest"
  | "preserve"
  | "descend";

/** Geometry that survives a CSS transform chain. `rect` is the painted
 * axis-aligned bounding box, which stops describing the element the moment
 * anything on or above it rotates: a rotated square reports a larger upright
 * rectangle. This box keeps the element's own unrotated border box, the
 * accumulated rotation and scale that place it on screen, and the pivot that
 * future rotations turn about, so an editor can draw and manipulate the shape
 * the user actually sees.
 *
 * Chains built from translation, z-rotation, and nonzero scale are exact.
 * Mirroring reports an equivalent positively oriented border box.
 * Skew and 3D transforms report `rotation: 0` with the
 * axis-aligned `rect` position, because no rotated rectangle describes them.
 */
export interface DesignRuntimeNodeBox {
  /** Frame-space position of the border box's top-left corner after the whole
   * transform chain places it — the image of the box's own origin, not the
   * bounding box's corner. */
  x: number;
  y: number;
  /** Untransformed border-box size in layout pixels. */
  width: number;
  height: number;
  /** Accumulated rotation in CSS degrees, normalized to (-180, 180]. */
  rotation: number;
  /** Accumulated axis scale; both are 1 unless the chain scales this element. */
  scaleX: number;
  scaleY: number;
  /** `transform-origin` as a fraction of the border box (0.5 is the center).
   * Values outside 0–1 are legitimate: an origin may sit outside the box. */
  originX: number;
  originY: number;
}

/** Untransformed border-box position in the immediate parent's padding box.
 * Optional on older runtimes. Read with the inspector snapshot, never by the
 * host's pointer handlers. */
export interface DesignRuntimeNodeLayout {
  x: number;
  y: number;
  parentId: string | null;
  parentWidth: number;
  parentHeight: number;
  parentDisplay: string;
  parentPosition: string;
  /** Inspector-only context. Optional for compatibility with older runtimes. */
  parentFlexDirection?: string;
  parentAlignItems?: string;
  parentJustifyItems?: string;
  /** Computed CSS before used-value resolution turns intrinsic sizes into px. */
  widthValue?: string;
  heightValue?: string;
  isContainingBlock: boolean;
  /** For `position: fixed`: the parent, a further ancestor, or the viewport
   * positions the box. Omitted by older runtimes and for other positions. */
  fixedContainingBlock?: "parent" | "ancestor" | "viewport";
}

export interface DesignRuntimeChildrenLayout {
  /** All direct authored children, including hidden layers. */
  count: number;
  /** Visible HTML children with a layout box. Never includes grandchildren. */
  nodeIds: string[];
  x: "start" | "center" | "end" | "stretch" | "mixed";
  y: "start" | "center" | "end" | "stretch" | "mixed";
  truncated: boolean;
}

export interface DesignRuntimeNodeDetails {
  sourceVersion: string;
  oid: string;
  tag: string;
  name: string;
  text: string | null;
  /** True only when replacing this node's text cannot discard child layers. */
  textEditable?: boolean;
  /** Intrinsic sizing survives the iframe-to-host editing handoff. Older
   * runtimes omit this and the editor safely falls back to fixed geometry. */
  textSizing?: DesignRuntimeTextSizing;
  selector: string;
  visible: boolean;
  breadcrumb: string[];
  rect: DesignRuntimeRect;
  /** Transform-aware geometry. Omitted by older runtimes; the editor then
   * falls back to the axis-aligned `rect`. */
  box?: DesignRuntimeNodeBox;
  layout?: DesignRuntimeNodeLayout;
  /** A bounded aggregate for container controls; omitted by older runtimes. */
  childrenLayout?: DesignRuntimeChildrenLayout;
  /** Affine map from the children's padding-box coordinates to frame space.
   * Includes ancestor transforms, reflections, borders, and container scroll. */
  childCoordinateSpace?: [number, number, number, number, number, number];
  borderCoordinateSpace?: DesignRuntimeCoordinateSpace | null;
  parentCoordinateSpace?: DesignRuntimeCoordinateSpace | null;
  relocationContext?: DesignRuntimeRelocationContext;
  styles: Record<string, string>;
  /** Computed-style keys with a direct active declaration on this element.
   * Omitted by older runtimes; inspector chrome treats omission as unknown. */
  authoredStyleProperties?: string[];
  /** The cascade's winning declaration for each authored property, as written
   * (`var(--primary-button-bg)`), where it comes from, and the tokens it reads.
   * Omitted by older runtimes and for any property whose winner is ambiguous
   * (for example a shorthand partly overridden by a longhand); the inspector
   * then shows the computed value, as before. */
  authoredStyles?: Record<string, DesignRuntimeAuthoredStyle>;
  /** Present when the node renders inside an open shadow root. */
  shadow?: true;
  /** The element's authored class attribute, bounded; omitted when absent and
   * by older runtimes. */
  classes?: string;
}

/** Where a winning declaration lives in the rendered frame document. */
export interface DesignRuntimeStyleOrigin {
  /** `source`: an imported style source; `linked`: a Design stylesheet the
   * frame links (tokens.css, a page stylesheet); `frame`: the frame's own
   * `<style>`; `inline`: the element's `style` attribute. */
  origin: "source" | "linked" | "frame" | "inline";
  /** Imported style source id, for `source`. */
  sourceId?: string;
  /** Design-root-relative stylesheet, for `linked`. */
  file?: string;
}

/** A custom property a winning value reads, with its resolved value and the
 * winning declaration on the nearest element that sets it. */
export interface DesignRuntimeStyleToken extends Partial<DesignRuntimeStyleOrigin> {
  name: string;
  value: string;
}

export interface DesignRuntimeAuthoredStyle extends DesignRuntimeStyleOrigin {
  value: string;
  important?: boolean;
  tokens?: DesignRuntimeStyleToken[];
}

export const DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS = {
  properties: 128,
  value: 1024,
  tokensPerValue: 8,
  tokenValue: 256,
} as const;

const STYLE_ORIGINS = new Set(["source", "linked", "frame", "inline"]);

function isRuntimeStyleOrigin(
  value: Record<string, unknown>,
  required: boolean,
): boolean {
  if (value.origin === undefined) return !required;
  return (
    typeof value.origin === "string" &&
    STYLE_ORIGINS.has(value.origin) &&
    (value.sourceId === undefined ||
      (typeof value.sourceId === "string" && value.sourceId.length <= 64)) &&
    (value.file === undefined ||
      (typeof value.file === "string" && value.file.length <= 256))
  );
}

/** Validate `DesignRuntimeNodeDetails.authoredStyles` at a trust boundary. */
export function isDesignRuntimeAuthoredStyles(
  value: unknown,
): value is Record<string, DesignRuntimeAuthoredStyle> {
  return isRuntimeAuthoredStyles(value);
}

function isRuntimeAuthoredStyles(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.properties)
    return false;
  return entries.every(([property, style]) => {
    if (
      property.length > 64 ||
      !/^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property) ||
      !isRecord(style) ||
      typeof style.value !== "string" ||
      style.value.length > DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.value ||
      (style.important !== undefined && typeof style.important !== "boolean") ||
      !isRuntimeStyleOrigin(style, true)
    )
      return false;
    if (style.tokens === undefined) return true;
    return (
      Array.isArray(style.tokens) &&
      style.tokens.length <= DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.tokensPerValue &&
      style.tokens.every(
        (token) =>
          isRecord(token) &&
          typeof token.name === "string" &&
          /^--[A-Za-z0-9_-]{1,126}$/.test(token.name) &&
          typeof token.value === "string" &&
          token.value.length <= DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.tokenValue &&
          isRuntimeStyleOrigin(token, false),
      )
    );
  });
}

/** Direct children a gesture measures alongside their container. */
export interface DesignRuntimeChildGeometry {
  oid: string;
  rect: DesignRuntimeRect;
  /** Untransformed border box in the container's padding-box coordinates.
   * Sent only while the container is turned or scaled, where the frame-space
   * `rect` is a bounding box rather than the child's own box. */
  local?: DesignRuntimeRect;
  /** `visibility: hidden` keeps an item's layout slot without painting it; it
   * still separates its neighbors, so it stays in the geometry. */
  hidden?: boolean;
  /** Same layer name the tree and details report, so an affordance drawn
   * between two children can still say which two. */
  name: string;
  /** Keyed exactly like `DesignRuntimeNodeDetails.styles`, so a paint helper
   * reads a child the same way whichever call produced it. */
  styles: Record<string, string>;
}

/** The narrow geometry one frame of direct manipulation needs.
 *
 * `getNodeDetails` and `previewStyles` answer with the element's whole computed
 * style catalog plus its authored-property provenance and text — the right
 * payload for an inspector, and the wrong one for a pointer. A drag repaints one
 * outline, four padding hatches, and the gap handles; asking for everything else
 * sixty times a second is what makes the element trail the overlay that
 * describes it. This carries exactly what those paints read, measured in the
 * same task the styles were applied in, so there is no animation frame between
 * the write and the answer. */
export interface DesignRuntimeNodeGeometry {
  sourceVersion: string;
  oid: string;
  rect: DesignRuntimeRect;
  box: DesignRuntimeNodeBox;
  borderCoordinateSpace?: DesignRuntimeCoordinateSpace | null;
  parentCoordinateSpace?: DesignRuntimeCoordinateSpace | null;
  styles: Record<string, string>;
  /** Populated only when the caller asked for children (gap affordances). */
  children: DesignRuntimeChildGeometry[];
}

export type DesignRuntimeCoordinateSpace = [number, number, number, number, number, number];

export function isDesignRuntimeCoordinateSpace(value: unknown): value is DesignRuntimeCoordinateSpace {
  return Array.isArray(value) && value.length === 6 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** Children one geometry response may describe. Gap handles are drawn between
 * adjacent siblings, so a container with more than this is already past the
 * point where individual affordances are usable. */
export const DESIGN_RUNTIME_GEOMETRY_CHILD_LIMIT = 64;

export interface DesignRuntimeWarning {
  ruleId:
    | "contrast"
    | "overflow"
    | "spacing-scale"
    | "audit-limit"
    | "layer-tree-limit";
  message: string;
  oid: string;
  fix: string;
}

export interface DesignRuntimeSnapshot {
  sourceVersion: string;
  revision: number;
  tree: DesignRuntimeTreeNode[];
  frame: DesignRuntimeNodeDetails;
  warnings: DesignRuntimeWarning[];
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
}

export interface DesignRuntimeScreenshot {
  sourceVersion: string;
  dataUrl: string;
  mimeType: "image/png";
  width: number;
  height: number;
  scale: number;
  nodeId: string | null;
}

export interface DesignRuntimeMatchedDeclaration {
  property: string;
  value: string;
  important: boolean;
  selector?: string;
  sourceFile?: string;
  inherited: boolean;
  active: boolean;
}

export interface DesignRuntimeMatchedStyles {
  sourceVersion: string;
  nodeId: string;
  property: string;
  computedValue: string;
  matched: DesignRuntimeMatchedDeclaration[];
  truncated: boolean;
}

export interface DesignRuntimeMotionKeyframe {
  offset: number;
  styles: Record<string, string>;
}

export interface DesignRuntimeMotionPreview {
  keyframes: DesignRuntimeMotionKeyframe[];
  duration: number;
  delay: number;
  easing: string;
  iterations: number;
  direction: "normal" | "reverse" | "alternate" | "alternate-reverse";
  fill: "none" | "forwards" | "backwards" | "both";
  currentTime: number;
  playing: boolean;
}

export interface DesignRuntimeStyleUpdate {
  nodeId: string;
  styles: Record<string, string | null>;
}

/** Engine-confirmed @keyframes mirrored into an already-painted document. */
export interface DesignRuntimeKeyframesUpdate {
  name: string;
  keyframes: Array<{
    /** CSS keyframe percentage in the inclusive 0–100 range. */
    offset: number;
    styles: Record<string, string>;
  }>;
}

/** One base or named-mode custom-property declaration. */
export interface DesignRuntimeTokenUpdate {
  name: string;
  theme: string | null;
  value: string;
}

/** Non-element CSS changes that can be adopted without document navigation. */
export interface DesignRuntimeNodeMove {
  nodeId: string;
  parentId: string;
  beforeId: string | null;
}

export interface DesignRuntimeLayoutPreview {
  /** Paint is handed to a cached canvas image while this layer crosses frames. */
  suppressNodeId?: string | null;
  /** Dragging a layer only needs that layer's box; gap tools request children. */
  children?: boolean;
  updates: DesignRuntimeStyleUpdate[];
  nodeIds: string[];
  moves?: DesignRuntimeNodeMove[];
  cancelMoves?: boolean;
}

/** A host-authored layer the engine appends to an existing parent (a frame
 * drawn inside a frame). The runtime builds the element from these fields
 * only; it never parses markup. */
export interface DesignRuntimeNodeInsert {
  nodeId: string;
  parentId: string;
  /** Null appends at the parent's end, exactly where the source edit lands. */
  beforeId: string | null;
  tag: "div";
  /** The element's complete inline style attribute, as authored. */
  style: string;
}

export interface DesignRuntimeInsertPreview {
  inserts: DesignRuntimeNodeInsert[];
  /** Parent styles the same transaction writes (a static parent becomes
   * `position: relative`). */
  updates?: DesignRuntimeStyleUpdate[];
}

export interface DesignRuntimeInsertPreviewResult {
  snapshot: DesignRuntimeSnapshot;
  details: DesignRuntimeNodeDetails[];
}

export interface DesignRuntimeGenerationPatch {
  moves?: DesignRuntimeNodeMove[];
  keyframes?: DesignRuntimeKeyframesUpdate[];
  tokens?: DesignRuntimeTokenUpdate[];
  /** Opt-in (`previewInsert`): structural appends adopted in place. */
  inserts?: DesignRuntimeNodeInsert[];
  /** Opt-in (`commitStructure`): engine-confirmed subtree edits. */
  structure?: DesignRuntimeStructureOperation[];
  structurePreviewId?: string;
}

export type DesignRuntimeStructureOperation =
  | { type: "duplicate"; nodeId: string; duplicateNodeId: string }
  | { type: "delete"; nodeId: string };

export interface DesignRuntimeStructurePreview {
  previewId: string;
  operations: DesignRuntimeStructureOperation[];
}

export interface DesignRuntimeStructurePreviewResult {
  sourceVersion: string;
  details: DesignRuntimeNodeDetails[];
}

/** Result of adopting an engine-confirmed visual generation in-place. */
export interface DesignRuntimeStyleCommit {
  sourceVersion: string;
  /** True when the lightweight wire snapshot intentionally omits its tree. */
  treeUnchanged: boolean;
  snapshot: DesignRuntimeSnapshot;
  details: DesignRuntimeNodeDetails[];
}

export type DesignRuntimeMethod =
  | "getSnapshot"
  | "getElementAtLoc"
  | "getElementsInRect"
  | "getNodeDetails"
  | "getMatchedStyles"
  | "setNodeVisibility"
  | "setTheme"
  | "previewStyles"
  | "getLayoutTargets"
  | "previewLayout"
  | "restoreGeneration"
  | "previewHistory"
  | "previewGeometry"
  | "commitStyles"
  | "commitStructure"
  | "previewStructure"
  | "clearPreviewStructure"
  | "previewText"
  | "clearPreviewText"
  | "previewMotion"
  | "clearPreviewStyles"
  | "captureScreenshot"
  /** Opt-in: advertised only to a host whose handshake requests it. */
  | "previewStylesheet"
  | "setPlayback"
  | "previewInsert"
  | "clearPreviewInserts";

/** Methods a runtime advertises only when the host's handshake lists them
 * in `features`, so a host that predates them still accepts the runtime's
 * capabilities. */
export const DESIGN_RUNTIME_OPT_IN_METHODS = ["previewStylesheet", "setPlayback", "previewInsert", "clearPreviewInserts", "previewHistory", "commitStructure", "previewStructure", "clearPreviewStructure"] as const;

export interface DesignRuntimePlaybackStopped {
  sourceVersion: string;
  sessionId: string;
  reason: "escape" | "hidden";
}

/** Largest in-flight stylesheet text `previewStylesheet` applies. */
export const MAX_DESIGN_RUNTIME_PREVIEW_STYLESHEET_CHARS = 4 * 1024 * 1024;

/** A linked Design stylesheet's in-flight text, applied in place of its
 * inlined copy in this document generation. */
export interface DesignRuntimeStylesheetPreviewResult {
  /** Inlined copies of the stylesheet this document links (0 when none). */
  applied: number;
  snapshot: DesignRuntimeSnapshot;
}

export interface DesignRuntimeCapabilities {
  methods: DesignRuntimeMethod[];
  cancellation: true;
  /** Capture cancellation responds only after decode/encoding cleanup. */
  captureCompletion?: true;
  typedErrors: true;
  sourcePinned: true;
  maxStyleProperties: number;
  maxMatchedDeclarations: number;
  maxCapturePixels: number;
}

export interface DesignRuntimeReadyPayload {
  sourceVersion: string;
  capabilities: DesignRuntimeCapabilities;
  snapshot: DesignRuntimeSnapshot;
}

const DESIGN_RUNTIME_ERROR_CODES = new Set<DesignRuntimeErrorCode>([
  "BAD_REQUEST",
  "SOURCE_VERSION_MISMATCH",
  "METHOD_NOT_SUPPORTED",
  "NODE_NOT_FOUND",
  "CANCELLED",
  "INTERNAL_ERROR",
]);

const DESIGN_RUNTIME_METHODS = new Set<DesignRuntimeMethod>([
  "getSnapshot",
  "getElementAtLoc",
  "getElementsInRect",
  "getNodeDetails",
  "getMatchedStyles",
  "setNodeVisibility",
  "setTheme",
  "previewStyles",
  "getLayoutTargets",
  "previewLayout",
  "restoreGeneration",
  "previewHistory",
  "previewGeometry",
  "commitStyles",
  "commitStructure",
  "previewStructure",
  "clearPreviewStructure",
  "previewText",
  "clearPreviewText",
  "previewMotion",
  "clearPreviewStyles",
  "captureScreenshot",
  "previewStylesheet",
  "setPlayback",
  "previewInsert",
  "clearPreviewInserts",
]);

export interface DesignRuntimeHostRequest {
  protocol: typeof DESIGN_RUNTIME_PROTOCOL;
  version: typeof DESIGN_RUNTIME_VERSION;
  type: "request";
  sourceVersion: string;
  requestId: string;
  method: DesignRuntimeMethod;
  args: Record<string, unknown>;
}

export interface DesignRuntimeHostHandshake {
  protocol: typeof DESIGN_RUNTIME_PROTOCOL;
  version: typeof DESIGN_RUNTIME_VERSION;
  type: "handshake";
  sourceVersion: string;
  /** Opt-in methods this host understands; older runtimes ignore it. */
  features?: Array<(typeof DESIGN_RUNTIME_OPT_IN_METHODS)[number]>;
}

export interface DesignRuntimeHostCancel {
  protocol: typeof DESIGN_RUNTIME_PROTOCOL;
  version: typeof DESIGN_RUNTIME_VERSION;
  type: "cancel";
  sourceVersion: string;
  requestId: string;
}

export interface DesignRuntimeHostTeardown {
  protocol: typeof DESIGN_RUNTIME_PROTOCOL;
  version: typeof DESIGN_RUNTIME_VERSION;
  type: "teardown";
  sourceVersion: string;
}

export type DesignRuntimeHostMessage =
  | DesignRuntimeHostRequest
  | DesignRuntimeHostCancel
  | DesignRuntimeHostTeardown;

export type DesignRuntimeFrameMessage =
  | {
      protocol: typeof DESIGN_RUNTIME_PROTOCOL;
      version: typeof DESIGN_RUNTIME_VERSION;
      type: "response";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocol: typeof DESIGN_RUNTIME_PROTOCOL;
      version: typeof DESIGN_RUNTIME_VERSION;
      type: "response";
      requestId: string;
      ok: false;
      error: DesignRuntimeError;
    }
  | {
      protocol: typeof DESIGN_RUNTIME_PROTOCOL;
      version: typeof DESIGN_RUNTIME_VERSION;
      type: "event";
      event: "ready";
      payload: DesignRuntimeReadyPayload;
    }
  | {
      protocol: typeof DESIGN_RUNTIME_PROTOCOL;
      version: typeof DESIGN_RUNTIME_VERSION;
      type: "event";
      event: "mutation";
      payload: DesignRuntimeSnapshot;
    }
  | {
      protocol: typeof DESIGN_RUNTIME_PROTOCOL;
      version: typeof DESIGN_RUNTIME_VERSION;
      type: "event";
      /** Sent only after an opted-in host starts a playback session. */
      event: "playbackStopped";
      payload: DesignRuntimePlaybackStopped;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSourceVersion(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRuntimeRect(value: unknown): value is DesignRuntimeRect {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
}

function isRuntimeNodeBox(value: unknown): value is DesignRuntimeNodeBox {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isFiniteNumber(value.rotation) &&
    Math.abs(value.rotation as number) <= 180 &&
    isFiniteNumber(value.scaleX) &&
    (value.scaleX as number) > 0 &&
    isFiniteNumber(value.scaleY) &&
    (value.scaleY as number) > 0 &&
    isFiniteNumber(value.originX) &&
    isFiniteNumber(value.originY)
  );
}

function isRuntimeTextSizing(value: unknown): value is DesignRuntimeTextSizing {
  if (!isRecord(value)) return false;
  return (
    ["fixed", "auto", "min-content", "max-content", "fit-content"].includes(
      String(value.width),
    ) &&
    (value.height === "fixed" || value.height === "auto") &&
    isFiniteNumber(value.availableWidth) &&
    value.availableWidth >= 0 &&
    value.availableWidth <= 100_000
  );
}

export function isRuntimeNodeLayout(
  value: unknown,
): value is DesignRuntimeNodeLayout {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    (value.parentId === null ||
      (typeof value.parentId === "string" && value.parentId.length <= 256)) &&
    isFiniteNumber(value.parentWidth) &&
    value.parentWidth >= 0 &&
    isFiniteNumber(value.parentHeight) &&
    value.parentHeight >= 0 &&
    typeof value.parentDisplay === "string" &&
    typeof value.parentPosition === "string" &&
    [
      "parentFlexDirection",
      "parentAlignItems",
      "parentJustifyItems",
      "widthValue",
      "heightValue",
    ].every(
      (key) =>
        value[key] === undefined ||
        (typeof value[key] === "string" && value[key].length <= 1024),
    ) &&
    typeof value.isContainingBlock === "boolean"
  );
}

function isRuntimeChildrenLayout(
  value: unknown,
): value is DesignRuntimeChildrenLayout {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.count) &&
    (value.count as number) >= 0 &&
    Array.isArray(value.nodeIds) &&
    value.nodeIds.length <= DESIGN_LAYOUT_CHILD_LIMIT &&
    value.nodeIds.length <= (value.count as number) &&
    value.nodeIds.every(
      (oid) => typeof oid === "string" && oid.length > 0 && oid.length <= 256,
    ) &&
    new Set(value.nodeIds).size === value.nodeIds.length &&
    ["start", "center", "end", "stretch", "mixed"].includes(String(value.x)) &&
    ["start", "center", "end", "stretch", "mixed"].includes(String(value.y)) &&
    typeof value.truncated === "boolean"
  );
}

export function isDesignRuntimeRelocationContext(value: unknown): value is DesignRuntimeRelocationContext {
  const boundedStyles = (styles: unknown) => isRecord(styles) && Object.keys(styles).length <= 64 &&
    Object.entries(styles).every(([key, style]) => key.length <= 128 && typeof style === "string" && style.length <= 2048);
  return isRecord(value) && boundedStyles(value.inheritedStyles) &&
    (value.baseStyles === undefined || boundedStyles(value.baseStyles)) &&
    (value.rootStyles === undefined || boundedStyles(value.rootStyles)) &&
    Array.isArray(value.unsupported) && value.unsupported.length <= 8 &&
    value.unsupported.every((reason) => typeof reason === "string" && reason.length <= 256);
}

function isRuntimeNodeDetails(
  value: unknown,
): value is DesignRuntimeNodeDetails {
  if (!isRecord(value) || !isRecord(value.styles)) return false;
  return (
    isSourceVersion(value.sourceVersion) &&
    typeof value.oid === "string" &&
    typeof value.tag === "string" &&
    typeof value.name === "string" &&
    (value.text === null ||
      (typeof value.text === "string" && value.text.length <= 10_000)) &&
    (value.textEditable === undefined ||
      typeof value.textEditable === "boolean") &&
    (value.shadow === undefined || value.shadow === true) &&
    (value.classes === undefined ||
      (typeof value.classes === "string" && value.classes.length <= 1024)) &&
    (value.textSizing === undefined || isRuntimeTextSizing(value.textSizing)) &&
    typeof value.selector === "string" &&
    typeof value.visible === "boolean" &&
    Array.isArray(value.breadcrumb) &&
    value.breadcrumb.length <= 64 &&
    value.breadcrumb.every((part) => typeof part === "string") &&
    isRuntimeRect(value.rect) &&
    (value.box === undefined || isRuntimeNodeBox(value.box)) &&
    (value.layout === undefined || isRuntimeNodeLayout(value.layout)) &&
    (value.childrenLayout === undefined ||
      isRuntimeChildrenLayout(value.childrenLayout)) &&
    (value.childCoordinateSpace === undefined ||
      (Array.isArray(value.childCoordinateSpace) &&
        value.childCoordinateSpace.length === 6 &&
        value.childCoordinateSpace.every(isFiniteNumber))) &&
    (value.borderCoordinateSpace === undefined || value.borderCoordinateSpace === null || isDesignRuntimeCoordinateSpace(value.borderCoordinateSpace)) &&
    (value.parentCoordinateSpace === undefined || value.parentCoordinateSpace === null || isDesignRuntimeCoordinateSpace(value.parentCoordinateSpace)) &&
    (value.relocationContext === undefined || isDesignRuntimeRelocationContext(value.relocationContext)) &&
    Object.keys(value.styles).length <= DESIGN_RUNTIME_STYLE_SNAPSHOT_LIMIT &&
    Object.values(value.styles).every((style) => typeof style === "string") &&
    (value.authoredStyleProperties === undefined ||
      (Array.isArray(value.authoredStyleProperties) &&
        value.authoredStyleProperties.length <= 128 &&
        value.authoredStyleProperties.every(
          (property) => typeof property === "string" && property.length <= 64,
        ))) &&
    (value.authoredStyles === undefined ||
      isRuntimeAuthoredStyles(value.authoredStyles))
  );
}

function isRuntimeTree(value: unknown): value is DesignRuntimeTreeNode[] {
  if (!Array.isArray(value)) return false;
  const pending: Array<{ value: unknown; depth: number }> = value.map(
    (node) => ({
      value: node,
      depth: 0,
    }),
  );
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!isRecord(current.value) || current.depth > DESIGN_RUNTIME_TREE_DEPTH_LIMIT) return false;
    if (
      typeof current.value.oid !== "string" ||
      typeof current.value.tag !== "string" ||
      typeof current.value.name !== "string" ||
      (current.value.layerName !== undefined &&
        (typeof current.value.layerName !== "string" || current.value.layerName.length > 80)) ||
      (current.value.text !== null && typeof current.value.text !== "string") ||
      typeof current.value.visible !== "boolean" ||
      (current.value.display !== undefined &&
        (typeof current.value.display !== "string" ||
          current.value.display.length > 64)) ||
      (current.value.flexDirection !== undefined &&
        (typeof current.value.flexDirection !== "string" ||
          current.value.flexDirection.length > 64)) ||
      (current.value.shadow !== undefined && current.value.shadow !== true) ||
      !Array.isArray(current.value.children)
    ) {
      return false;
    }
    count += 1;
    if (count > DESIGN_RUNTIME_TREE_NODE_LIMIT) return false;
    for (const child of current.value.children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function isRuntimeSnapshot(value: unknown): value is DesignRuntimeSnapshot {
  if (!isRecord(value) || !isRecord(value.viewport)) return false;
  if (
    !isSourceVersion(value.sourceVersion) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isRuntimeTree(value.tree) ||
    !isRuntimeNodeDetails(value.frame) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 128 ||
    !value.warnings.every(
      (warning) =>
        isRecord(warning) &&
        (warning.ruleId === "contrast" ||
          warning.ruleId === "overflow" ||
          warning.ruleId === "spacing-scale" ||
          warning.ruleId === "audit-limit" ||
          warning.ruleId === "layer-tree-limit") &&
        typeof warning.message === "string" &&
        typeof warning.oid === "string" &&
        typeof warning.fix === "string",
    )
  ) {
    return false;
  }
  return (
    isFiniteNumber(value.viewport.width) &&
    isFiniteNumber(value.viewport.height) &&
    isFiniteNumber(value.viewport.scrollX) &&
    isFiniteNumber(value.viewport.scrollY)
  );
}

function isRuntimeCapabilities(
  value: unknown,
): value is DesignRuntimeCapabilities {
  if (!isRecord(value) || !Array.isArray(value.methods)) return false;
  return (
    value.methods.length > 0 &&
    value.methods.length <= DESIGN_RUNTIME_METHODS.size &&
    new Set(value.methods).size === value.methods.length &&
    value.methods.every(
      (method) =>
        typeof method === "string" &&
        DESIGN_RUNTIME_METHODS.has(method as DesignRuntimeMethod),
    ) &&
    value.cancellation === true &&
    value.typedErrors === true &&
    value.sourcePinned === true &&
    isFiniteNumber(value.maxStyleProperties) &&
    value.maxStyleProperties >= 1 &&
    value.maxStyleProperties <= 1_024 &&
    isFiniteNumber(value.maxMatchedDeclarations) &&
    value.maxMatchedDeclarations >= 1 &&
    value.maxMatchedDeclarations <= 10_000 &&
    isFiniteNumber(value.maxCapturePixels) &&
    value.maxCapturePixels >= 1 &&
    value.maxCapturePixels <= 64_000_000
  );
}

export function isDesignRuntimeFrameMessage(
  value: unknown,
): value is DesignRuntimeFrameMessage {
  if (!isRecord(value)) return false;
  const message = value;
  if (
    message.protocol !== DESIGN_RUNTIME_PROTOCOL ||
    message.version !== DESIGN_RUNTIME_VERSION
  ) {
    return false;
  }
  if (message.type === "response") {
    if (
      typeof message.requestId !== "string" ||
      message.requestId.length < 1 ||
      message.requestId.length > 128 ||
      typeof message.ok !== "boolean"
    ) {
      return false;
    }
    if (message.ok) return "result" in message;
    return (
      isRecord(message.error) &&
      typeof message.error.code === "string" &&
      DESIGN_RUNTIME_ERROR_CODES.has(
        message.error.code as DesignRuntimeErrorCode,
      ) &&
      typeof message.error.message === "string" &&
      message.error.message.length <= 2_048 &&
      typeof message.error.retryable === "boolean"
    );
  }
  if (
    message.type !== "event" ||
    (message.event !== "ready" && message.event !== "mutation" && message.event !== "playbackStopped") ||
    !isRecord(message.payload)
  ) {
    return false;
  }
  if (message.event === "mutation") return isRuntimeSnapshot(message.payload);
  const payload = message.payload;
  if (message.event === "playbackStopped") {
    return isSourceVersion(payload.sourceVersion) &&
      typeof payload.sessionId === "string" && payload.sessionId.length > 0 && payload.sessionId.length <= 128 &&
      (payload.reason === "escape" || payload.reason === "hidden");
  }
  return (
    isSourceVersion(payload.sourceVersion) &&
    isRuntimeCapabilities(payload.capabilities) &&
    isRuntimeSnapshot(payload.snapshot) &&
    payload.snapshot.sourceVersion === payload.sourceVersion
  );
}

/**
 * Self-contained browser source injected after authored scripts are removed.
 * Keep this ES2020-compatible: Electron executes the string inside sandboxed
 * srcDoc frames without a bundler or module loader.
 */
export const DESIGN_RUNTIME_SOURCE = String.raw`(function () {
  "use strict";

  var PROTOCOL = "zeros-design-runtime";
  var VERSION = 2;
  var SOURCE_VERSION = String(window.__zerosDesignSourceVersion || "");
  var MUTATION_DEBOUNCE_MS = 500;
  var MAX_CAPTURE_DIMENSION = 8192;
  // A full Retina viewport tile needs ~8 MP (2x backing over ~2 M css px).
  // Viewport captures live only in renderer memory — the persisted-thumbnail
  // wire cap below does not apply to them.
  var MAX_VIEWPORT_CAPTURE_PIXELS = 9000000;
  var MAX_AUDIT_WARNINGS = ${DESIGN_RUNTIME_AUDIT_WARNING_LIMIT};
  var MAX_MATCHED_DECLARATIONS = 256;
  var MAX_ACTIVE_REQUESTS = 128;
  var MAX_STYLE_SNAPSHOT_PROPERTIES = 256;
  var MAX_TREE_NODES = ${DESIGN_RUNTIME_TREE_NODE_LIMIT};
  // Keep structured-clone payload nesting well below Chromium's IPC depth
  // ceiling; the outer protocol envelope adds several more object levels.
  var MAX_TREE_DEPTH = ${DESIGN_RUNTIME_TREE_DEPTH_LIMIT};
  var MAX_AUDIT_ELEMENTS = 5000;
  // Keep worst-case RGBA → PNG base64 within the engine's 12 MB wire cap.
  var MAX_CAPTURE_PIXELS = 2000000;
  // Transform accumulation walks to the document root; the bound only protects
  // against a pathological or cyclic parent chain.
  var MAX_TRANSFORM_CHAIN = 128;
  var LINEAR_IDENTITY = [1, 0, 0, 1];
  var STYLE_PROPERTIES = [
    "position", "left", "top", "right", "bottom", "width", "height",
    "minWidth", "minHeight", "maxWidth", "maxHeight", "boxSizing", "zIndex",
    "display", "visibility", "float", "clear",
    "flexDirection", "flexWrap", "flexGrow", "flexShrink", "flexBasis", "order",
    "gap", "rowGap", "columnGap", "alignItems", "alignSelf", "alignContent",
    "justifyContent", "justifyItems", "justifySelf",
    "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow", "gridAutoColumns",
    "gridAutoRows", "gridColumn", "gridRow",
    "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
    "background", "backgroundColor", "backgroundImage", "backgroundPosition",
    "backgroundSize", "backgroundRepeat", "backgroundBlendMode",
    "border", "borderWidth", "borderStyle", "borderColor", "borderRadius",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius",
    "borderBottomLeftRadius", "outline", "outlineWidth", "outlineStyle",
    "outlineColor", "outlineOffset", "color",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
    "fontVariant", "fontKerning", "fontFeatureSettings", "fontVariationSettings",
    "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textAlign", "textTransform",
    "textDecoration", "textOverflow", "textWrap", "whiteSpace", "wordBreak",
    "overflowWrap", "verticalAlign", "writingMode", "direction", "unicodeBidi", "hyphens",
    "overflow", "overflowX", "overflowY", "aspectRatio", "objectFit", "objectPosition",
    "opacity", "mixBlendMode", "isolation", "boxShadow", "textShadow", "filter",
    "backdropFilter", "clipPath",
    "transform", "transformOrigin", "rotate", "scale", "translate", "perspective", "perspectiveOrigin",
    "transition", "transitionProperty", "transitionDuration", "transitionTimingFunction",
    "transitionDelay", "animation", "animationName", "animationDuration",
    "animationTimingFunction", "animationDelay", "animationIterationCount",
    "animationDirection", "animationFillMode", "cursor", "pointerEvents"
  ];
  var NON_TEXT_EDITABLE_TAGS = new Set([
    "area", "audio", "base", "br", "canvas", "col", "embed", "hr",
    "iframe", "img", "input", "link", "meta", "object", "param", "path",
    "source", "svg", "track", "video", "wbr"
  ]);
  var METHODS = [
    "getSnapshot", "getElementAtLoc", "getElementsInRect", "getNodeDetails", "getMatchedStyles",
    "setNodeVisibility", "setTheme", "previewStyles", "previewGeometry", "getLayoutTargets", "previewLayout", "restoreGeneration", "commitStyles", "previewText", "clearPreviewText", "previewMotion", "clearPreviewStyles",
    "captureScreenshot"
  ];
  // Advertised only to a host whose handshake asks for them, so a host that
  // predates a method still accepts these capabilities.
  var OPT_IN_METHODS = ["previewStylesheet", "setPlayback", "previewInsert", "clearPreviewInserts", "previewHistory", "commitStructure", "previewStructure", "clearPreviewStructure"];
  var enabledOptInMethods = [];
  var MAX_PREVIEW_STYLESHEET_CHARS = 4194304;
  // Everything one frame of direct manipulation paints from. Deliberately tiny:
  // the full STYLE_PROPERTIES catalog belongs to the inspector, not the pointer.
  var GEOMETRY_STYLE_PROPERTIES = [
    "display", "position", "flexDirection", "flexWrap",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "rowGap", "columnGap", "transformOrigin",
    "gridTemplateColumns", "gridTemplateRows",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "justifyContent", "alignContent"
  ];
  var GEOMETRY_CHILD_LIMIT = 64;

  if (window.__zerosDesignRuntimeVersion === VERSION) return;
  if (!/^[a-f0-9]{24}$/.test(SOURCE_VERSION)) {
    throw new Error("Design runtime source generation is missing.");
  }
  window.__zerosDesignRuntimeVersion = VERSION;

  var revision = 1;
  var elementsByOid = new Map();
  var visibilityOverridesByOid = new Map();
  var previewStyleOverridesByOid = new Map();
  var previewTextOverridesByOid = new Map();
  var previewAnimationsByOid = new Map();
  var playbackSessionId = null;
  var committedKeyframesByName = new Map();
  var committedTokensByKey = new Map();
  var committedGenerationStyle = null;
  var committedKeyframeRulesByName = new Map();
  var committedTokenRulesByKey = new Map();
  var lastSnapshot = null;
  // Inlined linked stylesheets showing an agent's in-flight text, with the
  // generation's own text to restore.
  var previewStylesheetTexts = new Map();
  var authoredStylePropertiesCache = new WeakMap();
  var authoredStylesCache = new WeakMap();
  var authoredStyleRuleMetadata = null;
  var oidStyleRuleIndex = null;
  var elementMapStale = true;
  var mutationTimer = null;
  var parentPort = null;
  var observer = null;
  var observing = false;
  var disposed = false;
  var activeRequests = new Set();
  var cancelledRequests = new Set();
  var activeCaptures = new Map();
  var trustedParentOrigin = null;
  try {
    trustedParentOrigin = document.referrer
      ? new URL(document.referrer).origin
      : null;
  } catch (_error) {
    trustedParentOrigin = null;
  }

  /** Passive frames stay still. Whole-frame Play and the Motion editor's
   * explicit preview are the only owners allowed to run authored motion. */
  function suspendAuthoredMotion() {
    if (playbackSessionId !== null) return;
    stillAuthoredTimelines();
    if (typeof document.getAnimations !== "function") return;
    var previews = new Set();
    previewAnimationsByOid.forEach(function (animation) {
      previews.add(animation);
    });
    document.getAnimations().forEach(function (animation) {
      if (previews.has(animation)) return;
      try { animation.cancel(); } catch (_error) {}
    });
  }

  /** SVG SMIL timelines, marquees and media loop outside the Web Animations
   * API. They hold their opening state with the capture hosts' definition. */
  ${DESIGN_STILL_TIMELINES_SOURCE}

  /** The same guarantee scoped to one element and its subtree. A preview write
   * can only start a transition on the element it wrote to, so once a gesture's
   * first write has cleared the document there is no reason to re-walk it sixty
   * times a second. */
  function suspendElementMotion(element) {
    if (playbackSessionId !== null) return;
    if (typeof element.getAnimations !== "function") {
      suspendAuthoredMotion();
      return;
    }
    var previews = new Set();
    previewAnimationsByOid.forEach(function (animation) {
      previews.add(animation);
    });
    element.getAnimations({ subtree: true }).forEach(function (animation) {
      if (previews.has(animation)) return;
      try { animation.cancel(); } catch (_error) {}
    });
  }

  function stopPlayback(reason) {
    var sessionId = playbackSessionId;
    playbackSessionId = null;
    suspendAuthoredMotion();
    if (sessionId !== null && reason) {
      event("playbackStopped", { sourceVersion: SOURCE_VERSION, sessionId: sessionId, reason: reason });
    }
  }

  function setPlayback(sessionId, playing) {
    if (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 128 || typeof playing !== "boolean") {
      throw typedError("BAD_REQUEST", "Invalid frame playback session.", false);
    }
    if (playing && document.hidden) throw typedError("BAD_REQUEST", "A hidden frame cannot play.", false);
    if (playing && playbackSessionId !== sessionId) {
      playbackSessionId = sessionId;
      previewAnimationsByOid.forEach(function (animation) { animation.cancel(); });
      previewAnimationsByOid.clear();
      // Cancelling CSSAnimation objects for editing does not make them start
      // again on its own. A synchronous display reset creates fresh authored
      // timelines, including pseudo-elements and inline !important rules,
      // without changing the source, timing, cascade or any painted frame.
      withoutObservedMutations(function () {
        var root = document.documentElement;
        var style = root.getAttribute("style");
        try {
          // A discrete display transition must not postpone this reset.
          root.style.setProperty("transition-property", "none", "important");
          root.style.setProperty("display", "none", "important");
          root.getBoundingClientRect();
          // Flush Chromium's lazy CSSOM attribute before restoring absence;
          // otherwise removeAttribute can leave an empty style attribute.
          root.getAttribute("style");
        } finally {
          if (style === null) root.removeAttribute("style");
          else root.setAttribute("style", style);
        }
        root.getBoundingClientRect();
      });
      document.querySelectorAll("svg").forEach(function (svg) {
        if (svg.ownerSVGElement || typeof svg.unpauseAnimations !== "function") return;
        try { svg.setCurrentTime(0); svg.unpauseAnimations(); } catch (_error) {}
      });
      document.querySelectorAll("marquee").forEach(function (marquee) {
        try { if (typeof marquee.start === "function") marquee.start(); } catch (_error) {}
      });
      document.querySelectorAll("video[autoplay], audio[autoplay]").forEach(function (media) {
        try {
          var started = media.play();
          if (started && typeof started.catch === "function") started.catch(function () {});
        } catch (_error) {}
      });
    } else if (!playing && playbackSessionId === sessionId) {
      stopPlayback();
    }
    return { playing: playbackSessionId !== null, sessionId: playbackSessionId };
  }

  function post(message) {
    if (parentPort && (!disposed || message.type === "response")) parentPort.postMessage(message);
  }

  function event(name, payload) {
    post({
      protocol: PROTOCOL,
      version: VERSION,
      type: "event",
      event: name,
      payload: payload
    });
  }

  function typedError(code, message, retryable) {
    return { code: code, message: String(message), retryable: retryable === true };
  }

  function errorPayload(value) {
    if (value && typeof value === "object" && typeof value.code === "string") {
      return typedError(value.code, value.message || value.code, value.retryable);
    }
    var message = value instanceof Error ? value.message : String(value);
    if (/not found/i.test(message)) return typedError("NODE_NOT_FOUND", message, false);
    if (/unknown design runtime method/i.test(message)) {
      return typedError("METHOD_NOT_SUPPORTED", message, false);
    }
    if (/\b(?:invalid|must|missing|no visible geometry)\b/i.test(message)) {
      return typedError("BAD_REQUEST", message, false);
    }
    return typedError("INTERNAL_ERROR", message, false);
  }

  function response(requestId, ok, value) {
    post(ok
      ? {
          protocol: PROTOCOL,
          version: VERSION,
          type: "response",
          requestId: requestId,
          ok: true,
          result: value
        }
      : {
          protocol: PROTOCOL,
          version: VERSION,
          type: "response",
          requestId: requestId,
          ok: false,
          error: errorPayload(value)
        });
  }

  function capabilities() {
    return {
      methods: METHODS.concat(enabledOptInMethods),
      cancellation: true,
      captureCompletion: true,
      typedErrors: true,
      sourcePinned: true,
      maxStyleProperties: 64,
      maxMatchedDeclarations: MAX_MATCHED_DECLARATIONS,
      maxCapturePixels: MAX_CAPTURE_PIXELS
    };
  }

  function oidOf(element) {
    return element && element.getAttribute
      ? element.getAttribute("data-oid") || ""
      : "";
  }

  function targetOidOf(element) {
    return element === document.body ? ${JSON.stringify(DESIGN_RUNTIME_DOCUMENT_BODY_ID)} : oidOf(element);
  }

  // ── Rendered (flat) tree ──────────────────────────────────
  // Frames may carry open shadow roots, for example a declarative
  // <template shadowrootmode="open"> serialized from a web component. Layers,
  // hit testing and inspection follow what the browser renders: a host's
  // layers are its shadow root's children and a slot's layers are the
  // elements assigned to it. Ordinary documents are unchanged.
  function shadowRootOf(element) {
    var root = element && element.shadowRoot;
    return root && root.mode === "open" ? root : null;
  }

  function composedParentOf(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
    var parent = node.parentNode;
    return parent && parent.nodeType === 11 && parent.host ? parent.host : null;
  }

  function composedChildrenOf(element) {
    var root = shadowRootOf(element);
    if (root) return root.children;
    if (element.localName === "slot" && typeof element.assignedElements === "function") {
      var assigned = element.assignedElements();
      if (assigned.length > 0) return assigned;
    }
    return element.children;
  }

  /** The tree whose stylesheets style this element: its shadow root, or the
   * document. */
  function styleScopeOf(element) {
    var root = element && typeof element.getRootNode === "function" ? element.getRootNode() : null;
    return root && root.nodeType === 11 && root.host ? root : document;
  }

  function inShadowTree(element) {
    return styleScopeOf(element) !== document;
  }

  /** The box an element lays out in: slots are display: contents by default,
   * so assigned elements lay out in the slot's parent box. */
  function layoutParentOf(element) {
    var parent = composedParentOf(element);
    while (parent && parent.localName === "slot" && getComputedStyle(parent).display === "contents") {
      parent = composedParentOf(parent);
    }
    return parent;
  }

  /** document.elementsFromPoint retargets shadow content to its host. Expand
   * each open host in place, deepest hits first, so a click selects what the
   * person sees. */
  function deepElementsFromPoint(x, y) {
    var result = [];
    var seen = new Set();
    function expand(list, scope) {
      for (var index = 0; index < list.length; index += 1) {
        var element = list[index];
        if (seen.has(element)) continue;
        if (scope !== document && element.getRootNode() !== scope) continue;
        seen.add(element);
        var root = shadowRootOf(element);
        if (root && typeof root.elementsFromPoint === "function") expand(root.elementsFromPoint(x, y), root);
        result.push(element);
      }
    }
    expand(document.elementsFromPoint(x, y), document);
    return result;
  }

  function directText(element) {
    var pieces = [];
    for (var index = 0; index < element.childNodes.length; index += 1) {
      var node = element.childNodes[index];
      if (node.nodeType === Node.TEXT_NODE && node.textContent) {
        pieces.push(node.textContent);
      }
    }
    var text = pieces.join(" ").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 120) : null;
  }

  function textEditableOf(element) {
    return element.children.length === 0 && !shadowRootOf(element) &&
      !NON_TEXT_EDITABLE_TAGS.has(element.tagName.toLowerCase());
  }

  function editableTextOf(element) {
    return String(element.textContent || "").slice(0, 10000);
  }

  function typedSizingValue(element, property) {
    try {
      if (typeof element.computedStyleMap !== "function") return "";
      var value = element.computedStyleMap().get(property);
      return value ? String(value).trim().toLowerCase() : "";
    } catch (_error) {
      return "";
    }
  }

  function textSizingOf(element) {
    var computed = getComputedStyle(element);
    var widthValue = typedSizingValue(element, "width");
    var heightValue = typedSizingValue(element, "height");
    var intrinsicWidths = ["min-content", "max-content", "fit-content"];
    var inlineAutoDisplays = [
      "inline", "inline-block", "inline-flex", "inline-grid", "inline-table"
    ];
    var width = intrinsicWidths.indexOf(widthValue) >= 0
      ? widthValue
      : widthValue === "auto" && inlineAutoDisplays.indexOf(computed.display) >= 0
        ? "auto"
        : "fixed";
    var parent = layoutParentOf(element);
    var availableWidth = element.getBoundingClientRect().width;
    if (parent) {
      var parentStyle = getComputedStyle(parent);
      var left = parseFloat(parentStyle.paddingLeft) || 0;
      var right = parseFloat(parentStyle.paddingRight) || 0;
      availableWidth = Math.max(0, parent.clientWidth - left - right);
    }
    return {
      width: width,
      height: heightValue === "auto" ? "auto" : "fixed",
      availableWidth: Math.min(100000, availableWidth)
    };
  }

  function layerNameOf(element) {
    return (element.getAttribute("data-name") || "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  }

  function nameOf(element) {
    var explicit =
      layerNameOf(element) ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.id ||
      directText(element);
    return explicit
      ? String(explicit).replace(/\s+/g, " ").trim().slice(0, 80)
      : element.tagName.toLowerCase();
  }

  function visibleOf(element, elementStyle) {
    for (
      var current = element;
      current && current instanceof Element;
      current = composedParentOf(current)
    ) {
      var style = current === element && elementStyle
        ? elementStyle
        : getComputedStyle(current);
      if (
        current.hidden ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return false;
      }
    }
    return true;
  }

  function rectOf(element) {
    var rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function stylesOf(computed, authoredProperties) {
    var styles = {};
    var knownProperties = new Set();
    var styleCount = 0;
    for (var index = 0; index < STYLE_PROPERTIES.length; index += 1) {
      var property = STYLE_PROPERTIES[index];
      styles[property] = computed[property] || "";
      knownProperties.add(cssPropertyName(property));
      styleCount += 1;
    }
    // The curated catalog keeps pointer/read payloads bounded, while directly
    // authored declarations may use any browser-supported property or custom
    // token. Include those computed values as canonical CSS keys so the CSS
    // inspector can faithfully round-trip them without expanding the snapshot
    // to every browser default.
    for (var authoredIndex = 0; authoredIndex < authoredProperties.length; authoredIndex += 1) {
      var authoredProperty = authoredProperties[authoredIndex];
      if (knownProperties.has(authoredProperty)) continue;
      if (styleCount >= MAX_STYLE_SNAPSHOT_PROPERTIES) break;
      styles[authoredProperty] = computed.getPropertyValue(authoredProperty) || "";
      knownProperties.add(authoredProperty);
      styleCount += 1;
    }
    return styles;
  }

  /** Every finite number in a CSS value, in author order. Computed transform,
   * rotate, scale, and transform-origin values are already resolved to
   * matrices, canonical angles, and pixels, so no unit resolution is needed. */
  function cssNumbers(value) {
    var parts = String(value == null ? "" : value).match(
      /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi
    );
    if (!parts) return null;
    var result = [];
    for (var index = 0; index < parts.length; index += 1) {
      var parsed = parseFloat(parts[index]);
      if (!isFinite(parsed)) return null;
      result.push(parsed);
    }
    return result;
  }

  /** Compose two 2D linear parts in CSS matrix order (a, b, c, d). Translation
   * is deliberately dropped: it never changes an element's orientation, and the
   * bounding-box inversion in boxOf recovers it exactly. */
  function multiplyLinear(outer, inner) {
    return [
      outer[0] * inner[0] + outer[2] * inner[1],
      outer[1] * inner[0] + outer[3] * inner[1],
      outer[0] * inner[2] + outer[2] * inner[3],
      outer[1] * inner[2] + outer[3] * inner[3]
    ];
  }

  function linearOfTransform(value) {
    var trimmed = String(value || "").trim();
    if (!trimmed || trimmed === "none") return LINEAR_IDENTITY;
    var numbers = cssNumbers(trimmed);
    if (!numbers) return null;
    if (trimmed.indexOf("matrix3d(") === 0) {
      if (numbers.length !== 16) return null;
      var flat =
        numbers[2] === 0 && numbers[3] === 0 && numbers[6] === 0 &&
        numbers[7] === 0 && numbers[8] === 0 && numbers[9] === 0 &&
        numbers[10] === 1 && numbers[11] === 0 && numbers[14] === 0 &&
        numbers[15] === 1;
      if (!flat) return null;
      return [numbers[0], numbers[1], numbers[4], numbers[5]];
    }
    if (trimmed.indexOf("matrix(") !== 0 || numbers.length !== 6) return null;
    return [numbers[0], numbers[1], numbers[2], numbers[3]];
  }

  /** The individual CSS rotate property, which Tailwind's rotate utilities
   * emit and computed transform never reports. */
  function linearOfRotate(value) {
    var trimmed = String(value || "").trim();
    if (!trimmed || trimmed === "none") return LINEAR_IDENTITY;
    if (/[xy]/i.test(trimmed)) return null;
    var numbers = cssNumbers(trimmed);
    if (!numbers || (numbers.length !== 1 && numbers.length !== 4)) return null;
    if (
      numbers.length === 4 &&
      !(numbers[0] === 0 && numbers[1] === 0 && numbers[2] === 1)
    ) {
      return null;
    }
    var degrees = numbers[numbers.length - 1];
    if (/rad/i.test(trimmed)) degrees = (degrees * 180) / Math.PI;
    else if (/turn/i.test(trimmed)) degrees = degrees * 360;
    else if (/grad/i.test(trimmed)) degrees = (degrees * 360) / 400;
    var radians = (degrees * Math.PI) / 180;
    return [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians)];
  }

  /** The individual CSS scale property, likewise invisible to computed
   * transform. */
  function linearOfScale(value) {
    var trimmed = String(value || "").trim();
    if (!trimmed || trimmed === "none") return LINEAR_IDENTITY;
    var numbers = cssNumbers(trimmed);
    if (!numbers || numbers.length < 1 || numbers.length > 3) return null;
    var unit = trimmed.indexOf("%") >= 0 ? 0.01 : 1;
    if (numbers.length === 3 && numbers[2] * unit !== 1) return null;
    return [
      numbers[0] * unit,
      0,
      0,
      (numbers.length > 1 ? numbers[1] : numbers[0]) * unit
    ];
  }

  function ownLinearOf(computed) {
    var matrix = linearOfTransform(computed.transform);
    var rotate = linearOfRotate(computed.rotate);
    var scale = linearOfScale(computed.scale);
    if (!matrix || !rotate || !scale) return null;
    // Individual properties apply before transform: translate, rotate, scale.
    return multiplyLinear(multiplyLinear(rotate, scale), matrix);
  }

  /** The element's own orientation composed with every ancestor's, so a layer
   * inside a rotated container reports the rotation the user sees. Returns null
   * when any link in the chain is not a 2D transform. */
  function accumulatedLinearOf(element) {
    var linear = LINEAR_IDENTITY;
    var depth = 0;
    for (
      var node = element;
      node && node.nodeType === 1 && depth < MAX_TRANSFORM_CHAIN;
      node = composedParentOf(node)
    ) {
      depth += 1;
      var computed = getComputedStyle(node);
      if ((computed.perspective && computed.perspective !== "none") || (computed.zoom && computed.zoom !== "1" && computed.zoom !== "normal")) return null;
      // Transforms do not apply to non-replaced inline boxes.
      if (computed.display === "inline") continue;
      var own = ownLinearOf(computed);
      if (!own) return null;
      linear = multiplyLinear(own, linear);
    }
    return linear;
  }

  function computedEdgeTotal(computed, properties) {
    var total = 0;
    for (var index = 0; index < properties.length; index += 1) {
      var parsed = parseFloat(computed[properties[index]]);
      if (isFinite(parsed)) total += parsed;
    }
    return total;
  }

  /** Chromium resolves computed width and height against the element's own
   * box-sizing,
   * so a content-box element needs its padding and border added back to reach
   * the border box the selection outline traces. */
  function borderBoxSizeOf(computed) {
    var width = parseFloat(computed.width);
    var height = parseFloat(computed.height);
    if (!isFinite(width) || !isFinite(height) || width < 0 || height < 0) {
      return null;
    }
    if (computed.boxSizing !== "border-box") {
      width += computedEdgeTotal(computed, [
        "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"
      ]);
      height += computedEdgeTotal(computed, [
        "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"
      ]);
    }
    return { width: width, height: height };
  }

  function roundedGeometry(value) {
    var result = Math.round(value * 1000000) / 1000000;
    return result === 0 ? 0 : result;
  }

  function boxOf(element, computed, rect) {
    var size = borderBoxSizeOf(computed);
    var width = size ? size.width : rect.width;
    var height = size ? size.height : rect.height;
    var origin = cssNumbers(computed.transformOrigin);
    var originX = origin && origin.length > 0 ? origin[0] : width / 2;
    var originY = origin && origin.length > 1 ? origin[1] : height / 2;
    var box = {
      x: rect.x,
      y: rect.y,
      width: width,
      height: height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      originX: roundedGeometry(width > 0 ? originX / width : 0.5),
      originY: roundedGeometry(height > 0 ? originY / height : 0.5)
    };
    var linear = size ? accumulatedLinearOf(element) : null;
    if (!linear) return box;
    var a = linear[0], b = linear[1], c = linear[2], d = linear[3];
    var determinant = a * d - b * c;
    var scaleX = Math.sqrt(a * a + b * b);
    // A collapsed or skewed chain cannot be represented by an oriented box.
    if (determinant === 0 || scaleX <= 0) return box;
    if (Math.abs((a * c + b * d) / (scaleX * scaleX)) > 0.0005) return box;
    // The transform maps the box's own origin to the affine translation, so the
    // bounding box's minimum corner recovers where that origin landed.
    var minX = Math.min(0, a * width, a * width + c * height, c * height);
    var minY = Math.min(0, b * width, b * width + d * height, d * height);
    box.x = roundedGeometry(rect.x - minX);
    box.y = roundedGeometry(rect.y - minY);
    if (determinant < 0) {
      // Reflect the local Y axis to describe the same four painted corners
      // with positive extents, as required by the host's rectangle contract.
      box.x = roundedGeometry(box.x + c * height);
      box.y = roundedGeometry(box.y + d * height);
      box.originY = roundedGeometry(1 - box.originY);
      determinant = -determinant;
    }
    box.width = roundedGeometry(width);
    box.height = roundedGeometry(height);
    box.rotation = roundedGeometry((Math.atan2(b, a) * 180) / Math.PI);
    box.scaleX = roundedGeometry(scaleX);
    box.scaleY = roundedGeometry(determinant / scaleX);
    return box;
  }

  function cssPropertyName(property) {
    if (property.indexOf("--") === 0) return property;
    return property
      .replace(/([A-Z])/g, "-$1")
      .replace(/^ms-/, "-ms-")
      .toLowerCase();
  }

  function declarationProperties(style) {
    var declarations = [];
    if (!style) return declarations;
    // CSSOM enumeration may expand authored shorthands into longhands. Parsing
    // normalized declaration text preserves padding as padding, while a real
    // background-color cannot turn into a synthetic background shorthand.
    var text = String(style.cssText || "");
    var parts = [];
    var current = "";
    var depth = 0;
    var quote = "";
    for (var textIndex = 0; textIndex < text.length; textIndex += 1) {
      var character = text[textIndex];
      if (quote) {
        current += character;
        if (character === quote && text[textIndex - 1] !== "\\") quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      if (character === "(") depth += 1;
      if (character === ")") depth = Math.max(0, depth - 1);
      if (character === ";" && depth === 0) {
        if (current.trim()) parts.push(current);
        current = "";
      } else {
        current += character;
      }
    }
    if (current.trim()) parts.push(current);
    for (var index = 0; index < parts.length; index += 1) {
      var colon = parts[index].indexOf(":");
      if (colon < 1) continue;
      var property = cssPropertyName(parts[index].slice(0, colon).trim());
      if (
        property.length <= 64 &&
        /^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property)
      ) {
        declarations.push(property);
      }
    }
    return declarations;
  }

  function styleRuleMetadata(scope) {
    scope = scope || document;
    if (authoredStyleRuleMetadata === null) authoredStyleRuleMetadata = new Map();
    var cachedMetadata = authoredStyleRuleMetadata.get(scope);
    if (cachedMetadata) return cachedMetadata;
    var metadata = [];
    function visitRules(rules, active) {
      for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
        var rule = rules[ruleIndex];
        if (rule.type === CSSRule.STYLE_RULE && rule.selectorText && rule.style) {
          metadata.push({
            selector: rule.selectorText,
            active: active,
            declarations: declarationProperties(rule.style)
          });
        } else if (rule.cssRules) {
          visitRules(rule.cssRules, active && conditionalRuleActive(rule));
        }
      }
    }
    for (var sheetIndex = 0; sheetIndex < scope.styleSheets.length; sheetIndex += 1) {
      try {
        visitRules(scope.styleSheets[sheetIndex].cssRules || [], true);
      } catch (_error) {
        // Inaccessible sheets cannot provide trustworthy authored metadata.
      }
    }
    authoredStyleRuleMetadata.set(scope, metadata);
    return metadata;
  }

  /** Record exactly the physical sides a box's insets pin. The computed value
   * of an auto inset on a positioned box is its used length, and neither a
   * shorthand nor a losing rule says which side won, so constraint readers
   * get the cascade's answer: the typed computed value keeps \`auto\`. */
  function recordInsetPins(element, authored) {
    var sides = ["top", "right", "bottom", "left"];
    if (typeof element.computedStyleMap === "function") {
      try {
        var map = element.computedStyleMap();
        sides.forEach(function (side) {
          var value = map.get(side);
          if (!value) return;
          if (String(value) === "auto") authored.delete(side);
          else authored.add(side);
        });
        // Shorthands are resolved into the sides above; logical longhands stay
        // as the provenance they are.
        ["inset", "inset-inline", "inset-block"].forEach(function (shorthand) {
          authored.delete(shorthand);
        });
        return;
      } catch (_error) {
        // Fall back to the inline declaration below.
      }
    }
    if (!authored.has("inset")) return;
    sides.forEach(function (side) {
      var value = element.style.getPropertyValue(side).trim();
      if (value && value !== "auto") authored.add(side);
    });
  }

  /** Where a fixed box is positioned from: the nearest ancestor that creates a
   * containing block for fixed descendants (transform, filter, perspective,
   * containment), or the viewport when none does. */
  function fixedContainingBlockOf(element) {
    var containingParent = composedParentOf(element);
    for (var current = containingParent; current && current !== document.documentElement; current = composedParentOf(current)) {
      var style = getComputedStyle(current);
      var contain = style.contain || "";
      var willChange = style.willChange || "";
      if (
        (style.transform && style.transform !== "none") ||
        (style.filter && style.filter !== "none") ||
        (style.perspective && style.perspective !== "none") ||
        (style.backdropFilter && style.backdropFilter !== "none") ||
        /paint|layout|strict|content/.test(contain) ||
        /transform|filter|perspective/.test(willChange)
      ) {
        return current === containingParent ? "parent" : "ancestor";
      }
    }
    return "viewport";
  }

  function authoredStylePropertiesOf(element) {
    var cached = authoredStylePropertiesCache.get(element);
    if (cached && cached.inline === element.style.cssText) return cached.properties.slice();
    var authored = new Set(declarationProperties(element.style));
    var rules = styleRuleMetadata(styleScopeOf(element));
    for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
      var rule = rules[ruleIndex];
      if (!rule.active || rule.declarations.length === 0) continue;
      var matches = false;
      try { matches = element.matches(rule.selector); } catch (_error) { matches = false; }
      if (!matches) continue;
      for (var propertyIndex = 0; propertyIndex < rule.declarations.length; propertyIndex += 1) {
        authored.add(rule.declarations[propertyIndex]);
      }

    }
    recordInsetPins(element, authored);
    var result = Array.from(authored).slice(0, 128);
    authoredStylePropertiesCache.set(element, { inline: element.style.cssText, properties: result });
    return result.slice();
  }

  // ── Winning authored declarations ─────────────────────────
  // The inspector shows what an author wrote (var(--primary-button-bg)), not
  // only the computed color. For each authored property this finds the
  // cascade's winner among the element's style attribute and the active rules
  // that match it: importance, then the style attribute, then cascade layers
  // (reversed for !important), then specificity, then order of appearance.
  // Nesting and element-dependent conditions are conservative candidates:
  // if one can set the property, fall back to the browser's computed value.

  function styleOriginOf(sheet) {
    var node = sheet && sheet.ownerNode;
    if (!node || typeof node.getAttribute !== "function") return { origin: "frame" };
    var sourceId = node.getAttribute("data-zeros-style-source");
    if (sourceId) return { origin: "source", sourceId: sourceId.slice(0, 64) };
    var file = node.getAttribute("data-zeros-source");
    if (file) return { origin: "linked", file: file.slice(0, 256) };
    return { origin: "frame" };
  }

  function splitTopLevel(text, separator) {
    var parts = [];
    var depth = 0;
    var quote = "";
    var start = 0;
    for (var index = 0; index < text.length; index += 1) {
      var character = text[index];
      if (character === "\\") { index += 1; continue; }
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
      else if (character === separator && depth === 0) {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(text.slice(start));
    return parts.map(function (part) { return part.trim(); }).filter(Boolean);
  }

  function identifierEnd(text, index) {
    while (index < text.length) {
      var code = text.charCodeAt(index);
      if (text[index] === "\\") { index += 2; continue; }
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95 || code >= 128) {
        index += 1;
        continue;
      }
      break;
    }
    return index;
  }

  function closingIndex(text, index, open, close) {
    var depth = 0;
    var quote = "";
    for (var cursor = index; cursor < text.length; cursor += 1) {
      var character = text[cursor];
      if (character === "\\") { cursor += 1; continue; }
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === open) depth += 1;
      else if (character === close) {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    return text.length - 1;
  }

  function compareSpecificity(left, right) {
    for (var index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
  }

  function maxListSpecificity(list) {
    var best = [0, 0, 0];
    splitTopLevel(list, ",").forEach(function (selector) {
      var specificity = selectorSpecificity(selector);
      if (compareSpecificity(specificity, best) > 0) best = specificity;
    });
    return best;
  }

  /** Selectors Level 4 specificity of one complex selector. */
  function selectorSpecificity(selector) {
    var text = String(selector);
    var a = 0, b = 0, c = 0;
    var index = 0;
    while (index < text.length) {
      var character = text[index];
      if (character === "#") { a += 1; index = identifierEnd(text, index + 1); continue; }
      if (character === ".") { b += 1; index = identifierEnd(text, index + 1); continue; }
      if (character === "[") { b += 1; index = closingIndex(text, index, "[", "]") + 1; continue; }
      if (character === ":") {
        var pseudoElement = text[index + 1] === ":";
        var start = index + (pseudoElement ? 2 : 1);
        var end = identifierEnd(text, start);
        var name = text.slice(start, end).toLowerCase();
        var argument = null;
        index = end;
        if (text[index] === "(") {
          var close = closingIndex(text, index, "(", ")");
          argument = text.slice(index + 1, close);
          index = close + 1;
        }
        if (pseudoElement || name === "before" || name === "after" || name === "first-line" || name === "first-letter") { c += 1; continue; }
        if (name === "where") continue;
        if (name === "is" || name === "not" || name === "has" || name === "matches" || name === "-webkit-any") {
          var inner = maxListSpecificity(argument || "");
          a += inner[0]; b += inner[1]; c += inner[2];
          continue;
        }
        b += 1;
        if ((name === "nth-child" || name === "nth-last-child") && argument) {
          var ofIndex = argument.toLowerCase().indexOf(" of ");
          if (ofIndex >= 0) {
            var filtered = maxListSpecificity(argument.slice(ofIndex + 4));
            a += filtered[0]; b += filtered[1]; c += filtered[2];
          }
        }
        continue;
      }
      var code = text.charCodeAt(index);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 128 || character === "\\") {
        var typeEnd = identifierEnd(text, index);
        // A namespace prefix (ns|type) contributes only its type.
        if (text[typeEnd] !== "|") c += 1;
        index = typeEnd;
        continue;
      }
      index += 1;
    }
    return [a, b, c];
  }

  var cascadeRuleIndex = null;
  var longhandsByShorthand = new Map();

  /** Every active style rule in document order with its layer position,
   * origin and declared property names. Custom-property declarations are
   * indexed by name so token lookups touch only the rules that set them. */
  function cascadeRules(scope) {
    scope = scope || document;
    if (!cascadeRuleIndex) cascadeRuleIndex = new Map();
    var cachedIndex = cascadeRuleIndex.get(scope);
    if (cachedIndex) return cachedIndex;
    var rules = [];
    var customRules = new Map();
    var siblingsByParent = new Map();
    var anonymousLayers = 0;
    function layerPosition(parentKey, parentPath, dottedName) {
      var key = parentKey;
      var path = parentPath.slice();
      dottedName.split(".").forEach(function (segment) {
        var siblings = siblingsByParent.get(key);
        if (!siblings) { siblings = new Map(); siblingsByParent.set(key, siblings); }
        if (!siblings.has(segment)) siblings.set(segment, siblings.size);
        path.push(siblings.get(segment));
        key = key + "\u0000" + segment;
      });
      return { key: key, path: path };
    }
    function visit(list, active, layer, origin, uncertain, nested) {
      for (var index = 0; index < list.length; index += 1) {
        var rule = list[index];
        var kind = rule.constructor && rule.constructor.name;
        if ((rule.type === CSSRule.STYLE_RULE && rule.selectorText && rule.style) || (nested && kind === "CSSNestedDeclarations" && rule.style)) {
          var declared = declarationProperties(rule.style);
          // A nested selector is relative to its parent, so element.matches()
          // cannot establish applicability or specificity. Keep its property
          // footprint rather than silently selecting a losing outer rule.
          var entry = { rule: rule, selector: nested ? null : rule.selectorText, uncertain: uncertain || nested, active: active, layer: layer.path, order: rules.length, origin: origin, declared: declared };
          rules.push(entry);
          declared.forEach(function (property) {
            if (property.indexOf("--") !== 0) return;
            var list = customRules.get(property);
            if (!list) { list = []; customRules.set(property, list); }
            list.push(entry);
          });
          if (rule.cssRules) visit(rule.cssRules, active, layer, origin, uncertain, true);
        } else if (kind === "CSSLayerStatementRule" && rule.nameList) {
          for (var name = 0; name < rule.nameList.length; name += 1) layerPosition(layer.key, layer.path, rule.nameList[name]);
        } else if (kind === "CSSLayerBlockRule") {
          anonymousLayers += 1;
          visit(rule.cssRules || [], active, layerPosition(layer.key, layer.path, rule.name || "\u0001" + anonymousLayers), origin, uncertain, nested);
        } else if (rule.cssRules) {
          // Media/supports are document-wide. Container queries, scopes and
          // other groups need evidence this resolver does not have per element.
          var knownCondition = rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE;
          visit(rule.cssRules, active && conditionalRuleActive(rule), layer, origin, uncertain || !knownCondition, nested);
        }
      }
    }
    for (var sheetIndex = 0; sheetIndex < scope.styleSheets.length; sheetIndex += 1) {
      var sheet = scope.styleSheets[sheetIndex];
      try {
        visit(sheet.cssRules || [], true, { key: "", path: [] }, styleOriginOf(sheet), false, false);
      } catch (_error) {
        // Inaccessible sheets cannot provide trustworthy provenance.
      }
    }
    var built = { rules: rules, customRules: customRules };
    cascadeRuleIndex.set(scope, built);
    return built;
  }

  /** Positive when left's layer outranks right's for normal declarations.
   * Unlayered styles follow every sublayer of their parent. */
  function compareLayers(left, right) {
    for (var index = 0; ; index += 1) {
      var leftIndex = index < left.length ? left[index] : Infinity;
      var rightIndex = index < right.length ? right[index] : Infinity;
      if (leftIndex !== rightIndex) return leftIndex > rightIndex ? 1 : -1;
      if (leftIndex === Infinity) return 0;
    }
  }

  function specificityFor(element, entry) {
    var best = null;
    splitTopLevel(entry.selector, ",").forEach(function (selector) {
      var matches = false;
      try { matches = element.matches(selector); } catch (_error) { matches = false; }
      if (!matches) return;
      var specificity = selectorSpecificity(selector);
      if (!best || compareSpecificity(specificity, best) > 0) best = specificity;
    });
    return best || maxListSpecificity(entry.selector);
  }

  function matchingEntries(element, entries) {
    var result = [];
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      if (!entry.active) continue;
      var matches = entry.selector === null;
      try { if (!matches) matches = element.matches(entry.selector); } catch (_error) { matches = false; }
      if (matches) result.push({ entry: entry, specificity: null });
    }
    return result;
  }

  function longhandsOf(property) {
    if (property.indexOf("--") === 0) return [];
    var cached = longhandsByShorthand.get(property);
    if (cached) return cached;
    var probe = document.createElement("div").style;
    var longhands = [];
    try {
      probe.setProperty(property, "inherit");
      for (var index = 0; index < probe.length; index += 1) {
        if (probe[index] !== property) longhands.push(probe[index]);
      }
    } catch (_error) {
      longhands = [];
    }
    longhandsByShorthand.set(property, longhands);
    return longhands;
  }

  function outranks(candidate, current, element) {
    if (candidate.important !== current.important) return candidate.important;
    if (!!candidate.inline !== !!current.inline) return !!candidate.inline;
    if (candidate.inline) return false;
    var layers = compareLayers(candidate.match.entry.layer, current.match.entry.layer);
    if (layers !== 0) return candidate.important ? layers < 0 : layers > 0;
    if (!candidate.match.specificity) candidate.match.specificity = specificityFor(element, candidate.match.entry);
    if (!current.match.specificity) current.match.specificity = specificityFor(element, current.match.entry);
    var specificity = compareSpecificity(candidate.match.specificity, current.match.specificity);
    if (specificity !== 0) return specificity > 0;
    return candidate.match.entry.order > current.match.entry.order;
  }

  function declarationValue(style, property, declared) {
    var value = style.getPropertyValue(property);
    var important = style.getPropertyPriority(property) === "important";
    if (!value) {
      // CSSOM leaves a var()-based shorthand's longhands empty, including in
      // style attributes. Its unknown value still competes in the cascade.
      var shorthand = (declared || declarationProperties(style)).filter(function (name) {
        return name !== property && longhandsOf(name).indexOf(property) >= 0 && style.getPropertyValue(name).indexOf("var(") >= 0;
      })[0];
      if (!shorthand) return null;
      value = null;
      important = style.getPropertyPriority(shorthand) === "important";
    }
    return { value: value === null ? null : value.trim(), important: important };
  }

  /** The winning declaration of one property. A rule that sets it through a
   * var()-based shorthand competes with an unknown value, so the inspector
   * never claims a value the browser could not expand. */
  function winningDeclaration(element, property, matches) {
    var inline = declarationValue(element.style, property, null);
    var best = inline ? { inline: true, value: inline.value, important: inline.important } : null;
    for (var index = 0; index < matches.length; index += 1) {
      var match = matches[index];
      var declaration = declarationValue(match.entry.rule.style, property, match.entry.declared);
      if (!declaration) continue;
      var candidate = { match: match, value: declaration.value, important: declaration.important };
      if (match.entry.uncertain) {
        candidate.value = null;
        return candidate;
      }
      if (!best || outranks(candidate, best, element)) best = candidate;
    }
    return best;
  }

  function originOfWinner(winner) {
    if (winner.inline) return { origin: "inline" };
    var origin = winner.match.entry.origin;
    var result = { origin: origin.origin };
    if (origin.sourceId) result.sourceId = origin.sourceId;
    if (origin.file) result.file = origin.file;
    return result;
  }

  function sameWinner(left, right) {
    if (!left || !right) return false;
    if (left.inline || right.inline) return !!left.inline && !!right.inline;
    return left.match.entry === right.match.entry;
  }

  /** The nearest element (this one or an ancestor) whose winning declaration
   * sets a custom property, and where that declaration lives. */
  function tokenOrigin(element, name, index) {
    var scope = styleScopeOf(element);
    var entries = index.customRules.get(name) || [];
    for (var current = element; current && current.nodeType === 1; current = composedParentOf(current)) {
      // Custom properties inherit across shadow boundaries; each ancestor's
      // own tree supplies the rules that can set them.
      var currentScope = styleScopeOf(current);
      if (currentScope !== scope) {
        scope = currentScope;
        entries = cascadeRules(scope).customRules.get(name) || [];
      }
      var winner = winningDeclaration(current, name, matchingEntries(current, entries));
      // An uncertain local override also prevents attributing the token to an
      // ancestor. The computed token value is still available to the inspector.
      if (winner) return winner.value === null ? null : originOfWinner(winner);
    }
    return null;
  }

  function authoredStylesOf(element, properties) {
    // Cached like authoredStylePropertiesOf: one rule scan per element and
    // generation; theme and style changes start a new generation.
    var key = element.style.cssText + "\u0000" + properties.join(",");
    var cached = authoredStylesCache.get(element);
    if (cached && cached.key === key) return cached.styles;
    var styles = authoredStylesUncached(element, properties);
    authoredStylesCache.set(element, { key: key, styles: styles });
    return styles;
  }

  function authoredStylesUncached(element, properties) {
    var index = cascadeRules(styleScopeOf(element));
    var matches = matchingEntries(element, index.rules);
    var computed = getComputedStyle(element);
    var result = {};
    var count = 0;
    var budget = 32768;
    var origins = new Map();
    for (var propertyIndex = 0; propertyIndex < properties.length && count < ${DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.properties}; propertyIndex += 1) {
      var property = properties[propertyIndex];
      var winner = winningDeclaration(element, property, matches);
      if (!winner || winner.value === null || !winner.value) continue;
      if (winner.value.length > ${DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.value} || winner.value.length > budget) continue;
      var longhands = longhandsOf(property);
      // A shorthand is authoritative only while none of its longhands has a
      // different winner, such as a later utility that sets one side.
      if (longhands.length > 0 && longhands.some(function (longhand) {
        return !sameWinner(winningDeclaration(element, longhand, matches), winner);
      })) continue;
      var style = originOfWinner(winner);
      style.value = winner.value;
      if (winner.important) style.important = true;
      var tokens = [];
      var pattern = /var\(\s*(--[A-Za-z0-9_-]{1,126})/g;
      for (var found = pattern.exec(winner.value); found && tokens.length < ${DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.tokensPerValue}; found = pattern.exec(winner.value)) {
        var name = found[1];
        if (tokens.some(function (token) { return token.name === name; })) continue;
        if (!origins.has(name)) origins.set(name, tokenOrigin(element, name, index));
        var token = { name: name, value: computed.getPropertyValue(name).trim().slice(0, ${DESIGN_RUNTIME_AUTHORED_STYLE_LIMITS.tokenValue}) };
        var origin = origins.get(name);
        if (origin) {
          token.origin = origin.origin;
          if (origin.sourceId) token.sourceId = origin.sourceId;
          if (origin.file) token.file = origin.file;
        }
        tokens.push(token);
      }
      if (tokens.length > 0) style.tokens = tokens;
      result[property] = style;
      budget -= winner.value.length;
      count += 1;
    }
    return result;
  }

  /** Rebuild the oid → element map. Callers that only need to resolve a node
   * should use ensureElementMap: a full document walk per request is 1-3 walks
   * per gesture frame, and the observer already knows when the DOM changed. */
  function refreshElementMap() {
    elementMapStale = false;
    var next = new Map();
    var root = document.body || document.documentElement;
    var scopes = [root];
    if (root instanceof Element) {
      var rootOid = oidOf(root);
      if (rootOid) next.set(rootOid, root);
      if (shadowRootOf(root)) scopes.push(shadowRootOf(root));
    }
    for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
      var walker = document.createTreeWalker(scopes[scopeIndex], NodeFilter.SHOW_ELEMENT);
      for (var node = walker.nextNode(); node; node = walker.nextNode()) {
        var oid = oidOf(node);
        if (oid && !next.has(oid)) next.set(oid, node);
        var nodeShadow = shadowRootOf(node);
        if (nodeShadow) scopes.push(nodeShadow);
      }
    }
    if (document.body) next.set(${JSON.stringify(DESIGN_RUNTIME_DOCUMENT_BODY_ID)}, document.body);
    elementsByOid = next;
    visibilityOverridesByOid.forEach(function (_display, oid) {
      if (!next.has(oid)) visibilityOverridesByOid.delete(oid);
    });
    previewStyleOverridesByOid.forEach(function (_styles, oid) {
      if (!next.has(oid)) previewStyleOverridesByOid.delete(oid);
    });
    previewTextOverridesByOid.forEach(function (_text, oid) {
      if (!next.has(oid)) previewTextOverridesByOid.delete(oid);
    });
  }

  function treeNode(element, depth, budget) {
    if (budget.count >= MAX_TREE_NODES) {
      budget.truncated = true;
      return null;
    }
    budget.count += 1;
    var oid = oidOf(element);
    var computed = getComputedStyle(element);
    var children = [];
    var layerChildren = composedChildrenOf(element);
    if (depth >= MAX_TREE_DEPTH) {
      if (layerChildren.length > 0) budget.truncated = true;
    } else {
      for (var index = 0; index < layerChildren.length; index += 1) {
        var child = layerChildren[index];
        if (!oidOf(child)) continue;
        var childNode = treeNode(child, depth + 1, budget);
        if (childNode) children.push(childNode);
      }
    }
    var node = {
      oid: oid,
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      layerName: layerNameOf(element),
      text: directText(element),
      visible: visibleOf(element, computed),
      display: computed.display || "",
      flexDirection: computed.flexDirection || "",
      children: children
    };
    if (inShadowTree(element)) node.shadow = true;
    return node;
  }

  function breadcrumbOf(element) {
    var result = [];
    for (var current = element; current && current instanceof Element; current = composedParentOf(current)) {
      var oid = oidOf(current);
      if (oid) {
        result.push(current.tagName.toLowerCase() + " · " + nameOf(current));
      }
      if (current === document.body) break;
    }
    return result.reverse();
  }

  function layoutOriginOf(element) {
    var x = 0, y = 0, depth = 0;
    for (var node = element; node && depth < MAX_TRANSFORM_CHAIN; node = node.offsetParent) {
      depth += 1;
      x += node.offsetLeft || 0;
      y += node.offsetTop || 0;
      if (node.offsetParent) {
        x += node.offsetParent.clientLeft || 0;
        y += node.offsetParent.clientTop || 0;
      }
    }
    return { x: x, y: y };
  }

  function layoutOf(element, computed) {
    var parent = layoutParentOf(element);
    var parentComputed = parent ? getComputedStyle(parent) : null;
    var own = layoutOriginOf(element);
    var parentOrigin = parent ? layoutOriginOf(parent) : { x: 0, y: 0 };
    var parentSize = parentComputed ? borderBoxSizeOf(parentComputed) : null;
    var x = own.x - parentOrigin.x - (parent ? parent.clientLeft || 0 : 0);
    var y = own.y - parentOrigin.y - (parent ? parent.clientTop || 0 : 0);
    // Preserve subpixels for absolute children; offsetLeft/Top are integers.
    if (parent && element.offsetParent === parent && computed.position === "absolute") {
      var left = parseFloat(computed.left), top = parseFloat(computed.top);
      if (isFinite(left)) x = left + (parseFloat(computed.marginLeft) || 0);
      if (isFinite(top)) y = top + (parseFloat(computed.marginTop) || 0);
    }
    return {
      x: x, y: y,
      parentId: parent ? targetOidOf(parent) || null : null,
      parentWidth: Math.max(0, parentSize ? parentSize.width - computedEdgeTotal(parentComputed, ["borderLeftWidth", "borderRightWidth"]) : parent ? parent.clientWidth || 0 : window.innerWidth),
      parentHeight: Math.max(0, parentSize ? parentSize.height - computedEdgeTotal(parentComputed, ["borderTopWidth", "borderBottomWidth"]) : parent ? parent.clientHeight || 0 : window.innerHeight),
      parentDisplay: parentComputed ? parentComputed.display : "block",
      parentPosition: parentComputed ? parentComputed.position : "static",
      parentFlexDirection: parentComputed ? parentComputed.flexDirection : "row",
      parentAlignItems: parentComputed ? parentComputed.alignItems : "normal",
      parentJustifyItems: parentComputed ? parentComputed.justifyItems : "normal",
      widthValue: typedSizingValue(element, "width"),
      heightValue: typedSizingValue(element, "height"),
      isContainingBlock: !!parent && (element.offsetParent === parent || parentComputed.position !== "static"),
      fixedContainingBlock: computed.position === "fixed" ? fixedContainingBlockOf(element) : undefined
    };
  }

  function borderCoordinateSpaceOf(element, computed, rect) {
    var size = borderBoxSizeOf(computed);
    var matrix = size ? accumulatedLinearOf(element) : null;
    if (!matrix || Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 0.000001) return null;
    var a = matrix[0], b = matrix[1], c = matrix[2], d = matrix[3];
    return [a, b, c, d,
      rect.x - Math.min(0, a * size.width, c * size.height, a * size.width + c * size.height),
      rect.y - Math.min(0, b * size.width, d * size.height, b * size.width + d * size.height)];
  }

  function childCoordinateSpaceOf(element, computed, rect) {
    var matrix = borderCoordinateSpaceOf(element, computed, rect);
    if (!matrix) return undefined;
    var a = matrix[0], b = matrix[1], c = matrix[2], d = matrix[3];
    var x = (parseFloat(computed.borderLeftWidth) || 0) - element.scrollLeft;
    var y = (parseFloat(computed.borderTopWidth) || 0) - element.scrollTop;
    return [a, b, c, d,
      matrix[4] + a * x + c * y,
      matrix[5] + b * x + d * y];
  }

  function parentCoordinateSpaceOf(element) {
    var parent = layoutParentOf(element);
    var position = getComputedStyle(element).position;
    if (position === "absolute" || position === "fixed") {
      for (var candidate = parent; candidate; candidate = layoutParentOf(candidate)) {
        var style = getComputedStyle(candidate);
        if ((position === "absolute" && style.position !== "static") ||
            (style.transform && style.transform !== "none") ||
            (style.translate && style.translate !== "none") ||
            (style.rotate && style.rotate !== "none") ||
            (style.scale && style.scale !== "none") ||
            (style.filter && style.filter !== "none") ||
            (style.backdropFilter && style.backdropFilter !== "none") ||
            (style.perspective && style.perspective !== "none") ||
            /paint|layout|strict|content/.test(style.contain || "") ||
            /transform|translate|rotate|scale|filter|perspective/.test(style.willChange || "")) {
          return childCoordinateSpaceOf(candidate, style, rectOf(candidate)) || null;
        }
      }
      return [1, 0, 0, 1, position === "fixed" ? 0 : -window.scrollX, position === "fixed" ? 0 : -window.scrollY];
    }
    return parent ? childCoordinateSpaceOf(parent, getComputedStyle(parent), rectOf(parent)) || null : [1, 0, 0, 1, 0, 0];
  }

  function childConstraintOf(element, computed, authored, axis) {
    var property = "--zeros-layout-" + axis;
    var marker = authored.indexOf(property) >= 0 ? computed.getPropertyValue(property).trim() : "";
    if (["start", "center", "end", "stretch"].indexOf(marker) >= 0) return marker;
    if (computed.position !== "absolute" && computed.position !== "fixed") return "start";
    var start = axis === "x" ? "left" : "top";
    var end = axis === "x" ? "right" : "bottom";
    var hasStart = authored.indexOf(start) >= 0 && computed[start] !== "auto";
    var hasEnd = authored.indexOf(end) >= 0 && computed[end] !== "auto";
    return hasEnd ? hasStart ? "stretch" : "end" : "start";
  }

  function childrenLayoutOf(element, computed) {
    var children = [];
    var layoutChildren = composedChildrenOf(element);
    for (var index = 0; index < layoutChildren.length; index += 1) {
      var child = layoutChildren[index];
      if (oidOf(child)) children.push(child);
    }
    var result = { count: children.length, nodeIds: [], x: "start", y: "start", truncated: children.length > ${DESIGN_LAYOUT_CHILD_LIMIT} };
    if (result.truncated) {
      result.x = result.y = "mixed";
      return result;
    }
    if (computed.display === "contents" || !visibleOf(element, computed)) return result;
    for (var index = 0; index < children.length; index += 1) {
      var child = children[index];
      if (!(child instanceof HTMLElement)) continue;
      var childComputed = getComputedStyle(child);
      if (childComputed.display === "contents" || !visibleOf(child, childComputed)) continue;
      var authored = authoredStylePropertiesOf(child);
      var x = childConstraintOf(child, childComputed, authored, "x");
      var y = childConstraintOf(child, childComputed, authored, "y");
      result.x = result.nodeIds.length === 0 ? x : result.x === x ? x : "mixed";
      result.y = result.nodeIds.length === 0 ? y : result.y === y ? y : "mixed";
      result.nodeIds.push(oidOf(child));
    }
    return result;
  }

  /** What a layer needs to look the same in another parent or frame. Its
   * frame base (the body, styled by the directory's shared imports) comes
   * from the destination's own styles, so only values the layer's context
   * sets beyond that base travel; the base itself is reported for a
   * destination whose base differs. The body carries its whole inherited
   * appearance. Ancestor effects, SVG, scroll state and stilled animations
   * stay where they are, as in any design tool: a layer leaving a faded group
   * is no longer faded. Only a box the planner cannot place is refused. */
  function relocationContextOf(element) {
    var inheritedStyles = {};
    var baseStyles = {};
    var rootStyles = {};
    var unsupported = new Set();
    var computed = getComputedStyle(element);
    var body = document.body;
    var base = body && body !== element && body.contains(element) ? getComputedStyle(body) : null;
    var root = getComputedStyle(document.documentElement);
    var carried = 0;
    var portable = function (value) {
      return value.length <= 2048 && !value.toLowerCase().includes("url(");
    };
    // These default to currentColor. Freezing that resolved color would stop
    // a later color edit from reaching the text, so they follow color instead.
    var followsColor = function (style, property, value) {
      return (property === "-webkit-text-fill-color" || property === "-webkit-text-stroke-color") &&
        value === style.getPropertyValue("color");
    };
    ${JSON.stringify(DESIGN_RELOCATION_INHERITED_PROPERTIES)}.forEach(function (property) {
      var value = computed.getPropertyValue(property);
      var baseValue = base ? base.getPropertyValue(property) : "";
      if (base && baseValue && portable(baseValue) && !followsColor(base, property, baseValue))
        baseStyles[property] = baseValue;
      if (!value || !portable(value) || followsColor(computed, property, value) || (base && value === baseValue)) return;
      inheritedStyles[property] = value;
      carried += 1;
    });
    Array.from(computed).forEach(function (property) {
      if (!property.startsWith("--") || property === "--zeros-layout-origin-flow") return;
      if (carried >= ${DESIGN_RELOCATION_MAX_INHERITED_STYLES} || property.length > 128) return;
      var value = computed.getPropertyValue(property);
      var rootValue = root.getPropertyValue(property);
      if (!portable(value) || value === rootValue) return;
      inheritedStyles[property] = value;
      if (portable(rootValue)) rootStyles[property] = rootValue;
      carried += 1;
    });
    if (computed.display === "contents") unsupported.add("a layer without its own box");
    if (!borderCoordinateSpaceOf(element, computed, rectOf(element))) unsupported.add("unsupported transform");
    return { inheritedStyles: inheritedStyles, baseStyles: baseStyles, rootStyles: rootStyles, unsupported: Array.from(unsupported) };
  }

  function detailsOf(element, layoutOnly, relocation) {
    var oid = targetOidOf(element);
    if (!oid) throw new Error("The selected element has no stable data-oid.");
    var escaped = window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape(oid)
      : oid.replace(/["\\]/g, "\\$&");
    var textEditable = textEditableOf(element);
    var computed = getComputedStyle(element);
    var authoredStyleProperties = layoutOnly ? [] : authoredStylePropertiesOf(element);
    var rect = rectOf(element);
    var result = {
      sourceVersion: SOURCE_VERSION,
      oid: oid,
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: textEditable ? editableTextOf(element) : directText(element),
      textEditable: textEditable,
      selector: element === document.body ? "body" : "[data-oid=\"" + escaped + "\"]",
      visible: visibleOf(element, computed),
      breadcrumb: layoutOnly ? [] : breadcrumbOf(element),
      rect: rect,
      box: boxOf(element, computed, rect),
      layout: layoutOf(element, computed),
      childrenLayout: layoutOnly ? undefined : childrenLayoutOf(element, computed),
      childCoordinateSpace: childCoordinateSpaceOf(element, computed, rect),
      borderCoordinateSpace: borderCoordinateSpaceOf(element, computed, rect),
      parentCoordinateSpace: parentCoordinateSpaceOf(element),
      styles: layoutOnly ? Object.fromEntries(["display", "position", "left", "top", "width", "height", "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "marginTop", "marginRight", "marginBottom", "marginLeft", "flexDirection", "flexWrap", "direction", "order", "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd"].map(function (key) { return [key, computed[key] || ""]; })) : stylesOf(computed, authoredStyleProperties),
      authoredStyleProperties: authoredStyleProperties
    };
    if (inShadowTree(element)) result.shadow = true;
    var classAttribute = element.getAttribute("class");
    if (classAttribute && classAttribute.trim()) result.classes = classAttribute.replace(/\s+/g, " ").trim().slice(0, 1024);
    result.styles["--zeros-layout-origin-flow"] = element.style ? element.style.getPropertyValue("--zeros-layout-origin-flow").trim() : "";
    if (textEditable && !layoutOnly) result.textSizing = textSizingOf(element);
    if (relocation) result.relocationContext = relocationContextOf(element);
    if (!layoutOnly) attachAuthoredStyles(result, element, authoredStyleProperties);
    return result;
  }

  /** Provenance is advisory: a failure leaves the computed-only details. */
  function attachAuthoredStyles(result, element, properties) {
    try {
      result.authoredStyles = authoredStylesOf(element, properties);
    } catch (_error) {
      // Older-runtime behavior: the inspector shows computed values.
    }
  }

  function frameDetailsOf(element) {
    var oid = targetOidOf(element);
    if (oid) return detailsOf(element);
    var computed = getComputedStyle(element);
    var authoredStyleProperties = authoredStylePropertiesOf(element);
    var rect = rectOf(element);
    var result = {
      sourceVersion: SOURCE_VERSION,
      oid: "",
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: directText(element),
      textEditable: false,
      selector: element === document.body ? "body" : "html",
      visible: visibleOf(element, computed),
      breadcrumb: [],
      rect: rect,
      box: boxOf(element, computed, rect),
      childrenLayout: childrenLayoutOf(element, computed),
      styles: stylesOf(computed, authoredStyleProperties),
      authoredStyleProperties: authoredStyleProperties
    };
    attachAuthoredStyles(result, element, authoredStyleProperties);
    return result;
  }

  function frameElement() {
    var body = document.body;
    if (body) {
      var roots = Array.from(body.children).filter(function (child) { return !!oidOf(child); });
      // Only explicitly seeded frame shells share the canvas row. An authored
      // main/div may be a small visible layer with its own children and styles.
      if (roots.length === 1 && roots[0].hasAttribute("data-zeros-frame-root")) return roots[0];
    }
    return body || document.documentElement;
  }

  function parsedColor(value) {
    var parts = String(value || "").match(/[0-9.]+/g);
    if (!parts || parts.length < 3) return null;
    return {
      r: Math.max(0, Math.min(255, Number(parts[0]))) / 255,
      g: Math.max(0, Math.min(255, Number(parts[1]))) / 255,
      b: Math.max(0, Math.min(255, Number(parts[2]))) / 255,
      a: parts.length > 3 ? Math.max(0, Math.min(1, Number(parts[3]))) : 1
    };
  }

  function composite(foreground, background) {
    var alpha = foreground.a + background.a * (1 - foreground.a);
    if (alpha <= 0) return { r: 1, g: 1, b: 1, a: 1 };
    return {
      r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
      g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
      b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
      a: alpha
    };
  }

  function backgroundColorOf(element) {
    var layers = [];
    for (var current = element; current && current instanceof Element; current = current.parentElement) {
      var layer = parsedColor(getComputedStyle(current).backgroundColor);
      if (layer && layer.a > 0) layers.push(layer);
    }
    var result = { r: 1, g: 1, b: 1, a: 1 };
    for (var index = layers.length - 1; index >= 0; index -= 1) {
      result = composite(layers[index], result);
    }
    return result;
  }

  function luminance(color) {
    function channel(value) {
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrastRatio(foreground, background) {
    var fg = luminance(composite(foreground, background));
    var bg = luminance(background);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }

  function pixelValue(value) {
    var match = /^(-?[0-9]+(?:\.[0-9]+)?)px$/.exec(String(value || "").trim());
    return match ? Number(match[1]) : null;
  }

  function auditWarnings() {
    var warnings = [];
    var seen = new Set();
    var auditedElements = 0;
    function add(ruleId, oid, message, fix) {
      var key = ruleId + "\u0000" + oid;
      if (seen.has(key) || warnings.length >= MAX_AUDIT_WARNINGS) return;
      seen.add(key);
      warnings.push({ ruleId: ruleId, oid: oid, message: message, fix: fix });
    }
    elementsByOid.forEach(function (element, oid) {
      if (auditedElements >= MAX_AUDIT_ELEMENTS) return;
      auditedElements += 1;
      if (!visibleOf(element)) return;
      var computed = getComputedStyle(element);
      if (
        (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) ||
        (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1)
      ) {
        add(
          "overflow",
          oid,
          "Content overflows this element's layout box.",
          "Increase the box size, allow wrapping, or choose an intentional overflow behavior."
        );
      }
      var spacingProperties = [
        "gap", "rowGap", "columnGap", "paddingTop", "paddingRight",
        "paddingBottom", "paddingLeft", "marginTop", "marginRight",
        "marginBottom", "marginLeft"
      ];
      var offScale = [];
      for (var spacingIndex = 0; spacingIndex < spacingProperties.length; spacingIndex += 1) {
        var spacingProperty = spacingProperties[spacingIndex];
        var pixels = pixelValue(computed[spacingProperty]);
        if (pixels !== null && Math.abs(pixels) > 0.01 && Math.abs(pixels / 4 - Math.round(pixels / 4)) > 0.01) {
          offScale.push(spacingProperty + "=" + pixels + "px");
        }
      }
      if (offScale.length > 0) {
        add(
          "spacing-scale",
          oid,
          "Spacing is off the 4px design scale: " + offScale.slice(0, 3).join(", ") + ".",
          "Use a design spacing token or a multiple of 4px."
        );
      }
      if (directText(element)) {
        var foreground = parsedColor(computed.color);
        if (foreground) {
          var background = backgroundColorOf(element);
          var ratio = contrastRatio(foreground, background);
          var fontSize = pixelValue(computed.fontSize) || 0;
          var weight = Number(computed.fontWeight) || 400;
          var threshold = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700) ? 3 : 4.5;
          if (ratio + 0.01 < threshold) {
            add(
              "contrast",
              oid,
              "Text contrast is " + ratio.toFixed(2) + ":1; this text needs at least " + threshold.toFixed(1) + ":1.",
              "Increase the foreground/background contrast or use a verified color token pair."
            );
          }
        }
      }
    });
    if (elementsByOid.size > MAX_AUDIT_ELEMENTS) {
      add(
        "audit-limit",
        oidOf(frameElement()) || "frame",
        "The design audit sampled the first " + MAX_AUDIT_ELEMENTS + " authored elements.",
        "Audit smaller component scopes when reviewing very large documents."
      );
    }
    return warnings;
  }

  function snapshot(retainAudits) {
    if (structurePreviews.length) return withStructurePresentation(function () { return snapshot(retainAudits); });
    // A snapshot is the semantic cache generation. Theme changes and observed
    // DOM/style mutations both arrive through this boundary.
    authoredStylePropertiesCache = new WeakMap();
    authoredStylesCache = new WeakMap();
    authoredStyleRuleMetadata = null;
    cascadeRuleIndex = null;
    oidStyleRuleIndex = null;
    refreshElementMap();
    var roots = [];
    var treeBudget = { count: 0, truncated: false };
    var body = document.body;
    if (body && oidOf(body)) {
      var bodyNode = treeNode(body, 0, treeBudget);
      if (bodyNode) roots.push(bodyNode);
    } else if (body) {
      for (var index = 0; index < body.children.length; index += 1) {
        var child = body.children[index];
        if (!oidOf(child)) continue;
        var rootNode = treeNode(child, 0, treeBudget);
        if (rootNode) roots.push(rootNode);
      }
    }
    // Structural adoption needs current ancestry immediately. Contrast/style
    // audits are separate readback work, coalesced by the host after editing.
    var warnings = retainAudits && lastSnapshot
      ? lastSnapshot.warnings.filter(function (warning) { return warning.ruleId !== "layer-tree-limit" && elementsByOid.has(warning.oid); })
      : auditWarnings();
    if (treeBudget.truncated) {
      warnings.unshift({
        ruleId: "layer-tree-limit",
        oid: oidOf(frameElement()) || "frame",
        message: "Layers were bounded to " + MAX_TREE_NODES + " nodes and " + MAX_TREE_DEPTH + " nested levels.",
        fix: "Split this document into smaller frames or components before editing deeper layers."
      });
      if (warnings.length > MAX_AUDIT_WARNINGS) warnings.length = MAX_AUDIT_WARNINGS;
    }
    var result = {
      sourceVersion: SOURCE_VERSION,
      revision: revision,
      tree: roots,
      frame: frameDetailsOf(frameElement()),
      warnings: warnings,
      viewport: {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    };
    lastSnapshot = result;
    return result;
  }

  function styleOnlySnapshot() {
    if (!lastSnapshot) return snapshot();
    authoredStylePropertiesCache = new WeakMap();
    authoredStylesCache = new WeakMap();
    authoredStyleRuleMetadata = null;
    cascadeRuleIndex = null;
    oidStyleRuleIndex = null;
    ensureElementMap();
    var result = {
      sourceVersion: SOURCE_VERSION,
      revision: revision,
      tree: lastSnapshot.tree,
      frame: frameDetailsOf(frameElement()),
      // The engine mutation response owns the authoritative lint refresh. Keep
      // runtime audit payloads off the pointer-up path; the next requested or
      // observed full snapshot recomputes this bounded list.
      warnings: lastSnapshot.warnings,
      viewport: {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    };
    lastSnapshot = result;
    return result;
  }

  function ensureElementMap() {
    if (elementMapStale) refreshElementMap();
  }

  function elementForOid(oid) {
    if (typeof oid !== "string" || !oid) {
      throw new Error("nodeId must be a non-empty data-oid.");
    }
    ensureElementMap();
    var element = elementsByOid.get(oid);
    if (!element) {
      // A miss is the one case worth a walk: an element can only arrive through
      // a path the observer saw, but a rebuild here keeps that a fact.
      refreshElementMap();
      element = elementsByOid.get(oid);
    }
    if (!element) throw new Error("Element not found: " + oid);
    return element;
  }

  function editableOidPath(element) {
    var path = [];
    var current = element;
    while (current && current instanceof Element) {
      if (oidOf(current)) path.push(current);
      current = composedParentOf(current);
    }
    path.reverse();
    // Legacy documents may put a frame oid on <body>. It is an ownership
    // shell, not the first editable top-level layer when descendants exist.
    if (path.length > 1 && path[0] === document.body) path.shift();
    return path;
  }

  function elementAtLoc(x, y, mode, selectedNodeId) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("x and y must be finite frame coordinates.");
    }
    var stack = deepElementsFromPoint(x, y);
    for (var index = 0; index < stack.length; index += 1) {
      var path = editableOidPath(stack[index]);
      if (path.length === 0) continue;
      var hitMode = mode === "deepest" || mode === "top-level" ||
        mode === "preserve" || mode === "descend" ? mode : "deepest";
      var chosen = hitMode === "deepest" ? path[path.length - 1] : path[0];
      if (hitMode === "preserve" || hitMode === "descend") {
        var selectedIndex = -1;
        for (var pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
          if (oidOf(path[pathIndex]) === selectedNodeId) selectedIndex = pathIndex;
        }
        if (hitMode === "preserve" && selectedIndex >= 0) {
          chosen = path[selectedIndex];
        } else if (hitMode === "descend" && selectedIndex >= 0) {
          chosen = path[Math.min(selectedIndex + 1, path.length - 1)];
        } else if (typeof selectedNodeId === "string" && selectedNodeId) {
          refreshElementMap();
          var selectedElement = elementsByOid.get(selectedNodeId);
          if (selectedElement) {
            var selectedDepth = editableOidPath(selectedElement).length;
            var targetIndex = Math.min(
              path.length - 1,
              Math.max(0, selectedDepth - 1 + (hitMode === "descend" ? 1 : 0))
            );
            chosen = path[targetIndex];
          }
        }
      }
      return detailsOf(chosen);
    }
    return null;
  }

  function elementsInRect(x, y, width, height, scopeNodeId) {
    if (
      !Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 0 || height < 0 || width > 100000 || height > 100000
    ) {
      throw new Error("Selection rectangle must contain bounded finite coordinates.");
    }
    ensureElementMap();
    var scope = scopeNodeId ? elementForOid(scopeNodeId) : document.body;
    var right = x + width;
    var bottom = y + height;
    var result = [];
    var scopeChildren = composedChildrenOf(scope);
    for (var index = 0; index < scopeChildren.length; index += 1) {
      var element = scopeChildren[index];
      if (!oidOf(element) || !visibleOf(element)) continue;
      var rect = rectOf(element);
      if (rect.width <= 0 || rect.height <= 0) continue;
      var intersects =
        rect.x < right && rect.x + rect.width > x &&
        rect.y < bottom && rect.y + rect.height > y;
      if (intersects) result.push(detailsOf(element));
      if (result.length >= 128) break;
    }
    return result;
  }

  function withoutObservedMutations(work) {
    var resume = observer && observing;
    if (resume) {
      // Authored scripts are stripped and blocked by CSP, so every mutation
      // source in this document is runtime-owned. Disconnecting before preview
      // writes suppresses only ephemeral runtime churn; revisit this if authored
      // execution is ever introduced.
      observer.takeRecords();
      observer.disconnect();
      observing = false;
    }
    try {
      return work();
    } finally {
      if (resume && !disposed) startObserving();
    }
  }

  function detailsAfterLayout(element) {
    return new Promise(function (resolve) {
      var settled = false;
      var fallback = null;
      function finish() {
        if (settled) return;
        settled = true;
        if (fallback !== null) window.clearTimeout(fallback);
        resolve(detailsOf(element));
      }
      fallback = window.setTimeout(finish, 50);
      if (document.visibilityState !== "visible") {
        finish();
        return;
      }
      window.requestAnimationFrame(finish);
    });
  }

  function setNodeVisibility(oid, visible) {
    var element = elementForOid(oid);
    var changed = withoutObservedMutations(function () {
      var wasVisible = visibleOf(element);
      var prior = visibilityOverridesByOid.get(oid);
      if (!prior) {
        prior = {
          value: element.style.getPropertyValue("display"),
          priority: element.style.getPropertyPriority("display"),
          hidden: element.hidden
        };
        visibilityOverridesByOid.set(oid, prior);
      }
      if (visible) {
        element.hidden = false;
        if (prior.value) {
          element.style.setProperty("display", prior.value, prior.priority);
        } else {
          element.style.removeProperty("display");
        }
        if (!visibleOf(element)) {
          element.style.setProperty("display", "revert", "important");
        }
      } else {
        element.hidden = prior.hidden;
        element.style.setProperty("display", "none", "important");
      }
      return visibleOf(element) !== wasVisible;
    });
    // Visibility is a semantic document change, not ephemeral preview churn.
    // The observer is suppressed across the write, so publish the resulting
    // generation here: the host's layer tree must carry the new visible flags
    // within this interaction, or its next toggle would repeat this one.
    if (changed) publishGenerationNow();
    return detailsAfterLayout(element);
  }

  function setTheme(theme) {
    if (theme !== null && (typeof theme !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(theme))) {
      throw new Error("theme must be null or a portable theme name.");
    }
    var currentTheme = document.documentElement.getAttribute("data-zd-theme");
    // Re-applying the active mode is a semantic no-op. Reuse the exact cached
    // snapshot so the host store can preserve reference identity and avoid a
    // second React commit during iframe readiness.
    if (currentTheme === theme) return lastSnapshot || snapshot();
    withoutObservedMutations(function () {
      if (theme === null) document.documentElement.removeAttribute("data-zd-theme");
      else document.documentElement.setAttribute("data-zd-theme", theme);
    });
    suspendAuthoredMotion();
    revision += 1;
    return snapshot();
  }

  /** Show a linked Design stylesheet's in-flight text in place of its inlined
   * copy (data-zeros-source), or restore the generation's text with null.
   * Only this document changes; the saved generation replaces it. */
  function previewStylesheet(file, css) {
    if (typeof file !== "string" || !file || file.length > 1024) {
      throw new Error("file must be a Design stylesheet path.");
    }
    if (css !== null && (typeof css !== "string" || css.length > MAX_PREVIEW_STYLESHEET_CHARS)) {
      throw new Error("css must be null or bounded stylesheet text.");
    }
    var sheets = Array.prototype.filter.call(
      document.querySelectorAll("style[data-zeros-source]"),
      function (element) { return element.getAttribute("data-zeros-source") === file; }
    );
    var applied = 0;
    var changed = false;
    withoutObservedMutations(function () {
      sheets.forEach(function (element) {
        applied += 1;
        if (css === null) {
          if (!previewStylesheetTexts.has(element)) return;
          element.textContent = previewStylesheetTexts.get(element);
          previewStylesheetTexts.delete(element);
          changed = true;
          return;
        }
        if (!previewStylesheetTexts.has(element)) previewStylesheetTexts.set(element, element.textContent);
        if (element.textContent === css) return;
        element.textContent = css;
        changed = true;
      });
    });
    if (!changed) return { applied: applied, snapshot: lastSnapshot || snapshot() };
    suspendAuthoredMotion();
    revision += 1;
    return { applied: applied, snapshot: styleOnlySnapshot() };
  }

  function previewStyleProperties(property) {
    var probe = document.createElement("div").style;
    probe.setProperty(property, "initial");
    return probe.length ? Array.from(probe) : [property];
  }

  function restorePreviewStyle(element, prior) {
    prior.effects.forEach(function (effect) {
      if (effect.value) element.style.setProperty(effect.property, effect.value, effect.priority);
      else element.style.removeProperty(effect.property);
      if (prior.rule) {
        if (effect.ruleValue) prior.rule.style.setProperty(effect.property, effect.ruleValue, effect.rulePriority);
        else prior.rule.style.removeProperty(effect.property);
      }
    });
  }

  function applyPreviewStyles(element, oid, styles) {
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
      throw new Error("styles must be an object.");
    }
    var entries = Object.entries(styles);
    if (entries.length < 1 || entries.length > 64) {
      throw new Error("styles must contain between 1 and 64 properties.");
    }
    entries.forEach(function (entry) {
      if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(entry[0]) || (typeof entry[1] !== "string" && entry[1] !== null)) throw new Error("Invalid preview style: " + entry[0]);
    });
    var priorByProperty = previewStyleOverridesByOid.get(oid);
    var entering = !priorByProperty;
    if (!priorByProperty) {
      priorByProperty = new Map();
      previewStyleOverridesByOid.set(oid, priorByProperty);
    }
    if (entries.some(function (entry) { return !priorByProperty.has(entry[0]); })) {
      var originalInline = document.createElement("div").style;
      originalInline.cssText = element.style.cssText;
      var originalRules = new Map();
      priorByProperty.forEach(function (prior) {
        if (prior.rule && !originalRules.has(prior.rule)) {
          var original = document.createElement("div").style;
          original.cssText = prior.rule.style.cssText;
          originalRules.set(prior.rule, original);
        }
        prior.effects.forEach(function (effect) {
          if (effect.value) originalInline.setProperty(effect.property, effect.value, effect.priority);
          else originalInline.removeProperty(effect.property);
          if (prior.rule) {
            var rule = originalRules.get(prior.rule);
            if (effect.ruleValue) rule.setProperty(effect.property, effect.ruleValue, effect.rulePriority);
            else rule.removeProperty(effect.property);
          }
        });
      });
      entries.forEach(function (entry) {
        var property = entry[0];
        if (priorByProperty.has(property)) return;
        var inlineValue = originalInline.getPropertyValue(property);
        var exactRules = inlineValue ? [] : exactTopLevelStyleRules(oid, property);
        var rule = exactRules.length === 1 ? exactRules[0] : null;
        var originalRule = rule ? originalRules.get(rule) || rule.style : null;
        priorByProperty.set(property, {
          value: inlineValue,
          priority: originalInline.getPropertyPriority(property),
          rule: rule,
          ruleValue: originalRule ? originalRule.getPropertyValue(property) : "",
          rulePriority: originalRule ? originalRule.getPropertyPriority(property) : "",
          effects: previewStyleProperties(property).map(function (affected) {
            return {
              property: affected,
              value: originalInline.getPropertyValue(affected),
              priority: originalInline.getPropertyPriority(affected),
              ruleValue: originalRule ? originalRule.getPropertyValue(affected) : "",
              rulePriority: originalRule ? originalRule.getPropertyPriority(affected) : ""
            };
          })
        });
      });
    }
    withoutObservedMutations(function () {
      for (var index = 0; index < entries.length; index += 1) {
        var property = entries[index][0];
        var value = entries[index][1];
        var prior = priorByProperty.get(property);
        prior.latestValue = value;
        if (prior.rule) {
          element.style.removeProperty(property);
          if (value === null) prior.rule.style.removeProperty(property);
          else prior.rule.style.setProperty(property, value, prior.rulePriority);
        } else if (value === null) element.style.removeProperty(property);
        else element.style.setProperty(property, value, prior.priority);
      }
    });
    // The first write of a preview clears the document, because anything already
    // running would repaint against the editor. Every later write in the same
    // preview can only have started something on this element.
    if (entering) suspendAuthoredMotion();
    else suspendElementMotion(element);
  }

  function previewStyles(oid, styles) {
    var element = elementForOid(oid);
    applyPreviewStyles(element, oid, styles);
    return detailsAfterLayout(element);
  }

  function geometryStylesOf(computed) {
    var styles = {};
    for (var index = 0; index < GEOMETRY_STYLE_PROPERTIES.length; index += 1) {
      var property = GEOMETRY_STYLE_PROPERTIES[index];
      styles[property] = computed[property] || "";
    }
    return styles;
  }

  /** Measure one element the way a gesture needs it: in this task, right after
   * the write, with no animation frame in between.
   *
   * Reading a rect flushes layout synchronously, so the first read already
   * reflects the styles just applied — and every later read in this same task is
   * free, which is what lets the children come along without a second reflow. */
  function geometryOf(element, includeChildren) {
    var oid = targetOidOf(element);
    if (!oid) throw new Error("The selected element has no stable data-oid.");
    var computed = getComputedStyle(element);
    var rect = rectOf(element);
    var box = boxOf(element, computed, rect);
    var transformed = box.rotation !== 0 || box.scaleX !== 1 || box.scaleY !== 1;
    var children = [];
    if (includeChildren) {
      var geometryChildren = composedChildrenOf(element);
      for (var index = 0; index < geometryChildren.length; index += 1) {
        if (children.length >= GEOMETRY_CHILD_LIMIT || index >= ${DESIGN_LAYOUT_CHILD_LIMIT}) break;
        var child = geometryChildren[index];
        var childOid = oidOf(child);
        if (!childOid || child.hidden) continue;
        var childComputed = getComputedStyle(child);
        // Layout participation, not paint: a visibility:hidden item still holds
        // its slot, while display:none and display:contents boxes hold none.
        if (childComputed.display === "none" || childComputed.display === "contents") continue;
        var childRect = rectOf(child);
        if (childRect.width <= 0 && childRect.height <= 0) continue;
        var entry = {
          oid: childOid,
          rect: childRect,
          name: nameOf(child),
          // Margins are part of the space between two boxes but not the gap.
          styles: {
            position: childComputed.position || "",
            order: childComputed.order || "",
            marginTop: childComputed.marginTop || "",
            marginRight: childComputed.marginRight || "",
            marginBottom: childComputed.marginBottom || "",
            marginLeft: childComputed.marginLeft || ""
          }
        };
        if (childComputed.visibility === "hidden" || childComputed.visibility === "collapse") {
          entry.hidden = true;
        }
        if (transformed) {
          var childLayout = layoutOf(child, childComputed);
          var childSize = borderBoxSizeOf(childComputed);
          // Layout offsets ignore scrolling; the painted box does not.
          entry.local = {
            x: childLayout.x - (element.scrollLeft || 0),
            y: childLayout.y - (element.scrollTop || 0),
            width: childSize ? childSize.width : childRect.width,
            height: childSize ? childSize.height : childRect.height
          };
        }
        children.push(entry);
      }
    }
    return {
      sourceVersion: SOURCE_VERSION,
      oid: oid,
      rect: rect,
      box: box,
      borderCoordinateSpace: borderCoordinateSpaceOf(element, computed, rect),
      parentCoordinateSpace: parentCoordinateSpaceOf(element),
      styles: geometryStylesOf(computed),
      children: children
    };
  }

  function previewGeometry(oid, styles, includeChildren) {
    var element = elementForOid(oid);
    if (styles !== undefined && styles !== null) {
      applyPreviewStyles(element, oid, styles);
    }
    return geometryOf(element, includeChildren === true);
  }

  /** Mirror an uncontrolled inline editor into the exact painted element.
   * The authored text is retained once and restored on Escape or teardown. */
  function restoreTextPreviewPaint(element, preview) {
    preview.paint.forEach(function (prior, property) {
      if (prior.value) element.style.setProperty(property, prior.value, prior.priority);
      else element.style.removeProperty(property);
    });
  }

  function previewText(oid, text) {
    var element = elementForOid(oid);
    if (!textEditableOf(element)) {
      throw new Error("The selected element cannot be edited as direct text.");
    }
    if (typeof text !== "string" || text.length > 10000) {
      throw new Error("text must be a string no longer than 10000 characters.");
    }
    if (!previewTextOverridesByOid.has(oid)) {
      var paint = new Map();
      // Preserve semantic/computed color while the host editor owns glyph
      // paint. Selection readback can occur during this transient preview;
      // changing color here would make a later contenteditable transparent.
      ["text-shadow", "text-decoration-color", "-webkit-text-fill-color", "-webkit-text-stroke-color"].forEach(function (property) {
        paint.set(property, {
          value: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property)
        });
      });
      previewTextOverridesByOid.set(oid, { text: element.textContent || "", paint: paint });
    }
    withoutObservedMutations(function () {
      element.textContent = text;
      element.style.setProperty("text-shadow", "none", "important");
      element.style.setProperty("text-decoration-color", "transparent", "important");
      element.style.setProperty("-webkit-text-fill-color", "transparent", "important");
      element.style.setProperty("-webkit-text-stroke-color", "transparent", "important");
    });
    return detailsAfterLayout(element);
  }

  function clearPreviewText(oid) {
    var element = elementForOid(oid);
    if (!previewTextOverridesByOid.has(oid)) {
      return detailsAfterLayout(element);
    }
    var preview = previewTextOverridesByOid.get(oid);
    withoutObservedMutations(function () {
      element.textContent = preview.text;
      restoreTextPreviewPaint(element, preview);
      previewTextOverridesByOid.delete(oid);
    });
    return detailsAfterLayout(element);
  }

  /** Every top-level data-oid attribute rule, grouped by the oid it names.
   *
   * The first preview of each property has to find the authored rule behind it,
   * and doing that per property meant walking every rule of every sheet again —
   * on a utility-class document that is tens of thousands of comparisons at the
   * exact moment a drag begins. One pass per generation answers all of them; the
   * index drops with the other style caches whenever the document changes. */
  function styleRulesByOid() {
    if (oidStyleRuleIndex !== null) return oidStyleRuleIndex;
    var index = new Map();
    var selectorPattern = /^\[\s*data-oid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]$/i;
    for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex += 1) {
      var rules;
      try { rules = document.styleSheets[sheetIndex].cssRules || []; }
      catch (_error) { continue; }
      for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
        var rule = rules[ruleIndex];
        if (rule.type !== CSSRule.STYLE_RULE || !rule.selectorText || !rule.style) continue;
        var selectorMatch = selectorPattern.exec(rule.selectorText.trim());
        var ruleOid = rule.selectorText.trim() === "body"
          ? ${JSON.stringify(DESIGN_RUNTIME_DOCUMENT_BODY_ID)}
          : selectorMatch ? selectorMatch[1] || selectorMatch[2] || selectorMatch[3] || "" : "";
        if (!ruleOid) continue;
        var bucket = index.get(ruleOid);
        if (!bucket) {
          bucket = [];
          index.set(ruleOid, bucket);
        }
        bucket.push(rule);
      }
    }
    oidStyleRuleIndex = index;
    return index;
  }

  function exactTopLevelStyleRules(oid, property) {
    var candidates = styleRulesByOid().get(oid);
    if (!candidates) return [];
    var matches = [];
    for (var index = 0; index < candidates.length; index += 1) {
      if (declarationProperties(candidates[index].style).indexOf(property) === -1) {
        continue;
      }
      matches.push(candidates[index]);
    }
    return matches;
  }

  function prepareGenerationPatch(patch) {
    if (patch === undefined || patch === null) {
      return {
        changed: false,
        keyframeUpdates: [],
        keyframes: committedKeyframesByName,
        tokenUpdates: [],
        tokens: committedTokensByKey
      };
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Committed generation patch must be an object.");
    }
    var patchKeys = Object.keys(patch);
    if (patchKeys.some(function (key) { return key !== "keyframes" && key !== "tokens"; })) {
      throw new Error("Committed generation patch contains an unknown field.");
    }
    var keyframeUpdates = patch.keyframes === undefined ? [] : patch.keyframes;
    var tokenUpdates = patch.tokens === undefined ? [] : patch.tokens;
    if (!Array.isArray(keyframeUpdates) || keyframeUpdates.length > 32) {
      throw new Error("Committed keyframes must be a bounded array.");
    }
    if (!Array.isArray(tokenUpdates) || tokenUpdates.length > 128) {
      throw new Error("Committed tokens must be a bounded array.");
    }
    var nextKeyframes = new Map(committedKeyframesByName);
    keyframeUpdates.forEach(function (definition) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw new Error("Each committed keyframe definition must be an object.");
      }
      if (
        typeof definition.name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(definition.name) ||
        !Array.isArray(definition.keyframes) ||
        definition.keyframes.length < 2 ||
        definition.keyframes.length > 32
      ) {
        throw new Error("Invalid committed keyframe definition.");
      }
      var seenOffsets = new Set();
      var keyframes = definition.keyframes.map(function (keyframe) {
        if (!keyframe || typeof keyframe !== "object" || Array.isArray(keyframe)) {
          throw new Error("Each committed keyframe must be an object.");
        }
        var offset = Number(keyframe.offset);
        var styles = keyframe.styles;
        if (
          !Number.isFinite(offset) ||
          offset < 0 ||
          offset > 100 ||
          seenOffsets.has(offset) ||
          !styles ||
          typeof styles !== "object" ||
          Array.isArray(styles)
        ) {
          throw new Error("Invalid committed keyframe.");
        }
        seenOffsets.add(offset);
        var entries = Object.entries(styles);
        if (entries.length < 1 || entries.length > 64) {
          throw new Error("Committed keyframe styles must be bounded.");
        }
        entries.forEach(function (entry) {
          if (
            !/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(entry[0]) ||
            typeof entry[1] !== "string" ||
            entry[1].length > 2048
          ) {
            throw new Error("Invalid committed keyframe style: " + entry[0]);
          }
        });
        return { offset: offset, styles: Object.fromEntries(entries) };
      });
      nextKeyframes.set(definition.name, {
        name: definition.name,
        keyframes: keyframes
      });
    });
    var nextTokens = new Map(committedTokensByKey);
    tokenUpdates.forEach(function (token) {
      if (!token || typeof token !== "object" || Array.isArray(token)) {
        throw new Error("Each committed token must be an object.");
      }
      if (
        typeof token.name !== "string" ||
        !/^--[A-Za-z0-9_-]{1,126}$/.test(token.name) ||
        (token.theme !== null &&
          (typeof token.theme !== "string" ||
            !/^[a-z][a-z0-9_-]{0,63}$/.test(token.theme))) ||
        typeof token.value !== "string" ||
        token.value.length > 2048
      ) {
        throw new Error("Invalid committed design token.");
      }
      nextTokens.set(String(token.theme || "") + "\u0000" + token.name, {
        name: token.name,
        theme: token.theme,
        value: token.value
      });
    });
    return {
      changed: keyframeUpdates.length > 0 || tokenUpdates.length > 0,
      keyframeUpdates: keyframeUpdates.map(function (definition) {
        return nextKeyframes.get(definition.name);
      }),
      keyframes: nextKeyframes,
      tokenUpdates: tokenUpdates.map(function (token) {
        return nextTokens.get(String(token.theme || "") + "\u0000" + token.name);
      }),
      tokens: nextTokens
    };
  }

  function removeTopLevelRule(sheet, target) {
    for (var index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
      if (sheet.cssRules[index] === target) {
        sheet.deleteRule(index);
        return;
      }
    }
  }

  function baseTokenInsertionIndex(sheet, tokenRulesByKey) {
    var namedRules = new Set();
    tokenRulesByKey.forEach(function (rule, key) {
      if (key.slice(0, key.indexOf("\u0000"))) namedRules.add(rule);
    });
    for (var index = 0; index < sheet.cssRules.length; index += 1) {
      if (namedRules.has(sheet.cssRules[index])) return index;
    }
    return sheet.cssRules.length;
  }

  function keyframeDefinitionsEqual(left, right) {
    if (!left || !right || left.name !== right.name) return false;
    if (left.keyframes.length !== right.keyframes.length) return false;
    return left.keyframes.every(function (leftFrame, index) {
      var rightFrame = right.keyframes[index];
      if (!rightFrame || leftFrame.offset !== rightFrame.offset) return false;
      var leftEntries = Object.entries(leftFrame.styles);
      var rightEntries = Object.entries(rightFrame.styles);
      if (leftEntries.length !== rightEntries.length) return false;
      return leftEntries.every(function (entry) {
        return rightFrame.styles[entry[0]] === entry[1];
      });
    });
  }

  function replaceKeyframeRule(rule, definition) {
    for (var index = rule.cssRules.length - 1; index >= 0; index -= 1) {
      rule.deleteRule(rule.cssRules[index].keyText);
    }
    definition.keyframes.forEach(function (keyframe) {
      rule.appendRule(String(keyframe.offset) + "% {}");
      var frameRule = rule.cssRules[rule.cssRules.length - 1];
      if (!frameRule || !frameRule.style) {
        throw new Error("Committed keyframe rule is unavailable.");
      }
      Object.entries(keyframe.styles).forEach(function (entry) {
        frameRule.style.setProperty(entry[0], entry[1]);
      });
    });
  }

  /**
   * Patch only generation dependencies named by the confirmed update. Keeping
   * the style element and unrelated CSSRule objects alive avoids invalidating
   * every token, animation, and glyph run for a one-property edit.
   */
  function applyCommittedGenerationPatch(plan) {
    var style = committedGenerationStyle;
    var created = !style || !style.isConnected || !style.sheet;
    if (created) {
      style = document.createElement("style");
      style.setAttribute("data-zeros-runtime-generation", "");
      style.setAttribute("media", "not all");
      (document.head || document.documentElement).appendChild(style);
    }
    var sheet = style.sheet;
    if (!sheet) {
      if (created) style.remove();
      throw new Error("Committed generation stylesheet is unavailable.");
    }

    var nextKeyframeRules = created
      ? new Map()
      : new Map(committedKeyframeRulesByName);
    var nextTokenRules = created ? new Map() : new Map(committedTokenRulesByKey);
    var keyframeDefinitions = created
      ? Array.from(plan.keyframes.values())
      : plan.keyframeUpdates;
    var tokenDefinitions = created
      ? Array.from(plan.tokens.values())
      : plan.tokenUpdates;
    var rollback = [];

    try {
      tokenDefinitions.forEach(function (token) {
        var key = String(token.theme || "") + "\u0000" + token.name;
        var existing = committedTokensByKey.get(key);
        if (
          !created &&
          existing &&
          existing.name === token.name &&
          existing.theme === token.theme &&
          existing.value === token.value
        ) return;
        var rule = nextTokenRules.get(key);
        if (!rule) {
          var selector = token.theme === null
            ? ":root"
            : '[data-zd-theme="' + token.theme + '"]';
          var insertionIndex = token.theme === null
            ? baseTokenInsertionIndex(sheet, nextTokenRules)
            : sheet.cssRules.length;
          var ruleIndex = sheet.insertRule(selector + " {}", insertionIndex);
          rule = sheet.cssRules[ruleIndex];
          if (!rule || !rule.style) {
            throw new Error("Committed token rule is unavailable.");
          }
          nextTokenRules.set(key, rule);
          rollback.push(function () { removeTopLevelRule(sheet, rule); });
        } else {
          var previousValue = rule.style.getPropertyValue(token.name);
          var previousPriority = rule.style.getPropertyPriority(token.name);
          rollback.push(function () {
            if (previousValue) {
              rule.style.setProperty(token.name, previousValue, previousPriority);
            } else {
              rule.style.removeProperty(token.name);
            }
          });
        }
        rule.style.setProperty(token.name, token.value);
      });

      keyframeDefinitions.forEach(function (definition) {
        var existing = committedKeyframesByName.get(definition.name);
        if (!created && keyframeDefinitionsEqual(existing, definition)) return;
        var rule = nextKeyframeRules.get(definition.name);
        if (!rule) {
          var ruleIndex = sheet.insertRule(
            "@keyframes " + definition.name + " {}",
            sheet.cssRules.length
          );
          rule = sheet.cssRules[ruleIndex];
          if (!rule || typeof rule.appendRule !== "function") {
            throw new Error("Committed keyframes rule is unavailable.");
          }
          nextKeyframeRules.set(definition.name, rule);
          rollback.push(function () { removeTopLevelRule(sheet, rule); });
        } else {
          var previousDefinition = existing;
          rollback.push(function () {
            if (previousDefinition) replaceKeyframeRule(rule, previousDefinition);
          });
        }
        replaceKeyframeRule(rule, definition);
      });

      if (created) style.removeAttribute("media");
      committedGenerationStyle = style;
      committedKeyframeRulesByName = nextKeyframeRules;
      committedTokenRulesByKey = nextTokenRules;
      committedKeyframesByName = plan.keyframes;
      committedTokensByKey = plan.tokens;
    } catch (error) {
      if (created) {
        style.remove();
      } else {
        for (var index = rollback.length - 1; index >= 0; index -= 1) {
          try { rollback[index](); } catch (_rollbackError) {}
        }
      }
      throw error;
    }
  }

  /**
   * Commit an engine-confirmed visual mutation into this already-painted
   * document, then advance the source CAS generation on the same private port.
   * Every update is validated before the first write so malformed input cannot
   * leave a partially adopted canvas.
   */
  var previewMovesByOid = new Map();
  var previewInsertsByOid = new Map();
  var generationHistory = [];
  var paintedSourceVersion = SOURCE_VERSION;
  var historyPresentationTarget = null;
  var historyPresentationMeasure = [];
  var INSERT_PARENT_REJECTED = /^(AREA|BASE|BR|COL|COLGROUP|EMBED|HR|IMG|INPUT|LINK|META|PARAM|SOURCE|TRACK|WBR|SELECT|OPTION|OPTGROUP|TABLE|THEAD|TBODY|TFOOT|TR|UL|OL|DL|SCRIPT|STYLE|TEMPLATE|TEXTAREA|IFRAME|SVG)$/i;

  /** Validate every insert before the first write. A previewed element is the
   * same node a later commit confirms; any other existing id is a conflict. */
  function prepareInserts(inserts) {
    if (inserts === undefined) return [];
    if (enabledOptInMethods.indexOf("previewInsert") < 0) throw new Error("Layer inserts require previewInsert.");
    if (!Array.isArray(inserts) || inserts.length < 1 || inserts.length > 8) throw new Error("Invalid layer inserts.");
    var seen = new Set();
    return inserts.map(function (insert) {
      if (!insert || typeof insert !== "object" || Array.isArray(insert) ||
          typeof insert.nodeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(insert.nodeId) ||
          typeof insert.parentId !== "string" || insert.tag !== "div" ||
          typeof insert.style !== "string" || insert.style.length > 4096 ||
          (insert.beforeId !== null && typeof insert.beforeId !== "string")) {
        throw new Error("Invalid layer insert.");
      }
      if (seen.has(insert.nodeId)) throw new Error("Duplicate layer insert.");
      seen.add(insert.nodeId);
      var parent = elementForOid(insert.parentId);
      if (parent === document.documentElement || INSERT_PARENT_REJECTED.test(parent.tagName)) {
        throw new Error("This layer cannot contain a frame.");
      }
      var before = insert.beforeId ? elementForOid(insert.beforeId) : null;
      if (before && before.parentElement !== parent) throw new Error("Invalid layer insert position.");
      var previewed = previewInsertsByOid.get(insert.nodeId) || null;
      ensureElementMap();
      var existing = elementsByOid.get(insert.nodeId);
      if (existing && (!previewed || existing !== previewed.element)) {
        throw new Error("Layer already exists: " + insert.nodeId);
      }
      return { oid: insert.nodeId, parent: parent, before: before, style: insert.style, previewed: previewed };
    });
  }

  function insertedElement(plan) {
    var element = document.createElement("div");
    element.setAttribute("data-oid", plan.oid);
    element.setAttribute("style", plan.style);
    return element;
  }

  /** Restore only the parent properties an insert preview wrote and no other
   * live insert preview still claims; other previews keep their baseline. */
  function restoreInsertParentStyles(parentStyles) {
    parentStyles.forEach(function (entry) {
      var element = elementsByOid.get(entry.oid);
      var priorByProperty = previewStyleOverridesByOid.get(entry.oid);
      if (!element || !priorByProperty) return;
      var claimed = new Set();
      previewInsertsByOid.forEach(function (preview) {
        preview.parentStyles.forEach(function (other) {
          if (other.oid === entry.oid) other.properties.forEach(function (property) { claimed.add(property); });
        });
      });
      entry.properties.forEach(function (property) {
        var prior = priorByProperty.get(property);
        if (!prior || claimed.has(property)) return;
        restorePreviewStyle(element, prior);
        priorByProperty.delete(property);
      });
      if (priorByProperty.size === 0) previewStyleOverridesByOid.delete(entry.oid);
    });
  }

  /** Remove previewed inserts: the named ones, or all of them. A preview lives
   * until its own commit adopts it, its author cancels it, or a preview with
   * the same id replaces it; another generation's commit never retires it. */
  function clearInsertPreviews(only) {
    if (!previewInsertsByOid.size) return false;
    var removed = false;
    withoutObservedMutations(function () {
      Array.from(previewInsertsByOid.entries()).reverse().forEach(function (entry) {
        if (only && !only.has(entry[0])) return;
        var preview = entry[1];
        if (preview.element.parentNode) preview.element.parentNode.removeChild(preview.element);
        previewInsertsByOid.delete(entry[0]);
        restoreInsertParentStyles(preview.parentStyles);
        removed = true;
      });
    });
    // The tree changed without an observed mutation: advance the semantic
    // generation so hosts never mistake this snapshot for the previous one.
    if (removed) {
      refreshElementMap();
      revision += 1;
    }
    return removed;
  }

  /** Paint a drawn layer before the engine confirms it. Latest preview wins;
   * a commit with the same inserts adopts these exact elements. */
  function previewInsert(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid insert preview.");
    var updates = args.updates === undefined ? [] : args.updates;
    if (!Array.isArray(updates) || updates.length > 8) throw new Error("Invalid insert parent styles.");
    if (Array.isArray(args.inserts)) {
      clearInsertPreviews(new Set(args.inserts.map(function (insert) { return insert && insert.nodeId; })));
    }
    var plans = prepareInserts(args.inserts);
    if (previewInsertsByOid.size + plans.length > 8) throw new Error("Too many pending layer inserts.");
    var parentStyles = updates.map(function (update) {
      if (!update || typeof update !== "object" || typeof update.nodeId !== "string" ||
          !update.styles || typeof update.styles !== "object" || Array.isArray(update.styles)) {
        throw new Error("Invalid insert parent style.");
      }
      return { oid: update.nodeId, element: elementForOid(update.nodeId), styles: update.styles, properties: Object.keys(update.styles) };
    });
    var inserted = [];
    withoutObservedMutations(function () {
      parentStyles.forEach(function (entry) { applyPreviewStyles(entry.element, entry.oid, entry.styles); });
      plans.forEach(function (plan) {
        var element = insertedElement(plan);
        plan.parent.insertBefore(element, plan.before);
        // Every insert of the batch claims the parent styles it needs, so
        // cancelling one keeps them while a sibling preview remains.
        previewInsertsByOid.set(plan.oid, { element: element, parentStyles: parentStyles });
        inserted.push(element);
      });
    });
    revision += 1;
    var nextSnapshot = snapshot();
    return { snapshot: nextSnapshot, details: inserted.map(function (element) { return detailsOf(element); }) };
  }

  function clearPreviewInserts(nodeIds) {
    if (nodeIds !== undefined && (!Array.isArray(nodeIds) || nodeIds.length > 8 ||
        nodeIds.some(function (oid) { return typeof oid !== "string"; }))) {
      throw new Error("Invalid insert preview ids.");
    }
    clearInsertPreviews(nodeIds === undefined ? null : new Set(nodeIds));
    return { snapshot: snapshot() };
  }
  var dragPaintStyle = null;

  function suppressDragPaint(oid) {
    if (oid === undefined) return;
    var element = oid === null ? null : elementForOid(oid);
    if (dragPaintStyle) dragPaintStyle.remove();
    dragPaintStyle = null;
    if (!element) return;
    var style = document.createElement("style");
    var selector = element === document.body ? "body" : '[data-oid="' + CSS.escape(oid) + '"]';
    style.textContent = selector + "{opacity:0!important}";
    document.head.appendChild(style);
    dragPaintStyle = style;
  }

  /** A gesture needs containers and siblings, never thousands of SVG paths.
   * Prioritize its exact selected ancestry before the bounded context scan so
   * document order cannot make a late selected layer uneditable. */
  function layoutTargets(args) {
    ensureElementMap();
    var selected = args.nodeId ? elementForOid(args.nodeId) : null;
    var found = new Set();
    function add(element) {
      if (!element || found.size >= 512 || found.has(element) || !targetOidOf(element)) return;
      if (!(element instanceof HTMLElement) && element.tagName.toLowerCase() !== "svg") return;
      if (visibleOf(element)) found.add(element);
    }
    for (var ancestor = selected, depth = 0; ancestor && depth < MAX_TRANSFORM_CHAIN; ancestor = ancestor.parentElement, depth += 1) add(ancestor);
    // Nearby siblings have priority in a large flow. Their DOM order is
    // restored below, independently of the order in which they were found.
    if (selected) {
      var previous = selected.previousElementSibling, next = selected.nextElementSibling;
      for (var index = 0; index < 128 && (previous || next); index += 1) {
        add(previous); add(next);
        previous = previous && previous.previousElementSibling;
        next = next && next.nextElementSibling;
      }
    }
    add(document.body);
    var root = document.body;
    var current = root;
    var visited = 0;
    while (current && visited < 2048 && found.size < 512) {
      visited += 1;
      var visible = visibleOf(current);
      if (visible) add(current);
      // SVG is an atomic layout item; its internal drawing commands cannot
      // contain HTML frames. Hidden subtrees need no geometry readback.
      if (visible && current instanceof HTMLElement && current !== selected && current.firstElementChild) {
        current = current.firstElementChild;
        continue;
      }
      while (current && current !== root && !current.nextElementSibling) current = current.parentElement;
      current = current && current !== root ? current.nextElementSibling : null;
    }
    return Array.from(found).sort(function (a, b) {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    }).map(function (element) { return detailsOf(element, true); });
  }

  /** Match design-web's authored duplicate identity rule. The parity tests
   * compare real DOM output with the source adapter, including collisions. */
  function duplicateStructureIdentity(rootId, originalId, index, used) {
    var safe = originalId.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "node-" + index;
    var prefix = (rootId + "-" + safe).slice(0, 248);
    var candidate = prefix;
    var suffix = 2;
    while (used.has(candidate)) {
      var ending = "-" + suffix++;
      candidate = prefix.slice(0, 256 - ending.length) + ending;
    }
    return candidate;
  }

  /** Clone only the existing sanitized DOM, never host-supplied HTML. Prepare
   * every operation and bound its retained subtree before the first write. */
  function prepareStructure(operations) {
    var result = { inserts: [], deletes: [], elements: new Map(), bytes: 0 };
    if (operations === undefined) return result;
    if (enabledOptInMethods.indexOf("commitStructure") < 0) throw new Error("Structural commits require commitStructure.");
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 256) throw new Error("Invalid structural edits.");
    ensureElementMap();
    var used = new Set(elementsByOid.keys());
    var projectedNodes = elementsByOid.size - (document.body ? 1 : 0);
    var selected = [];
    var nodes = 0;
    operations.forEach(function (operation) {
      if (!operation || (operation.type !== "duplicate" && operation.type !== "delete") || typeof operation.nodeId !== "string") throw new Error("Invalid structural edit.");
      var element = elementForOid(operation.nodeId);
      if (element === document.body || element === document.documentElement || !element.parentElement ||
          selected.some(function (other) { return other === element || other.contains(element) || element.contains(other); })) throw new Error("Overlapping structural edits.");
      selected.push(element);
      var descendants = element.getElementsByTagName("*");
      nodes += descendants.length + 1;
      if (nodes > MAX_TREE_NODES) throw new Error("Structural edits exceed the node budget.");
      var bytes = element.outerHTML.length * 2 + (descendants.length + 1) * 256;
      result.bytes += bytes;
      if (result.bytes > 4 * 1024 * 1024) throw new Error("Structural edits exceed the memory budget.");
      var originals = [element].concat(Array.from(descendants));
      // A speculative style/move is not authored source. The host can safely
      // reload instead when a subtree has another gesture still in progress.
      if (originals.some(function (node) { var id = node.getAttribute("data-oid"); return previewStyleOverridesByOid.has(id) || previewMovesByOid.has(id) || previewInsertsByOid.has(id); }))
        throw new Error("The subtree still has an unconfirmed preview.");
      if (operation.type === "delete") {
        projectedNodes -= originals.length;
        result.deletes.push({ oid: operation.nodeId, element: element, parent: element.parentElement, before: element.nextSibling, bytes: bytes });
        return;
      }
      projectedNodes += originals.length;
      if (projectedNodes > MAX_TREE_NODES) throw new Error("The copied document exceeds the node budget.");
      if (typeof operation.duplicateNodeId !== "string" || !operation.duplicateNodeId.length || operation.duplicateNodeId.length > 256 ||
          operation.duplicateNodeId.trim() !== operation.duplicateNodeId || /[\u0000-\u001f\u007f]/.test(operation.duplicateNodeId) || used.has(operation.duplicateNodeId)) throw new Error("Invalid duplicate identity.");
      var clone = element.cloneNode(true);
      var copies = [clone].concat(Array.from(clone.getElementsByTagName("*")));
      copies.forEach(function (node, index) {
        var oldId = node.getAttribute("data-oid");
        if (!oldId) return;
        var id = index === 0 ? operation.duplicateNodeId : duplicateStructureIdentity(operation.duplicateNodeId, oldId, index, used);
        node.setAttribute("data-oid", id);
        used.add(id);
        result.elements.set(id, node);
      });
      result.inserts.push({ oid: operation.duplicateNodeId, element: clone, parent: element.parentElement, before: element.nextSibling, bytes: bytes });
    });
    return result;
  }

  var structurePreviews = [];

  function paintStructure(plan) {
    withoutObservedMutations(function () {
      plan.inserts.forEach(function (insert) { insert.parent.insertBefore(insert.element, insert.before && insert.before.parentNode === insert.parent ? insert.before : null); });
      plan.deletes.forEach(function (deleted) { deleted.element.remove(); });
    });
    refreshElementMap();
  }

  function rewindStructurePreviews() {
    var previous = structurePreviews;
    structurePreviews = [];
    if (!previous.length) return previous;
    withoutObservedMutations(function () {
      previous.slice().reverse().forEach(function (preview) {
        preview.updates = [];
        preview.moves = [];
        preview.plan.elements.forEach(function (element, oid) {
          var styles = previewStyleOverridesByOid.get(oid);
          if (styles) preview.updates.push({ nodeId: oid, styles: Object.fromEntries(Array.from(styles, function (entry) { return [entry[0], entry[1].latestValue]; })) });
          if (previewMovesByOid.has(oid) && element.parentElement) preview.moves.push({ nodeId: oid,
            parentId: targetOidOf(element.parentElement), beforeId: element.nextElementSibling ? targetOidOf(element.nextElementSibling) : null });
          previewStyleOverridesByOid.delete(oid);
          previewMovesByOid.delete(oid);
        });
        preview.plan.deletes.slice().reverse().forEach(function (deleted) {
          deleted.parent.insertBefore(deleted.element, deleted.before && deleted.before.parentNode === deleted.parent ? deleted.before : null);
        });
        preview.plan.inserts.slice().reverse().forEach(function (insert) { insert.element.remove(); });
      });
    });
    refreshElementMap();
    return previous;
  }

  function repaintStructurePreviews(previous) {
    previous.forEach(function (preview) {
      try {
        // Earlier writes may have changed the copied source. Rebuild from the
        // confirmed DOM, in input order, rather than promoting an old clone.
        var plan = prepareStructure(preview.operations);
        if (plan.bytes + structurePreviews.reduce(function (sum, current) { return sum + current.plan.bytes; }, 0) > 4 * 1024 * 1024) return;
        paintStructure(plan);
        structurePreviews.push({ id: preview.id, operations: preview.operations, plan: plan });
        if (preview.updates && preview.updates.length || preview.moves && preview.moves.length)
          previewLayout({ updates: preview.updates, moves: preview.moves, nodeIds: [] });
      } catch (_retiredPreview) {
        // This projection has lost its source. The checked source operation
        // owns any conflict; a failed optional repaint cannot fail a save.
      }
    });
  }

  function previewStructure(args) {
    if (!args || typeof args.previewId !== "string" || args.previewId.length < 1 || args.previewId.length > 128) throw new Error("Invalid structural preview identity.");
    if (structurePreviews.some(function (preview) { return preview.id === args.previewId; })) throw new Error("Structural preview already exists.");
    if (structurePreviews.length >= 32) throw new Error("Too many pending structural previews.");
    var plan = prepareStructure(args.operations);
    if (plan.bytes + structurePreviews.reduce(function (sum, preview) { return sum + preview.plan.bytes; }, 0) > 4 * 1024 * 1024 ||
        args.operations.length + structurePreviews.reduce(function (sum, preview) { return sum + preview.operations.length; }, 0) > 256) throw new Error("Pending structural previews exceed their budget.");
    paintStructure(plan);
    structurePreviews.push({ id: args.previewId, operations: args.operations, plan: plan });
    // No snapshot publication or source generation change: these are pixels
    // awaiting a checked source write, not confirmed document authority.
    return { sourceVersion: SOURCE_VERSION, details: plan.inserts.map(function (insert) { return detailsOf(insert.element); }) };
  }

  function clearPreviewStructure(args) {
    if (args.previewId !== undefined && (typeof args.previewId !== "string" || args.previewId.length > 128)) throw new Error("Invalid structural preview identity.");
    if (args.previewId !== undefined && !structurePreviews.some(function (preview) { return preview.id === args.previewId; })) return {};
    var previous = rewindStructurePreviews();
    if (args.previewId !== undefined) repaintStructurePreviews(previous.filter(function (preview) { return preview.id !== args.previewId; }));
    return {};
  }

  function withStructurePresentation(commit, patch) {
    var id = patch && patch.structurePreviewId;
    var own = structurePreviews.find(function (preview) { return preview.id === id; });
    if (own && JSON.stringify(own.operations) !== JSON.stringify(patch.structure)) throw new Error("Structural preview does not match the confirmed edit.");
    var previous = rewindStructurePreviews();
    var committed = false;
    try {
      var result = commit();
      committed = true;
      return result;
    } finally {
      repaintStructurePreviews(committed ? previous.filter(function (preview) { return preview.id !== id; }) : previous);
    }
  }

  function prepareMoves(moves, inserted) {
    if (moves === undefined) return [];
    if (!Array.isArray(moves) || moves.length > 32) throw new Error("Too many layer moves.");
    var seen = new Set();
    var plans = moves.map(function (move) {
      if (!move || typeof move.nodeId !== "string" || typeof move.parentId !== "string") throw new Error("Invalid layer move.");
      var find = function (oid) { return inserted && inserted.get(oid) || elementForOid(oid); };
      var element = find(move.nodeId);
      var parent = find(move.parentId);
      var before = move.beforeId ? find(move.beforeId) : null;
      if (seen.has(element) || element === document.body || element === parent || element.contains(parent) || (before && (before.parentElement !== parent || before === element))) throw new Error("Invalid layer destination.");
      if (/^(AREA|BASE|BR|COL|EMBED|HR|IMG|INPUT|LINK|META|PARAM|SOURCE|TRACK|WBR|SELECT|OPTION|TABLE|THEAD|TBODY|TFOOT|TR|UL|OL|DL)$/.test(parent.tagName)) throw new Error("This layer cannot contain a frame.");
      seen.add(element);
      return { oid: move.nodeId, element: element, parent: parent, before: before };
    });
    // Validate the resulting ancestry too (two individually valid moves can
    // otherwise create a cycle together).
    plans.forEach(function (plan) {
      var current = plan.parent;
      var visited = new Set([plan.element]);
      while (current) {
        if (visited.has(current)) throw new Error("Layer moves cannot create a cycle.");
        visited.add(current);
        var next = plans.find(function (candidate) { return candidate.element === current; });
        current = next ? next.parent : current.parentElement;
      }
    });
    return plans;
  }

  function cancelMovePreviews() {
    withoutObservedMutations(function () {
      Array.from(previewMovesByOid.values()).reverse().forEach(function (prior) {
        prior.parent.insertBefore(prior.element, prior.before && prior.before.parentElement === prior.parent ? prior.before : null);
      });
      previewMovesByOid.clear();
    });
  }

  function previewLayout(args) {
    var updates = args.updates || [];
    var nodeIds = args.nodeIds || [];
    if (!Array.isArray(updates) || updates.length > ${DESIGN_LAYOUT_CHILD_LIMIT + 1} || !Array.isArray(nodeIds) || nodeIds.length > 32) throw new Error("Layout preview is too large.");
    var moves = prepareMoves(args.moves);
    // All targets and values are checked before the first DOM write.
    var elements = updates.map(function (update) {
      if (!update || !update.styles || typeof update.styles !== "object" || Array.isArray(update.styles)) throw new Error("Invalid layout styles.");
      var entries = Object.entries(update.styles);
      if (entries.length > 64 || entries.some(function (entry) { return !/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(entry[0]) || (entry[1] !== null && (typeof entry[1] !== "string" || entry[1].length > 2048)); })) throw new Error("Invalid layout styles.");
      return elementForOid(update.nodeId);
    });
    var measured = nodeIds.map(elementForOid);
    if (args.suppressNodeId !== undefined && args.suppressNodeId !== null) elementForOid(args.suppressNodeId);
    withoutObservedMutations(function () {
      suppressDragPaint(args.suppressNodeId);
      if (args.cancelMoves) cancelMovePreviews();
      moves.forEach(function (move) {
        if (!previewMovesByOid.has(move.oid)) previewMovesByOid.set(move.oid, { element: move.element, parent: move.element.parentElement, before: move.element.nextSibling });
        if (move.element.parentElement !== move.parent || move.element.nextElementSibling !== move.before) move.parent.insertBefore(move.element, move.before);
      });
      updates.forEach(function (update, index) {
        if (Object.keys(update.styles).length) applyPreviewStyles(elements[index], update.nodeId, update.styles);
      });
    });
    return measured.map(function (element) { return geometryOf(element, args.children !== false); });
  }

  function restoreGeneration(target, commit, measure, readback) {
    if (!/^[a-f0-9]{24}$/.test(target)) throw new Error("Invalid history generation.");
    var versions = generationHistory.length ? [generationHistory[0].from].concat(generationHistory.map(function (entry) { return entry.to; })) : [SOURCE_VERSION];
    var touched = new Set();
    var treeUnchanged = true;
    var from = versions.lastIndexOf(paintedSourceVersion);
    var to = versions.lastIndexOf(target);
    if (from < 0 || to < 0) throw new Error("History generation is no longer retained.");
    rewindStructurePreviews();
    // A speculative inverse may already be painted. Confirmation must still
    // publish every node (and structural change) between the saved versions.
    var confirmedFrom = versions.lastIndexOf(SOURCE_VERSION);
    for (var index = Math.min(from, to, confirmedFrom); index < Math.max(from, to, confirmedFrom); index += 1) {
      var entry = generationHistory[index];
      if (!entry) continue;
      entry.nodeIds.forEach(function (oid) { touched.add(oid); });
      if (entry.moves.length || (entry.inserts && entry.inserts.length) || (entry.deletes && entry.deletes.length) || entry.changes.some(function (change) { return /^(display|visibility|flex-direction|flex-flow|all)$/.test(change.property); })) treeUnchanged = false;
    }
    withoutObservedMutations(function () {
      cancelMovePreviews();
      if (clearInsertPreviews()) treeUnchanged = false;
      Array.from(previewStyleOverridesByOid.keys()).forEach(clearPreviewStyles);
      var apply = function (entry, forward) {
        var inserts = entry.inserts || [];
        var deletes = entry.deletes || [];
        if (entry.moves.length || inserts.length || deletes.length || entry.changes.some(function (change) { return /^(display|visibility|flex-direction|flex-flow|all)$/.test(change.property); })) treeUnchanged = false;
        entry.nodeIds.forEach(function (oid) { touched.add(oid); });
        if (!forward) deletes.slice().reverse().forEach(function (deleted) {
          deleted.parent.insertBefore(deleted.element, deleted.before && deleted.before.parentNode === deleted.parent ? deleted.before : null);
        });
        if (forward) inserts.forEach(function (insert) {
          insert.parent.insertBefore(insert.element, insert.before && insert.before.parentNode === insert.parent ? insert.before : null);
        });
        var moves = forward ? entry.moves : entry.moves.slice().reverse();
        moves.forEach(function (move) {
          var parent = forward ? move.parent : move.oldParent;
          var before = forward ? move.before : move.oldBefore;
          parent.insertBefore(move.element, before && before.parentNode === parent ? before : null);
        });
        entry.changes.forEach(function (change) {
          var value = forward ? change.after : change.before;
          var priority = forward ? change.afterPriority : change.beforePriority;
          if (value) change.target.setProperty(change.property, value, priority);
          else change.target.removeProperty(change.property);
        });
        if (!forward) inserts.slice().reverse().forEach(function (insert) {
          if (insert.element.parentNode) insert.element.parentNode.removeChild(insert.element);
        });
        if (forward) deletes.forEach(function (deleted) { deleted.element.remove(); });
      };
      while (from > to) { from -= 1; apply(generationHistory[from], false); }
      while (from < to) { apply(generationHistory[from], true); from += 1; }
    });
    paintedSourceVersion = target;
    if (commit) {
      SOURCE_VERSION = target;
      window.__zerosDesignSourceVersion = SOURCE_VERSION;
    }
    revision += 1;
    if (readback === false) return null;
    var nextSnapshot = treeUnchanged ? styleOnlySnapshot() : snapshot();
    // An undone insert is no longer in the document; report only live nodes.
    var details = Array.from(touched).slice(0, 256).flatMap(function (oid) {
      ensureElementMap();
      var element = elementsByOid.get(oid);
      return element && element.isConnected ? [detailsOf(element)] : [];
    });
    // History can move boxes it never touched (the selection among them). The
    // host names those it shows so they are measured in this same round trip;
    // a box the restored generation no longer contains is simply omitted.
    (Array.isArray(measure) ? measure.slice(0, 64) : []).forEach(function (oid) {
      if (typeof oid !== "string" || !oid || touched.has(oid)) return;
      touched.add(oid);
      ensureElementMap();
      var element = elementsByOid.get(oid);
      if (!element) {
        refreshElementMap();
        element = elementsByOid.get(oid);
      }
      if (element && element.isConnected) details.push(detailsOf(element));
    });
    return { sourceVersion: SOURCE_VERSION, treeUnchanged: treeUnchanged,
      snapshot: treeUnchanged ? Object.assign({}, nextSnapshot, { tree: [] }) : nextSnapshot,
      details: details };
  }

  // A pending Undo is presentation, never the next save's baseline. Authority
  // is applied and measured on its own source, then the latest inverse is
  // repainted in this same task, before the browser can display the save.
  function withHistoryPresentation(commit) {
    var target = historyPresentationTarget;
    if (target !== null) restoreGeneration(SOURCE_VERSION, false, undefined, false);
    try {
      var result = commit();
      if (target !== null) {
        var measured = new Set(result.details.map(function (detail) { return detail.oid; }));
        historyPresentationMeasure.forEach(function (oid) {
          if (measured.has(oid)) return;
          try { result.details.push(detailsOf(elementForOid(oid))); } catch (_missingSelection) {}
        });
      }
      return result;
    } finally {
      if (target !== null) {
        try { restoreGeneration(target, false, undefined, false); }
        catch (_expiredHistory) { historyPresentationTarget = null; historyPresentationMeasure = []; }
      }
    }
  }

  function previewHistory(args) {
    if (args.targetSourceVersion !== null &&
        (typeof args.targetSourceVersion !== "string" || !/^[a-f0-9]{24}$/.test(args.targetSourceVersion)))
      throw new Error("Invalid history presentation generation.");
    var target = args.targetSourceVersion;
    var measure = Array.isArray(args.measure) ? args.measure.filter(function (oid) { return typeof oid === "string"; }).slice(0, 64) : [];
    var result = restoreGeneration(target === null ? SOURCE_VERSION : target, false, measure, target !== null);
    historyPresentationTarget = target;
    historyPresentationMeasure = target === null ? [] : measure;
    return result;
  }

  function commitStyles(updates, nextSourceVersion, patch) {
    if (!/^[a-f0-9]{24}$/.test(nextSourceVersion)) {
      throw new Error("nextSourceVersion must be a valid source generation.");
    }
    var inserts = prepareInserts(patch ? patch.inserts : undefined);
    var structure = prepareStructure(patch ? patch.structure : undefined);
    var moves = prepareMoves(patch && patch.moves, structure.elements);
    if (patch && patch.structure && (inserts.length || patch.tokens || patch.keyframes ||
        moves.some(function (move) { return !structure.inserts.some(function (insert) { return insert.element === move.element; }) || structure.elements.has(targetOidOf(move.parent)); }))) throw new Error("Structural commits can only place their copied roots.");
    // A new copy has no prior authored location. Its final placement belongs
    // to the insertion history, so Undo removes it and Redo puts it back there.
    moves = moves.filter(function (move) {
      var insert = structure.inserts.find(function (candidate) { return candidate.element === move.element; });
      if (!insert) return true;
      insert.parent = move.parent;
      insert.before = move.before;
      return false;
    });
    var generationPatch = prepareGenerationPatch(patch && { keyframes: patch.keyframes, tokens: patch.tokens });
    if (
      !Array.isArray(updates) ||
      updates.length > ${DESIGN_LAYOUT_CHILD_LIMIT + 1} ||
      (updates.length < 1 && !generationPatch.changed && moves.length === 0 && inserts.length === 0 && structure.inserts.length === 0 && structure.deletes.length === 0)
    ) {
      throw new Error("A commit must contain styles or a generation patch.");
    }
    var prepared = updates.map(function (update) {
      if (!update || typeof update !== "object" || Array.isArray(update)) {
        throw new Error("Each committed style update must be an object.");
      }
      var oid = update.nodeId;
      var styles = update.styles;
      if (typeof oid !== "string" || oid.length < 1 || oid.length > 256) {
        throw new Error("Each committed style update needs a bounded nodeId.");
      }
      if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
        throw new Error("Each committed style update needs a styles object.");
      }
      var entries = Object.entries(styles);
      if (entries.length < 1 || entries.length > 64) {
        throw new Error("Committed styles must contain between 1 and 64 properties.");
      }
      entries.forEach(function (entry) {
        var property = entry[0];
        var value = entry[1];
        if (
          !/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property) ||
          (typeof value !== "string" && value !== null) ||
          (typeof value === "string" && value.length > 2048)
        ) {
          throw new Error("Invalid committed style: " + property);
        }
      });
      var element = structure.elements.get(oid) || elementForOid(oid);
      if (structure.deletes.some(function (deleted) { return deleted.element === element || deleted.element.contains(element); })) throw new Error("Cannot style a deleted subtree.");
      var preview = previewStyleOverridesByOid.get(oid);
      if (preview) {
        var committedProperties = new Set(entries.map(function (entry) { return entry[0]; }));
        var committedEffects = new Set(entries.flatMap(function (entry) { return previewStyleProperties(entry[0]); }));
        preview.forEach(function (prior, property) {
          if (!committedProperties.has(property) && prior.effects.some(function (effect) { return committedEffects.has(effect.property); })) throw new Error("Reload the saved source after overlapping style previews.");
        });
      }
      var plans = entries.map(function (entry) {
        var property = entry[0];
        var prior = preview ? preview.get(property) : null;
        var inlineValue = prior
          ? prior.value
          : element.style.getPropertyValue(property);
        var inlinePriority = prior
          ? prior.priority
          : element.style.getPropertyPriority(property);
        var exactRules = inlineValue || (prior && prior.rule)
          ? []
          : exactTopLevelStyleRules(oid, property);
        return {
          property: property,
          value: entry[1],
          prior: prior,
          newerPreview: prior && prior.latestValue !== entry[1] ? prior.latestValue : undefined,
          inlineValue: inlineValue,
          inlinePriority: inlinePriority,
          rule: prior && prior.rule
            ? prior.rule
            : (exactRules.length === 1 ? exactRules[0] : null)
        };
      });
      return { oid: oid, element: element, preview: preview, plans: plans };
    });
    var changes = [];
    var historyInserts = structure.inserts.slice();
    var historyMoves = moves.map(function (move) {
      var prior = previewMovesByOid.get(move.oid);
      return Object.assign({}, move, { oldParent: prior ? prior.parent : move.element.parentElement, oldBefore: prior ? prior.before : move.element.nextSibling });
    }).filter(function (move) {
      var before = move.oldBefore;
      while (before && before.nodeType !== Node.ELEMENT_NODE) before = before.nextSibling;
      return move.oldParent !== move.parent || before !== move.before;
    });
    withoutObservedMutations(function () {
      structure.inserts.forEach(function (insert) { insert.parent.insertBefore(insert.element, insert.before); });
      prepared.forEach(function (update) {
        update.plans.forEach(function (plan) {
          var target = plan.rule ? plan.rule.style : update.element.style;
          var effects = previewStyleProperties(plan.property).map(function (property) {
            var prior = plan.prior && plan.prior.effects.find(function (effect) { return effect.property === property; });
            return { target: target, property: property,
              before: prior ? (plan.rule ? prior.ruleValue : prior.value) : target.getPropertyValue(property),
              beforePriority: prior ? (plan.rule ? prior.rulePriority : prior.priority) : target.getPropertyPriority(property) };
          });

          if (plan.rule) {
            // Auto-scope edits one unambiguous top-level data-oid rule. Remove
            // the speculative inline preview before mirroring that exact CSSOM
            // change so !important and the surrounding cascade stay honest.
            update.element.style.removeProperty(plan.property);
            if (plan.value === null) plan.rule.style.removeProperty(plan.property);
            else {
              var rulePriority = plan.rule.style.getPropertyPriority(plan.property);
              plan.rule.style.setProperty(plan.property, plan.value, rulePriority);
            }
          } else if (plan.value === null) {
            update.element.style.removeProperty(plan.property);
          } else {
            update.element.style.setProperty(
              plan.property,
              plan.value,
              plan.inlinePriority
            );
          }
          effects.forEach(function (effect) {
            changes.push(Object.assign(effect, { after: target.getPropertyValue(effect.property), afterPriority: target.getPropertyPriority(effect.property) }));
          });
          if (update.preview) update.preview.delete(plan.property);
          if (plan.newerPreview !== undefined) {
            applyPreviewStyles(update.element, update.oid, { [plan.property]: plan.newerPreview });
          }
        });
        if (update.preview && update.preview.size === 0) {
          previewStyleOverridesByOid.delete(update.oid);
        }
      });
      moves.forEach(function (move) {
        var prior = previewMovesByOid.get(move.oid);
        var currentParent = move.element.parentElement;
        var currentBefore = move.element.nextSibling;
        var newer = prior && (currentParent !== move.parent || move.element.nextElementSibling !== move.before);
        if (currentParent !== move.parent || move.element.nextElementSibling !== move.before) move.parent.insertBefore(move.element, move.before);
        previewMovesByOid.delete(move.oid);
        if (newer) {
          previewMovesByOid.set(move.oid, { element: move.element, parent: move.parent, before: move.before });
          currentParent.insertBefore(move.element, currentBefore);
        }
      });
      inserts.forEach(function (plan) {
        var element = plan.previewed ? plan.previewed.element : insertedElement(plan);
        if (plan.previewed) previewInsertsByOid.delete(plan.oid);
        if (element.parentElement !== plan.parent || (plan.before && element.nextElementSibling !== plan.before)) {
          plan.parent.insertBefore(element, plan.before);
        }
        historyInserts.push({ oid: plan.oid, element: element, parent: plan.parent, before: plan.before });
      });
      structure.deletes.forEach(function (deleted) { deleted.element.remove(); });
      if (generationPatch.changed) applyCommittedGenerationPatch(generationPatch);
    });
    if (historyInserts.length || structure.deletes.length) refreshElementMap();
    if (generationPatch.changed) generationHistory = [];
    else {
      var branch = generationHistory.findIndex(function (entry) { return entry.from === SOURCE_VERSION; });
      if (branch >= 0) generationHistory.splice(branch);
      generationHistory.push({ from: SOURCE_VERSION, to: nextSourceVersion, changes: changes, moves: historyMoves, inserts: historyInserts, deletes: structure.deletes, nodeIds: prepared.map(function (update) { return update.oid; }).concat(moves.map(function (move) { return move.oid; })).concat(historyInserts.map(function (insert) { return insert.oid; })).concat(structure.deletes.map(function (deleted) { return deleted.oid; })) });
      var bytes = function (entry) { return entry.changes.reduce(function (total, change) { return total + (change.before.length + change.after.length + change.property.length) * 2 + 128; }, 0) + entry.moves.length * 256 + (entry.inserts || []).concat(entry.deletes || []).reduce(function (total, node) { return total + (node.bytes || 256); }, 0); };
      var historyBytes = generationHistory.reduce(function (total, entry) { return total + bytes(entry); }, 0);
      while (generationHistory.length > 64 || historyBytes > 4 * 1024 * 1024) historyBytes -= bytes(generationHistory.shift());
    }
    paintedSourceVersion = nextSourceVersion;
    suspendAuthoredMotion();
    revision += 1;
    SOURCE_VERSION = nextSourceVersion;
    window.__zerosDesignSourceVersion = SOURCE_VERSION;
    var treeUnchanged = historyMoves.length === 0 && historyInserts.length === 0 && structure.deletes.length === 0 && prepared.every(function (update) {
      return update.plans.every(function (plan) {
        return plan.property !== "display" &&
          plan.property !== "visibility" &&
          plan.property !== "flex-direction" &&
          plan.property !== "flex-flow" &&
          plan.property !== "all";
      });
    });
    var nextSnapshot = treeUnchanged ? styleOnlySnapshot() : snapshot(true);
    return {
      sourceVersion: SOURCE_VERSION,
      treeUnchanged: treeUnchanged,
      snapshot: treeUnchanged
        ? Object.assign({}, nextSnapshot, { tree: [] })
        : nextSnapshot,
      details: prepared.map(function (update) {
        return detailsOf(elementForOid(update.oid));
      }).concat(historyInserts.map(function (insert) { return detailsOf(insert.element); }))
    };
  }

  function previewMotion(oid, input) {
    var element = elementForOid(oid);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("motion preview must be an object.");
    }
    var keyframes = input.keyframes;
    if (!Array.isArray(keyframes) || keyframes.length < 2 || keyframes.length > 32) {
      throw new Error("motion preview requires between 2 and 32 keyframes.");
    }
    var seenOffsets = new Set();
    var animationFrames = keyframes.map(function (keyframe) {
      if (!keyframe || typeof keyframe !== "object" || Array.isArray(keyframe)) {
        throw new Error("motion preview contains an invalid keyframe.");
      }
      var offset = Number(keyframe.offset);
      var styles = keyframe.styles;
      if (
        !Number.isFinite(offset) || offset < 0 || offset > 100 ||
        seenOffsets.has(offset) || !styles || typeof styles !== "object" ||
        Array.isArray(styles)
      ) {
        throw new Error("motion preview contains an invalid keyframe.");
      }
      seenOffsets.add(offset);
      var entries = Object.entries(styles);
      if (entries.length < 1 || entries.length > 64) {
        throw new Error("motion keyframes require between 1 and 64 styles.");
      }
      var frame = { offset: offset / 100 };
      for (var index = 0; index < entries.length; index += 1) {
        var property = entries[index][0];
        var value = entries[index][1];
        if (
          !/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property) ||
          typeof value !== "string" || value.length < 1 || value.length > 2048
        ) {
          throw new Error("motion preview contains an invalid style.");
        }
        var animationProperty = property.indexOf("--") === 0
          ? property
          : property.replace(/-([a-z])/g, function (_match, letter) {
              return letter.toUpperCase();
            });
        frame[animationProperty] = value;
      }
      return frame;
    }).sort(function (left, right) { return left.offset - right.offset; });
    var duration = Number(input.duration);
    var delay = Number(input.delay);
    var iterations = Number(input.iterations);
    var currentTime = Number(input.currentTime);
    var directions = ["normal", "reverse", "alternate", "alternate-reverse"];
    var fills = ["none", "forwards", "backwards", "both"];
    if (
      !Number.isFinite(duration) || duration < 1 || duration > 60000 ||
      !Number.isFinite(delay) || delay < -60000 || delay > 60000 ||
      !Number.isFinite(iterations) || iterations < 0 || iterations > 1000 ||
      !Number.isFinite(currentTime) || currentTime < delay || currentTime > delay + duration ||
      typeof input.easing !== "string" || input.easing.length < 1 || input.easing.length > 256 ||
      directions.indexOf(input.direction) < 0 || fills.indexOf(input.fill) < 0 ||
      typeof input.playing !== "boolean"
    ) {
      throw new Error("motion preview timing is invalid.");
    }
    var prior = previewAnimationsByOid.get(oid);
    if (prior) prior.cancel();
    suspendAuthoredMotion();
    var animation = element.animate(animationFrames, {
      duration: duration,
      delay: delay,
      easing: input.easing,
      iterations: iterations,
      direction: input.direction,
      fill: input.fill
    });
    animation.currentTime = currentTime;
    if (input.playing) animation.play();
    else animation.pause();
    previewAnimationsByOid.set(oid, animation);
    return detailsAfterLayout(element);
  }

  function clearPreviewStyles(oid) {
    var element = elementForOid(oid);
    var priorByProperty = previewStyleOverridesByOid.get(oid);
    var previewAnimation = previewAnimationsByOid.get(oid);
    if (previewAnimation) {
      previewAnimation.cancel();
      previewAnimationsByOid.delete(oid);
    }
    withoutObservedMutations(function () {
      if (priorByProperty) {
        priorByProperty.forEach(function (prior) { restorePreviewStyle(element, prior); });
        previewStyleOverridesByOid.delete(oid);
      }
    });
    suspendAuthoredMotion();
    return detailsAfterLayout(element);
  }

  function stylesheetSource(sheet) {
    var owner = sheet.ownerNode;
    if (owner && owner.getAttribute) {
      var authored = owner.getAttribute("data-zeros-source") ||
        owner.getAttribute("data-zeros-component");
      if (authored) {
        return String(authored).replace(/^\.\//, "").split(/[?#]/, 1)[0];
      }
    }
    if (sheet.href) {
      try {
        var url = new URL(sheet.href, document.baseURI);
        var pieces = url.pathname.split("/");
        return pieces[pieces.length - 1] || undefined;
      } catch (_error) {
        return undefined;
      }
    }
    return undefined;
  }

  function conditionalRuleActive(rule) {
    if (rule.type === CSSRule.MEDIA_RULE && rule.media) {
      return window.matchMedia(rule.media.mediaText).matches;
    }
    if (
      typeof CSSRule.SUPPORTS_RULE === "number" &&
      rule.type === CSSRule.SUPPORTS_RULE &&
      rule.conditionText && window.CSS && typeof window.CSS.supports === "function"
    ) {
      try { return window.CSS.supports(rule.conditionText); } catch (_error) { return false; }
    }
    return true;
  }

  function matchedDeclarationsForElement(element, property, inherited, output) {
    if (element.style) {
      var inlineValue = element.style.getPropertyValue(property);
      if (inlineValue && output.length < MAX_MATCHED_DECLARATIONS) {
        output.push({
          property: property,
          value: inlineValue,
          important: element.style.getPropertyPriority(property) === "important",
          inherited: inherited,
          active: true
        });
      }
    }
    function visitRules(rules, sourceFile, active) {
      for (var index = 0; index < rules.length; index += 1) {
        if (output.length >= MAX_MATCHED_DECLARATIONS) return;
        var rule = rules[index];
        if (rule.type === CSSRule.STYLE_RULE && rule.selectorText && rule.style) {
          var matches = false;
          try { matches = element.matches(rule.selectorText); } catch (_error) { matches = false; }
          var value = rule.style.getPropertyValue(property);
          if (matches && value) {
            output.push({
              property: property,
              value: value,
              important: rule.style.getPropertyPriority(property) === "important",
              selector: rule.selectorText,
              sourceFile: sourceFile,
              inherited: inherited,
              active: active
            });
          }
        } else if (rule.cssRules) {
          visitRules(
            rule.cssRules,
            sourceFile,
            active && conditionalRuleActive(rule)
          );
        }
      }
    }
    var matchedScope = styleScopeOf(element);
    for (var sheetIndex = 0; sheetIndex < matchedScope.styleSheets.length; sheetIndex += 1) {
      var sheet = matchedScope.styleSheets[sheetIndex];
      try {
        visitRules(sheet.cssRules || [], stylesheetSource(sheet), true);
      } catch (_error) {
        // The design renderer normally owns every stylesheet. If a browser
        // still marks one inaccessible, omit it instead of inventing source.
      }
    }
  }

  function getMatchedStyles(oid, rawProperty) {
    var element = elementForOid(oid);
    var raw = String(rawProperty || "").trim();
    var property = raw.indexOf("--") === 0 ? raw : raw.toLowerCase();
    if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property)) {
      throw new Error("Invalid matched-style property: " + property);
    }
    var matched = [];
    matchedDeclarationsForElement(element, property, false, matched);
    if (matched.length === 0) {
      for (
        var parent = composedParentOf(element);
        parent && matched.length === 0;
        parent = composedParentOf(parent)
      ) {
        matchedDeclarationsForElement(parent, property, true, matched);
      }
    }
    return {
      sourceVersion: SOURCE_VERSION,
      nodeId: oid,
      property: property,
      computedValue: getComputedStyle(element).getPropertyValue(property),
      matched: matched,
      truncated: matched.length >= MAX_MATCHED_DECLARATIONS
    };
  }

  // Chromium runs toBlob PNG encoding off the frame's main thread. Settled
  // camera moves request multi-megapixel viewport tiles; the synchronous
  // toDataURL path would stall live previews and animations for the whole
  // encode, so it remains only as the fallback for engines without toBlob.
  function encodeCanvasPng(canvas, onDataUrl, onError, operation) {
    var fallback = function () {
      try {
        if (operation.cancelled) throw typedError("CANCELLED", "Capture cancelled.", false);
        onDataUrl(canvas.toDataURL("image/png"));
      } catch (error) {
        onError(error);
      }
    };
    if (
      typeof canvas.toBlob !== "function" ||
      typeof FileReader === "undefined"
    ) {
      fallback();
      return;
    }
    try {
      canvas.toBlob(function (blob) {
        if (operation.cancelled) {
          onError(typedError("CANCELLED", "Capture cancelled.", false));
          return;
        }
        if (!blob) {
          fallback();
          return;
        }
        var reader = new FileReader();
        operation.cancelEncoding = function () { reader.abort(); };
        reader.onabort = function () { onError(typedError("CANCELLED", "Capture cancelled.", false)); };
        reader.onload = function () {
          var result = reader.result;
          if (typeof result === "string" && result.indexOf("data:") === 0) {
            onDataUrl(result);
          } else {
            fallback();
          }
        };
        reader.onerror = fallback;
        reader.readAsDataURL(blob);
      }, "image/png");
    } catch (error) {
      fallback();
    }
  }

  function captureScreenshot(args, requestId) {
    var captureSourceVersion = SOURCE_VERSION;
    var requestedCrop = args && typeof args.crop === "object" ? args.crop : null;
    var requestedOutput = args && typeof args.outputSize === "object"
      ? args.outputSize
      : null;
    var viewportCapture = requestedCrop !== null || requestedOutput !== null;
    if (viewportCapture && (!requestedCrop || !requestedOutput)) {
      throw new Error("Viewport screenshot crop and output size are both required.");
    }
    var nodeId = typeof args.nodeId === "string" && args.nodeId
      ? args.nodeId
      : null;
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    var viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    var crop;
    if (viewportCapture) {
      var cropX = Number(requestedCrop.x);
      var cropY = Number(requestedCrop.y);
      var cropWidth = Number(requestedCrop.width);
      var cropHeight = Number(requestedCrop.height);
      var requestedOutputWidth = Number(requestedOutput.width);
      var requestedOutputHeight = Number(requestedOutput.height);
      if (
        !Number.isFinite(cropX) || !Number.isFinite(cropY) ||
        !Number.isFinite(cropWidth) || !Number.isFinite(cropHeight) ||
        !Number.isFinite(requestedOutputWidth) ||
        !Number.isFinite(requestedOutputHeight) ||
        cropWidth <= 0 || cropHeight <= 0 ||
        requestedOutputWidth <= 0 || requestedOutputHeight <= 0
      ) {
        throw new Error("Viewport screenshot geometry is invalid.");
      }
      var cropLeft = Math.max(0, Math.min(viewportWidth, cropX));
      var cropTop = Math.max(0, Math.min(viewportHeight, cropY));
      var cropRight = Math.max(
        cropLeft,
        Math.min(viewportWidth, cropX + cropWidth)
      );
      var cropBottom = Math.max(
        cropTop,
        Math.min(viewportHeight, cropY + cropHeight)
      );
      crop = {
        x: cropLeft,
        y: cropTop,
        width: cropRight - cropLeft,
        height: cropBottom - cropTop
      };
    } else {
      crop = nodeId
        ? rectOf(elementForOid(nodeId))
        : { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
    }
    var documentX = crop.x + window.scrollX;
    var documentY = crop.y + window.scrollY;
    if (crop.width <= 0 || crop.height <= 0) {
      throw new Error("The screenshot target has no visible geometry.");
    }
    var requestedScale = viewportCapture
      ? Math.min(
          Number(requestedOutput.width) / crop.width,
          Number(requestedOutput.height) / crop.height
        )
      : (typeof args.scale === "number" ? args.scale : 1);
    var scale = viewportCapture
      ? requestedScale
      : Math.max(0.1, Math.min(2, requestedScale));
    scale = Math.min(
      scale,
      MAX_CAPTURE_DIMENSION / crop.width,
      MAX_CAPTURE_DIMENSION / crop.height,
      Math.sqrt(
        (viewportCapture ? MAX_VIEWPORT_CAPTURE_PIXELS : MAX_CAPTURE_PIXELS) /
          (crop.width * crop.height)
      )
    );
    scale = Math.max(0.01, scale);
    var outputWidth = Math.max(1, Math.round(crop.width * scale));
    var outputHeight = Math.max(1, Math.round(crop.height * scale));
    // A cropped output still decodes a whole-document SVG. Reserve for that
    // image, the canvas/encoder and source strings before cloning the DOM.
    if (viewportWidth * viewportHeight * 8 + outputWidth * outputHeight * 16 + 128 * 1024 * 1024 > 256 * 1024 * 1024) {
      throw typedError("BAD_REQUEST", "Capture temporary image budget exceeded.", false);
    }
    if (disposed || cancelledRequests.has(requestId)) throw typedError("CANCELLED", "Capture cancelled.", false);
    var clone = document.documentElement.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    // A document propagates a solid BODY background to its transparent root
    // canvas. Inside foreignObject, BODY instead paints only its own box.
    // Reproduce that canvas paint without adding it twice for translucent fills.
    var captureBody = document.body;
    var clonedCaptureBody = clone.querySelector("body");
    var captureRootStyle = getComputedStyle(document.documentElement);
    var captureBodyStyle = captureBody ? getComputedStyle(captureBody) : null;
    function captureColorIsTransparent(color) {
      return color === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) ||
        /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
    }
    if (captureBody && clonedCaptureBody && captureBodyStyle &&
        captureRootStyle.backgroundImage === "none" &&
        captureColorIsTransparent(captureRootStyle.backgroundColor) &&
        captureBodyStyle.backgroundImage === "none" &&
        !captureColorIsTransparent(captureBodyStyle.backgroundColor) &&
        captureBodyStyle.display !== "none" &&
        captureRootStyle.contain === "none" && captureBodyStyle.contain === "none" &&
        captureRootStyle.contentVisibility === "visible" && captureBodyStyle.contentVisibility === "visible") {
      // Changing the root/BODY paint must not change descendants that
      // explicitly inherit it. Preserve immediate children and both elements'
      // pseudo colors; deeper inheritance then follows those values.
      for (var captureChildIndex = 0; captureChildIndex < captureBody.children.length; captureChildIndex += 1) {
        var clonedCaptureChild = clonedCaptureBody.children[captureChildIndex];
        if (clonedCaptureChild && clonedCaptureChild.style) {
          clonedCaptureChild.style.setProperty("background-color", getComputedStyle(captureBody.children[captureChildIndex]).backgroundColor, "important");
        }
      }
      var capturePseudoCss = "";
      [document.documentElement, captureBody].forEach(function (element) {
        ["::before", "::after", "::first-line", "::first-letter"].forEach(function (pseudo) {
          var pseudoStyle = getComputedStyle(element, pseudo);
          if (pseudo === "::first-line" || pseudo === "::first-letter" ||
              (pseudoStyle.content !== "none" && pseudoStyle.content !== "normal")) {
            capturePseudoCss += element.localName + pseudo + "{background-color:" + pseudoStyle.backgroundColor + "!important}";
          }
        });
      });
      if (capturePseudoCss) {
        var capturePseudoStyle = document.createElement("style");
        // The first important layer outranks authored important rules, even
        // ID selectors in later layers. An anonymous layer cannot collide
        // with an authored name. This stylesheet exists only in the clone.
        capturePseudoStyle.textContent = "@layer{" + capturePseudoCss + "}";
        var captureStyleParent = clone.querySelector("head") || clone;
        captureStyleParent.insertBefore(capturePseudoStyle, captureStyleParent.firstChild);
      }
      clone.style.setProperty("background-color", captureBodyStyle.backgroundColor, "important");
      clonedCaptureBody.style.setProperty("background-color", "transparent", "important");
    }

    var scripts = clone.querySelectorAll("script");
    for (var index = scripts.length - 1; index >= 0; index -= 1) {
      scripts[index].remove();
    }
    scripts = null;
    clone.style.setProperty("width", viewportWidth + "px", "important");
    clone.style.setProperty("height", viewportHeight + "px", "important");
    clone.style.setProperty("overflow", "hidden", "important");
    var serialized = new XMLSerializer().serializeToString(clone);
    clone = null;
    if (serialized.length > 16 * 1024 * 1024) throw typedError("BAD_REQUEST", "Capture source budget exceeded.", false);
    // Authored svg/foreignObject rules must never move or resize the capture's
    // own containers. Keep inherited font/color and :root rules intact: copying
    // every computed property would freeze currentColor before descendants can
    // inherit it. Inline important geometry also outranks authored CSS layers.
    var captureContainerStyle = "display:block!important;position:static!important;inset:auto!important;x:0!important;y:0!important;" +
      "margin:0!important;padding:0!important;border:0!important;" +
      "transform:none!important;translate:none!important;rotate:none!important;scale:none!important;zoom:1!important;" +
      "min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;" +
      "width:" + viewportWidth + "px!important;height:" + viewportHeight + "px!important;";
    var svg =
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + viewportWidth +
      "\" height=\"" + viewportHeight + "\" style=\"" + captureContainerStyle + "\" viewBox=\"0 0 " + viewportWidth +
      " " + viewportHeight + "\"><foreignObject x=\"0\" y=\"0\" width=\"" + viewportWidth +
      "\" height=\"" + viewportHeight + "\" style=\"" + captureContainerStyle + "\">" + serialized +
      "</foreignObject></svg>";
    // A blob URL makes Chromium mark a foreignObject canvas as origin-unclean.
    // A self-contained data URL preserves the same pixels without tainting.
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    serialized = "";
    svg = "";
    return new Promise(function (resolve, reject) {
      var settled = false;
      var image = new Image();
      var canvas = null;
      var encoding = false;
      var operation = { cancelled: false, cancelEncoding: null, cancel: function () {
        operation.cancelled = true;
        if (operation.cancelEncoding) operation.cancelEncoding();
        else if (!encoding) finish(typedError("CANCELLED", "Capture cancelled.", false));
        // toBlob cannot be interrupted. Keep ownership until its callback.
      } };
      activeCaptures.set(requestId, operation);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        image.src = "";
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
        operation.cancelEncoding = null;
        activeCaptures.delete(requestId);
        if (operation.cancelled) reject(typedError("CANCELLED", "Capture cancelled.", false));
        else if (error) reject(error);
        else resolve(result);
      }
      var timer = window.setTimeout(function () {
        operation.cancel();
      }, 8000);
      image.onload = function () {
        if (settled) return;
        try {
          if (operation.cancelled) { operation.cancel(); return; }
          canvas = document.createElement("canvas");
          canvas.width = outputWidth;
          canvas.height = outputHeight;
          var context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas capture is unavailable.");
          context.drawImage(
            image, documentX, documentY, crop.width, crop.height,
            0, 0, outputWidth, outputHeight
          );
          encoding = true;
          encodeCanvasPng(canvas, function (dataUrl) {
            finish(null, {
              sourceVersion: captureSourceVersion,
              dataUrl: dataUrl,
              mimeType: "image/png",
              width: outputWidth,
              height: outputHeight,
              scale: scale,
              nodeId: nodeId
            });
          }, function (error) { finish(error); }, operation);
        } catch (error) {
          finish(error);
        }
      };
      image.onerror = function () {
        if (settled) return;
        finish(new Error("Frame screenshot could not be rendered."));
      };
      image.src = url;
      url = "";
    });
  }

  function handle(method, args, requestId) {
    switch (method) {
      case "getSnapshot":
        return snapshot();
      case "getElementAtLoc":
        return elementAtLoc(Number(args.x), Number(args.y), args.mode, args.selectedNodeId);
      case "getElementsInRect":
        return elementsInRect(
          Number(args.x), Number(args.y), Number(args.width), Number(args.height),
          typeof args.scopeNodeId === "string" && args.scopeNodeId ? args.scopeNodeId : null
        );
      case "getNodeDetails":
        return detailsOf(elementForOid(args.nodeId), false, args.relocation === true);
      case "getMatchedStyles":
        return getMatchedStyles(args.nodeId, args.property);
      case "setNodeVisibility":
        return setNodeVisibility(args.nodeId, args.visible === true);
      case "setTheme":
        return setTheme(args.theme === null ? null : args.theme);
      case "previewStyles":
        return previewStyles(args.nodeId, args.styles);
      case "getLayoutTargets":
        return layoutTargets(args);
      case "previewLayout":
        return previewLayout(args);
      case "restoreGeneration":
        return args.commit === true
          ? withHistoryPresentation(function () { return restoreGeneration(args.targetSourceVersion, true, args.measure); })
          : restoreGeneration(args.targetSourceVersion, false, args.measure);
      case "previewHistory":
        if (enabledOptInMethods.indexOf("previewHistory") < 0) throw new Error("Unknown design runtime method: previewHistory");
        return previewHistory(args);
      case "previewGeometry":
        return previewGeometry(args.nodeId, args.styles, args.children);
      case "commitStyles":
        return withHistoryPresentation(function () { return withStructurePresentation(function () { return commitStyles(args.updates, args.nextSourceVersion, args.patch); }, args.patch); });
      case "commitStructure":
        if (enabledOptInMethods.indexOf("commitStructure") < 0) throw new Error("Unknown design runtime method: commitStructure");
        return withHistoryPresentation(function () { return withStructurePresentation(function () { return commitStyles(args.updates, args.nextSourceVersion, args.patch); }, args.patch); });
      case "previewStructure":
        if (enabledOptInMethods.indexOf("previewStructure") < 0) throw new Error("Unknown design runtime method: previewStructure");
        return previewStructure(args);
      case "clearPreviewStructure":
        if (enabledOptInMethods.indexOf("clearPreviewStructure") < 0) throw new Error("Unknown design runtime method: clearPreviewStructure");
        return clearPreviewStructure(args);
      case "previewText":
        return previewText(args.nodeId, args.text);
      case "clearPreviewText":
        return clearPreviewText(args.nodeId);
      case "previewMotion":
        return previewMotion(args.nodeId, args);
      case "clearPreviewStyles":
        return clearPreviewStyles(args.nodeId);
      case "captureScreenshot":
        return captureScreenshot(args, requestId);
      case "setPlayback":
        if (enabledOptInMethods.indexOf("setPlayback") < 0) {
          throw new Error("Unknown design runtime method: setPlayback");
        }
        return setPlayback(args.sessionId, args.playing);
      case "previewStylesheet":
        if (enabledOptInMethods.indexOf("previewStylesheet") < 0) {
          throw new Error("Unknown design runtime method: previewStylesheet");
        }
        return previewStylesheet(args.file, args.css === null ? null : args.css);
      case "previewInsert":
        if (enabledOptInMethods.indexOf("previewInsert") < 0) {
          throw new Error("Unknown design runtime method: previewInsert");
        }
        return previewInsert(args);
      case "clearPreviewInserts":
        if (enabledOptInMethods.indexOf("clearPreviewInserts") < 0) {
          throw new Error("Unknown design runtime method: clearPreviewInserts");
        }
        return clearPreviewInserts(args.nodeIds);
      default:
        throw new Error("Unknown design runtime method: " + method);
    }
  }

  function teardown() {
    rewindStructurePreviews();
    if (disposed) return;
    stopPlayback();
    disposed = true;
    if (mutationTimer !== null) {
      window.clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    if (observer) {
      observer.takeRecords();
      observer.disconnect();
      observing = false;
    }
    previewStyleOverridesByOid.forEach(function (properties, oid) {
      var element = elementsByOid.get(oid);
      if (!element) return;
      properties.forEach(function (prior) { restorePreviewStyle(element, prior); });
    });
    visibilityOverridesByOid.forEach(function (prior, oid) {
      var element = elementsByOid.get(oid);
      if (!element) return;
      element.hidden = prior.hidden;
      if (prior.value) element.style.setProperty("display", prior.value, prior.priority);
      else element.style.removeProperty("display");
    });
    previewTextOverridesByOid.forEach(function (preview, oid) {
      var element = elementsByOid.get(oid);
      if (!element) return;
      element.textContent = preview.text;
      restoreTextPreviewPaint(element, preview);
    });
    previewStyleOverridesByOid.clear();
    previewTextOverridesByOid.clear();
    previewAnimationsByOid.forEach(function (animation) { animation.cancel(); });
    previewAnimationsByOid.clear();
    visibilityOverridesByOid.clear();
    activeRequests.forEach(function (id) { cancelledRequests.add(id); });
    activeCaptures.forEach(function (capture) { capture.cancel(); });
    window.removeEventListener("message", receiveHandshake);
    finishTeardown();
  }

  function finishTeardown() {
    if (disposed && activeRequests.size === 0 && parentPort) {
      parentPort.onmessage = null;
      parentPort.close();
      parentPort = null;
    }
  }

  function receivePortMessage(portEvent) {
    var message = portEvent.data;
    // A style/history commit may advance the generation while an old capture
    // finishes. Its private-port cancellation still owns the original job.
    if (message && message.protocol === PROTOCOL && message.version === VERSION && message.type === "cancel") {
      if (activeRequests.has(message.requestId)) {
        cancelledRequests.add(message.requestId);
        var capture = activeCaptures.get(message.requestId);
        if (capture) capture.cancel();
      }
      return;
    }
    if (
      !message ||
      message.protocol !== PROTOCOL ||
      message.version !== VERSION ||
      message.sourceVersion !== SOURCE_VERSION
    ) {
      if (message && typeof message.requestId === "string") {
        response(
          message.requestId,
          false,
          typedError(
            "SOURCE_VERSION_MISMATCH",
            "Design runtime request targets another source generation.",
            true
          )
        );
      }
      return;
    }
    if (message.type === "teardown") {
      teardown();
      return;
    }
    if (
      disposed ||
      message.type !== "request" ||
      typeof message.requestId !== "string" ||
      typeof message.method !== "string" ||
      !message.args ||
      typeof message.args !== "object" ||
      Array.isArray(message.args)
    ) {
      return;
    }
    if (activeRequests.size >= MAX_ACTIVE_REQUESTS) {
      response(
        message.requestId,
        false,
        typedError("BAD_REQUEST", "Too many active design runtime requests.", true)
      );
      return;
    }
    activeRequests.add(message.requestId);
    Promise.resolve()
      .then(function () { return handle(message.method, message.args, message.requestId); })
      .then(
        function (result) {
          if (message.method === "captureScreenshot" && cancelledRequests.has(message.requestId)) {
            response(message.requestId, false, typedError("CANCELLED", "Capture cancelled.", false));
          } else if (!cancelledRequests.has(message.requestId)) {
            response(message.requestId, true, result);
          }
        },
        function (error) {
          if (message.method === "captureScreenshot" || !cancelledRequests.has(message.requestId)) {
            response(message.requestId, false, error);
          }
        }
      )
      .then(function () {
        activeRequests.delete(message.requestId);
        cancelledRequests.delete(message.requestId);
        finishTeardown();
      });
  }

  function receiveHandshake(messageEvent) {
    if (messageEvent.source !== parent || parentPort !== null) return;
    var message = messageEvent.data;
    if (
      !message ||
      message.protocol !== PROTOCOL ||
      message.version !== VERSION ||
      message.type !== "handshake" ||
      message.sourceVersion !== SOURCE_VERSION ||
      messageEvent.ports.length !== 1
    ) {
      if (messageEvent.ports.length === 1) messageEvent.ports[0].close();
      return;
    }
    // Sandboxed frames may have an opaque origin. Validate a real protocol
    // handshake first, then pin its exact parent origin for this document.
    if (trustedParentOrigin === null) trustedParentOrigin = messageEvent.origin;
    if (messageEvent.origin !== trustedParentOrigin) return;
    enabledOptInMethods = Array.isArray(message.features)
      ? OPT_IN_METHODS.filter(function (method) { return message.features.indexOf(method) >= 0; })
      : [];
    parentPort = messageEvent.ports[0];
    parentPort.onmessage = receivePortMessage;
    parentPort.start();
    var publishReady = function () {
      if (disposed || !parentPort) return;
      suspendAuthoredMotion();
      event("ready", {
        sourceVersion: SOURCE_VERSION,
        capabilities: capabilities(),
        snapshot: snapshot()
      });
    };
    // The iframe load event can precede web-font layout. Do not hand fallback
    // glyph pixels to the parent as a revealable document generation.
    var fontsReady = document.fonts && document.fonts.ready;
    if (fontsReady && typeof fontsReady.then === "function") {
      fontsReady.then(publishReady, publishReady);
    } else {
      publishReady();
    }
  }

  window.addEventListener("message", receiveHandshake);
  // A CSS animation that starts later (a hover, :checked or media query
  // state) is stilled as it starts, and media cannot start playing, so no
  // frame repaints in a loop while it sits on the canvas.
  document.addEventListener("animationstart", function (startEvent) {
    if (disposed) return;
    var target = startEvent.target;
    if (target && typeof target.getAnimations === "function") suspendElementMotion(target);
  }, true);
  document.addEventListener("play", function (playEvent) {
    var target = playEvent.target;
    if (playbackSessionId !== null || !target || typeof target.pause !== "function") return;
    try { target.pause(); } catch (_error) {}
  }, true);
  document.addEventListener("transitionrun", function (startEvent) {
    var target = startEvent.target;
    if (target && typeof target.getAnimations === "function") suspendElementMotion(target);
  }, true);
  document.addEventListener("keydown", function (keyEvent) {
    if (playbackSessionId === null || keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    stopPlayback("escape");
  }, true);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopPlayback("hidden");
  });
  // Native controls and same-document anchors work in Play. The sandbox's
  // navigation/network policy remains intact even for an iframe's own URL.
  function containNavigation(clickEvent) {
    var target = clickEvent.target;
    var link = target && typeof target.closest === "function" ? target.closest("a, area") : null;
    if (!link) return;
    clickEvent.preventDefault();
    if (playbackSessionId === null || clickEvent.type !== "click") return;
    var href = link.getAttribute("href") || "";
    if (href.charAt(0) !== "#") return;
    try {
      var destination = document.getElementById(decodeURIComponent(href.slice(1)));
      if (destination) destination.scrollIntoView();
    } catch (_error) {}
  }
  document.addEventListener("click", containNavigation, true);
  document.addEventListener("auxclick", containNavigation, true);
  document.addEventListener("contextmenu", containNavigation, true);
  document.addEventListener("submit", function (submitEvent) { submitEvent.preventDefault(); }, true);
  // Dropping a file or URL onto a browsing document can navigate that iframe
  // without clicking a link. Playback never turns it into a navigation target.
  document.addEventListener("dragover", function (dragEvent) { dragEvent.preventDefault(); }, true);
  document.addEventListener("drop", function (dropEvent) { dropEvent.preventDefault(); }, true);

  function publishMutation() {
    mutationTimer = null;
    revision += 1;
    event("mutation", snapshot());
  }

  /** Absorb any pending observer debounce so an explicit runtime write and the
   * churn it caused publish exactly one new generation, without its 500ms wait. */
  function publishGenerationNow() {
    if (mutationTimer !== null) window.clearTimeout(mutationTimer);
    publishMutation();
  }

  observer = new MutationObserver(function (records) {
    if (disposed || !observing) return;
    // Only a structural change can invalidate the oid map, and this is the one
    // place that learns about one. Runtime-owned writes run inside
    // withoutObservedMutations and never add or remove elements.
    for (var index = 0; index < records.length; index += 1) {
      if (records[index].type === "childList") {
        elementMapStale = true;
        break;
      }
    }
    // Native controls in a playback document are ephemeral; the host restores
    // the saved editing document on exit instead of publishing these changes.
    if (playbackSessionId !== null) return;
    if (mutationTimer !== null) window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(publishMutation, MUTATION_DEBOUNCE_MS);
  });
  function startObserving() {
    if (disposed || !observer || observing) return;
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    observing = true;
  }
  // The runtime is inserted in the head. Parser-created body nodes are the
  // initial saved document, not edits that can invalidate a just-started
  // gesture when the mutation debounce fires after readiness.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving, { once: true });
  } else {
    startObserving();
  }
})();`;
