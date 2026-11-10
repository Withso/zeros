import postcss from "postcss";
import type { DefaultTreeAdapterTypes } from "parse5";

import type { DesignLintViolation } from "./document-model";
import { isDesignNodeElement, isShadowDesignNodeElement } from "./node-identities";

// The Design authoring contract's advisory checks. Each one warns only: a
// frame that breaks the contract still renders, validates and saves. They are
// deliberately conservative, because a warning a careful designer would argue
// with teaches agents to ignore the rest.

type Element = DefaultTreeAdapterTypes.Element;
type Location = { startLine?: number; startCol?: number } | null | undefined;

/** Normalized colour (8-bit channels, alpha to three places) to the tokens
 * whose own default-theme value is exactly that colour. */
export type DesignTokenColorIndex = ReadonlyMap<string, readonly string[]>;

const REPEAT_THRESHOLD = 3;
const MAX_INLINE_STYLE_WARNINGS = 10;
const MAX_LITERAL_WARNINGS = 20;
const MAX_MARKUP_WARNINGS = 10;
/** Inline sets of one declaration are mostly positioning and sizing edits. */
const MIN_INLINE_DECLARATIONS = 2;
/** Elements in a repeated subtree, its root included, and levels below its
 * root: a card with nested content, not a <li> or a flat group of lines. */
const MIN_MARKUP_ELEMENTS = 4;
const MIN_MARKUP_DEPTH = 2;
const PLACES_SHOWN = 3;

function violation(
  file: string,
  ruleId: DesignLintViolation["ruleId"],
  message: string,
  location: Location,
  oid: string | null,
  fix: string,
): DesignLintViolation {
  return {
    ruleId,
    severity: "warning",
    message,
    file,
    line: location?.startLine ?? 1,
    column: location?.startCol ?? 1,
    ...(oid ? { oid } : {}),
    fix,
  };
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function places(lines: readonly number[]): string {
  const shown = lines.slice(0, PLACES_SHOWN);
  const rest = lines.length - shown.length;
  const list = rest > 0
    ? `${shown.join(", ")} and ${rest} more`
    : shown.length > 1
      ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
      : String(shown[0]);
  return `${lines.length === 1 ? "line" : "lines"} ${list}`;
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Report findings in order, keeping `cap - 1` and one remaining-count line
 * past the cap, as unknown-class does. */
function capped<T>(
  findings: readonly T[],
  cap: number,
  report: (finding: T) => DesignLintViolation,
  remainder: (count: number, first: T) => DesignLintViolation,
): DesignLintViolation[] {
  if (findings.length <= cap) return findings.map(report);
  return [
    ...findings.slice(0, cap - 1).map(report),
    remainder(findings.length - (cap - 1), findings[cap - 1]!),
  ];
}

/** Marks markup captured or pasted from a site or an app, on its root. Its
 * classes and inline styles are the source's, not this directory's
 * vocabulary, so the contract checks leave the whole subtree alone. */
export const DESIGN_CAPTURED_ATTRIBUTE = "data-zd-captured";

function marksCaptured(element: Element): boolean {
  return element.attrs.some((entry) => entry.name === DESIGN_CAPTURED_ATTRIBUTE);
}

/** Whether an element or one of its light-DOM ancestors is marked captured. */
function capturedLookup(): (element: Element) => boolean {
  const known = new Map<Element, boolean>();
  return (element) => {
    const chain: Element[] = [];
    let captured = false;
    for (let current: DefaultTreeAdapterTypes.ParentNode | null = element; current && "tagName" in current; ) {
      const cached = known.get(current);
      if (cached !== undefined) { captured = cached; break; }
      chain.push(current);
      if (marksCaptured(current)) { captured = true; break; }
      current = current.parentNode as DefaultTreeAdapterTypes.ParentNode | null;
    }
    for (const visited of chain) known.set(visited, captured);
    return captured;
  };
}

/** Light-DOM layers under body: what the frame's own markup authors. Shadow
 * content renders a host's private markup and is left alone. */
function authoredLayers(records: readonly { element: Element; oid: string | null }[]) {
  return records.filter(({ element }) => isDesignNodeElement(element) && !isShadowDesignNodeElement(element));
}

// ── Repeated inline style ──────────────────────────────────

function inlineDeclarationKey(style: string): string | null {
  let root: postcss.Root;
  try {
    root = postcss.parse(`x{${style}}`);
  } catch {
    return null;
  }
  const declarations: string[] = [];
  root.walkDecls((declaration) => {
    // Custom properties set inline are per-element parameters (--progress,
    // --swatch), not shared styling.
    if (declaration.prop.startsWith("--")) return;
    const property = declaration.prop.trim().toLowerCase();
    const value = declaration.value.trim().replace(/\s+/g, " ");
    declarations.push(`${property}: ${value}${declaration.important ? " !important" : ""}`);
  });
  if (declarations.length < MIN_INLINE_DECLARATIONS) return null;
  return [...new Set(declarations)].sort().join("; ");
}

function repeatedInlineStyles(
  file: string,
  layers: readonly { element: Element; oid: string | null }[],
): DesignLintViolation[] {
  const groups = new Map<string, { element: Element; oid: string | null }[]>();
  for (const layer of layers) {
    const style = attribute(layer.element, "style");
    if (!style) continue;
    const key = inlineDeclarationKey(style);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(layer);
    else groups.set(key, [layer]);
  }
  const repeated = [...groups].filter(([, members]) => members.length >= REPEAT_THRESHOLD);
  const fix = "Declare it once as a class in the frame's <style> or a Design stylesheet and use that class on each element; keep inline style for one-off values.";
  const locate = (element: Element) =>
    element.sourceCodeLocation?.attrs?.style ?? element.sourceCodeLocation?.startTag;
  return capped(
    repeated,
    MAX_INLINE_STYLE_WARNINGS,
    ([key, members]) => violation(
      file,
      "repeated-inline-style",
      `Move the inline style "${truncate(key)}", repeated on ${members.length} elements (${places(members.map(({ element }) => locate(element)?.startLine ?? 1))}), into one class.`,
      locate(members[0]!.element),
      members[0]!.oid,
      fix,
    ),
    (count, [, members]) => violation(
      file,
      "repeated-inline-style",
      `${count} more inline styles are repeated on three or more elements in this frame.`,
      locate(members[0]!.element),
      members[0]!.oid,
      fix,
    ),
  );
}

// ── Literal token values ───────────────────────────────────

function channel(text: string, scale: number): number | null {
  const percent = text.endsWith("%");
  const number = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(number)) return null;
  return percent ? (number / 100) * scale : number;
}

function colorKey(r: number, g: number, b: number, a: number): string | null {
  if (![r, g, b, a].every(Number.isFinite)) return null;
  const byte = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  return `${byte(r)},${byte(g)},${byte(b)},${Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000}`;
}

/** One hex, rgb() or hsl() colour as a comparable key. Named colours,
 * relative and wide-gamut syntaxes are left out rather than approximated. */
export function designColorLiteralKey(literal: string): string | null {
  const text = literal.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const [r, g, b, a = "ff"] = hex.length <= 4 ? [...hex].map((digit) => digit + digit) : hex.match(/../g)!;
    return colorKey(parseInt(r!, 16), parseInt(g!, 16), parseInt(b!, 16), parseInt(a, 16) / 255);
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text);
  if (!fn) return null;
  const body = fn[2]!.trim();
  const [channels, alphaText] = body.includes("/")
    ? (body.split("/") as [string, string])
    : [body, undefined];
  let parts = channels.includes(",") ? channels.split(",") : channels.trim().split(/\s+/);
  parts = parts.map((part) => part.trim()).filter(Boolean);
  let alpha = alphaText?.trim();
  if (alpha === undefined && parts.length === 4) alpha = parts.pop();
  if (parts.length !== 3 || (alphaText !== undefined && body.split("/").length !== 2)) return null;
  const a = alpha === undefined ? 1 : channel(alpha, 1);
  if (a === null) return null;
  if (fn[1]!.startsWith("rgb")) {
    const [r, g, b] = parts.map((part) => channel(part, 255));
    return r === null || g === null || b === null ? null : colorKey(r!, g!, b!, a);
  }
  const hue = /^(-?[\d.]+)(deg)?$/.exec(parts[0]!);
  const s = channel(parts[1]!.endsWith("%") ? parts[1]! : `${parts[1]}%`, 1);
  const l = channel(parts[2]!.endsWith("%") ? parts[2]! : `${parts[2]}%`, 1);
  if (!hue || s === null || l === null) return null;
  const h = ((Number(hue[1]) % 360) + 360) % 360;
  const k = (n: number) => (n + h / 30) % 12;
  const range = s * Math.min(l, 1 - l);
  const f = (n: number) => l - range * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return colorKey(f(0) * 255, f(8) * 255, f(4) * 255, a);
}

/** Tokens whose own value is one colour literal; aliases (`var(--x)`) are
 * left out, so the suggestion names the token that holds the value. */
export function designTokenColorIndex(
  tokens: Iterable<{ name: string; value: string }>,
): DesignTokenColorIndex {
  const index = new Map<string, string[]>();
  for (const token of tokens) {
    const key = designColorLiteralKey(token.value);
    if (!key) continue;
    const names = index.get(key) ?? [];
    if (!names.includes(token.name)) names.push(token.name);
    index.set(key, names);
  }
  return index;
}

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)/gi;

/** Colour literals in one declaration value. A url() is a reference, so
 * `url(#fade)` is not the colour #ffaadd. */
function colorLiterals(value: string): { text: string; key: string }[] {
  const masked = value.replace(/url\([^)]*\)/gi, (match) => " ".repeat(match.length));
  const found: { text: string; key: string }[] = [];
  for (const match of masked.matchAll(COLOR_LITERAL)) {
    const key = designColorLiteralKey(match[0]);
    if (key) found.push({ text: value.slice(match.index!, match.index! + match[0].length), key });
  }
  return found;
}

function literalTokenValues(
  file: string,
  source: string,
  layers: readonly { element: Element; oid: string | null }[],
  allRecords: readonly { element: Element; oid: string | null }[],
  index: DesignTokenColorIndex,
  lineAt: (offset: number) => { startLine: number; startCol: number },
  frameCaptured: boolean,
): DesignLintViolation[] {
  if (index.size === 0) return [];
  const findings = new Map<string, { text: string; tokens: readonly string[]; lines: number[]; location: Location; oid: string | null }>();
  const record = (text: string, key: string, location: Location, oid: string | null) => {
    const tokens = index.get(key);
    if (!tokens) return;
    const finding = findings.get(key);
    if (finding) finding.lines.push(location?.startLine ?? 1);
    else findings.set(key, { text, tokens, lines: [location?.startLine ?? 1], location, oid });
  };
  const walk = (css: string, declarationList: boolean, at: (offset: number) => Location, oid: string | null) => {
    let root: postcss.Root;
    const prefix = declarationList ? "x{" : "";
    try {
      root = postcss.parse(`${prefix}${css}${declarationList ? "}" : ""}`);
    } catch {
      return;
    }
    root.walkDecls((declaration) => {
      // A custom property declares a value; it is not a use of a token.
      if (declaration.prop.startsWith("--")) return;
      const offset = Math.max(0, (declaration.source?.start?.offset ?? 0) - prefix.length);
      for (const literal of colorLiterals(declaration.value)) record(literal.text, literal.key, at(offset), oid);
    });
  };
  // The frame's own stylesheets, in the document or its head; shadow roots
  // and templates hold a host's private styles. A frame captured as a whole
  // (marked on <html> or <body>) brought its stylesheets along too.
  for (const { element } of allRecords) {
    if (frameCaptured || element.tagName !== "style" || isInTemplate(element)) continue;
    const text = element.childNodes[0];
    const start = text && "sourceCodeLocation" in text ? text.sourceCodeLocation?.startOffset : undefined;
    if (start === undefined) continue;
    const css = source.slice(start, element.sourceCodeLocation?.endTag?.startOffset ?? start);
    walk(css, false, (offset) => lineAt(start + offset), null);
  }
  for (const { element, oid } of layers) {
    const style = attribute(element, "style");
    const location = element.sourceCodeLocation?.attrs?.style ?? element.sourceCodeLocation?.startTag;
    if (style) walk(style, true, () => location, oid);
  }
  const fix = "Use the token so the value follows the directory's tokens and themes; keep a literal only where no token means that value.";
  const ordered = [...findings.values()].sort((left, right) => (left.location?.startLine ?? 1) - (right.location?.startLine ?? 1));
  return capped(
    ordered,
    MAX_LITERAL_WARNINGS,
    (finding) => {
      const tokens = finding.tokens.slice(0, PLACES_SHOWN).map((name) => `var(${name})`);
      const choice = tokens.length > 1 ? `${tokens.slice(0, -1).join(", ")} or ${tokens.at(-1)}` : tokens[0];
      const where = finding.lines.length === 1 ? places(finding.lines) : `${finding.lines.length} places: ${places(finding.lines)}`;
      return violation(file, "literal-token-value", `Write ${choice} instead of the literal colour "${finding.text}" (${where}).`, finding.location, finding.oid, fix);
    },
    (count, first) => violation(
      file,
      "literal-token-value",
      `${count} more literal colours in this frame equal a token's value.`,
      first.location,
      first.oid,
      fix,
    ),
  );
}

function isInTemplate(element: Element): boolean {
  for (let current = element.parentNode as DefaultTreeAdapterTypes.ParentNode | null; current; ) {
    if ("tagName" in current && current.tagName === "template") return true;
    if (!("tagName" in current) && current.nodeName === "#document-fragment") return true;
    current = "parentNode" in current ? (current.parentNode as DefaultTreeAdapterTypes.ParentNode | null) : null;
  }
  return false;
}

// ── Repeated markup ────────────────────────────────────────

interface Shape {
  id: number;
  size: number;
  depth: number;
}

/** State classes (`is-active`, `has-error`) mark a state of the same markup. */
const STATE_CLASS = /^(?:is|has)-/;

/** Same shape means the same tags and classes in the same tree. Text, state
 * classes and other attributes are ignored, so drawn states of one control
 * match. An inline <svg> and a component instance are leaves. */
function repeatedMarkup(
  file: string,
  layers: readonly { element: Element; oid: string | null }[],
  captured: (element: Element) => boolean,
): DesignLintViolation[] {
  const authored = new Set(layers.map(({ element }) => element));
  const oids = new Map(layers.map(({ element, oid }) => [element, oid]));
  const interned = new Map<string, number>();
  const shapes = new Map<Element, Shape>();
  const children = (element: Element) =>
    element.childNodes.filter((node): node is Element => "tagName" in node && authored.has(node));
  const shapeOf = (root: Element): Shape => {
    // Iterative post-order: deeply nested captured markup must not overflow.
    const stack: { element: Element; visited: boolean }[] = [{ element: root, visited: false }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (shapes.has(top.element)) { stack.pop(); continue; }
      // Captured markup is one opaque leaf inside the markup around it.
      const leaf = top.element.tagName === "svg" || top.element.tagName.startsWith("zd-") || captured(top.element);
      const kids = leaf ? [] : children(top.element);
      if (!top.visited) {
        top.visited = true;
        for (const kid of kids) if (!shapes.has(kid)) stack.push({ element: kid, visited: false });
        continue;
      }
      stack.pop();
      const classes = (attribute(top.element, "class") ?? "")
        .split(/[\t\n\f\r ]+/)
        .filter((name) => name && !STATE_CLASS.test(name))
        .sort()
        .join(".");
      const kidShapes = kids.map((kid) => shapes.get(kid)!);
      const key = `${top.element.tagName}.${classes}(${kidShapes.map((shape) => shape.id).join(",")})`;
      let id = interned.get(key);
      if (id === undefined) interned.set(key, (id = interned.size));
      shapes.set(top.element, {
        id,
        size: 1 + kidShapes.reduce((sum, shape) => sum + shape.size, 0),
        depth: kidShapes.length ? 1 + Math.max(...kidShapes.map((shape) => shape.depth)) : 0,
      });
    }
    return shapes.get(root)!;
  };
  const groups = new Map<number, Element[]>();
  for (const { element } of layers) {
    if (element.tagName.startsWith("zd-") || captured(element)) continue;
    const shape = shapeOf(element);
    if (shape.size < MIN_MARKUP_ELEMENTS || shape.depth < MIN_MARKUP_DEPTH) continue;
    const group = groups.get(shape.id);
    if (group) group.push(element);
    else groups.set(shape.id, [element]);
  }
  // Largest shapes first; a repeat inside an already reported repeat is part
  // of that component, not a second one.
  const covered = new Set<Element>();
  const cover = (element: Element) => {
    const pending = [element];
    while (pending.length) {
      const next = pending.pop()!;
      covered.add(next);
      pending.push(...children(next));
    }
  };
  const ordered = [...groups.values()]
    .filter((members) => members.length >= REPEAT_THRESHOLD)
    .sort((left, right) => shapes.get(right[0]!)!.size - shapes.get(left[0]!)!.size);
  const reported: Element[][] = [];
  for (const members of ordered) {
    const open = members.filter((element) => !covered.has(element));
    if (open.length < REPEAT_THRESHOLD) continue;
    for (const element of open) cover(element);
    reported.push(open);
  }
  reported.sort((left, right) =>
    (left[0]!.sourceCodeLocation?.startOffset ?? 0) - (right[0]!.sourceCodeLocation?.startOffset ?? 0));
  const fix = "Define it once as components/<name>.html with <slot> for its content and data-zd-attr for attribute values, then place one <zd-name> per use.";
  const describe = (element: Element) => {
    const classes = (attribute(element, "class") ?? "").split(/[\t\n\f\r ]+/).filter(Boolean).slice(0, 2).join(" ");
    return classes ? `<${element.tagName}> markup with class "${classes}",` : `<${element.tagName}> markup`;
  };
  return capped(
    reported,
    MAX_MARKUP_WARNINGS,
    (members) => violation(
      file,
      "repeated-markup",
      `Make the ${describe(members[0]!)} repeated ${members.length} times (${places(members.map((element) => element.sourceCodeLocation?.startLine ?? 1))}), one component.`,
      members[0]!.sourceCodeLocation?.startTag,
      oids.get(members[0]!) ?? null,
      fix,
    ),
    (count, members) => violation(
      file,
      "repeated-markup",
      `${count} more repeated markup shapes in this frame could each be one component.`,
      members[0]!.sourceCodeLocation?.startTag,
      oids.get(members[0]!) ?? null,
      fix,
    ),
  );
}

/** The authoring contract's warnings for one frame source. */
export function lintDesignAuthoringContract(input: {
  file: string;
  source: string;
  records: readonly { element: Element; oid: string | null }[];
  tokenColors: DesignTokenColorIndex | undefined;
  lineAt: (offset: number) => { startLine: number; startCol: number };
}): DesignLintViolation[] {
  const captured = capturedLookup();
  const layers = authoredLayers(input.records);
  const own = layers.filter(({ element }) => !captured(element));
  const frameCaptured = input.records.some(
    ({ element }) => (element.tagName === "html" || element.tagName === "body") && marksCaptured(element),
  );
  return [
    ...repeatedInlineStyles(input.file, own),
    ...literalTokenValues(input.file, input.source, own, input.records, input.tokenColors ?? new Map(), input.lineAt, frameCaptured),
    ...repeatedMarkup(input.file, layers, captured),
  ];
}
