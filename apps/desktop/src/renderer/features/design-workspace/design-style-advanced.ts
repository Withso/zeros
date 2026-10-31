import type {
  DesignRuntimeAuthoredStyle,
  DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";

import { canonicalDesignCssProperty } from "./design-computed-css";
import { readDesignComputedStyle } from "./design-style-values";

/** Properties a dedicated Style control already shows, including the
 * shorthands those controls read through their longhands. Everything else an
 * author (person or agent) declares on a layer is listed under Advanced, so
 * no authored CSS is invisible in the Style tab. */
export const DESIGN_STYLE_FIELD_PROPERTIES: ReadonlySet<string> = new Set([
  // Layout, auto layout, constraints and sizing.
  "display", "position", "inset", "top", "right", "bottom", "left",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "box-sizing", "flex", "flex-direction", "flex-wrap", "flex-flow",
  "flex-grow", "flex-shrink", "flex-basis", "align-items", "align-self",
  "justify-content", "justify-items", "justify-self", "gap", "row-gap",
  "column-gap", "grid-template-columns", "grid-template-rows", "padding",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "padding-inline", "padding-block", "overflow", "overflow-x", "overflow-y",
  "object-fit", "object-position",
  // Appearance and fill.
  "opacity", "mix-blend-mode", "border-radius", "border-top-left-radius",
  "border-top-right-radius", "border-bottom-right-radius",
  "border-bottom-left-radius", "background", "background-color",
  "background-image", "background-position", "background-size",
  "background-repeat", "background-blend-mode", "color",
  // Stroke.
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-width", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width", "border-style", "border-color",
  "outline", "outline-width", "outline-style", "outline-color",
  "outline-offset",
  // Effects and transform.
  "box-shadow", "text-shadow", "filter", "backdrop-filter", "clip-path",
  "transform", "transform-origin", "rotate", "scale", "translate",
  "perspective-origin",
  // Typography.
  "font", "font-family", "font-size", "font-weight", "font-style",
  "font-stretch", "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-decoration", "text-decoration-line", "text-transform",
  "text-indent", "text-overflow", "text-wrap", "white-space", "word-break",
  "overflow-wrap", "vertical-align", "writing-mode",
  // Transition and motion.
  "transition", "transition-property", "transition-duration",
  "transition-timing-function", "transition-delay", "animation",
  "animation-name", "animation-duration",
]);

export interface DesignAdvancedStyleRow {
  property: string;
  /** The winning declaration as written (`var(--gap-lg)`), else computed. */
  value: string;
  /** The winning declaration's origin, when the runtime knows it. */
  authored?: DesignRuntimeAuthoredStyle;
}

/** Engine-owned layout markers ride on authored style but are not design
 * properties a person sets. */
function internalProperty(property: string): boolean {
  return property.startsWith("--zeros-");
}

/** Authored declarations on this layer that no dedicated Style control shows,
 * in authored order, each with the value as written. A winner from a shared
 * reset (a universal or type selector such as imported preflight) is not
 * this layer's design and stays out of the list. */
export function designAdvancedStyleRows(
  details: Pick<
    DesignRuntimeNodeDetails,
    "authoredStyleProperties" | "authoredStyles" | "styles" | "baseStyleProperties"
  >,
): DesignAdvancedStyleRow[] {
  const rows: DesignAdvancedStyleRow[] = [];
  const seen = new Set<string>();
  const base = new Set(details.baseStyleProperties ?? []);
  for (const raw of details.authoredStyleProperties ?? []) {
    const property = canonicalDesignCssProperty(raw);
    if (
      seen.has(property) ||
      base.has(property) ||
      DESIGN_STYLE_FIELD_PROPERTIES.has(property) ||
      internalProperty(property)
    )
      continue;
    seen.add(property);
    const authored = details.authoredStyles?.[property];
    if (authored?.scope === "base") continue;
    // An imported framework's own variables (Tailwind's --tw-*) implement its
    // utilities; custom properties authored in this directory stay listed.
    if (property.startsWith("--") && authored?.origin === "source") continue;
    const value =
      authored?.value || readDesignComputedStyle(details.styles, property);
    if (!value) continue;
    rows.push(authored ? { property, value, authored } : { property, value });
  }
  return rows;
}

const CSS_PROPERTY_NAME = /^(?:--[A-Za-z0-9_-]{1,126}|-?[a-z][a-z0-9-]{0,63})$/;

/** A property name a person typed into Advanced, normalized, or null. */
export function designAdvancedPropertyName(input: string): string | null {
  const property = input.trim().startsWith("--")
    ? input.trim()
    : input.trim().toLowerCase();
  return CSS_PROPERTY_NAME.test(property) ? property : null;
}
