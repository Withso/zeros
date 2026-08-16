const CSS_PROPERTY = /^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/;

function withoutCssComments(source: string): string {
  let output = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      output += character;
      if (character === "\\") {
        output += source[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) throw new Error("Unclosed CSS comment.");
      output += " ";
      index = close + 1;
      continue;
    }
    output += character;
  }
  if (quote) throw new Error("Unclosed CSS string.");
  return output;
}

/** Parse one declaration list without accepting selectors or nested rules. */
export function parseDesignCssDeclarations(
  source: string,
  maxDeclarations = 64,
): Record<string, string> {
  const input = withoutCssComments(source).trim();
  if (!input) return {};
  const result = new Map<string, string>();
  let segmentStart = 0;
  let colon = -1;
  let quote = "";
  let escaped = false;
  let depth = 0;

  const finish = (end: number) => {
    const rawSegment = input.slice(segmentStart, end);
    const leadingWhitespace = rawSegment.length - rawSegment.trimStart().length;
    const declarationStart = segmentStart + leadingWhitespace;
    const segment = rawSegment.trim();
    segmentStart = end + 1;
    if (!segment) {
      colon = -1;
      return;
    }
    if (colon < declarationStart) {
      throw new Error(`Invalid CSS declaration: ${segment}`);
    }
    const property = input.slice(declarationStart, colon).trim();
    const value = input.slice(colon + 1, end).trim();
    if (!CSS_PROPERTY.test(property) || !value) {
      throw new Error(`Invalid CSS declaration: ${segment}`);
    }
    const normalized = property.startsWith("--")
      ? property
      : property.toLowerCase();
    result.delete(normalized);
    result.set(normalized, value);
    colon = -1;
    if (result.size > maxDeclarations) {
      throw new Error(`CSS paste exceeds ${maxDeclarations} declarations.`);
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
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
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "{" || character === "}") {
      throw new Error("Nested CSS rules are not supported here.");
    } else if (character === ":" && depth === 0 && colon < 0) {
      colon = index;
    } else if (character === ";" && depth === 0) {
      finish(index);
    }
    if (depth < 0) throw new Error("Unbalanced CSS value.");
  }
  if (quote || depth !== 0) throw new Error("Unbalanced CSS value.");
  if (segmentStart < input.length) finish(input.length);
  return Object.fromEntries(result);
}

export function serializeDesignCssDeclarations(
  declarations: Readonly<Record<string, string>>,
): string {
  return Object.entries(declarations)
    .map(([property, value]) => `${property}: ${value};`)
    .join("\n");
}

function runtimeStyleKey(property: string): string {
  if (property.startsWith("--")) return property;
  return property.replace(/-([a-z])/g, (_match, character: string) =>
    character.toUpperCase(),
  );
}

function cssStyleProperty(property: string): string {
  if (property.startsWith("--")) return property;
  return property
    .replace(/([A-Z])/g, "-$1")
    .replace(/^ms-/, "-ms-")
    .toLocaleLowerCase();
}

const AUTHORED_SHORTHAND_TARGETS: Readonly<Record<string, readonly string[]>> =
  {
    margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
    "margin-inline": ["margin-right", "margin-left"],
    "margin-inline-start": ["margin-left", "margin-right"],
    "margin-inline-end": ["margin-right", "margin-left"],
    "margin-block": ["margin-top", "margin-bottom"],
    "margin-block-start": ["margin-top", "margin-bottom"],
    "margin-block-end": ["margin-bottom", "margin-top"],
    padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
    "padding-inline": ["padding-right", "padding-left"],
    "padding-inline-start": ["padding-left", "padding-right"],
    "padding-inline-end": ["padding-right", "padding-left"],
    "padding-block": ["padding-top", "padding-bottom"],
    "padding-block-start": ["padding-top", "padding-bottom"],
    "padding-block-end": ["padding-bottom", "padding-top"],
    inset: ["top", "right", "bottom", "left"],
    "inset-inline": ["right", "left"],
    "inset-inline-start": ["left", "right"],
    "inset-inline-end": ["right", "left"],
    "inset-block": ["top", "bottom"],
    "inset-block-start": ["top", "bottom"],
    "inset-block-end": ["bottom", "top"],
    border: ["border-width", "border-style", "border-color"],
    "border-top": ["border-width", "border-style", "border-color"],
    "border-right": ["border-width", "border-style", "border-color"],
    "border-bottom": ["border-width", "border-style", "border-color"],
    "border-left": ["border-width", "border-style", "border-color"],
    "border-block": ["border-width", "border-style", "border-color"],
    "border-inline": ["border-width", "border-style", "border-color"],
    background: [
      "background-color",
      "background-image",
      "background-position",
      "background-size",
      "background-repeat",
    ],
    font: ["font-family", "font-size", "font-weight", "line-height"],
    flex: ["flex-grow", "flex-shrink", "flex-basis"],
    "flex-flow": ["flex-direction", "flex-wrap"],
    gap: ["row-gap", "column-gap"],
    overflow: ["overflow-x", "overflow-y"],
    outline: ["outline-width", "outline-style", "outline-color"],
    "place-content": ["align-content", "justify-content"],
    "place-items": ["align-items", "justify-items"],
    "place-self": ["align-self", "justify-self"],
    transition: [
      "transition-property",
      "transition-duration",
      "transition-timing-function",
      "transition-delay",
    ],
    animation: [
      "animation-name",
      "animation-duration",
      "animation-timing-function",
      "animation-delay",
      "animation-iteration-count",
      "animation-direction",
      "animation-fill-mode",
    ],
  };

function authoredDeclarationAffects(
  authoredProperty: string,
  inspectedProperty: string,
): boolean {
  if (authoredProperty === inspectedProperty) return true;
  if (authoredProperty === "all" && !inspectedProperty.startsWith("--")) {
    return (
      inspectedProperty !== "direction" && inspectedProperty !== "unicode-bidi"
    );
  }
  if (
    AUTHORED_SHORTHAND_TARGETS[authoredProperty]?.includes(inspectedProperty)
  ) {
    return true;
  }
  if (
    ["border-width", "border-style", "border-color"].includes(inspectedProperty)
  ) {
    const suffix = inspectedProperty.slice("border-".length);
    return new RegExp(
      `^border-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?)-${suffix}$`,
    ).test(authoredProperty);
  }
  return false;
}

function isZeroComputedStyle(value: string): boolean {
  return /^[-+]?0(?:\.0+)?(?:[a-z%]+)?$/i.test(value.trim());
}

/** Older live v2 frame runtimes can remain mounted across renderer HMR and
 * omit authored metadata. Restrict the fallback to non-inherited properties
 * whose computed initial value is unambiguous; geometry-derived width/height
 * and inherited typography must never be guessed as authored. */
function inferAuthoredStyleFromComputed(
  property: string,
  computedValue: string,
): boolean {
  const value = computedValue.trim().toLocaleLowerCase();
  if (!value) return false;
  if (/^(?:margin|padding)-(?:top|right|bottom|left)$/.test(property)) {
    return !isZeroComputedStyle(value);
  }
  if (/^border-(?:width|radius)$/.test(property)) {
    return !isZeroComputedStyle(value);
  }
  const initialValues: Readonly<Record<string, string>> = {
    top: "auto",
    right: "auto",
    bottom: "auto",
    left: "auto",
    "z-index": "auto",
    opacity: "1",
    transform: "none",
    perspective: "none",
    "box-shadow": "none",
    "text-shadow": "none",
    filter: "none",
    "backdrop-filter": "none",
    "background-color": "rgba(0, 0, 0, 0)", // check:ui ignore-line (CSSOM initial value)
    "background-image": "none",
    "border-radius": "0px",
    gap: "normal",
    "row-gap": "normal",
    "column-gap": "normal",
    "transition-duration": "0s",
    "transition-delay": "0s",
    "animation-name": "none",
  };
  const initial = initialValues[property];
  return initial !== undefined && value !== initial;
}

export function isDesignRuntimeStylePropertyAuthored(
  properties: readonly string[] | undefined,
  property: string,
  computedValue?: string,
): boolean {
  const inspectedProperty = cssStyleProperty(property);
  if (properties) {
    return properties.some((authoredProperty) =>
      authoredDeclarationAffects(
        cssStyleProperty(authoredProperty),
        inspectedProperty,
      ),
    );
  }
  return computedValue === undefined
    ? false
    : inferAuthoredStyleFromComputed(inspectedProperty, computedValue);
}

export function designStyleFieldValue(
  properties: readonly string[] | undefined,
  property: string,
  computedValue: string,
): string {
  return isDesignRuntimeStylePropertyAuthored(
    properties,
    property,
    computedValue,
  )
    ? computedValue
    : "";
}

export function readDesignComputedStyle(
  styles: Readonly<Record<string, string>>,
  property: string,
): string {
  return styles[runtimeStyleKey(property)] ?? styles[property] ?? "";
}

const DESIGN_OFFSET_PROPERTIES = new Set(["left", "top", "right", "bottom"]);

/** CSS offsets are inert on a static element. Keep the inspector's generic
 * X/Y fields, color/fill tools, and pasted declaration path consistent by
 * promoting only offset edits to relative positioning. An explicitly authored
 * position always wins. */
export function withDesignPositionContext<T extends string | null>(
  styles: Readonly<Record<string, T>>,
  computedPosition: string,
): Record<string, T | string> {
  if (
    computedPosition !== "static" ||
    styles.position !== undefined ||
    !Object.keys(styles).some((property) =>
      DESIGN_OFFSET_PROPERTIES.has(property),
    )
  ) {
    return { ...styles };
  }
  return { position: "relative", ...styles };
}

interface DesignNumericValue {
  number: number;
  unit: string;
}

function parseDesignNumericValue(value: string): DesignNumericValue | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-z%]*)$/.exec(
    value.trim(),
  );
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? { number, unit: match[2] ?? "" } : null;
}

function formatDesignNumber(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function scrubDesignNumericValue(
  value: string,
  delta: number,
): string | null {
  const parsed = parseDesignNumericValue(value);
  if (!parsed || !Number.isFinite(delta)) return null;
  return `${formatDesignNumber(parsed.number + delta)}${parsed.unit}`;
}

const DESIGN_PX_DEFAULT_PROPERTIES = new Set([
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
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "flex-basis",
  "grid-auto-columns",
  "grid-auto-rows",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "outline-width",
  "outline-offset",
  "font-size",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "perspective",
  "transform-origin",
  "object-position",
  "background-position",
  "background-size",
]);

const DESIGN_MS_DEFAULT_PROPERTIES = new Set([
  "transition-duration",
  "transition-delay",
  "animation-duration",
  "animation-delay",
]);

const DESIGN_LAYOUT_PROPERTIES = new Set([
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "aspect-ratio",
  "box-sizing",
  "margin",
  "padding",
  "border-width",
  "border-style",
  "display",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "justify-self",
  "order",
  "gap",
  "row-gap",
  "column-gap",
  "grid",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-column",
  "grid-row",
  "float",
  "clear",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-overflow",
  "text-wrap",
  "word-break",
  "overflow-wrap",
  "text-transform",
  "white-space",
  "vertical-align",
  "writing-mode",
  "hyphens",
  "transform",
  "transform-origin",
  "perspective",
  "perspective-origin",
]);

/** Design tools treat a bare spatial value as pixels and a bare timing value
 * as milliseconds. CSS itself rejects values such as `width: 320`, so apply
 * the editor convention before both speculative preview and source commit. */
export function normalizeDesignStyleFieldInput(
  property: string,
  input: string,
  baseline: string,
): string {
  const normalizedProperty = cssStyleProperty(property);
  const resolved = resolveDesignNumericExpression(input, baseline);
  const parsed = parseDesignNumericValue(resolved);
  if (!parsed || parsed.unit) return resolved;
  if (DESIGN_PX_DEFAULT_PROPERTIES.has(normalizedProperty)) {
    return `${formatDesignNumber(parsed.number)}px`;
  }
  if (DESIGN_MS_DEFAULT_PROPERTIES.has(normalizedProperty)) {
    return `${formatDesignNumber(parsed.number)}ms`;
  }
  return resolved;
}

/** Whether a preview needs browser layout readback to keep the selected box,
 * spacing controls, and child gap bands aligned with the painted element. */
export function designStylePropertyAffectsLayout(property: string): boolean {
  const normalized = cssStyleProperty(property);
  return (
    normalized.startsWith("--") ||
    DESIGN_LAYOUT_PROPERTIES.has(normalized) ||
    /^(?:margin|padding|border)-(?:top|right|bottom|left)(?:-width)?$/.test(
      normalized,
    ) ||
    /^(?:margin|padding|inset)-(?:block|inline)/.test(normalized) ||
    /^grid-(?:column|row)(?:-|$)/.test(normalized)
  );
}

class NumericExpressionParser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly baseline: number,
  ) {}

  parse(): number {
    const value = this.additive();
    this.whitespace();
    if (this.index !== this.source.length || !Number.isFinite(value)) {
      throw new Error("Invalid numeric expression.");
    }
    return value;
  }

  private whitespace() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private match(character: string): boolean {
    this.whitespace();
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private additive(): number {
    let value = this.multiplicative();
    while (true) {
      if (this.match("+")) value += this.multiplicative();
      else if (this.match("-")) value -= this.multiplicative();
      else return value;
    }
  }

  private multiplicative(): number {
    let value = this.power();
    while (true) {
      if (this.match("*")) value *= this.power();
      else if (this.match("/")) value /= this.power();
      else return value;
    }
  }

  private power(): number {
    let value = this.unary();
    if (this.match("^")) value **= this.power();
    return value;
  }

  private unary(): number {
    if (this.match("+")) return this.unary();
    if (this.match("-")) return -this.unary();
    return this.primary();
  }

  private primary(): number {
    this.whitespace();
    if (this.match("(")) {
      const value = this.additive();
      if (!this.match(")")) throw new Error("Unbalanced numeric expression.");
      return value;
    }
    if ((this.source[this.index] ?? "").toLocaleLowerCase() === "x") {
      this.index += 1;
      return this.baseline;
    }
    const remainder = this.source.slice(this.index);
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(remainder);
    if (!match?.[0]) throw new Error("Expected a number.");
    this.index += match[0].length;
    return Number(match[0]);
  }
}

/** Resolve compact design-tool equations (+10, *2, or x-based arithmetic)
 * against the value captured on focus. Ordinary absolute CSS values pass
 * through unchanged. */
export function resolveDesignNumericExpression(
  input: string,
  baseline: string,
): string {
  const source = input.trim();
  const prior = parseDesignNumericValue(baseline);
  if (!prior || !source) return input;
  const absolute = parseDesignNumericValue(source);
  if (
    absolute &&
    !absolute.unit &&
    /^-\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(source)
  ) {
    return `${formatDesignNumber(absolute.number)}${prior.unit}`;
  }
  if (absolute?.unit || (!/[xX()+*/^]/.test(source) && !/^[+-]/.test(source))) {
    return input;
  }
  const expression =
    /^[+*/^]/.test(source) || /^-\s*\d/.test(source) ? `x${source}` : source;
  try {
    const value = new NumericExpressionParser(expression, prior.number).parse();
    return `${formatDesignNumber(value)}${prior.unit}`;
  } catch {
    return input;
  }
}
