import { createHash } from "node:crypto";
import postcss from "postcss";

// Per-frame pruning of imported style sources. Every frame used to carry each
// source whole; a large design system or a font with many subsets then cost
// its full size in every frame. A source is indexed once per revision: each
// top-level statement, and each statement inside @media, @supports, @layer,
// @container, @scope and @starting-style, becomes a unit with offsets into
// the CSS. A frame then receives:
// - rules whose selectors can match its classes, ids and element names
//   (attribute selectors, pseudo-classes and their arguments never prune, so
//   theme selectors and states such as [open] keep working);
// - every other statement, such as @property, @layer order and @page;
// - the @font-face rules for families the kept CSS or the frame names, when
//   their unicode-range covers characters the frame shows;
// - the @keyframes the kept CSS or the frame names.
// Frames run no JavaScript, so their classes and ids change only when their
// source does, which renders and prunes again.
//
// The index is typed arrays: selector features and custom property names are
// 32-bit hashes, so a collision can only keep a rule a frame does not need.

const UNIT_ALWAYS = 0;
const UNIT_RULE = 1;
const UNIT_FONT_FACE = 2;
const UNIT_KEYFRAMES = 3;

const WRAPPERS = new Set(["media", "supports", "layer", "container", "scope", "document", "-moz-document", "starting-style"]);
const KEYFRAMES = /^(?:-[a-z]+-)?keyframes$/i;
/** Elements every frame document has. */
const PRESENT_TAGS = new Set(["html", "head", "body"]);
/** How much of one value is kept to find font and animation names. */
const MAX_REFERENCE_VALUE = 512;
const VARIABLE_READ = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** FNV-1a over UTF-16 code units. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let at = 0; at < value.length; at += 1) {
    result ^= value.charCodeAt(at);
    result = Math.imul(result, 0x01000193);
  }
  return result | 0;
}

export interface DesignCssIndex {
  css: string;
  start: Int32Array;
  end: Int32Array;
  kind: Uint8Array;
  /** Innermost wrapper of each unit, or -1. */
  wrapper: Int32Array;
  wrapperStart: Int32Array;
  /** Offset just after the wrapper's `{`. */
  wrapperOpenEnd: Int32Array;
  wrapperParent: Int32Array;
  /** Unit u's selectors are ruleSelectors[u]..ruleSelectors[u + 1]. */
  ruleSelectors: Int32Array;
  /** Selector s's features are features[selectorBounds[s]..selectorBounds[s + 1]]. */
  selectorBounds: Int32Array;
  /** Hashes of ".class", "#id" or an element name, lowercase. */
  features: Int32Array;
  /** Unit u reads the custom properties reads[readStart[u]..readStart[u + 1]]. */
  readStart: Int32Array;
  reads: Int32Array;
  /** Custom property definitions: unit, name, bounded lowercase value and
   * the properties the value reads. */
  defineUnit: Int32Array;
  defineName: Int32Array;
  defineValue: string[];
  defineReadStart: Int32Array;
  defineReads: Int32Array;
  /** Lowercase font, font-family, animation and animation-name values. */
  text: Map<number, string>;
  /** Characters beyond ASCII that `content` values show. */
  codePoints: Map<number, number[]>;
  faces: Map<number, { family: string; ranges: number[] | null }>;
  keyframes: Map<number, string>;
  /** Units whose text is not a slice of css: a named @layer's order statement. */
  synthetic: Map<number, string>;
  /** What the index holds in memory, near enough for cache budgets. */
  bytes: number;
}

function isIdentifierCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95 || code >= 128;
}

/** An identifier starting at `index`, with CSS escapes decoded. */
function readIdentifier(selector: string, index: number): [string, number] {
  let name = "";
  let at = index;
  while (at < selector.length) {
    const code = selector.charCodeAt(at);
    if (code === 92) {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(selector.slice(at + 1, at + 7));
      if (hex) {
        const point = Number.parseInt(hex[0], 16);
        name += point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : REPLACEMENT_CHARACTER;
        at += 1 + hex[0].length;
        if (/\s/.test(selector[at] ?? "")) at += 1;
      } else if (at + 1 < selector.length) {
        name += selector[at + 1];
        at += 2;
      } else {
        at += 1;
      }
      continue;
    }
    if (!isIdentifierCode(code)) break;
    name += selector[at];
    at += 1;
  }
  return [name, at];
}

/** The index just past the bracketed or parenthesised group at `index`. */
function skipGroup(selector: string, index: number, open: string, close: string): number {
  let depth = 0;
  for (let at = index; at < selector.length; at += 1) {
    const char = selector[at];
    if (char === "\\") {
      at += 1;
    } else if (char === '"' || char === "'") {
      const ends = selector.indexOf(char, at + 1);
      if (ends < 0) return -1;
      at = ends;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/** The classes, ids and element names one selector needs a frame to have, or
 * null when it cannot tell (the rule is then kept). Arguments of :is(),
 * :not(), :has() and other functional pseudo-classes never prune. */
export function designSelectorFeatures(selector: string): string[] | null {
  const needs: string[] = [];
  let index = 0;
  let compoundStart = true;
  while (index < selector.length) {
    const char = selector[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === ">" || char === "+" || char === "~") {
      compoundStart = true;
      index += 1;
    } else if (char === "." || char === "#") {
      const [name, next] = readIdentifier(selector, index + 1);
      if (!name) return null;
      needs.push(`${char}${name.toLowerCase()}`);
      index = next;
      compoundStart = false;
    } else if (char === "[") {
      index = skipGroup(selector, index, "[", "]");
      if (index < 0) return null;
      compoundStart = false;
    } else if (char === ":") {
      index += selector[index + 1] === ":" ? 2 : 1;
      index = readIdentifier(selector, index)[1];
      if (selector[index] === "(") {
        index = skipGroup(selector, index, "(", ")");
        if (index < 0) return null;
      }
      compoundStart = false;
    } else if (char === "*" || char === "&") {
      index += 1;
      compoundStart = false;
    } else if (char === "|") {
      // A namespace separator: an element name follows.
      index += 1;
      compoundStart = true;
    } else if (char === "\\" || isIdentifierCode(char.charCodeAt(0))) {
      const [name, next] = readIdentifier(selector, index);
      if (!name) return null;
      index = next;
      if (selector[index] === "|" && selector[index + 1] !== "=") {
        index += 1;
        compoundStart = true;
        continue;
      }
      const tag = name.toLowerCase();
      if (compoundStart && !PRESENT_TAGS.has(tag)) needs.push(tag);
      compoundStart = false;
    } else {
      return null;
    }
  }
  return needs;
}

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/s, "$2").trim();
}

/** A unicode-range as [low, high] pairs, or null when it reads as anything. */
export function designUnicodeRanges(value: string): number[] | null {
  const ranges: number[] = [];
  for (const part of value.split(",")) {
    const match = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!match) return null;
    const low = match[1]!;
    if (match[2]) {
      ranges.push(Number.parseInt(low, 16), Number.parseInt(match[2], 16));
    } else if (low.includes("?")) {
      ranges.push(Number.parseInt(low.replace(/\?/g, "0"), 16), Number.parseInt(low.replace(/\?/g, "f"), 16));
    } else {
      const point = Number.parseInt(low, 16);
      ranges.push(point, point);
    }
  }
  return ranges.length ? ranges : null;
}

function nonAsciiCodePoints(value: string, into: Set<number>): void {
  for (const match of value.matchAll(/[\u0080-\u{10FFFF}]/gu)) into.add(match[0].codePointAt(0)!);
  for (const match of value.matchAll(/\\([0-9a-fA-F]{1,6})/g)) {
    const point = Number.parseInt(match[1]!, 16);
    if (point >= 0x80 && point <= 0x10ffff) into.add(point);
  }
}

function pushVariableReads(value: string, into: number[]): void {
  if (!value.includes("var(")) return;
  for (const match of value.matchAll(VARIABLE_READ)) into.push(hash(match[1]!));
}

/** Stringify `root` once and index its units. `root.toString()` would produce
 * the same CSS. */
export function indexDesignCss(root: postcss.Root): DesignCssIndex {
  const unitNodes: postcss.ChildNode[] = [];
  const unitOf = new Map<postcss.Node, number>();
  const unitWrapper: number[] = [];
  const wrapperOf = new Map<postcss.Node, number>();
  const wrapperParent: number[] = [];
  const synthetic = new Map<number, string>();
  const visit = (container: postcss.Container, wrapper: number) => {
    for (const node of container.nodes ?? []) {
      if (node.type === "comment") continue;
      if (node.type === "atrule" && node.nodes && WRAPPERS.has(node.name.toLowerCase())) {
        if (node.name.toLowerCase() === "layer" && node.params.trim()) {
          // A pruned named layer still keeps its place in the layer order.
          synthetic.set(unitNodes.length, `@layer ${node.params.trim()};`);
          unitNodes.push(node);
          unitWrapper.push(wrapper);
        }
        const id = wrapperParent.length;
        wrapperParent.push(wrapper);
        wrapperOf.set(node, id);
        visit(node, id);
        continue;
      }
      unitOf.set(node, unitNodes.length);
      unitNodes.push(node);
      unitWrapper.push(wrapper);
    }
  };
  visit(root, -1);

  const units = unitNodes.length;
  const start = new Int32Array(units);
  const end = new Int32Array(units);
  const wrapperStart = new Int32Array(wrapperParent.length);
  const wrapperOpenEnd = new Int32Array(wrapperParent.length);
  const parts: string[] = [];
  let length = 0;
  postcss.stringify(root, (part, node, type) => {
    if (node) {
      const unit = unitOf.get(node);
      if (unit !== undefined) {
        if (type !== "end") start[unit] = length;
        if (type !== "start") end[unit] = length + part.length;
      } else if (type === "start") {
        const wrapper = wrapperOf.get(node);
        if (wrapper !== undefined) {
          wrapperStart[wrapper] = length;
          wrapperOpenEnd[wrapper] = length + part.length;
        }
      }
    }
    parts.push(part);
    length += part.length;
  });
  const css = parts.join("");
  parts.length = 0;

  const kind = new Uint8Array(units);
  const ruleSelectors = new Int32Array(units + 1);
  const selectorBounds: number[] = [0];
  const features: number[] = [];
  const readStart = new Int32Array(units + 1);
  const reads: number[] = [];
  const defineUnit: number[] = [];
  const defineName: number[] = [];
  const defineValue: string[] = [];
  const defineReadStart: number[] = [0];
  const defineReads: number[] = [];
  const text = new Map<number, string>();
  const codePoints = new Map<number, number[]>();
  const faces = new Map<number, { family: string; ranges: number[] | null }>();
  const keyframes = new Map<number, string>();
  let stringBytes = 0;

  for (const [unit, node] of unitNodes.entries()) {
    ruleSelectors[unit] = selectorBounds.length - 1;
    readStart[unit] = reads.length;
    if (synthetic.has(unit)) continue;
    if (node.type === "rule") {
      kind[unit] = UNIT_RULE;
      for (const selector of node.selectors) {
        for (const feature of designSelectorFeatures(selector) ?? []) features.push(hash(feature));
        selectorBounds.push(features.length);
      }
    } else if (node.type === "atrule") {
      const name = node.name.toLowerCase();
      if (name === "font-face") {
        let family = "";
        let ranges: number[] | null = null;
        node.each((child) => {
          if (child.type !== "decl") return;
          const prop = child.prop.toLowerCase();
          if (prop === "font-family") family = unquote(child.value).toLowerCase();
          else if (prop === "unicode-range") ranges = designUnicodeRanges(child.value);
        });
        if (family) {
          kind[unit] = UNIT_FONT_FACE;
          faces.set(unit, { family, ranges });
          stringBytes += family.length + 48;
        }
        continue;
      }
      if (KEYFRAMES.test(name)) {
        const keyframe = unquote(node.params).toLowerCase();
        if (keyframe) {
          kind[unit] = UNIT_KEYFRAMES;
          keyframes.set(unit, keyframe);
          stringBytes += keyframe.length + 32;
        }
        continue;
      }
    }
    if (node.type !== "rule" && node.type !== "atrule") continue;
    const names: string[] = [];
    const shown = new Set<number>();
    node.walkDecls((declaration) => {
      const value = declaration.value;
      if (declaration.prop.startsWith("--")) {
        defineUnit.push(unit);
        defineName.push(hash(declaration.prop));
        const bounded = (value.length > MAX_REFERENCE_VALUE ? value.slice(0, MAX_REFERENCE_VALUE) : value).toLowerCase();
        defineValue.push(bounded);
        stringBytes += bounded.length + 24;
        pushVariableReads(value, defineReads);
        defineReadStart.push(defineReads.length);
        return;
      }
      pushVariableReads(value, reads);
      const prop = declaration.prop.toLowerCase();
      if (prop === "font-family" || prop === "font" || prop === "animation" || prop === "animation-name") {
        names.push(value.slice(0, MAX_REFERENCE_VALUE).toLowerCase());
      } else if (prop === "content") {
        nonAsciiCodePoints(value, shown);
      }
    });
    if (names.length) {
      const joined = names.join("\n");
      text.set(unit, joined);
      stringBytes += joined.length + 32;
    }
    if (shown.size) {
      codePoints.set(unit, [...shown]);
      stringBytes += shown.size * 8 + 32;
    }
  }
  ruleSelectors[units] = selectorBounds.length - 1;
  readStart[units] = reads.length;
  return finishIndex({
    css,
    start,
    end,
    kind,
    wrapper: Int32Array.from(unitWrapper),
    wrapperStart,
    wrapperOpenEnd,
    wrapperParent: Int32Array.from(wrapperParent),
    ruleSelectors,
    selectorBounds: Int32Array.from(selectorBounds),
    features: Int32Array.from(features),
    readStart,
    reads: Int32Array.from(reads),
    defineUnit: Int32Array.from(defineUnit),
    defineName: Int32Array.from(defineName),
    defineValue,
    defineReadStart: Int32Array.from(defineReadStart),
    defineReads: Int32Array.from(defineReads),
    text,
    codePoints,
    faces,
    keyframes,
    synthetic,
    bytes: 0,
  }, stringBytes);
}

function finishIndex(index: DesignCssIndex, stringBytes: number): DesignCssIndex {
  const arrays = [
    index.start, index.end, index.kind, index.wrapper, index.wrapperStart, index.wrapperOpenEnd, index.wrapperParent,
    index.ruleSelectors, index.selectorBounds, index.features, index.readStart, index.reads, index.defineUnit,
    index.defineName, index.defineReadStart, index.defineReads,
  ];
  index.bytes = index.css.length + arrays.reduce((total, array) => total + array.byteLength, 0) + stringBytes + 256;
  return index;
}

export function parseAndIndexDesignCss(css: string): DesignCssIndex {
  return indexDesignCss(postcss.parse(css));
}

/** One index for CSS indexed in pieces, joined by newlines. */
export function concatDesignCssIndexes(pieces: readonly DesignCssIndex[]): DesignCssIndex {
  if (pieces.length === 1) return pieces[0]!;
  const sum = (count: (piece: DesignCssIndex) => number) => pieces.reduce((total, piece) => total + count(piece), 0);
  const units = sum((piece) => piece.kind.length);
  const wrappers = sum((piece) => piece.wrapperParent.length);
  const selectors = sum((piece) => piece.selectorBounds.length - 1);
  const defines = sum((piece) => piece.defineUnit.length);
  const start = new Int32Array(units);
  const end = new Int32Array(units);
  const kind = new Uint8Array(units);
  const wrapper = new Int32Array(units);
  const wrapperStart = new Int32Array(wrappers);
  const wrapperOpenEnd = new Int32Array(wrappers);
  const wrapperParent = new Int32Array(wrappers);
  const ruleSelectors = new Int32Array(units + 1);
  const selectorBounds = new Int32Array(selectors + 1);
  const features = new Int32Array(sum((piece) => piece.features.length));
  const readStart = new Int32Array(units + 1);
  const reads = new Int32Array(sum((piece) => piece.reads.length));
  const defineUnit = new Int32Array(defines);
  const defineName = new Int32Array(defines);
  const defineValue: string[] = [];
  const defineReadStart = new Int32Array(defines + 1);
  const defineReads = new Int32Array(sum((piece) => piece.defineReads.length));
  const text = new Map<number, string>();
  const codePoints = new Map<number, number[]>();
  const faces = new Map<number, { family: string; ranges: number[] | null }>();
  const keyframes = new Map<number, string>();
  const synthetic = new Map<number, string>();
  let cssOffset = 0;
  let unitOffset = 0;
  let wrapperOffset = 0;
  let selectorOffset = 0;
  let featureOffset = 0;
  let readOffset = 0;
  let defineOffset = 0;
  let defineReadOffset = 0;
  let stringBytes = 0;
  for (const piece of pieces) {
    const count = piece.kind.length;
    for (let unit = 0; unit < count; unit += 1) {
      start[unitOffset + unit] = piece.start[unit]! + cssOffset;
      end[unitOffset + unit] = piece.end[unit]! + cssOffset;
      wrapper[unitOffset + unit] = piece.wrapper[unit]! < 0 ? -1 : piece.wrapper[unit]! + wrapperOffset;
      ruleSelectors[unitOffset + unit] = piece.ruleSelectors[unit]! + selectorOffset;
      readStart[unitOffset + unit] = piece.readStart[unit]! + readOffset;
    }
    kind.set(piece.kind, unitOffset);
    for (let at = 0; at < piece.wrapperParent.length; at += 1) {
      wrapperStart[wrapperOffset + at] = piece.wrapperStart[at]! + cssOffset;
      wrapperOpenEnd[wrapperOffset + at] = piece.wrapperOpenEnd[at]! + cssOffset;
      wrapperParent[wrapperOffset + at] = piece.wrapperParent[at]! < 0 ? -1 : piece.wrapperParent[at]! + wrapperOffset;
    }
    const pieceSelectors = piece.selectorBounds.length - 1;
    for (let at = 0; at < pieceSelectors; at += 1) selectorBounds[selectorOffset + at] = piece.selectorBounds[at]! + featureOffset;
    features.set(piece.features, featureOffset);
    reads.set(piece.reads, readOffset);
    for (let at = 0; at < piece.defineUnit.length; at += 1) {
      defineUnit[defineOffset + at] = piece.defineUnit[at]! + unitOffset;
      defineReadStart[defineOffset + at] = piece.defineReadStart[at]! + defineReadOffset;
      defineValue.push(piece.defineValue[at]!);
    }
    defineName.set(piece.defineName, defineOffset);
    defineReads.set(piece.defineReads, defineReadOffset);
    for (const [unit, value] of piece.text) text.set(unit + unitOffset, value);
    for (const [unit, value] of piece.codePoints) codePoints.set(unit + unitOffset, value);
    for (const [unit, value] of piece.faces) faces.set(unit + unitOffset, value);
    for (const [unit, value] of piece.keyframes) keyframes.set(unit + unitOffset, value);
    for (const [unit, value] of piece.synthetic) synthetic.set(unit + unitOffset, value);
    stringBytes += Math.max(0, piece.bytes - piece.css.length);
    cssOffset += piece.css.length + 1;
    unitOffset += count;
    wrapperOffset += piece.wrapperParent.length;
    selectorOffset += pieceSelectors;
    featureOffset += piece.features.length;
    readOffset += piece.reads.length;
    defineOffset += piece.defineUnit.length;
    defineReadOffset += piece.defineReads.length;
  }
  ruleSelectors[units] = selectorOffset;
  readStart[units] = readOffset;
  selectorBounds[selectorOffset] = featureOffset;
  defineReadStart[defines] = defineReadOffset;
  return finishIndex({
    css: pieces.map((piece) => piece.css).join("\n"),
    start,
    end,
    kind,
    wrapper,
    wrapperStart,
    wrapperOpenEnd,
    wrapperParent,
    ruleSelectors,
    selectorBounds,
    features,
    readStart,
    reads,
    defineUnit,
    defineName,
    defineValue,
    defineReadStart,
    defineReads,
    text,
    codePoints,
    faces,
    keyframes,
    synthetic,
    bytes: 0,
  }, stringBytes);
}

/** Split CSS after top-level statements into pieces of at least `size`
 * characters, so a large source is parsed a piece at a time. Strings,
 * comments and parentheses (such as data: URLs) never split. */
export function splitDesignCss(css: string, size: number): string[] {
  if (css.length <= size) return [css];
  const pieces: string[] = [];
  let depth = 0;
  let parens = 0;
  let from = 0;
  for (let at = 0; at < css.length; at += 1) {
    const code = css.charCodeAt(at);
    if (code === 92) {
      at += 1;
    } else if (code === 34 || code === 39) {
      for (at += 1; at < css.length; at += 1) {
        const next = css.charCodeAt(at);
        if (next === 92) at += 1;
        else if (next === code || next === 10) break;
      }
    } else if (code === 47 && css.charCodeAt(at + 1) === 42) {
      const close = css.indexOf("*/", at + 2);
      at = close < 0 ? css.length : close + 1;
    } else if (code === 40) {
      parens += 1;
    } else if (code === 41) {
      parens = Math.max(0, parens - 1);
    } else if (parens === 0 && code === 123) {
      depth += 1;
    } else if (parens === 0 && (code === 125 || code === 59)) {
      if (code === 125) depth = Math.max(0, depth - 1);
      if (depth === 0 && at + 1 - from >= size) {
        pieces.push(css.slice(from, at + 1));
        from = at + 1;
      }
    }
  }
  if (from < css.length) pieces.push(css.slice(from));
  return pieces;
}

// What a frame shows: its classes, ids and elements, the custom properties
// and font or animation names its own markup and stylesheets use, and the
// characters it displays.

export interface DesignFrameFeatures {
  classes: ReadonlySet<string>;
  ids: ReadonlySet<string>;
  tags: ReadonlySet<string>;
  variables: ReadonlySet<string>;
  /** Lowercase font, animation and custom property values the frame sets. */
  text: string;
  /** Characters beyond ASCII the frame shows, sorted; null when an entity
   * could not be read, which keeps every unicode-range. */
  codePoints: readonly number[] | null;
  /** Changes whenever pruning could. */
  signature: string;
}

const TAG = /<([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const CLASS_OR_ID = /(?:^|\s)(class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const REFERENCE = /(font-family|font|animation-name|animation|--[A-Za-z0-9_-]+)\s*[:=]\s*([^;}<>\n]{0,512})/gi;
const ENTITY = /&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;
/** Named references whose characters are known; any other name keeps every
 * unicode-range. */
const NAMED: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165,
  brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175, deg: 176,
  plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183, cedil: 184, sup1: 185, ordm: 186,
  raquo: 187, frac14: 188, frac12: 189, frac34: 190, iquest: 191, times: 215, divide: 247, ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226,
  hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592,
  uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, minus: 8722, infin: 8734, ne: 8800, le: 8804, ge: 8805, check: 10003,
  hearts: 9829, spades: 9824, clubs: 9827, diams: 9830, loz: 9674, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204,
  zwj: 8205, lrm: 8206, rlm: 8207,
};

function decodeAttribute(value: string): string {
  return value.replace(ENTITY, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Math.min(Number.parseInt(name.slice(2), 16), 0x10ffff));
    if (name.startsWith("#")) return String.fromCodePoint(Math.min(Number.parseInt(name.slice(1), 10), 0x10ffff));
    const point = NAMED[name];
    return point === undefined ? whole : String.fromCodePoint(point);
  });
}

interface StylesheetScan {
  variables: string[];
  text: string;
  codePoints: number[];
}
const stylesheetScans = new Map<string, StylesheetScan>();
const MAX_STYLESHEET_SCANS = 64;

function scanText(text: string, variables: Set<string>, references: string[], codePoints: Set<number>): void {
  for (const match of text.matchAll(VARIABLE_READ)) variables.add(match[1]!);
  for (const match of text.matchAll(REFERENCE)) references.push(match[2]!.toLowerCase());
  nonAsciiCodePoints(text, codePoints);
}

/** A frame's own stylesheets are prepared once per revision; their scan is
 * kept with the same string. */
function scanStylesheet(css: string): StylesheetScan {
  const known = stylesheetScans.get(css);
  if (known) return known;
  const variables = new Set<string>();
  const references: string[] = [];
  const codePoints = new Set<number>();
  scanText(css, variables, references, codePoints);
  const scan = { variables: [...variables], text: references.join("\n"), codePoints: [...codePoints] };
  stylesheetScans.set(css, scan);
  while (stylesheetScans.size > MAX_STYLESHEET_SCANS) stylesheetScans.delete(stylesheetScans.keys().next().value!);
  return scan;
}

export function designFrameFeatures(
  html: string,
  options: { stylesheets?: readonly string[]; variables?: readonly string[] } = {},
): DesignFrameFeatures {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const tags = new Set<string>(PRESENT_TAGS);
  for (const tag of html.matchAll(TAG)) {
    tags.add(tag[1]!.toLowerCase());
    const attributes = tag[2]!;
    if (!attributes) continue;
    for (const attribute of attributes.matchAll(CLASS_OR_ID)) {
      const value = decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? "").toLowerCase();
      if (attribute[1]!.toLowerCase() === "id") {
        if (value.trim()) ids.add(value.trim());
      } else {
        for (const name of value.split(/[\t\n\f\r ]+/)) if (name) classes.add(name);
      }
    }
  }
  const variables = new Set<string>(options.variables ?? []);
  const references: string[] = [];
  const codePoints = new Set<number>();
  scanText(html, variables, references, codePoints);
  let unknownEntity = false;
  for (const entity of html.matchAll(ENTITY)) {
    const name = entity[1]!;
    if (name.startsWith("#")) {
      const point = name.startsWith("#x") || name.startsWith("#X") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (point >= 0x80 && point <= 0x10ffff) codePoints.add(point);
    } else if (NAMED[name] === undefined) {
      unknownEntity = true;
    } else if (NAMED[name]! >= 0x80) {
      codePoints.add(NAMED[name]!);
    }
  }
  for (const css of options.stylesheets ?? []) {
    const scan = scanStylesheet(css);
    for (const variable of scan.variables) variables.add(variable);
    if (scan.text) references.push(scan.text);
    for (const point of scan.codePoints) codePoints.add(point);
  }
  const text = references.join("\n");
  const points = unknownEntity ? null : [...codePoints].sort((left, right) => left - right);
  const signature = createHash("sha256")
    .update([...classes].sort().join(" "))
    .update("\0")
    .update([...ids].sort().join(" "))
    .update("\0")
    .update([...tags].sort().join(" "))
    .update("\0")
    .update([...variables].sort().join(" "))
    .update("\0")
    .update(text)
    .update("\0")
    .update(points === null ? "*" : points.join(","))
    .digest("hex")
    .slice(0, 24);
  return { classes, ids, tags, variables, text, codePoints: points, signature };
}

/** Whether a unicode-range covers printable ASCII or a character shown. */
function coversShownText(ranges: readonly number[], codePoints: readonly number[]): boolean {
  for (let at = 0; at < ranges.length; at += 2) {
    const low = ranges[at]!;
    const high = ranges[at + 1]!;
    if (low <= 0x7e && high >= 0x20) return true;
    for (const point of codePoints) {
      if (point > high) break;
      if (point >= low) return true;
    }
  }
  return false;
}

/** Each source's CSS for one frame. */
export function pruneDesignFrameSources(
  indexes: readonly DesignCssIndex[],
  frame: DesignFrameFeatures,
): string[] {
  return chooseUnits(indexes, frame).map((keep, at) => {
    const index = indexes[at]!;
    const parts: string[] = [];
    emit(index, keep, (start, end, text) => parts.push(text ?? index.css.slice(start, end)));
    return parts.join("\n");
  });
}

/** The length of each source's CSS for one frame, without building it. */
export function measureDesignFrameSources(
  indexes: readonly DesignCssIndex[],
  frame: DesignFrameFeatures,
): number[] {
  return chooseUnits(indexes, frame).map((keep, at) => {
    let length = 0;
    let parts = 0;
    emit(indexes[at]!, keep, (start, end, text) => {
      length += text === undefined ? end - start : text.length;
      parts += 1;
    });
    return length + Math.max(0, parts - 1);
  });
}

/** Choose the units of every source a frame uses. Font faces and keyframes
 * are kept for names any source's kept CSS or the frame refers to, so they
 * are decided across all sources at once. */
function chooseUnits(
  indexes: readonly DesignCssIndex[],
  frame: DesignFrameFeatures,
): Uint8Array[] {
  const present = new Set<number>();
  for (const name of frame.classes) present.add(hash(`.${name}`));
  for (const name of frame.ids) present.add(hash(`#${name}`));
  for (const name of frame.tags) present.add(hash(name));
  const keeps = indexes.map((index) => {
    const keep = new Uint8Array(index.kind.length);
    for (let unit = 0; unit < keep.length; unit += 1) {
      const kind = index.kind[unit];
      if (kind === UNIT_ALWAYS) {
        keep[unit] = 1;
      } else if (kind === UNIT_RULE) {
        for (let selector = index.ruleSelectors[unit]!; selector < index.ruleSelectors[unit + 1]!; selector += 1) {
          let matches = true;
          for (let at = index.selectorBounds[selector]!; at < index.selectorBounds[selector + 1]!; at += 1) {
            if (!present.has(index.features[at]!)) {
              matches = false;
              break;
            }
          }
          if (matches) {
            keep[unit] = 1;
            break;
          }
        }
      }
    }
    return keep;
  });

  // Names the kept CSS and the frame use, through the custom properties read.
  const text: string[] = [frame.text];
  const codePoints = new Set(frame.codePoints ?? []);
  const pending: number[] = [...frame.variables].map(hash);
  const definitions = new Map<number, Array<[DesignCssIndex, number]>>();
  for (const [position, index] of indexes.entries()) {
    const keep = keeps[position]!;
    for (let unit = 0; unit < keep.length; unit += 1) {
      if (!keep[unit]) continue;
      for (let at = index.readStart[unit]!; at < index.readStart[unit + 1]!; at += 1) pending.push(index.reads[at]!);
    }
    for (const [unit, value] of index.text) if (keep[unit]) text.push(value);
    for (const [unit, points] of index.codePoints) if (keep[unit]) for (const point of points) codePoints.add(point);
    for (let definition = 0; definition < index.defineUnit.length; definition += 1) {
      if (!keep[index.defineUnit[definition]!]) continue;
      const name = index.defineName[definition]!;
      const known = definitions.get(name);
      if (known) known.push([index, definition]);
      else definitions.set(name, [[index, definition]]);
    }
  }
  const read = new Set<number>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (read.has(name)) continue;
    read.add(name);
    for (const [index, definition] of definitions.get(name) ?? []) {
      text.push(index.defineValue[definition]!);
      for (let at = index.defineReadStart[definition]!; at < index.defineReadStart[definition + 1]!; at += 1) {
        pending.push(index.defineReads[at]!);
      }
    }
  }
  const named = text.join("\n");
  const shown = frame.codePoints === null ? null : [...codePoints].sort((left, right) => left - right);

  return indexes.map((index, position) => {
    const keep = keeps[position]!;
    for (const [unit, face] of index.faces) {
      keep[unit] = named.includes(face.family) && (face.ranges === null || shown === null || coversShownText(face.ranges, shown)) ? 1 : 0;
    }
    for (const [unit, keyframe] of index.keyframes) keep[unit] = named.includes(keyframe) ? 1 : 0;
    return keep;
  });
}

/** The kept units in source order, inside the wrappers they were in: each
 * part is a slice of the CSS, or literal text. */
function emit(
  index: DesignCssIndex,
  keep: Uint8Array,
  part: (start: number, end: number, text?: string) => void,
): void {
  const none: number[] = [];
  let open = none;
  const chains = new Map<number, number[]>();
  const chain = (wrapper: number): number[] => {
    if (wrapper < 0) return none;
    let wrappers = chains.get(wrapper);
    if (!wrappers) {
      wrappers = [];
      for (let at = wrapper; at >= 0; at = index.wrapperParent[at]!) wrappers.push(at);
      wrappers.reverse();
      chains.set(wrapper, wrappers);
    }
    return wrappers;
  };
  for (let unit = 0; unit < keep.length; unit += 1) {
    if (!keep[unit]) continue;
    const wrappers = chain(index.wrapper[unit]!);
    let common = 0;
    while (common < open.length && common < wrappers.length && open[common] === wrappers[common]) common += 1;
    for (let close = open.length; close > common; close -= 1) part(0, 0, "}");
    for (let at = common; at < wrappers.length; at += 1) {
      part(index.wrapperStart[wrappers[at]!]!, index.wrapperOpenEnd[wrappers[at]!]!);
    }
    open = wrappers;
    const text = index.synthetic.get(unit);
    if (text === undefined) part(index.start[unit]!, index.end[unit]!);
    else part(0, 0, text);
  }
  for (let close = open.length; close > 0; close -= 1) part(0, 0, "}");
}
