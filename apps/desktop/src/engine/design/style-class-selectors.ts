import postcss from "postcss";
import { splitDesignCss } from "./style-prune";

type ClassOperator = "=" | "~=" | "^=" | "$=" | "*=" | "|=";
interface ClassAttribute {
  operator: ClassOperator;
  value: string;
  insensitive: boolean;
}

export interface DesignClassCatalog {
  names: Set<string>;
  attributes: ClassAttribute[];
  bytes: number;
}

const ASCII_SPACE = /[\t\n\f\r ]/;

function trimAscii(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_SPACE.test(value[start]!)) start += 1;
  while (end > start && ASCII_SPACE.test(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

function lowerAscii(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function readIdentifier(source: string, index: number): [string, number] {
  let name = "";
  let at = index;
  while (at < source.length) {
    const char = source[at]!;
    if (char === "\\") {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(source.slice(at + 1, at + 7));
      if (hex) {
        const code = Number.parseInt(hex[0], 16);
        name += code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
        at += 1 + hex[0].length;
        if (source[at] === "\r" && source[at + 1] === "\n") at += 2;
        else if (ASCII_SPACE.test(source[at] ?? "")) at += 1;
      } else {
        if (at + 1 === source.length || /[\n\r\f]/.test(source[at + 1]!)) throw new Error("Invalid CSS identifier escape.");
        name += source[at + 1];
        at += 2;
      }
    } else if (/[\w\u0080-\uFFFF-]/.test(char)) {
      name += char;
      at += 1;
    } else break;
  }
  return [name, at];
}

function stringEnd(source: string, index: number): number {
  const quote = source[index];
  for (let at = index + 1; at < source.length; at += 1) {
    if (source[at] === "\\") at += 1;
    else if (source[at] === quote) return at + 1;
  }
  throw new Error("Unclosed CSS selector string.");
}

function decoded(value: string): string {
  let result = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\") {
      result += value[index++];
    } else if (/[\n\r\f]/.test(value[index + 1] ?? "")) {
      index += value[index + 1] === "\r" && value[index + 2] === "\n" ? 3 : 2;
    } else {
      const [name, next] = readIdentifier(value, index);
      result += name;
      index = next;
    }
  }
  return result;
}

function classAttribute(selector: string, index: number, catalog: DesignClassCatalog): number {
  let end = index + 1;
  let raw = "";
  for (; end < selector.length; end += 1) {
    const char = selector[end];
    if (char === "\\") {
      raw += selector.slice(end, end + 2);
      end += 1;
    } else if (char === '"' || char === "'") {
      const next = stringEnd(selector, end);
      raw += selector.slice(end, next);
      end = next - 1;
    } else if (char === "/" && selector[end + 1] === "*") {
      const next = selector.indexOf("*/", end + 2);
      if (next < 0) throw new Error("Unclosed CSS selector comment.");
      end = next + 1;
    } else if (char === "]") break;
    else raw += char;
  }
  if (end === selector.length) throw new Error("Unclosed CSS attribute selector.");
  raw = trimAscii(raw);
  let [name, at] = readIdentifier(raw, 0);
  if (raw.startsWith("*|") || (raw[at] === "|" && raw[at + 1] !== "=")) {
    [name, at] = readIdentifier(raw, raw.startsWith("*|") ? 2 : at + 1);
  }
  if (name.toLowerCase() !== "class") return end + 1;
  while (ASCII_SPACE.test(raw[at] ?? "")) at += 1;
  const operator = /^(?:[~^$*|]?=)/.exec(raw.slice(at))?.[0] as ClassOperator | undefined;
  if (!operator) return end + 1;
  at += operator.length;
  while (ASCII_SPACE.test(raw[at] ?? "")) at += 1;
  let value: string;
  if (raw[at] === '"' || raw[at] === "'") {
    const next = stringEnd(raw, at);
    value = decoded(raw.slice(at + 1, next - 1));
    at = next;
  } else {
    [value, at] = readIdentifier(raw, at);
  }
  const flag = lowerAscii(trimAscii(raw.slice(at)));
  if (flag && flag !== "i" && flag !== "s") throw new Error("Unknown CSS class attribute modifier.");
  if (!value) return end + 1;
  if ((operator === "=" || operator === "~=") && flag !== "i") {
    if (operator === "=") {
      for (const token of value.split(/[\t\n\f\r ]+/)) if (token) catalog.names.add(token);
    } else if (!ASCII_SPACE.test(value)) catalog.names.add(value);
  } else {
    catalog.attributes.push({ operator, value: flag === "i" ? lowerAscii(value) : value, insensitive: flag === "i" });
  }
  return end + 1;
}

/** Pruning deliberately ignores pseudo-class arguments; recognition must
 * descend into them while ignoring quoted text and non-class attributes. */
function selectorClasses(selector: string, catalog: DesignClassCatalog): void {
  let depth = 0;
  for (let index = 0; index < selector.length;) {
    const char = selector[index]!;
    if (char === ".") {
      const [name, next] = readIdentifier(selector, index + 1);
      if (!name) throw new Error("Missing CSS class name.");
      catalog.names.add(name);
      index = next;
    } else if (char === "[") {
      index = classAttribute(selector, index, catalog);
    } else if (char === '"' || char === "'") {
      index = stringEnd(selector, index);
    } else if (char === "/" && selector[index + 1] === "*") {
      const end = selector.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unclosed CSS selector comment.");
      index = end + 2;
    } else if (char === "\\" || /[\w\u0080-\uFFFF-]/.test(char)) {
      index = readIdentifier(selector, index)[1];
    } else {
      if (char === "(") depth += 1;
      if (char === ")" && --depth < 0) throw new Error("Unbalanced CSS selector.");
      index += 1;
    }
  }
  if (depth) throw new Error("Unclosed CSS selector function.");
}

export function extractDesignClassCatalog(css: string): DesignClassCatalog {
  const catalog: DesignClassCatalog = { names: new Set(), attributes: [], bytes: 128 };
  for (const piece of splitDesignCss(css, 512 * 1024)) {
    const root = postcss.parse(piece);
    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /^(?:-[a-z]+-)?keyframes$/i.test(rule.parent.name)) return;
      selectorClasses(rule.selector, catalog);
    });
    root.walkAtRules("scope", (rule) => { selectorClasses(rule.params, catalog); });
  }
  for (const name of catalog.names) catalog.bytes += 48 + name.length * 2;
  for (const attribute of catalog.attributes) catalog.bytes += 64 + attribute.value.length * 2;
  return catalog;
}

/** Substring/prefix/suffix operators apply to one used class name, an
 * approximation of matching the element's complete class attribute. */
export function designCatalogHasClass(catalog: DesignClassCatalog, name: string): boolean {
  if (catalog.names.has(name)) return true;
  return catalog.attributes.some(({ operator, value, insensitive }) => {
    const token = insensitive ? lowerAscii(name) : name;
    switch (operator) {
      case "=": return value.split(/[\t\n\f\r ]+/).includes(token);
      case "~=": return token === value;
      case "^=": return token.startsWith(value);
      case "$=": return token.endsWith(value);
      case "*=": return token.includes(value);
      case "|=": return token === value || token.startsWith(`${value}-`);
    }
  });
}
