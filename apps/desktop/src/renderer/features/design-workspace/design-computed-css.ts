import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  readDesignComputedStyle,
  serializeDesignCssDeclarations,
} from "./design-style-values";

/** Designer-facing property suggestions. The editor still accepts every valid
 * CSS property; this catalog only makes the common browser vocabulary quick to
 * discover without asking designers to memorize it. */
export const DESIGN_CSS_PROPERTY_SUGGESTIONS = [
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "aspect-ratio",
  "box-sizing",
  "z-index",
  "display",
  "visibility",
  "float",
  "clear",
  "overflow",
  "overflow-x",
  "overflow-y",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "order",
  "gap",
  "row-gap",
  "column-gap",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "justify-self",
  "place-content",
  "place-items",
  "place-self",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-column",
  "grid-row",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-inline",
  "padding-block",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-block",
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-blend-mode",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "outline",
  "outline-width",
  "outline-style",
  "outline-color",
  "outline-offset",
  "color",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-align",
  "text-transform",
  "text-decoration",
  "text-overflow",
  "text-wrap",
  "white-space",
  "word-break",
  "overflow-wrap",
  "vertical-align",
  "writing-mode",
  "direction",
  "unicode-bidi",
  "hyphens",
  "object-fit",
  "object-position",
  "opacity",
  "mix-blend-mode",
  "isolation",
  "box-shadow",
  "text-shadow",
  "filter",
  "backdrop-filter",
  "clip-path",
  "transform",
  "transform-origin",
  "perspective",
  "perspective-origin",
  "transition",
  "transition-property",
  "transition-duration",
  "transition-timing-function",
  "transition-delay",
  "animation",
  "animation-name",
  "animation-duration",
  "animation-timing-function",
  "animation-delay",
  "animation-iteration-count",
  "animation-direction",
  "animation-fill-mode",
  "cursor",
  "pointer-events",
] as const;

const UNIVERSAL_CSS_VALUES = ["inherit", "initial", "unset", "revert"];

const PROPERTY_VALUE_SUGGESTIONS: Readonly<Record<string, readonly string[]>> =
  {
    position: ["static", "relative", "absolute", "fixed", "sticky"],
    display: [
      "block",
      "inline",
      "inline-block",
      "flex",
      "inline-flex",
      "grid",
      "inline-grid",
      "contents",
      "none",
    ],
    visibility: ["visible", "hidden", "collapse"],
    float: ["none", "left", "right", "inline-start", "inline-end"],
    clear: ["none", "left", "right", "both"],
    "box-sizing": ["border-box", "content-box"],
    overflow: ["visible", "hidden", "clip", "scroll", "auto"],
    "overflow-x": ["visible", "hidden", "clip", "scroll", "auto"],
    "overflow-y": ["visible", "hidden", "clip", "scroll", "auto"],
    "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
    "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
    "align-items": ["stretch", "flex-start", "center", "flex-end", "baseline"],
    "align-self": [
      "auto",
      "stretch",
      "flex-start",
      "center",
      "flex-end",
      "baseline",
    ],
    "align-content": [
      "normal",
      "stretch",
      "flex-start",
      "center",
      "flex-end",
      "space-between",
      "space-around",
      "space-evenly",
    ],
    "justify-content": [
      "normal",
      "flex-start",
      "center",
      "flex-end",
      "space-between",
      "space-around",
      "space-evenly",
      "stretch",
    ],
    "justify-items": ["normal", "stretch", "start", "center", "end"],
    "justify-self": ["auto", "normal", "stretch", "start", "center", "end"],
    "grid-auto-flow": ["row", "column", "dense", "row dense", "column dense"],
    "background-repeat": [
      "repeat",
      "repeat-x",
      "repeat-y",
      "no-repeat",
      "space",
      "round",
    ],
    "background-size": ["auto", "cover", "contain"],
    "border-style": ["none", "solid", "dashed", "dotted", "double"],
    "font-style": ["normal", "italic", "oblique"],
    "font-weight": [
      "normal",
      "bold",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
    ],
    "text-align": ["start", "center", "end", "left", "right", "justify"],
    "text-transform": ["none", "capitalize", "uppercase", "lowercase"],
    "text-overflow": ["clip", "ellipsis"],
    "text-wrap": ["wrap", "nowrap", "balance", "pretty"],
    "white-space": [
      "normal",
      "nowrap",
      "pre",
      "pre-wrap",
      "pre-line",
      "break-spaces",
    ],
    "word-break": ["normal", "break-all", "keep-all", "break-word"],
    "overflow-wrap": ["normal", "break-word", "anywhere"],
    "object-fit": ["fill", "contain", "cover", "none", "scale-down"],
    "mix-blend-mode": [
      "normal",
      "multiply",
      "screen",
      "overlay",
      "darken",
      "lighten",
      "difference",
    ],
    isolation: ["auto", "isolate"],
    "pointer-events": ["auto", "none"],
    cursor: [
      "auto",
      "default",
      "pointer",
      "move",
      "text",
      "grab",
      "grabbing",
      "not-allowed",
    ],
    transform: ["none"],
    filter: ["none"],
    "backdrop-filter": ["none"],
    "box-shadow": ["none"],
    "text-shadow": ["none"],
  };

export function canonicalDesignCssProperty(property: string): string {
  if (property.startsWith("--")) return property;
  return property
    .replace(/([A-Z])/g, "-$1")
    .replace(/^webkit-/, "-webkit-")
    .replace(/^moz-/, "-moz-")
    .replace(/^ms-/, "-ms-")
    .toLocaleLowerCase();
}

let browserCssPropertySuggestions: readonly string[] | null = null;

/** Keep the hand-curated designer vocabulary first, then expose every CSS
 * property implemented by this browser. The latter is discovered lazily from
 * CSSStyleDeclaration so newer properties work without waiting for this list
 * to be updated. */
export function designCssPropertySuggestions(): readonly string[] {
  if (browserCssPropertySuggestions) return browserCssPropertySuggestions;
  if (typeof document !== "object" || !document.body) {
    return DESIGN_CSS_PROPERTY_SUGGESTIONS;
  }

  const seen = new Set<string>(DESIGN_CSS_PROPERTY_SUGGESTIONS);
  const supported: string[] = [];
  const style = document.body.style as unknown as Record<string, unknown>;
  for (const property in style) {
    if (
      property === "cssText" ||
      property === "cssFloat" ||
      typeof style[property] !== "string"
    ) {
      continue;
    }
    const canonical = canonicalDesignCssProperty(property);
    if (
      !/^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(canonical) ||
      seen.has(canonical)
    ) {
      continue;
    }
    seen.add(canonical);
    supported.push(canonical);
  }
  browserCssPropertySuggestions = [
    ...DESIGN_CSS_PROPERTY_SUGGESTIONS,
    ...supported.sort(),
  ];
  return browserCssPropertySuggestions;
}

/** Values are computed by the iframe runtime, but only directly authored
 * declarations are shown. This keeps the surface concise like browser
 * inspector rules instead of dumping every inherited browser default. */
export function computedDesignCssDeclarations(
  details: DesignRuntimeNodeDetails,
): Record<string, string> {
  const properties =
    details.authoredStyleProperties ?? Object.keys(details.styles);
  const declarations: Record<string, string> = {};
  for (const property of properties) {
    const canonical = canonicalDesignCssProperty(property);
    const value = readDesignComputedStyle(details.styles, canonical);
    if (!value || Object.hasOwn(declarations, canonical)) continue;
    declarations[canonical] = value;
  }
  return declarations;
}

export function computedDesignCssSource(
  details: DesignRuntimeNodeDetails,
): string {
  return serializeDesignCssDeclarations(computedDesignCssDeclarations(details));
}

export function diffDesignCssDeclarations(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const [property, value] of Object.entries(next)) {
    if (previous[property] !== value) patch[property] = value;
  }
  for (const property of Object.keys(previous)) {
    if (!Object.hasOwn(next, property)) patch[property] = null;
  }
  return patch;
}

export function designCssValueSuggestions(property: string): readonly string[] {
  return [
    ...(PROPERTY_VALUE_SUGGESTIONS[property] ?? []),
    ...UNIVERSAL_CSS_VALUES,
  ];
}
