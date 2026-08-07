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

export interface DesignRuntimeNodeDetails {
  sourceVersion: string;
  oid: string;
  tag: string;
  name: string;
  text: string | null;
  selector: string;
  visible: boolean;
  breadcrumb: string[];
  rect: DesignRuntimeRect;
  styles: Record<string, string>;
}

export interface DesignRuntimeWarning {
  ruleId: "contrast" | "overflow" | "spacing-scale";
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

export type DesignRuntimeMethod =
  | "getSnapshot"
  | "getElementAtLoc"
  | "getNodeDetails"
  | "getMatchedStyles"
  | "setNodeVisibility"
  | "previewStyles"
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
  "getNodeDetails",
  "getMatchedStyles",
  "setNodeVisibility",
  "previewStyles",
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

function isRuntimeNodeDetails(
  value: unknown,
): value is DesignRuntimeNodeDetails {
  if (!isRecord(value) || !isRecord(value.styles)) return false;
  return (
    isSourceVersion(value.sourceVersion) &&
    typeof value.oid === "string" &&
    typeof value.tag === "string" &&
    typeof value.name === "string" &&
    (value.text === null || typeof value.text === "string") &&
    typeof value.selector === "string" &&
    typeof value.visible === "boolean" &&
    Array.isArray(value.breadcrumb) &&
    value.breadcrumb.length <= 64 &&
    value.breadcrumb.every((part) => typeof part === "string") &&
    isRuntimeRect(value.rect) &&
    Object.keys(value.styles).length <= 128 &&
    Object.values(value.styles).every((style) => typeof style === "string")
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
          warning.ruleId === "spacing-scale") &&
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
  var MAX_CAPTURE_DIMENSION = 4096;
  var MAX_AUDIT_WARNINGS = 128;
  var MAX_MATCHED_DECLARATIONS = 256;
  var MAX_ACTIVE_REQUESTS = 128;
  // Keep worst-case RGBA → PNG base64 within the engine's 12 MB wire cap.
  var MAX_CAPTURE_PIXELS = 2000000;
  var STYLE_PROPERTIES = [
    "position", "left", "top", "right", "bottom", "width", "height",
    "minWidth", "minHeight", "maxWidth", "maxHeight", "boxSizing", "display",
    "flexDirection", "gap", "rowGap", "columnGap",
    "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "alignItems", "justifyContent", "background", "backgroundColor",
    "border", "borderWidth", "borderColor", "borderRadius", "color",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "textAlign", "overflow", "overflowX", "overflowY", "opacity", "boxShadow"
  ];
  var METHODS = [
    "getSnapshot", "getElementAtLoc", "getNodeDetails", "getMatchedStyles",
    "setNodeVisibility", "previewStyles", "clearPreviewStyles",
    "captureScreenshot"
  ];

  if (window.__zerosDesignRuntimeVersion === VERSION) return;
  if (!/^[a-f0-9]{24}$/.test(SOURCE_VERSION)) {
    throw new Error("Design runtime source generation is missing.");
  }
  window.__zerosDesignRuntimeVersion = VERSION;

  var revision = 1;
  var elementsByOid = new Map();
  var visibilityOverridesByOid = new Map();
  var previewStyleOverridesByOid = new Map();
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

  function stylesOf(element) {
    var computed = getComputedStyle(element);
    var styles = {};
    for (var index = 0; index < STYLE_PROPERTIES.length; index += 1) {
      var property = STYLE_PROPERTIES[index];
      styles[property] = computed[property] || "";
    }
    return styles;
  }

  function refreshElementMap() {
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
  }

  function treeNode(element) {
    var oid = oidOf(element);
    var children = [];
    for (var index = 0; index < element.children.length; index += 1) {
      var child = element.children[index];
      if (oidOf(child)) children.push(treeNode(child));
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
    return {
      sourceVersion: SOURCE_VERSION,
      oid: oid,
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: directText(element),
      selector: "[data-oid=\"" + escaped + "\"]",
      visible: visibleOf(element),
      breadcrumb: breadcrumbOf(element),
      rect: rectOf(element),
      styles: stylesOf(element)
    };
  }

  function frameDetailsOf(element) {
    var oid = oidOf(element);
    if (oid) return detailsOf(element);
    return {
      sourceVersion: SOURCE_VERSION,
      oid: "",
      tag: element.tagName.toLowerCase(),
      name: nameOf(element),
      text: directText(element),
      selector: element === document.body ? "body" : "html",
      visible: visibleOf(element),
      breadcrumb: [],
      rect: rectOf(element),
      styles: stylesOf(element)
    };
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
    function add(ruleId, oid, message, fix) {
      var key = ruleId + "\u0000" + oid;
      if (seen.has(key) || warnings.length >= MAX_AUDIT_WARNINGS) return;
      seen.add(key);
      warnings.push({ ruleId: ruleId, oid: oid, message: message, fix: fix });
    }
    elementsByOid.forEach(function (element, oid) {
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
    return warnings;
  }

  function snapshot() {
    refreshElementMap();
    var roots = [];
    var body = document.body;
    if (body && oidOf(body)) {
      roots.push(treeNode(body));
    } else if (body) {
      for (var index = 0; index < body.children.length; index += 1) {
        var child = body.children[index];
        if (oidOf(child)) roots.push(treeNode(child));
      }
    }
    return {
      sourceVersion: SOURCE_VERSION,
      revision: revision,
      tree: roots,
      frame: frameDetailsOf(frameElement()),
      warnings: auditWarnings(),
      viewport: {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    };
  }

  function elementForOid(oid) {
    if (typeof oid !== "string" || !oid) {
      throw new Error("nodeId must be a non-empty data-oid.");
    }
    refreshElementMap();
    var element = elementsByOid.get(oid);
    if (!element) throw new Error("Element not found: " + oid);
    return element;
  }

  function elementAtLoc(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("x and y must be finite frame coordinates.");
    }
    var stack = document.elementsFromPoint(x, y);
    for (var index = 0; index < stack.length; index += 1) {
      var current = stack[index];
      while (current && current instanceof Element) {
        if (oidOf(current)) return detailsOf(current);
        current = current.parentElement;
      }
    }
    return null;
  }

  function withoutObservedMutations(work) {
    var resume = observer && observing;
    if (resume) {
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
      window.requestAnimationFrame(function () { resolve(detailsOf(element)); });
    });
  }

  function setNodeVisibility(oid, visible) {
    var element = elementForOid(oid);
    withoutObservedMutations(function () {
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
    });
    return detailsAfterLayout(element);
  }

  function previewStyles(oid, styles) {
    var element = elementForOid(oid);
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
      throw new Error("styles must be an object.");
    }
    var entries = Object.entries(styles);
    if (entries.length < 1 || entries.length > 64) {
      throw new Error("styles must contain between 1 and 64 properties.");
    }
    var priorByProperty = previewStyleOverridesByOid.get(oid);
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
          priorByProperty.set(property, {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property)
          });
        }
        if (value === null) element.style.removeProperty(property);
        else element.style.setProperty(property, value);
      }
    });
    return detailsAfterLayout(element);
  }

  function clearPreviewStyles(oid) {
    var element = elementForOid(oid);
    var priorByProperty = previewStyleOverridesByOid.get(oid);
    withoutObservedMutations(function () {
      if (priorByProperty) {
        priorByProperty.forEach(function (prior, property) {
          if (prior.value) {
            element.style.setProperty(property, prior.value, prior.priority);
          } else {
            element.style.removeProperty(property);
          }
        });
        previewStyleOverridesByOid.delete(oid);
      }
    });
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

  function captureScreenshot(args) {
    var requestedScale = typeof args.scale === "number" ? args.scale : 1;
    var scale = Math.max(0.1, Math.min(2, requestedScale));
    var nodeId = typeof args.nodeId === "string" && args.nodeId
      ? args.nodeId
      : null;
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    var viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    var crop = nodeId
      ? rectOf(elementForOid(nodeId))
      : { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
    var documentX = crop.x + window.scrollX;
    var documentY = crop.y + window.scrollY;
    if (crop.width <= 0 || crop.height <= 0) {
      throw new Error("The screenshot target has no visible geometry.");
    }
    scale = Math.min(
      scale,
      MAX_CAPTURE_DIMENSION / crop.width,
      MAX_CAPTURE_DIMENSION / crop.height,
      Math.sqrt(MAX_CAPTURE_PIXELS / (crop.width * crop.height))
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
          resolve({
            sourceVersion: SOURCE_VERSION,
            dataUrl: canvas.toDataURL("image/png"),
            mimeType: "image/png",
            width: outputWidth,
            height: outputHeight,
            scale: scale,
            nodeId: nodeId
          });
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
        return elementAtLoc(Number(args.x), Number(args.y));
      case "getNodeDetails":
        return detailsOf(elementForOid(args.nodeId));
      case "getMatchedStyles":
        return getMatchedStyles(args.nodeId, args.property);
      case "setNodeVisibility":
        return setNodeVisibility(args.nodeId, args.visible === true);
      case "previewStyles":
        return previewStyles(args.nodeId, args.styles);
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
        if (prior.value) element.style.setProperty(property, prior.value, prior.priority);
        else element.style.removeProperty(property);
      });
    });
    visibilityOverridesByOid.forEach(function (prior, oid) {
      var element = elementsByOid.get(oid);
      if (!element) return;
      element.hidden = prior.hidden;
      if (prior.value) element.style.setProperty("display", prior.value, prior.priority);
      else element.style.removeProperty("display");
    });
    previewStyleOverridesByOid.clear();
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
    event("ready", {
      sourceVersion: SOURCE_VERSION,
      capabilities: capabilities(),
      snapshot: snapshot()
    });
  }

  window.addEventListener("message", receiveHandshake);

  function publishMutation() {
    mutationTimer = null;
    revision += 1;
    event("mutation", snapshot());
  }

  observer = new MutationObserver(function () {
    if (disposed || !observing) return;
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
