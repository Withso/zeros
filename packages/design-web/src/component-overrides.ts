// PURPOSE: An instance's part overrides: each part's style set on the
// instance itself, as one attribute of its host per part
// (zd-style-<part>="padding: 4px"). Expansion adds it after the part's own
// inline style, so it wins over the component's rules and its options; a
// Style panel write on a part edits only that attribute.

import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.DocumentFragment | Element;

export const DESIGN_PART_STYLE_ATTRIBUTE_PREFIX = "zd-style-";
/** Mirrors DESIGN_COMPONENT_PART_PREFIX in the protocol's design runtime. */
const PART_NODE_PREFIX = "::zeros-part:";
/** An instance record keeps attribute names to 64 characters. */
const MAX_PART_NAME = 64 - DESIGN_PART_STYLE_ATTRIBUTE_PREFIX.length;
const PART_NAME = /^[a-z0-9][a-z0-9_.:-]*$/;

/** The host and part a part's layer id names; null for any other id. */
export function designPartOfNodeId(nodeId: string): { host: string; part: string } | null {
  if (!nodeId.startsWith(PART_NODE_PREFIX)) return null;
  const rest = nodeId.slice(PART_NODE_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split === rest.length - 1 || rest.indexOf(":", split + 1) >= 0) return null;
  try {
    return { host: decodeURIComponent(rest.slice(0, split)), part: decodeURIComponent(rest.slice(split + 1)) };
  } catch {
    return null;
  }
}

/** The part a repeated copy ("chip#1") is a copy of, as an attribute names
 * it: HTML lowercases attribute names. */
const partKey = (part: string) => part.replace(/#\d+$/, "").toLowerCase();

/** The host attribute that holds a part's override, shared by its repeated
 * copies; null for a part no attribute name can carry. */
export function designPartStyleAttribute(part: string): string | null {
  const key = partKey(part);
  return key.length <= MAX_PART_NAME && PART_NAME.test(key) ? `${DESIGN_PART_STYLE_ATTRIBUTE_PREFIX}${key}` : null;
}

/** Each part an instance's host overrides, to the declarations it sets. */
export function designPartStyleOverrides(attributes: Iterable<{ name: string; value: string }>): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const { name, value } of attributes) {
    if (!name.startsWith(DESIGN_PART_STYLE_ATTRIBUTE_PREFIX)) continue;
    const part = name.slice(DESIGN_PART_STYLE_ATTRIBUTE_PREFIX.length);
    if (part && value.trim()) overrides.set(part, value.trim());
  }
  return overrides;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function insideComponent(element: Element): boolean {
  for (let parent = element.parentNode; parent && "tagName" in parent; parent = parent.parentNode)
    if (parent.tagName.startsWith("zd-")) return true;
  return false;
}

function partsOf(node: ParentNode, found: Element[] = []): Element[] {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    if (child.attrs.some((attribute) => attribute.name === "data-zd-part") && !insideComponent(child)) found.push(child);
    // A nested instance's own parts are its own to override.
    if (!child.tagName.startsWith("zd-")) partsOf(child, found);
  }
  return found;
}

/** An instance's rendered body with each overridden part's declarations
 * after its own inline style. Run before the instance's slots are filled:
 * the layers a frame places there are its own, not parts. */
export function applyDesignPartStyleOverrides(body: string, overrides: ReadonlyMap<string, string>): string {
  if (overrides.size === 0) return body;
  const fragment = parseFragment(body, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const element of partsOf(fragment)) {
    const part = element.attrs.find((attribute) => attribute.name === "data-zd-part")!.value;
    const override = overrides.get(partKey(part));
    const location = element.sourceCodeLocation?.startTag;
    if (!override || !location) continue;
    const own = element.attrs.find((attribute) => attribute.name === "style")?.value.trim();
    const style = `style="${escapeAttribute(own ? `${own.replace(/;\s*$/, "")}; ${override}` : override)}"`;
    const span = element.sourceCodeLocation?.attrs?.style;
    if (span) {
      edits.push({ start: span.startOffset, end: span.endOffset, text: style });
      continue;
    }
    const close = body.lastIndexOf(">", location.endOffset - 1);
    const slash = /\s*\/\s*$/.exec(body.slice(location.startOffset, close));
    const at = slash ? location.startOffset + slash.index : close;
    edits.push({ start: at, end: at, text: ` ${style}` });
  }
  let result = body;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return result;
}

/** Split a declaration list at its top-level semicolons. */
function declarations(list: string): Array<{ property: string; value: string }> {
  const result: Array<{ property: string; value: string }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const push = (end: number) => {
    const text = list.slice(start, end);
    const colon = text.indexOf(":");
    if (colon > 0) result.push({ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim() });
    start = end + 1;
  };
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) push(index);
  }
  push(list.length);
  return result.filter((entry) => entry.property && entry.value);
}

/** An override with each property set to its value, or removed (null);
 * null when nothing is left. Properties already validated. */
export function mergeDesignPartStyleOverride(existing: string | null | undefined, styles: ReadonlyMap<string, string | null>): string | null {
  const kept = declarations(existing ?? "").filter((entry) => !styles.has(entry.property));
  for (const [property, value] of styles) if (value !== null) kept.push({ property, value });
  return kept.length ? kept.map((entry) => `${entry.property}: ${entry.value}`).join("; ") : null;
}
