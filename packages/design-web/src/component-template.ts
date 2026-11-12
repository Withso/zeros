// A component's template layer: {{ holes }}, data-zd-if and data-zd-for,
// evaluated by the Design core's own expression interpreter with nothing but
// the option values, derived values and loop names in scope. It runs only in
// a file that declares options. Untouched markup is copied byte for byte from
// its source; only an element that holds a hole, a directive or an identity
// to rewrite is written again.

import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  COMPONENT_EXPRESSION_LIMITS,
  ComponentExpressionError,
  componentExpressionNames,
  componentOptionNameProblem,
  componentOptionReach,
  readComponentDeclaration,
  type ComponentOptionReach,
  createComponentExpressionBudget,
  evaluateComponentExpression,
  parseComponentExpression,
  type ComponentExpression,
  type ComponentExpressionBudget,
  type ComponentExpressionValue,
} from "@zeros/design-core/components";

export const COMPONENT_TEMPLATE_LIMITS = Object.freeze({
  /** Holes one rendering may fill. */
  holes: 512,
  /** Repeats across one rendering, all loops together. */
  iterations: 4_096,
  /** data-zd-for inside data-zd-for. */
  loopDepth: 3,
  /** Expression steps across one rendering. */
  steps: 100_000,
});

/** Attributes a hole may not fill: ones that load or run something, and the
 * identity attributes selection and history rely on. */
export const REFUSED_HOLE_ATTRIBUTES: readonly string[] = Object.freeze([
  "style", "href", "src", "srcset", "action", "formaction", "poster", "srcdoc", "data", "xlink:href", "ping", "background",
  "cite", "manifest", "codebase", "id", "data-oid", "data-zid",
]);
const REFUSED = new Set(REFUSED_HOLE_ATTRIBUTES);

export class ComponentTemplateError extends Error {
  constructor(
    message: string,
    /** Where in the rendered markup the problem is, when known. */
    readonly offset?: number,
  ) {
    super(message);
    this.name = "ComponentTemplateError";
  }
}

export interface ComponentTemplateBudget {
  holes: number;
  iterations: number;
  expression: ComponentExpressionBudget;
}

export function createComponentTemplateBudget(): ComponentTemplateBudget {
  return {
    holes: COMPONENT_TEMPLATE_LIMITS.holes,
    iterations: COMPONENT_TEMPLATE_LIMITS.iterations,
    expression: createComponentExpressionBudget(COMPONENT_TEMPLATE_LIMITS.steps),
  };
}

export interface ComponentTemplateOptions {
  scope: ReadonlyMap<string, ComponentExpressionValue>;
  /**
   * part: an instance's copy of a definition. Every data-oid or data-zid
   * becomes data-zd-part, with "#<copy>" on repeats after the first.
   * copy: a main frame rendering itself. The first repeat keeps its
   * data-oid; the others carry data-zd-copy="<oid>#<copy>" instead.
   */
  ids: "part" | "copy";
  budget: ComponentTemplateBudget;
  /** The markup is a whole document (a main frame), not a definition's body. */
  document?: boolean;
}

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;

const HOLE = /\{\{([\s\S]*?)\}\}/g;
const LOOP = /^\s*([^\s]+)\s+in\s+([\s\S]+)$/;
const RAW_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);

const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, "&quot;");

const parsed = new Map<string, ComponentExpression>();
function expressionOf(source: string): ComponentExpression {
  let tree = parsed.get(source);
  if (!tree) {
    tree = parseComponentExpression(source.trim());
    if (parsed.size >= 512) parsed.delete(parsed.keys().next().value!);
    parsed.set(source, tree);
  }
  return tree;
}

/** Render a component's markup with its values. Throws ComponentTemplateError. */
export function renderComponentTemplate(markup: string, options: ComponentTemplateOptions): string {
  const fragment = options.document ? parse(markup, { sourceCodeLocationInfo: true }) : parseFragment(markup, { sourceCodeLocationInfo: true });
  const { budget } = options;
  const evaluate = (source: string, scope: ReadonlyMap<string, ComponentExpressionValue>, offset?: number): ComponentExpressionValue => {
    try {
      return evaluateComponentExpression(expressionOf(source), scope, budget.expression);
    } catch (error) {
      if (error instanceof ComponentExpressionError) throw new ComponentTemplateError(error.message, offset);
      throw error;
    }
  };
  const fill = (text: string, scope: ReadonlyMap<string, ComponentExpressionValue>, escape: (value: string) => string, offset?: number) => {
    let output = "";
    let last = 0;
    for (const match of text.matchAll(HOLE)) {
      const literal = text.slice(last, match.index);
      if (literal.includes("{{")) throw new ComponentTemplateError("A hole opened with {{ is not closed with }}.", offset);
      if (--budget.holes < 0) throw new ComponentTemplateError(`A component may fill at most ${COMPONENT_TEMPLATE_LIMITS.holes} holes.`, offset);
      const value = evaluate(match[1]!, scope, offset);
      if (Array.isArray(value)) throw new ComponentTemplateError("A hole needs text, a number or true or false; a list cannot fill a hole.", offset);
      output += escape(literal) + escape(String(value));
      last = match.index! + match[0].length;
    }
    const rest = text.slice(last);
    if (rest.includes("{{")) throw new ComponentTemplateError("A hole opened with {{ is not closed with }}.", offset);
    return output + escape(rest);
  };

  const sourceOf = (node: { sourceCodeLocation?: { startOffset: number; endOffset: number } | null }) =>
    node.sourceCodeLocation ? markup.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset) : "";
  /** Copy as written: nothing below this node needs evaluating or rewriting. */
  const untouched = (element: Element) => {
    const raw = sourceOf(element);
    return !raw.includes("{{") && !/\sdata-zd-/i.test(raw) && (options.ids === "copy" || !/\sdata-(?:oid|zid)\s*=/i.test(raw));
  };

  const emitChildren = (nodes: readonly Node[], scope: ReadonlyMap<string, ComponentExpressionValue>, copy: readonly number[], loops: number) =>
    nodes.map((node) => emit(node, scope, copy, loops)).join("");

  const emit = (node: Node, scope: ReadonlyMap<string, ComponentExpressionValue>, copy: readonly number[], loops: number): string => {
    if (node.nodeName === "#text") {
      const raw = sourceOf(node as DefaultTreeAdapterTypes.TextNode);
      const parent = (node as DefaultTreeAdapterTypes.TextNode).parentNode as Element | null;
      if (!raw.includes("{{") || (parent && "tagName" in parent && RAW_TEXT.has(parent.tagName))) return raw;
      return fill((node as DefaultTreeAdapterTypes.TextNode).value, scope, escapeText, node.sourceCodeLocation?.startOffset);
    }
    if (node.nodeName === "#comment" || node.nodeName === "#documentType") return sourceOf(node as DefaultTreeAdapterTypes.CommentNode);
    const element = node as Element;
    const location = element.sourceCodeLocation;
    const offset = location?.startOffset;
    const attribute = (name: string) => element.attrs.find((entry) => entry.name === name && !entry.prefix)?.value;
    const loop = attribute("data-zd-for");
    if (loop !== undefined) {
      const match = LOOP.exec(loop);
      if (!match) throw new ComponentTemplateError('data-zd-for needs "name in list", such as "item in range(3)".', offset);
      const name = match[1]!;
      const problem = componentOptionNameProblem(name);
      if (problem) throw new ComponentTemplateError(`The loop name ${name}: ${problem}`, offset);
      if (scope.has(name)) throw new ComponentTemplateError(`The loop name ${name} already names an option or value.`, offset);
      if (loops >= COMPONENT_TEMPLATE_LIMITS.loopDepth)
        throw new ComponentTemplateError(`data-zd-for may nest at most ${COMPONENT_TEMPLATE_LIMITS.loopDepth} deep.`, offset);
      const items = evaluate(match[2]!, scope, offset);
      if (!Array.isArray(items)) throw new ComponentTemplateError("data-zd-for needs a list, such as range(3) or [\"a\", \"b\"].", offset);
      if (items.length > COMPONENT_EXPRESSION_LIMITS.list)
        throw new ComponentTemplateError(`A loop may repeat at most ${COMPONENT_EXPRESSION_LIMITS.list} times.`, offset);
      let output = "";
      items.forEach((item, index) => {
        if (--budget.iterations < 0)
          throw new ComponentTemplateError(`A component may make at most ${COMPONENT_TEMPLATE_LIMITS.iterations.toLocaleString("en-US")} repeats.`, offset);
        const inner = new Map(scope);
        inner.set(name, item);
        output += emitElement(element, inner, [...copy, index], loops + 1);
      });
      return output;
    }
    return emitElement(element, scope, copy, loops);
  };

  const emitElement = (element: Element, scope: ReadonlyMap<string, ComponentExpressionValue>, copy: readonly number[], loops: number): string => {
    const location = element.sourceCodeLocation;
    const offset = location?.startOffset;
    const condition = element.attrs.find((entry) => entry.name === "data-zd-if" && !entry.prefix)?.value;
    if (condition !== undefined) {
      const value = evaluate(condition, scope, offset);
      if (typeof value !== "boolean")
        throw new ComponentTemplateError("data-zd-if needs true or false, such as \"toolbar\" or \"count > 0\".", offset);
      if (!value) return "";
    }
    if (element.tagName === "template" && (condition !== undefined || element.attrs.some((entry) => entry.name === "data-zd-for"))) {
      // A template used only to wrap: its content stands in for it.
      return emitChildren((element as Template).content.childNodes, scope, copy, loops);
    }
    const repeated = copy.some((index) => index !== 0);
    if (!location) return emitChildren(element.childNodes, scope, copy, loops);
    if (!repeated && untouched(element)) return markup.slice(location.startOffset, location.endOffset);
    const startTag = location.startTag;
    if (!startTag) return markup.slice(location.startOffset, location.endOffset);
    const suffix = repeated ? `#${copy.join(".").replace(/^(?:0\.)+/, "")}` : "";
    const rewrite = repeated || element.attrs.some((entry) =>
      entry.value.includes("{{") || entry.name === "data-zd-if" || entry.name === "data-zd-for" ||
      (options.ids === "part" && (entry.name === "data-oid" || entry.name === "data-zid")));
    let tag = rewrite ? `<${element.tagName}` : markup.slice(startTag.startOffset, startTag.endOffset);
    let identity = false;
    for (const entry of rewrite ? element.attrs : []) {
      const name = entry.prefix ? `${entry.prefix}:${entry.name}` : entry.name;
      if (name === "data-zd-if" || name === "data-zd-for") continue;
      if (entry.value.includes("{{") &&
        (REFUSED.has(name) || /^on/i.test(name) || /^data-zd-/i.test(name) || (name === "content" && element.tagName === "meta")))
        throw new ComponentTemplateError(`The attribute ${name} cannot take a hole.`, offset);
      if (name === "data-oid" || name === "data-zid") {
        if (options.ids === "part") {
          if (!identity) tag += ` data-zd-part="${escapeAttribute(entry.value + suffix)}"`;
          identity = true;
          continue;
        }
        if (repeated && name === "data-oid") {
          tag += ` data-zd-copy="${escapeAttribute(entry.value + suffix)}"`;
          continue;
        }
      }
      const value = entry.value.includes("{{") ? fill(entry.value, scope, (text) => text, offset) : entry.value;
      tag += value === "" && !entry.value ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`;
    }
    if (rewrite) tag += markup.slice(startTag.endOffset - 2, startTag.endOffset) === "/>" ? " />" : ">";
    const children = element.tagName === "template"
      ? markup.slice(startTag.endOffset, location.endTag?.startOffset ?? startTag.endOffset)
      : RAW_TEXT.has(element.tagName)
        ? element.childNodes.map((child) => sourceOf(child as DefaultTreeAdapterTypes.TextNode)).join("")
        : emitChildren(element.childNodes, scope, copy, loops);
    const endTag = location.endTag ? markup.slice(location.endTag.startOffset, location.endTag.endOffset) : "";
    return tag + children + endTag;
  };

  return emitChildren(fragment.childNodes, options.scope, [], 0);
}

/** The expressions a template evaluates (holes, conditions and loop lists),
 * found without evaluating anything. */
export function componentTemplateExpressions(markup: string, options: { document?: boolean } = {}): string[] {
  const fragment = options.document ? parse(markup) : parseFragment(markup);
  const found: string[] = [];
  const holes = (text: string) => {
    for (const match of text.matchAll(HOLE)) found.push(match[1]!.trim());
  };
  const visit = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      if (node.nodeName === "#text") {
        const parent = (node as DefaultTreeAdapterTypes.TextNode).parentNode as Element | null;
        if (!(parent && "tagName" in parent && RAW_TEXT.has(parent.tagName))) holes((node as DefaultTreeAdapterTypes.TextNode).value);
        continue;
      }
      if (!("tagName" in node)) continue;
      const element = node as Element;
      if (element.tagName === "template" && element.attrs.some((attribute) => attribute.name === "data-zd-options")) continue;
      for (const attribute of element.attrs) {
        if (attribute.name === "data-zd-if") found.push(attribute.value.trim());
        else if (attribute.name === "data-zd-for") {
          const loop = LOOP.exec(attribute.value);
          if (loop) found.push(loop[2]!.trim());
        } else holes(attribute.value);
      }
      visit(element.tagName === "template" ? (element as Template).content.childNodes : element.childNodes);
      if (found.length > COMPONENT_TEMPLATE_LIMITS.holes * 4) return;
    }
  };
  visit(fragment.childNodes);
  return found;
}

/** What the Style panel needs about a frame that declares options: its
 * declaration as written (the <head>'s <template data-zd-options>), and
 * whether each option reaches the frame only through CSS. Null for a frame
 * that declares none. */
export interface DesignComponentSummary {
  elements: { tag: string; attributes: { name: string; value: string }[] }[];
  reach: Record<string, ComponentOptionReach>;
  /** Layers (by data-oid) whose own text a hole fills, and the options it
   * reads, through any derived value (none for a loop's own name). A person
   * cannot type over them. */
  boundText?: Record<string, string[]>;
}

/** The options an expression reads, through derived values. */
function optionsRead(expression: string, declaration: ReturnType<typeof readComponentDeclaration>["declaration"]): string[] {
  const options = new Set(declaration.options.map((option) => option.name));
  const derived = new Map(declaration.derived.map((entry) => [entry.name, entry.expression]));
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (names: Set<string>) => {
    for (const name of names) {
      if (options.has(name)) found.add(name);
      else if (derived.has(name) && !seen.has(name)) {
        seen.add(name);
        visit(componentExpressionNames(derived.get(name)!));
      }
    }
  };
  try {
    visit(componentExpressionNames(parseComponentExpression(expression)));
  } catch {
    // An expression that does not parse is lint's to report.
  }
  return [...found];
}

function boundTextOf(document: DefaultTreeAdapterTypes.Document, declaration: ReturnType<typeof readComponentDeclaration>["declaration"]) {
  // A Map while collecting: layer ids are authored text ("__proto__" as a
  // plain object's key would become its prototype).
  const bound = new Map<string, string[]>();
  let count = 0;
  const visit = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const element = node as Element;
      if (RAW_TEXT.has(element.tagName)) continue;
      const oid = element.attrs.find((attribute) => attribute.name === "data-oid")?.value;
      if (oid && count < 512 && oid !== "__proto__" && oid !== "constructor" && oid !== "prototype") {
        const read = new Set<string>();
        let holes = false;
        for (const child of element.childNodes)
          if (child.nodeName === "#text")
            for (const match of (child as DefaultTreeAdapterTypes.TextNode).value.matchAll(HOLE)) {
              holes = true;
              for (const name of optionsRead(match[1]!, declaration)) read.add(name);
            }
        if (holes) {
          bound.set(oid, [...read].sort().slice(0, 8));
          count += 1;
        }
      }
      visit(element.tagName === "template" ? (element as Template).content.childNodes : element.childNodes);
    }
  };
  visit(document.childNodes);
  return count ? Object.fromEntries(bound) : undefined;
}

export function designComponentSummaryOf(source: string): DesignComponentSummary | null {
  const end = source.search(/<\/head\b|<body\b/i);
  if (!/<template\b[^>]*\sdata-zd-options\b/i.test(end < 0 ? source : source.slice(0, end))) return null;
  const document = parse(source);
  const html = document.childNodes.find((node) => "tagName" in node && node.tagName === "html") as Element | undefined;
  const head = html?.childNodes.find((node) => "tagName" in node && node.tagName === "head") as Element | undefined;
  const template = head?.childNodes.find(
    (node) => "tagName" in node && node.tagName === "template" && node.attrs.some((attribute) => attribute.name === "data-zd-options"),
  ) as Template | undefined;
  if (!template) return null;
  const elements = template.content.childNodes
    .filter((node): node is Element => "tagName" in node)
    .map((element) => ({ tag: element.tagName, attributes: element.attrs.map(({ name, value }) => ({ name, value })) }));
  const { declaration } = readComponentDeclaration(elements.map((element) => ({ ...element, offset: 0 })));
  const names = new Set<string>();
  for (const expression of componentTemplateExpressions(source, { document: true })) {
    try {
      componentExpressionNames(parseComponentExpression(expression), names);
    } catch {
      // An expression that does not parse is lint's to report.
    }
  }
  const boundText = boundTextOf(document, declaration);
  return { elements, reach: componentOptionReach(declaration, names), ...(boundText ? { boundText } : {}) };
}
