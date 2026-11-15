// A component's state variants (Hover, Pressed, Focus, Disabled): the CSS
// they read and write. Showing one renders the main as if its root layer were
// in that state: each rule that names the state gets a copy with the state
// written as an attribute the root carries. Editing one writes a rule in the
// main's own <style> whose selector is the root layer in that state, then the
// edited layer inside it. Instances match it through their parts, so a real
// hover, press, focus or disabled control shows it everywhere.

import { COMPONENT_VARIANT_STATES, type ComponentVariantState } from "@zeros/design-core/components";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

import { readDesignComponentDeclaration, designSourceDeclaresComponentOptions } from "./component-options";
import { designDocumentBody } from "./document-body";

type Element = DefaultTreeAdapterTypes.Element;

/** The attribute a shown state's root carries, one token per state it applies. */
export const DESIGN_SHOWN_STATE_ATTRIBUTE = "data-zd-shown-state";

/** What showing a state applies: a press (active) is also a hover, and
 * focus-visible is also focus. */
const STATE_TOKENS: Readonly<Record<ComponentVariantState, readonly string[]>> = {
  hover: ["hover"],
  active: ["hover", "active"],
  "focus-visible": ["focus", "focus-visible"],
  disabled: ["disabled"],
};

const PSEUDO = /(?<![:\\]):(hover|active|focus-visible|focus|disabled)(?![\w(-])/gi;
/** At-rules a copy can sit in, as the original does. */
const WRAPPERS = new Set(["media", "supports", "container", "layer", "scope"]);

export function designComponentStateTokens(state: ComponentVariantState): readonly string[] {
  return STATE_TOKENS[state];
}

const isElement = (node: DefaultTreeAdapterTypes.ChildNode): node is Element => "tagName" in node;
const attributeOf = (element: Element, name: string) => element.attrs.find((attribute) => attribute.name === name)?.value;

function walkElements(node: DefaultTreeAdapterTypes.ParentNode, visit: (element: Element) => void): void {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    visit(child);
    // A template's content is inert, as the frame renders it.
    if (child.tagName !== "template") walkElements(child, visit);
  }
}

/** The copy of a rule set for the shown state, or null when it names none. */
function shownStateRule(rule: Rule, tokens: readonly string[]): string | null {
  let changed = false;
  const selector = rule.selector.replace(PSEUDO, (match, name: string) => {
    if (!tokens.includes(name.toLowerCase())) return match;
    changed = true;
    return `[${DESIGN_SHOWN_STATE_ATTRIBUTE}~="${name.toLowerCase()}"]`;
  });
  if (!changed) return null;
  let text = `${selector} {${rule.nodes.filter((node) => node.type === "decl").map((node) => ` ${node.toString()};`).join("")} }`;
  for (let parent = rule.parent as Container | undefined; parent && parent.type !== "root"; parent = parent.parent as Container | undefined) {
    // A nested rule's selector is relative to its parent; an at-rule a copy
    // cannot rejoin (an anonymous @layer, @keyframes) would change its meaning.
    if (parent.type !== "atrule") return null;
    const atRule = parent as AtRule;
    if (!WRAPPERS.has(atRule.name.toLowerCase()) || (atRule.name.toLowerCase() === "layer" && !atRule.params.trim())) return null;
    text = `@${atRule.name} ${atRule.params} { ${text} }`;
  }
  return text;
}

function shownStateRules(css: string, tokens: readonly string[]): string[] {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return [];
  }
  const copies: string[] = [];
  root.walkRules((rule) => {
    const copy = shownStateRule(rule, tokens);
    if (copy) copies.push(copy);
  });
  return copies;
}

/** The main's document as its root layers show the state: every root (each
 * element in the body) carries the state's tokens, and each <style> is
 * followed by the copies of its rules that name the state. */
export function showDesignComponentState(html: string, state: ComponentVariantState): string {
  const tokens = STATE_TOKENS[state];
  const document = parse(html, { sourceCodeLocationInfo: true });
  const edits: { at: number; text: string }[] = [];
  walkElements(document, (element) => {
    if (element.tagName !== "style") return;
    const location = element.sourceCodeLocation;
    if (!location?.endTag) return;
    const css = element.childNodes.map((node) => ("value" in node ? node.value : "")).join("");
    const copies = shownStateRules(css, tokens);
    if (copies.length) edits.push({ at: location.endOffset, text: `<style ${DESIGN_SHOWN_STATE_ATTRIBUTE}>${copies.join("\n").replace(/<\/style/gi, "<\\/style")}</style>` });
  });
  let body: Element;
  try {
    body = designDocumentBody(document);
  } catch {
    return html;
  }
  for (const element of body.childNodes.filter(isElement)) {
    const startTag = element.sourceCodeLocation?.startTag;
    if (!startTag || attributeOf(element, DESIGN_SHOWN_STATE_ATTRIBUTE) !== undefined) continue;
    const end = html.slice(startTag.endOffset - 2, startTag.endOffset) === "/>" ? startTag.endOffset - 2 : startTag.endOffset - 1;
    edits.push({ at: end, text: ` ${DESIGN_SHOWN_STATE_ATTRIBUTE}="${tokens.join(" ")}"` });
  }
  let result = html;
  for (const edit of edits.sort((left, right) => right.at - left.at)) result = `${result.slice(0, edit.at)}${edit.text}${result.slice(edit.at)}`;
  return result;
}

const cssString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** One layer, on the main (its data-oid) or in an instance (its part). */
const layerSelector = (id: string) => `:is([data-oid=${cssString(id)}], [data-zd-part=${cssString(id)}])`;

/** The rule a state edit writes: the root layer in the state, then the
 * edited layer inside it when that is not the root. */
export function designComponentStateSelector(rootId: string, nodeId: string, state: ComponentVariantState): string {
  return `${layerSelector(rootId)}:${state}${nodeId === rootId ? "" : ` ${layerSelector(nodeId)}`}`;
}

/** The root layer a state edit on this layer is under: the body's element
 * that holds it. */
function stateRootOf(body: Element, nodeId: string): string {
  for (const element of body.childNodes.filter(isElement)) {
    let found = attributeOf(element, "data-oid") === nodeId;
    if (!found) walkElements(element, (inner) => { if (attributeOf(inner, "data-oid") === nodeId) found = true; });
    if (!found) continue;
    const id = attributeOf(element, "data-oid");
    if (!id) throw new Error("The component's root layer has no layer id; select it once so Zeros can give it one.");
    return id;
  }
  throw new Error(`Design element ${nodeId} is not in this component.`);
}

/** Set or remove (null) declarations of one layer in one state of the main
 * component this file is: in the rule for that layer and state, which is
 * added to the main's last <style> in <head> when it has none. A state's
 * value wins over the layer's own style, so declarations are !important. */
export function mutateDesignComponentStateStyles(
  source: string,
  file: string,
  input: { nodeId: string; state: string; styles: ReadonlyArray<readonly [string, string | null]> },
): { source: string; selector: string } {
  const state = input.state as ComponentVariantState;
  if (!(COMPONENT_VARIANT_STATES as readonly string[]).includes(state)) throw new Error(`There is no component state ${input.state}.`);
  const declaration = designSourceDeclaresComponentOptions(source) ? readDesignComponentDeclaration(source, file) : null;
  if (!declaration?.variants.some((variant) => variant.state === state))
    throw new Error(`Only a component with a ${state} variant has that state; add it under Options.`);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const body = designDocumentBody(document);
  const selector = designComponentStateSelector(stateRootOf(body, input.nodeId), input.nodeId, state);
  const html = body.parentNode as Element;
  const head = html.childNodes.find((node): node is Element => isElement(node) && node.tagName === "head");
  const styles = (head?.childNodes ?? []).filter((node): node is Element => isElement(node) && node.tagName === "style" && !!node.sourceCodeLocation?.endTag);
  const parsed = styles.map((style) => {
    const location = style.sourceCodeLocation!;
    const start = location.startTag!.endOffset;
    const end = location.endTag!.startOffset;
    return { start, end, root: postcss.parse(source.slice(start, end)) };
  });
  const found = parsed.flatMap((entry) => entry.root.nodes.filter((node): node is Rule => node.type === "rule" && node.selector.trim() === selector)
    .map((rule) => ({ entry, rule })))[0];
  const set = (rule: Rule) => {
    for (const [property, value] of input.styles) {
      const existing = rule.nodes.filter((node) => node.type === "decl" && node.prop === property);
      if (value === null) existing.forEach((node) => node.remove());
      else if (existing.length) {
        existing.slice(0, -1).forEach((node) => node.remove());
        Object.assign(existing.at(-1)!, { value, important: true });
      } else rule.append(postcss.decl({ prop: property, value, important: true }));
    }
  };
  if (found) {
    set(found.rule);
    if (!found.rule.nodes.some((node: ChildNode) => node.type === "decl")) found.rule.remove();
    const text = found.entry.root.toString();
    return { source: `${source.slice(0, found.entry.start)}${text}${source.slice(found.entry.end)}`, selector };
  }
  if (input.styles.every(([, value]) => value === null)) return { source, selector };
  const rule = postcss.rule({ selector });
  set(rule);
  const text = `${selector} {${rule.nodes.map((node) => ` ${node.toString()};`).join("")} }`;
  const last = parsed.at(-1);
  if (last) {
    const before = source.slice(last.start, last.end);
    const lead = before.endsWith("\n") ? "" : "\n";
    return { source: `${source.slice(0, last.end)}${lead}${text}\n${source.slice(last.end)}`, selector };
  }
  const headEnd = head?.sourceCodeLocation?.endTag?.startOffset;
  if (headEnd === undefined) throw new Error(`${file} has no </head> to add the state's style to.`);
  // On its own line, indented as </head> is.
  const lineStart = source.lastIndexOf("\n", headEnd - 1) + 1;
  const indent = source.slice(lineStart, headEnd);
  const at = indent.trim() ? headEnd : lineStart;
  const pad = indent.trim() ? "" : indent;
  return { source: `${source.slice(0, at)}${pad}<style>\n${pad}${text}\n${pad}</style>\n${source.slice(at)}`, selector };
}
