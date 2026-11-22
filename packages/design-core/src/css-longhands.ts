// Whether two CSS properties set any of the same longhands: what a control
// binds is recorded as authored (often a shorthand such as `gap` or
// `background`), while the Style panel and the canvas write longhands
// (`row-gap`, `background-color`). The engine's lint has no DOM to ask, so
// the expansion is a static table, checked against Chromium's own in
// apps/desktop/src/engine/design/__tests__/css-longhands-browser.test.ts.

/** Standard shorthands to the longhands Chromium expands them to. */
export const CSS_SHORTHAND_LONGHANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "animation": ["animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state", "animation-name", "animation-timeline", "animation-range-start", "animation-range-end"],
  "animation-range": ["animation-range-start", "animation-range-end"],
  "background": ["background-image", "background-position-x", "background-position-y", "background-size", "background-repeat", "background-attachment", "background-origin", "background-clip", "background-color"],
  "background-position": ["background-position-x", "background-position-y"],
  "border": ["border-top-color", "border-top-style", "border-top-width", "border-right-color", "border-right-style", "border-right-width", "border-bottom-color", "border-bottom-style", "border-bottom-width", "border-left-color", "border-left-style", "border-left-width", "border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"],
  "border-block": ["border-block-start-color", "border-block-start-style", "border-block-start-width", "border-block-end-color", "border-block-end-style", "border-block-end-width"],
  "border-block-color": ["border-block-start-color", "border-block-end-color"],
  "border-block-end": ["border-block-end-width", "border-block-end-style", "border-block-end-color"],
  "border-block-start": ["border-block-start-width", "border-block-start-style", "border-block-start-color"],
  "border-block-style": ["border-block-start-style", "border-block-end-style"],
  "border-block-width": ["border-block-start-width", "border-block-end-width"],
  "border-bottom": ["border-bottom-width", "border-bottom-style", "border-bottom-color"],
  "border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
  "border-image": ["border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"],
  "border-inline": ["border-inline-start-color", "border-inline-start-style", "border-inline-start-width", "border-inline-end-color", "border-inline-end-style", "border-inline-end-width"],
  "border-inline-color": ["border-inline-start-color", "border-inline-end-color"],
  "border-inline-end": ["border-inline-end-width", "border-inline-end-style", "border-inline-end-color"],
  "border-inline-start": ["border-inline-start-width", "border-inline-start-style", "border-inline-start-color"],
  "border-inline-style": ["border-inline-start-style", "border-inline-end-style"],
  "border-inline-width": ["border-inline-start-width", "border-inline-end-width"],
  "border-left": ["border-left-width", "border-left-style", "border-left-color"],
  "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
  "border-right": ["border-right-width", "border-right-style", "border-right-color"],
  "border-spacing": ["-webkit-border-horizontal-spacing", "-webkit-border-vertical-spacing"],
  "border-style": ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"],
  "border-top": ["border-top-width", "border-top-style", "border-top-color"],
  "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
  "column-rule": ["column-rule-width", "column-rule-style", "column-rule-color"],
  "columns": ["column-width", "column-count", "column-height", "column-wrap"],
  "contain-intrinsic-size": ["contain-intrinsic-width", "contain-intrinsic-height"],
  "container": ["container-name", "container-type"],
  "flex": ["flex-grow", "flex-shrink", "flex-basis"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  "font": ["font-style", "font-variant-ligatures", "font-variant-caps", "font-variant-numeric", "font-variant-east-asian", "font-variant-alternates", "font-variant-position", "font-variant-emoji", "font-weight", "font-stretch", "font-size", "line-height", "font-family", "font-optical-sizing", "font-size-adjust", "font-kerning", "font-feature-settings", "font-variation-settings", "font-language-override"],
  "font-synthesis": ["font-synthesis-weight", "font-synthesis-style", "font-synthesis-small-caps"],
  "font-variant": ["font-variant-ligatures", "font-variant-caps", "font-variant-alternates", "font-variant-numeric", "font-variant-east-asian", "font-variant-position", "font-variant-emoji"],
  "gap": ["row-gap", "column-gap"],
  "grid": ["grid-template-rows", "grid-template-columns", "grid-template-areas", "grid-auto-flow", "grid-auto-rows", "grid-auto-columns"],
  "grid-area": ["grid-row-start", "grid-column-start", "grid-row-end", "grid-column-end"],
  "grid-column": ["grid-column-start", "grid-column-end"],
  "grid-column-gap": ["column-gap"],
  "grid-gap": ["row-gap", "column-gap"],
  "grid-row": ["grid-row-start", "grid-row-end"],
  "grid-row-gap": ["row-gap"],
  "grid-template": ["grid-template-rows", "grid-template-columns", "grid-template-areas"],
  "inset": ["top", "right", "bottom", "left"],
  "inset-block": ["inset-block-start", "inset-block-end"],
  "inset-inline": ["inset-inline-start", "inset-inline-end"],
  "list-style": ["list-style-position", "list-style-image", "list-style-type"],
  "margin": ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  "margin-block": ["margin-block-start", "margin-block-end"],
  "margin-inline": ["margin-inline-start", "margin-inline-end"],
  "marker": ["marker-start", "marker-mid", "marker-end"],
  "mask": ["mask-image", "-webkit-mask-position-x", "-webkit-mask-position-y", "mask-size", "mask-repeat", "mask-origin", "mask-clip", "mask-composite", "mask-mode"],
  "mask-position": ["-webkit-mask-position-x", "-webkit-mask-position-y"],
  "offset": ["offset-position", "offset-path", "offset-distance", "offset-rotate", "offset-anchor"],
  "outline": ["outline-color", "outline-style", "outline-width"],
  "overflow": ["overflow-x", "overflow-y"],
  "overscroll-behavior": ["overscroll-behavior-x", "overscroll-behavior-y"],
  "padding": ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  "padding-block": ["padding-block-start", "padding-block-end"],
  "padding-inline": ["padding-inline-start", "padding-inline-end"],
  "page-break-after": ["break-after"],
  "page-break-before": ["break-before"],
  "page-break-inside": ["break-inside"],
  "place-content": ["align-content", "justify-content"],
  "place-items": ["align-items", "justify-items"],
  "place-self": ["align-self", "justify-self"],
  "scroll-margin": ["scroll-margin-top", "scroll-margin-right", "scroll-margin-bottom", "scroll-margin-left"],
  "scroll-margin-block": ["scroll-margin-block-start", "scroll-margin-block-end"],
  "scroll-margin-inline": ["scroll-margin-inline-start", "scroll-margin-inline-end"],
  "scroll-padding": ["scroll-padding-top", "scroll-padding-right", "scroll-padding-bottom", "scroll-padding-left"],
  "scroll-padding-block": ["scroll-padding-block-start", "scroll-padding-block-end"],
  "scroll-padding-inline": ["scroll-padding-inline-start", "scroll-padding-inline-end"],
  "scroll-timeline": ["scroll-timeline-name", "scroll-timeline-axis"],
  "text-decoration": ["text-decoration-line", "text-decoration-thickness", "text-decoration-style", "text-decoration-color"],
  "text-emphasis": ["text-emphasis-style", "text-emphasis-color"],
  "text-wrap": ["text-wrap-mode", "text-wrap-style"],
  "transition": ["transition-property", "transition-duration", "transition-timing-function", "transition-delay", "transition-behavior"],
  "view-timeline": ["view-timeline-name", "view-timeline-axis", "view-timeline-inset"],
  "white-space": ["white-space-collapse", "text-wrap-mode"],
  "word-wrap": ["overflow-wrap"],
});

const SIDES: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/-inline-(?:start|end)/, ["-left", "-right"]],
  [/-block-(?:start|end)/, ["-top", "-bottom"]],
];
const CORNERS = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];
const SIZES: Readonly<Record<string, string>> = {
  "inline-size": "width", "block-size": "height",
  "min-inline-size": "min-width", "min-block-size": "min-height",
  "max-inline-size": "max-width", "max-block-size": "max-height",
  "contain-intrinsic-inline-size": "contain-intrinsic-width", "contain-intrinsic-block-size": "contain-intrinsic-height",
  "overflow-inline": "overflow-x", "overflow-block": "overflow-y",
};

/** A longhand and the physical ones it may stand for. Conservative: a
 * logical side is either physical side, since the writing mode is not
 * known here. */
function physical(longhand: string): string[] {
  if (Object.hasOwn(SIZES, longhand)) return [longhand, SIZES[longhand]!];
  if (/^border-(?:start|end)-(?:start|end)-radius$/.test(longhand)) return [longhand, ...CORNERS];
  for (const [logical, sides] of SIDES) {
    if (!logical.test(longhand)) continue;
    // inset-inline-start is `left` or `right`, without a prefix.
    return [longhand, ...sides.map((side) => longhand.replace(logical, side).replace(/^inset-/, ""))];
  }
  return [longhand];
}

const expanded = new Map<string, ReadonlySet<string>>();

/** Every longhand a property sets, with physical aliases; a custom or
 * unknown property is itself. */
export function cssPropertyLonghands(property: string): ReadonlySet<string> {
  const name = property.startsWith("--") ? property : property.toLowerCase();
  let found = expanded.get(name);
  if (!found) {
    const longhands = Object.hasOwn(CSS_SHORTHAND_LONGHANDS, name) ? CSS_SHORTHAND_LONGHANDS[name]! : [name];
    found = new Set(longhands.flatMap(physical));
    expanded.set(name, found);
  }
  return found;
}

/** Whether writing one property can change what the other sets. */
export function cssPropertiesOverlap(a: string, b: string): boolean {
  const left = cssPropertyLonghands(a);
  for (const longhand of cssPropertyLonghands(b)) if (left.has(longhand)) return true;
  return false;
}

/** The keys of a property-keyed record that overlap a property. */
export function cssOverlappingProperties(record: Readonly<Record<string, unknown>>, property: string): string[] {
  return Object.keys(record).filter((key) => cssPropertiesOverlap(key, property));
}
