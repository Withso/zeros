// ──────────────────────────────────────────────────────────
// Design iframe runtime protocol
// ──────────────────────────────────────────────────────────
//
// Design frames execute in an opaque sandbox. This file is the one shared
// contract between the engine that injects the runtime and the renderer that
// speaks to it. Authored design files remain HTML/CSS-only: the script below is
// app-owned, nonce-gated, and removed from every screenshot clone.

export const DESIGN_RUNTIME_PROTOCOL = "zeros-design-runtime";
export const DESIGN_RUNTIME_VERSION = 2;
/** Shared renderer/engine bound for one additive design selection. */
export const DESIGN_SELECTION_NODE_LIMIT = 32;
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
  text: string | null;
  visible: boolean;
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
 * Chains built from translation, z-rotation, and positive scale are exact.
 * Skew, mirroring, and 3D transforms report `rotation: 0` with the
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
  styles: Record<string, string>;
  /** Computed-style keys with a direct active declaration on this element.
   * Omitted by older runtimes; inspector chrome treats omission as unknown. */
  authoredStyleProperties?: string[];
}

/** Direct children a gesture measures alongside their container. */
export interface DesignRuntimeChildGeometry {
  oid: string;
  rect: DesignRuntimeRect;
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
  styles: Record<string, string>;
  /** Populated only when the caller asked for children (gap affordances). */
  children: DesignRuntimeChildGeometry[];
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
export interface DesignRuntimeGenerationPatch {
  keyframes?: DesignRuntimeKeyframesUpdate[];
  tokens?: DesignRuntimeTokenUpdate[];
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
  | "previewGeometry"
  | "commitStyles"
  | "previewText"
  | "clearPreviewText"
  | "previewMotion"
  | "clearPreviewStyles"
  | "captureScreenshot";

export interface DesignRuntimeCapabilities {
  methods: DesignRuntimeMethod[];
  cancellation: true;
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
  "previewGeometry",
  "commitStyles",
  "previewText",
  "clearPreviewText",
  "previewMotion",
  "clearPreviewStyles",
  "captureScreenshot",
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
    (value.textSizing === undefined || isRuntimeTextSizing(value.textSizing)) &&
    typeof value.selector === "string" &&
    typeof value.visible === "boolean" &&
    Array.isArray(value.breadcrumb) &&
    value.breadcrumb.length <= 64 &&
    value.breadcrumb.every((part) => typeof part === "string") &&
    isRuntimeRect(value.rect) &&
    (value.box === undefined || isRuntimeNodeBox(value.box)) &&
    Object.keys(value.styles).length <= DESIGN_RUNTIME_STYLE_SNAPSHOT_LIMIT &&
    Object.values(value.styles).every((style) => typeof style === "string") &&
    (value.authoredStyleProperties === undefined ||
      (Array.isArray(value.authoredStyleProperties) &&
        value.authoredStyleProperties.length <= 128 &&
        value.authoredStyleProperties.every(
          (property) => typeof property === "string" && property.length <= 64,
        )))
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
    if (!isRecord(current.value) || current.depth > 64) return false;
    if (
      typeof current.value.oid !== "string" ||
      typeof current.value.tag !== "string" ||
      typeof current.value.name !== "string" ||
      (current.value.text !== null && typeof current.value.text !== "string") ||
      typeof current.value.visible !== "boolean" ||
      !Array.isArray(current.value.children)
    ) {
      return false;
    }
    count += 1;
    if (count > 20_000) return false;
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
    (message.event !== "ready" && message.event !== "mutation") ||
    !isRecord(message.payload)
  ) {
    return false;
  }
  if (message.event === "mutation") return isRuntimeSnapshot(message.payload);
  const payload = message.payload;
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
  var MAX_AUDIT_WARNINGS = 128;
  var MAX_MATCHED_DECLARATIONS = 256;
  var MAX_ACTIVE_REQUESTS = 128;
  var MAX_TREE_NODES = 20000;
  // Keep structured-clone payload nesting well below Chromium's IPC depth
  // ceiling; the outer protocol envelope adds several more object levels.
  var MAX_TREE_DEPTH = 32;
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
    "transform", "transformOrigin", "perspective", "perspectiveOrigin",
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
    "setNodeVisibility", "setTheme", "previewStyles", "previewGeometry", "commitStyles", "previewText", "clearPreviewText", "previewMotion", "clearPreviewStyles",
    "captureScreenshot"
  ];
  // Everything one frame of direct manipulation paints from. Deliberately tiny:
  // the full STYLE_PROPERTIES catalog belongs to the inspector, not the pointer.
  var GEOMETRY_STYLE_PROPERTIES = [
    "display", "position", "flexDirection", "flexWrap",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "gap", "rowGap", "columnGap", "transformOrigin",
    "gridTemplateColumns", "gridTemplateRows"
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
  var committedKeyframesByName = new Map();
  var committedTokensByKey = new Map();
  var committedGenerationStyle = null;
  var committedKeyframeRulesByName = new Map();
  var committedTokenRulesByKey = new Map();
  var lastSnapshot = null;
  var authoredStylePropertiesCache = new WeakMap();
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
  var trustedParentOrigin = null;
  try {
    trustedParentOrigin = document.referrer
      ? new URL(document.referrer).origin
      : null;
  } catch (_error) {
    trustedParentOrigin = null;
  }

  /** The design surface is an editor, not a prototype player. Authored CSS
   * animations and transitions must not continuously repaint or flash during
   * selection/style commits; the explicit previewMotion path owns the only
   * animations allowed to run in Motion mode. */
  function suspendAuthoredMotion() {
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

  /** The same guarantee scoped to one element and its subtree. A preview write
   * can only start a transition on the element it wrote to, so once a gesture's
   * first write has cleared the document there is no reason to re-walk it sixty
   * times a second. */
  function suspendElementMotion(element) {
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

  function post(message) {
    if (parentPort && !disposed) parentPort.postMessage(message);
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
      methods: METHODS.slice(),
      cancellation: true,
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
    return element.children.length === 0 &&
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
    var parent = element.parentElement;
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

  function nameOf(element) {
    var explicit =
      element.getAttribute("aria-label") ||
      element.getAttribute("data-name") ||
      element.getAttribute("title") ||
      element.id ||
      directText(element);
    return explicit
      ? String(explicit).replace(/\s+/g, " ").trim().slice(0, 80)
      : element.tagName.toLowerCase();
  }

  function visibleOf(element) {
    for (
      var current = element;
      current && current instanceof Element;
      current = current.parentElement
    ) {
      var style = getComputedStyle(current);
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

  function stylesOf(computed) {
    var styles = {};
    for (var index = 0; index < STYLE_PROPERTIES.length; index += 1) {
      var property = STYLE_PROPERTIES[index];
      styles[property] = computed[property] || "";
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
      node = node.parentElement
    ) {
      depth += 1;
      var computed = getComputedStyle(node);
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
    // A mirrored or collapsed chain has no rotation to report, and a skewed one
    // paints a parallelogram that no rotated rectangle describes. Both keep the
    // axis-aligned bounding box rather than claiming a wrong orientation.
    if (determinant <= 0 || scaleX <= 0) return box;
    if (Math.abs((a * c + b * d) / (scaleX * scaleX)) > 0.0005) return box;
    // The transform maps the box's own origin to the affine translation, so the
    // bounding box's minimum corner recovers where that origin landed.
    var minX = Math.min(0, a * width, a * width + c * height, c * height);
    var minY = Math.min(0, b * width, b * width + d * height, d * height);
    box.x = roundedGeometry(rect.x - minX);
    box.y = roundedGeometry(rect.y - minY);
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

  function styleRuleMetadata() {
    if (authoredStyleRuleMetadata !== null) return authoredStyleRuleMetadata;
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
    for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex += 1) {
      try {
        visitRules(document.styleSheets[sheetIndex].cssRules || [], true);
      } catch (_error) {
        // Inaccessible sheets cannot provide trustworthy authored metadata.
      }
    }
    authoredStyleRuleMetadata = metadata;
    return metadata;
  }

  function authoredStylePropertiesOf(element) {
    var cached = authoredStylePropertiesCache.get(element);
    if (cached) return cached.slice();
    var authored = new Set(declarationProperties(element.style));
    var rules = styleRuleMetadata();
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
    var result = Array.from(authored).slice(0, 128);
    authoredStylePropertiesCache.set(element, result);
    return result.slice();
  }

  /** Rebuild the oid → element map. Callers that only need to resolve a node
   * should use ensureElementMap: a full document walk per request is 1-3 walks
   * per gesture frame, and the observer already knows when the DOM changed. */
  function refreshElementMap() {
    elementMapStale = false;
    var next = new Map();
    var root = document.body || document.documentElement;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    if (root instanceof Element) {
      var rootOid = oidOf(root);
      if (rootOid) next.set(rootOid, root);
    }
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var oid = oidOf(node);
      if (oid && !next.has(oid)) next.set(oid, node);
    }
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
    var children = [];
    if (depth >= MAX_TREE_DEPTH) {
      if (element.children.length > 0) budget.truncated = true;
    } else {
      for (var index = 0; index < element.children.length; index += 1) {
        var child = element.children[index];
        if (!oidOf(child)) continue;
        var childNode = treeNode(child, depth + 1, budget);
        if (childNode) children.push(childNode);
      }
    }
    return {
      oid: oid,
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: directText(element),
      visible: visibleOf(element),
      children: children
    };
  }

  function breadcrumbOf(element) {
    var result = [];
    for (var current = element; current && current instanceof Element; current = current.parentElement) {
      var oid = oidOf(current);
      if (oid) {
        result.push(current.tagName.toLowerCase() + " · " + nameOf(current));
      }
      if (current === document.body) break;
    }
    return result.reverse();
  }

  function detailsOf(element) {
    var oid = oidOf(element);
    if (!oid) throw new Error("The selected element has no stable data-oid.");
    var escaped = window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape(oid)
      : oid.replace(/["\\]/g, "\\$&");
    var textEditable = textEditableOf(element);
    var computed = getComputedStyle(element);
    var rect = rectOf(element);
    var result = {
      sourceVersion: SOURCE_VERSION,
      oid: oid,
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: textEditable ? editableTextOf(element) : directText(element),
      textEditable: textEditable,
      selector: "[data-oid=\"" + escaped + "\"]",
      visible: visibleOf(element),
      breadcrumb: breadcrumbOf(element),
      rect: rect,
      box: boxOf(element, computed, rect),
      styles: stylesOf(computed),
      authoredStyleProperties: authoredStylePropertiesOf(element)
    };
    if (textEditable) result.textSizing = textSizingOf(element);
    return result;
  }

  function frameDetailsOf(element) {
    var oid = oidOf(element);
    if (oid) return detailsOf(element);
    var computed = getComputedStyle(element);
    var rect = rectOf(element);
    var result = {
      sourceVersion: SOURCE_VERSION,
      oid: "",
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: directText(element),
      textEditable: false,
      selector: element === document.body ? "body" : "html",
      visible: visibleOf(element),
      breadcrumb: [],
      rect: rect,
      box: boxOf(element, computed, rect),
      styles: stylesOf(computed),
      authoredStyleProperties: authoredStylePropertiesOf(element)
    };
    return result;
  }

  function frameElement() {
    return document.querySelector("main[data-oid]") ||
      document.body ||
      document.documentElement;
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

  function snapshot() {
    // A snapshot is the semantic cache generation. Theme changes and observed
    // DOM/style mutations both arrive through this boundary.
    authoredStylePropertiesCache = new WeakMap();
    authoredStyleRuleMetadata = null;
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
    var warnings = auditWarnings();
    if (treeBudget.truncated && warnings.length < MAX_AUDIT_WARNINGS) {
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
    authoredStyleRuleMetadata = null;
    oidStyleRuleIndex = null;
    refreshElementMap();
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
      current = current.parentElement;
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
    var stack = document.elementsFromPoint(x, y);
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
    for (var index = 0; index < scope.children.length; index += 1) {
      var element = scope.children[index];
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

  function applyPreviewStyles(element, oid, styles) {
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
      throw new Error("styles must be an object.");
    }
    var entries = Object.entries(styles);
    if (entries.length < 1 || entries.length > 64) {
      throw new Error("styles must contain between 1 and 64 properties.");
    }
    var priorByProperty = previewStyleOverridesByOid.get(oid);
    var entering = !priorByProperty;
    if (!priorByProperty) {
      priorByProperty = new Map();
      previewStyleOverridesByOid.set(oid, priorByProperty);
    }
    withoutObservedMutations(function () {
      for (var index = 0; index < entries.length; index += 1) {
        var property = entries[index][0];
        var value = entries[index][1];
        if (
          !/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property) ||
          (typeof value !== "string" && value !== null)
        ) {
          throw new Error("Invalid preview style: " + property);
        }
        if (!priorByProperty.has(property)) {
          var inlineValue = element.style.getPropertyValue(property);
          var exactRules = inlineValue
            ? []
            : exactTopLevelStyleRules(oid, property);
          var rule = exactRules.length === 1 ? exactRules[0] : null;
          priorByProperty.set(property, {
            value: inlineValue,
            priority: element.style.getPropertyPriority(property),
            rule: rule,
            ruleValue: rule ? rule.style.getPropertyValue(property) : "",
            rulePriority: rule ? rule.style.getPropertyPriority(property) : ""
          });
        }
        var prior = priorByProperty.get(property);
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
    var oid = oidOf(element);
    if (!oid) throw new Error("The selected element has no stable data-oid.");
    var computed = getComputedStyle(element);
    var rect = rectOf(element);
    var children = [];
    if (includeChildren) {
      for (var index = 0; index < element.children.length; index += 1) {
        if (children.length >= GEOMETRY_CHILD_LIMIT) break;
        var child = element.children[index];
        var childOid = oidOf(child);
        if (!childOid || !visibleOf(child)) continue;
        var childRect = rectOf(child);
        if (childRect.width <= 0 || childRect.height <= 0) continue;
        children.push({
          oid: childOid,
          rect: childRect,
          name: nameOf(child),
          styles: { position: getComputedStyle(child).position || "" }
        });
      }
    }
    return {
      sourceVersion: SOURCE_VERSION,
      oid: oid,
      rect: rect,
      box: boxOf(element, computed, rect),
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
        if (!selectorMatch) continue;
        var ruleOid = selectorMatch[1] || selectorMatch[2] || selectorMatch[3] || "";
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
  function commitStyles(updates, nextSourceVersion, patch) {
    if (!/^[a-f0-9]{24}$/.test(nextSourceVersion)) {
      throw new Error("nextSourceVersion must be a valid source generation.");
    }
    var generationPatch = prepareGenerationPatch(patch);
    if (
      !Array.isArray(updates) ||
      updates.length > 32 ||
      (updates.length < 1 && !generationPatch.changed)
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
      var element = elementForOid(oid);
      var preview = previewStyleOverridesByOid.get(oid);
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
          inlinePriority: inlinePriority,
          rule: prior && prior.rule
            ? prior.rule
            : (exactRules.length === 1 ? exactRules[0] : null)
        };
      });
      return { oid: oid, element: element, preview: preview, plans: plans };
    });
    withoutObservedMutations(function () {
      prepared.forEach(function (update) {
        update.plans.forEach(function (plan) {
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
          if (update.preview) update.preview.delete(plan.property);
        });
        if (update.preview && update.preview.size === 0) {
          previewStyleOverridesByOid.delete(update.oid);
        }
      });
      if (generationPatch.changed) applyCommittedGenerationPatch(generationPatch);
    });
    suspendAuthoredMotion();
    revision += 1;
    SOURCE_VERSION = nextSourceVersion;
    window.__zerosDesignSourceVersion = SOURCE_VERSION;
    var treeUnchanged = prepared.every(function (update) {
      return update.plans.every(function (plan) {
        return plan.property !== "display" && plan.property !== "visibility";
      });
    });
    var nextSnapshot = treeUnchanged ? styleOnlySnapshot() : snapshot();
    return {
      sourceVersion: SOURCE_VERSION,
      treeUnchanged: treeUnchanged,
      snapshot: treeUnchanged
        ? Object.assign({}, nextSnapshot, { tree: [] })
        : nextSnapshot,
      details: prepared.map(function (update) {
        return detailsOf(elementForOid(update.oid));
      })
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
        priorByProperty.forEach(function (prior, property) {
          if (prior.rule) {
            element.style.removeProperty(property);
            if (prior.ruleValue) {
              prior.rule.style.setProperty(
                property,
                prior.ruleValue,
                prior.rulePriority
              );
            } else {
              prior.rule.style.removeProperty(property);
            }
          } else if (prior.value) {
            element.style.setProperty(property, prior.value, prior.priority);
          } else {
            element.style.removeProperty(property);
          }
        });
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
    for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex += 1) {
      var sheet = document.styleSheets[sheetIndex];
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
        var parent = element.parentElement;
        parent && matched.length === 0;
        parent = parent.parentElement
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
  function encodeCanvasPng(canvas, onDataUrl, onError) {
    var fallback = function () {
      try {
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
        if (!blob) {
          fallback();
          return;
        }
        var reader = new FileReader();
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

  function captureScreenshot(args) {
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
    var clone = document.documentElement.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    var scripts = clone.querySelectorAll("script");
    for (var index = scripts.length - 1; index >= 0; index -= 1) {
      scripts[index].remove();
    }
    clone.style.width = viewportWidth + "px";
    clone.style.height = viewportHeight + "px";
    clone.style.overflow = "hidden";
    var serialized = new XMLSerializer().serializeToString(clone);
    var svg =
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + crop.width +
      "\" height=\"" + crop.height + "\" viewBox=\"0 0 " + crop.width +
      " " + crop.height + "\"><foreignObject x=\"" + (-documentX) +
      "\" y=\"" + (-documentY) + "\" width=\"" + viewportWidth +
      "\" height=\"" + viewportHeight + "\">" + serialized +
      "</foreignObject></svg>";
    // A blob URL makes Chromium mark a foreignObject canvas as origin-unclean.
    // A self-contained data URL preserves the same pixels without tainting.
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var image = new Image();
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Frame screenshot timed out."));
      }, 8000);
      image.onload = function () {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          var canvas = document.createElement("canvas");
          canvas.width = outputWidth;
          canvas.height = outputHeight;
          var context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas capture is unavailable.");
          context.drawImage(image, 0, 0, outputWidth, outputHeight);
          encodeCanvasPng(canvas, function (dataUrl) {
            resolve({
              sourceVersion: SOURCE_VERSION,
              dataUrl: dataUrl,
              mimeType: "image/png",
              width: outputWidth,
              height: outputHeight,
              scale: scale,
              nodeId: nodeId
            });
          }, reject);
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = function () {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("Frame screenshot could not be rendered."));
      };
      image.src = url;
    });
  }

  function handle(method, args) {
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
        return detailsOf(elementForOid(args.nodeId));
      case "getMatchedStyles":
        return getMatchedStyles(args.nodeId, args.property);
      case "setNodeVisibility":
        return setNodeVisibility(args.nodeId, args.visible === true);
      case "setTheme":
        return setTheme(args.theme === null ? null : args.theme);
      case "previewStyles":
        return previewStyles(args.nodeId, args.styles);
      case "previewGeometry":
        return previewGeometry(args.nodeId, args.styles, args.children);
      case "commitStyles":
        return commitStyles(args.updates, args.nextSourceVersion, args.patch);
      case "previewText":
        return previewText(args.nodeId, args.text);
      case "clearPreviewText":
        return clearPreviewText(args.nodeId);
      case "previewMotion":
        return previewMotion(args.nodeId, args);
      case "clearPreviewStyles":
        return clearPreviewStyles(args.nodeId);
      case "captureScreenshot":
        return captureScreenshot(args);
      default:
        throw new Error("Unknown design runtime method: " + method);
    }
  }

  function teardown() {
    if (disposed) return;
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
      properties.forEach(function (prior, property) {
        if (prior.rule) {
          element.style.removeProperty(property);
          if (prior.ruleValue) {
            prior.rule.style.setProperty(property, prior.ruleValue, prior.rulePriority);
          } else {
            prior.rule.style.removeProperty(property);
          }
        } else if (prior.value) {
          element.style.setProperty(property, prior.value, prior.priority);
        } else {
          element.style.removeProperty(property);
        }
      });
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
    activeRequests.clear();
    cancelledRequests.clear();
    window.removeEventListener("message", receiveHandshake);
    if (parentPort) {
      parentPort.onmessage = null;
      parentPort.close();
      parentPort = null;
    }
  }

  function receivePortMessage(portEvent) {
    var message = portEvent.data;
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
    if (message.type === "cancel") {
      if (activeRequests.has(message.requestId)) {
        cancelledRequests.add(message.requestId);
      }
      return;
    }
    if (
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
      .then(function () { return handle(message.method, message.args); })
      .then(
        function (result) {
          if (!cancelledRequests.has(message.requestId)) {
            response(message.requestId, true, result);
          }
        },
        function (error) {
          if (!cancelledRequests.has(message.requestId)) {
            response(message.requestId, false, error);
          }
        }
      )
      .then(function () {
        activeRequests.delete(message.requestId);
        cancelledRequests.delete(message.requestId);
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
  startObserving();
})();`;
