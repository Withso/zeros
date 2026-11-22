// Which controls each layer of a main component reads, found statically from
// its own markup and CSS: text holes, data-zd-if and data-zd-for, attribute
// holes, and declarations that reach a control through var(--zd-*), a custom
// property that resolves to one, or a selector that tests an attribute a hole
// fills. Matching is by each selector's subject compound, ignoring
// combinators, order, media and specificity, so it over-approximates: a layer
// listed here may be bound, which is the safe side both for choosing what can
// be selected and for refusing raw writes. Linked stylesheets are not read;
// `vars` and `gates` let the renderer bind their winners when it reads them.
// Every bound is enforced while collecting.

import type { DefaultTreeAdapterTypes } from "parse5";
import postcss, { type Declaration, type Rule } from "postcss";
import { componentExpressionNames, parseComponentExpression, type readComponentDeclaration } from "@zeros/design-core/components";
import {
  DESIGN_COMPONENT_BINDINGS_LIMITS as LIMITS,
  DESIGN_COMPONENT_RECORD_LIMITS,
  type DesignComponentBindings,
} from "@zeros/protocol/design-catalog";

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;
type Declaration_ = ReturnType<typeof readComponentDeclaration>["declaration"];

const LOOP = /^\s*([^\s]+)\s+in\s+([\s\S]+)$/;
const RAW_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const VAR = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const ROOT_ALIASES = new Set([":root", ":host", "html", "body"]);
/** Layer ids that would become an object's prototype or constructor as keys. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Bounds on the custom-property graph walked for one main. */
const VAR_GRAPH_LIMITS = { properties: 1024, edges: 8192 };
const ENCODER = new TextEncoder();

interface LayerFacts {
  oid: string;
  element: Element;
  tag: string;
  classes: Set<string>;
  /** Class tokens holding a hole: the static text before the hole ("" for a bare hole). */
  classHoles: string[];
  attributes: Map<string, string>;
  text: Set<string>;
  visible: Set<string>;
  holes: Set<string>;
  styles: Map<string, Set<string>>;
}

/** The options a set of expression names reaches, through derived values. */
function optionsOfNames(names: ReadonlySet<string>, declaration: Declaration_): string[] {
  const options = new Set(declaration.options.map((option) => option.name));
  const derived = new Map(declaration.derived.map((entry) => [entry.name, entry.expression]));
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (current: ReadonlySet<string>) => {
    for (const name of current) {
      if (options.has(name)) found.add(name);
      else if (derived.has(name) && !seen.has(name)) {
        seen.add(name);
        visit(componentExpressionNames(derived.get(name)!));
      }
    }
  };
  visit(names);
  return [...found];
}

/** The options an expression reads, through derived values. */
export function componentExpressionOptions(expression: string, declaration: Declaration_): string[] {
  try {
    return optionsOfNames(componentExpressionNames(parseComponentExpression(expression)), declaration);
  } catch {
    // An expression that does not parse is lint's to report.
    return [];
  }
}

/** The options a --zd-* custom property carries: an option's own (an easing
 * one has -easing and -duration), or a derived value's. */
function zdVarOptions(name: string, declaration: Declaration_): string[] {
  const bare = name.slice("--zd-".length);
  const option = declaration.options.find((entry) => entry.name === bare);
  if (option) return [option.name];
  const easing = /^(.*)-(?:easing|duration)$/.exec(bare);
  if (easing && declaration.options.some((entry) => entry.name === easing[1] && entry.kind === "easing")) return [easing[1]!];
  return declaration.derived.some((entry) => entry.name === bare) ? optionsOfNames(new Set([bare]), declaration) : [];
}

/** Each `{{ … }}` in text as [start, end) spans, in one forward scan: past
 * an unclosed `{{` there is no other hole, so the cost stays linear. */
function holeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("{{", from);
    if (open < 0) break;
    const close = text.indexOf("}}", open + 2);
    if (close < 0) break;
    spans.push([open, close + 2]);
    from = close + 2;
  }
  return spans;
}
const holesIn = (text: string) => holeSpans(text).map(([start, end]) => text.slice(start + 2, end - 2));
/** A class list's tokens, a hole kept whole within its token. */
const classTokens = (value: string) => {
  let joined = "";
  let from = 0;
  for (const [start, end] of holeSpans(value)) {
    joined += value.slice(from, start) + value.slice(start, end).replace(/\s+/g, "");
    from = end;
  }
  return (joined + value.slice(from)).split(/\s+/).filter(Boolean);
};

/** One selector's compound parts: tag, ids, classes, attribute tests and the
 * :is()/:where() lists it nests. Pseudo-classes and elements are dropped. */
interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attributes: Array<{ name: string; value: string | null; operator: string | null; caseInsensitive: boolean }>;
  nested: string[][];
  /** Simple :not() compounds: a layer that certainly matches one is excluded. */
  negated: Compound[];
  /** Every :not() argument as written: the attributes it tests are still
   * what the rule depends on. */
  negatedText: string[];
  /** The parser dropped a condition (a pseudo-class it does not model, an
   * attribute test it could not read), so a match is never certain. */
  partial: boolean;
  root: boolean;
}

/** Split at top-level commas. */
function splitList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}

/** A complex selector's compounds, split at top-level combinators. */
function compoundsOf(selector: string): string[] {
  const compounds: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (quote) {
      current += character;
      if (character === "\\") current += selector[++index] ?? "";
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[\s>+~]/.test(character)) {
      if (current.trim()) compounds.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) compounds.push(current.trim());
  return compounds;
}

const unquote = (value: string) => value.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");

function parseCompound(text: string): Compound {
  const compound: Compound = { tag: null, ids: [], classes: [], attributes: [], nested: [], negated: [], negatedText: [], partial: false,
    root: ROOT_ALIASES.has(text.toLowerCase()) };
  let index = 0;
  const name = () => {
    const match = /^(?:\\.|[A-Za-z0-9_\-\u00a0-\uffff])+/.exec(text.slice(index));
    index += match?.[0].length ?? 0;
    return (match?.[0] ?? "").replace(/\\(.)/g, "$1");
  };
  const group = () => {
    let depth = 0;
    const start = index;
    for (; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")" && --depth === 0) { index += 1; break; }
    }
    return text.slice(start + 1, index - 1);
  };
  if (text[0] === "*") index = 1;
  else if (/[A-Za-z]/.test(text[0] ?? "")) compound.tag = name().toLowerCase();
  while (index < text.length) {
    const character = text[index]!;
    if (character === "#") { index += 1; compound.ids.push(name()); }
    else if (character === ".") { index += 1; compound.classes.push(name()); }
    else if (character === "[") {
      const end = text.indexOf("]", index);
      const body = text.slice(index + 1, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end + 1;
      const test = /^\s*([^\s~|^$*=]+)\s*(?:([~|^$*]?=)\s*([\s\S]*?))?\s*(?:\s([iIsS]))?\s*$/.exec(body);
      if (test) compound.attributes.push({ name: test[1]!.toLowerCase(), value: test[3] === undefined ? null : unquote(test[3]),
        operator: test[2] ?? null, caseInsensitive: test[4] === "i" || test[4] === "I" });
      else compound.partial = true;
    } else if (character === ":") {
      const element = text[index + 1] === ":";
      index += element ? 2 : 1;
      const pseudo = name().toLowerCase();
      const argument = text[index] === "(" ? group() : null;
      if (!element && argument !== null && (pseudo === "is" || pseudo === "where" || pseudo === "matches")) compound.nested.push(splitList(argument));
      else if (!element && argument !== null && pseudo === "not") {
        for (const alternative of splitList(argument)) {
          compound.negatedText.push(alternative);
          if (compoundsOf(alternative).length === 1) compound.negated.push(parseCompound(alternative));
        }
      } else if (!element && (pseudo === "root" || pseudo === "host")) compound.root = true;
      else compound.partial = true;
    } else index += 1;
  }
  return compound;
}

/** The attribute tests and classes a selector makes anywhere in it. */
function selectorTests(selector: string): { attributes: string[]; classes: string[] } {
  const attributes: string[] = [];
  const classes: string[] = [];
  for (const complex of splitList(selector))
    for (const text of compoundsOf(complex)) {
      const compound = parseCompound(text);
      attributes.push(...compound.attributes.map((test) => test.name));
      classes.push(...compound.classes);
      for (const nested of [...compound.nested.flat(), ...compound.negatedText]) {
        const inner = selectorTests(nested);
        attributes.push(...inner.attributes);
        classes.push(...inner.classes);
      }
    }
  return { attributes, classes };
}

/** An attribute selector's test against a known value: null for an operator
 * not modelled, which keeps the layer rather than drop a binding. */
function attributeTest(test: { value: string | null; operator: string | null; caseInsensitive: boolean }, actual: string): boolean | null {
  if (test.value === null) return true;
  const fold = (text: string) => (test.caseInsensitive ? text.toLowerCase() : text);
  const value = fold(test.value);
  const subject = fold(actual);
  switch (test.operator) {
    case "=": return subject === value;
    case "^=": return value !== "" && subject.startsWith(value);
    case "$=": return value !== "" && subject.endsWith(value);
    case "*=": return value !== "" && subject.includes(value);
    case "~=": return subject.split(/[\t\n\f\r ]+/).includes(value);
    case "|=": return subject === value || subject.startsWith(`${value}-`);
    default: return null;
  }
}

/** The layer matches this compound whatever its holes fill: tag, ids and
 * static classes only. */
function certainlyMatches(compound: Compound, layer: LayerFacts): boolean {
  if (compound.partial || compound.root || compound.nested.length || compound.negatedText.length) return false;
  if (!compound.tag && !compound.ids.length && !compound.classes.length && !compound.attributes.length) return false;
  // An attribute test is certain only against a value the layer holds as
  // written; one a hole fills may be anything.
  for (const test of compound.attributes) {
    const actual = test.name === "data-oid" ? layer.oid : layer.attributes.get(test.name);
    if (actual === undefined || actual.includes("{{") || attributeTest(test, actual) !== true) return false;
  }
  return (!compound.tag || compound.tag === layer.tag) && compound.ids.every((id) => layer.attributes.get("id") === id) &&
    compound.classes.every((name) => layer.classes.has(name));
}

function compoundMatches(compound: Compound, layer: LayerFacts, root: string | undefined): boolean {
  if (compound.negated.some((negated) => certainlyMatches(negated, layer))) return false;
  if (compound.root) return layer.oid === root;
  if (compound.tag && compound.tag !== layer.tag) return false;
  for (const id of compound.ids) if (layer.attributes.get("id") !== id) return false;
  for (const name of compound.classes)
    // A class a hole fills may be any class: over-approximate.
    if (!layer.classes.has(name) && !layer.classHoles.some((prefix) => name.startsWith(prefix))) return false;
  for (const test of compound.attributes) {
    if (test.name === "data-oid") {
      if (test.value !== null && attributeTest(test, layer.oid) === false) return false;
      continue;
    }
    if (test.name === "data-zd-part") {
      // A part's id carries a repeat's "#n"; its layer is the id without it.
      if (test.value !== null && attributeTest({ ...test, value: test.value.replace(/#[\d.]+$/, "") }, layer.oid) === false) return false;
      continue;
    }
    if (!layer.attributes.has(test.name)) return false;
  }
  for (const list of compound.nested)
    if (!list.some((complex) => {
      const last = compoundsOf(complex).at(-1);
      return last !== undefined && compoundMatches(parseCompound(last), layer, root);
    })) return false;
  return true;
}

/** Each complex selector's subject: its last compound. */
function subjectsOf(selector: string): Compound[] {
  return splitList(selector).flatMap((complex) => {
    const last = compoundsOf(complex).at(-1);
    return last === undefined ? [] : [parseCompound(last)];
  });
}

export function componentBindingsOf(document: DefaultTreeAdapterTypes.Document, declaration: Declaration_): DesignComponentBindings | undefined {
  let truncated = false;
  const layers = new Map<string, LayerFacts>();
  const styleSources: string[] = [];
  const optionNames = new Set(declaration.options.filter((option) => option.kind !== "slot").map((option) => option.name));
  const read = (expression: string) => componentExpressionOptions(expression, declaration);
  const gates = new Map<string, Set<string>>();
  const classGates: Array<{ prefix: string; options: Set<string> }> = [];

  const factsFor = (element: Element): LayerFacts | null => {
    const oid = element.attrs.find((attribute) => attribute.name === "data-oid")?.value
      ?? element.attrs.find((attribute) => attribute.name === "data-zid")?.value;
    if (!oid) return null;
    if (oid.length > DESIGN_COMPONENT_RECORD_LIMITS.layerId || UNSAFE_KEYS.has(oid)) {
      truncated = true;
      return null;
    }
    const existing = layers.get(oid);
    if (existing) return existing;
    const attributes = new Map(element.attrs.map((attribute) => [attribute.name, attribute.value]));
    const classes = new Set<string>();
    const classHoles: string[] = [];
    for (const token of classTokens(attributes.get("class") ?? "")) {
      const hole = token.indexOf("{{");
      if (hole < 0) classes.add(token);
      else classHoles.push(token.slice(0, hole));
    }
    const facts: LayerFacts = { oid, element, tag: element.tagName, classes, classHoles, attributes,
      text: new Set(), visible: new Set(), holes: new Set(), styles: new Map() };
    layers.set(oid, facts);
    return facts;
  };

  const visit = (nodes: readonly Node[], owner: LayerFacts | null, wrapping: ReadonlySet<string>) => {
    for (const node of nodes) {
      if (node.nodeName === "#text") {
        if (!owner) continue;
        for (const hole of holesIn((node as DefaultTreeAdapterTypes.TextNode).value)) {
          for (const name of read(hole)) owner.text.add(name);
          // Text a wrapping template shows is visible only when it is.
          for (const name of wrapping) owner.visible.add(name);
        }
        continue;
      }
      if (!("tagName" in node)) continue;
      const element = node as Element;
      if (element.tagName === "style") {
        styleSources.push(element.childNodes.map((child) => (child as DefaultTreeAdapterTypes.TextNode).value ?? "").join(""));
        continue;
      }
      if (RAW_TEXT.has(element.tagName)) continue;
      if (element.tagName === "template" && element.attrs.some((attribute) => attribute.name === "data-zd-options")) continue;
      const directives = new Set<string>();
      for (const attribute of element.attrs) {
        if (attribute.name === "data-zd-if") for (const name of read(attribute.value)) directives.add(name);
        else if (attribute.name === "data-zd-for") {
          const loop = LOOP.exec(attribute.value);
          if (loop) for (const name of read(loop[2]!)) directives.add(name);
        }
      }
      if (element.tagName === "template") {
        // A wrapping template stands in for its content: what it tests applies
        // there. One in foreign content (SVG metadata) has no template content.
        visit((element as Partial<Template>).content?.childNodes ?? element.childNodes, owner, new Set([...wrapping, ...directives]));
        continue;
      }
      const facts = factsFor(element);
      if (facts) {
        for (const name of [...wrapping, ...directives]) facts.visible.add(name);
        for (const attribute of element.attrs) {
          if (!attribute.value.includes("{{")) continue;
          const names = holesIn(attribute.value).flatMap(read);
          for (const name of names) facts.holes.add(name);
          if (attribute.name === "class") {
            for (const token of classTokens(attribute.value)) {
              const hole = token.indexOf("{{");
              if (hole >= 0) classGates.push({ prefix: token.slice(0, hole), options: new Set(holesIn(token).flatMap(read)) });
            }
          }
          const gate = gates.get(attribute.name) ?? new Set<string>();
          for (const name of names) gate.add(name);
          if (gate.size) gates.set(attribute.name, gate);
        }
        const inline = facts.attributes.get("style");
        if (inline) styleSources.push(`[data-oid="${facts.oid.replace(/["\\]/g, "\\$&")}"] { ${inline} }`);
      }
      visit(element.childNodes, facts ?? owner, facts ? new Set() : wrapping);
    }
  };
  visit(document.childNodes, null, new Set());

  // The main's one root: the only identified element under body.
  const html = document.childNodes.find((node) => "tagName" in node && node.tagName === "html") as Element | undefined;
  const body = html?.childNodes.find((node) => "tagName" in node && node.tagName === "body") as Element | undefined;
  const roots = (body?.childNodes ?? []).filter((node): node is Element => "tagName" in node &&
    !RAW_TEXT.has(node.tagName) && node.tagName !== "template" &&
    node.attrs.some((attribute) => attribute.name === "data-oid" || attribute.name === "data-zid"));
  const rootFacts = roots.length === 1 ? factsFor(roots[0]!) : null;
  const root = rootFacts?.oid;

  // The main's own CSS: custom-property edges, then what each declaration reaches.
  const rules: Rule[] = [];
  for (const source of styleSources) {
    try {
      postcss.parse(source).walkRules((rule) => {
        // A rule inside @keyframes names offsets, not layers.
        if (rule.parent?.type === "atrule" && /keyframes$/i.test((rule.parent as postcss.AtRule).name)) return;
        rules.push(rule);
      });
    } catch {
      // CSS that does not parse is lint's to report.
    }
  }
  const gateOptions = (selector: string): Set<string> => {
    const found = new Set<string>();
    const tests = selectorTests(selector);
    for (const name of tests.attributes) for (const option of gates.get(name) ?? []) found.add(option);
    for (const name of tests.classes)
      for (const gate of classGates)
        if (name.startsWith(gate.prefix)) for (const option of gate.options) found.add(option);
    return found;
  };
  const edges = new Map<string, Set<string>>();
  const gatedVars = new Map<string, Set<string>>();
  for (const rule of rules) {
    const gated = gateOptions(rule.selector);
    rule.each((child) => {
      if (child.type !== "decl" || !child.prop.startsWith("--")) return;
      const reads = edges.get(child.prop) ?? new Set<string>();
      for (const match of child.value.matchAll(VAR)) reads.add(match[1]!);
      edges.set(child.prop, reads);
      if (gated.size) {
        const options = gatedVars.get(child.prop) ?? new Set<string>();
        for (const option of gated) options.add(option);
        gatedVars.set(child.prop, options);
      }
    });
  }
  // What each of the main's custom properties reaches, propagated over the
  // graph of what it reads until nothing grows: a chain of any depth
  // resolves, and a property is revisited only when its set grows, so the
  // work is bounded by the edges times the controls. Past the graph's caps it
  // is not walked: each property the main declares then reads every control,
  // and the record says it was cut.
  let edgeCount = 0;
  for (const reads of edges.values()) edgeCount += reads.size;
  const overflow = edges.size > VAR_GRAPH_LIMITS.properties || edgeCount > VAR_GRAPH_LIMITS.edges;
  if (overflow) truncated = true;
  const everyControl = [...optionNames];
  const reached = new Map<string, Set<string>>();
  if (!overflow) {
    const readers = new Map<string, string[]>();
    for (const [name, reads] of edges)
      for (const read of reads) {
        const list = readers.get(read);
        if (list) list.push(name);
        else readers.set(read, [name]);
      }
    const pending: string[] = [];
    const add = (name: string, options: Iterable<string>) => {
      let set = reached.get(name);
      if (!set) reached.set(name, set = new Set());
      let grew = false;
      for (const option of options) if (!set.has(option)) { set.add(option); grew = true; }
      if (grew) pending.push(name);
    };
    for (const [name, reads] of edges) {
      const direct = new Set(gatedVars.get(name) ?? []);
      for (const read of reads) if (read.startsWith("--zd-")) for (const option of zdVarOptions(read, declaration)) direct.add(option);
      add(name, direct);
    }
    while (pending.length) {
      const name = pending.pop()!;
      const options = [...reached.get(name)!];
      for (const reader of readers.get(name) ?? []) add(reader, options);
    }
  }
  const resolve = (name: string): Set<string> => {
    if (name.startsWith("--zd-")) return new Set(zdVarOptions(name, declaration));
    if (overflow) return new Set(edges.has(name) ? everyControl : []);
    return reached.get(name) ?? new Set();
  };
  const valueOptions = (value: string) => {
    const found = new Set<string>();
    for (const match of value.matchAll(VAR)) for (const option of resolve(match[1]!)) found.add(option);
    return found;
  };
  const vars = new Map<string, Set<string>>();
  for (const name of edges.keys()) if (!name.startsWith("--zd-")) {
    const options = resolve(name);
    if (options.size) vars.set(name, options);
  }

  const layerList = [...layers.values()];
  for (const rule of rules) {
    // What a value reads holds for every arm of the list; a gate only for
    // the arm that tests it, so `.badge[data-tone], .caption` leaves
    // .caption's value unbound.
    const values: Array<[string, Set<string>]> = [];
    rule.each((child) => {
      if (child.type !== "decl") return;
      const declaration = child as Declaration;
      if (declaration.prop.startsWith("--zd-")) return;
      values.push([declaration.prop.toLowerCase().startsWith("--") ? declaration.prop : declaration.prop.toLowerCase(), valueOptions(declaration.value)]);
    });
    if (!values.length) continue;
    for (const arm of splitList(rule.selector)) {
      const gated = gateOptions(arm);
      const declarations = values
        .map(([property, read]): [string, Set<string>] => [property, new Set([...read, ...gated])])
        .filter(([, options]) => options.size > 0);
      if (!declarations.length) continue;
      const subjects = subjectsOf(arm);
      for (const layer of layerList) {
        if (!subjects.some((subject) => compoundMatches(subject, layer, root))) continue;
        for (const [property, options] of declarations) {
          const entry = layer.styles.get(property) ?? new Set<string>();
          for (const option of options) entry.add(option);
          layer.styles.set(property, entry);
        }
      }
    }
  }

  const list = (names: Iterable<string>) => {
    const sorted = [...names].filter((name) => name.length <= DESIGN_COMPONENT_RECORD_LIMITS.optionName).sort();
    if (sorted.length > LIMITS.options) truncated = true;
    return sorted.slice(0, LIMITS.options);
  };
  const boundedMap = (entries: Map<string, Set<string>>, max: number, keyOk: (key: string) => boolean) => {
    const out: Record<string, string[]> = {};
    let count = 0;
    for (const [key, options] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      const names = list(options);
      if (!names.length || !keyOk(key)) continue;
      if (count >= max) { truncated = true; break; }
      out[key] = names;
      count += 1;
    }
    return count ? out : undefined;
  };

  const result: DesignComponentBindings = { layers: {} };
  const used = new Set<string>();
  let layerCount = 0;
  for (const layer of layerList) {
    const entry: DesignComponentBindings["layers"][string] = {};
    const text = list(layer.text);
    const visible = list(layer.visible);
    const attributes = list(layer.holes);
    const styles = boundedMap(layer.styles, LIMITS.styles, (property) => property.length <= LIMITS.property);
    if (text.length) entry.text = text;
    if (visible.length) entry.visible = visible;
    if (attributes.length) entry.attributes = attributes;
    if (styles) entry.styles = styles;
    if (!Object.keys(entry).length) continue;
    if (layerCount >= LIMITS.layers) { truncated = true; continue; }
    result.layers[layer.oid] = entry;
    layerCount += 1;
    for (const names of [text, visible, attributes, ...Object.values(styles ?? {})]) for (const name of names) used.add(name);
  }
  if (root) result.root = root;
  const varsRecord = boundedMap(vars, LIMITS.vars, (key) => /^--[A-Za-z0-9_-]{1,126}$/.test(key));
  if (varsRecord) {
    result.vars = varsRecord;
    for (const names of Object.values(varsRecord)) for (const name of names) used.add(name);
  }
  const classGate = new Set(classGates.flatMap((gate) => [...gate.options]));
  if (classGate.size) gates.set("class", new Set([...(gates.get("class") ?? []), ...classGate]));
  const gatesRecord = boundedMap(gates, LIMITS.gates, (key) => key.length <= DESIGN_COMPONENT_RECORD_LIMITS.attributeName);
  if (gatesRecord) result.gates = gatesRecord;
  // An empty prefix (a hole at a class's start) names no class to test.
  const prefixes = new Map<string, Set<string>>();
  for (const gate of classGates) if (gate.prefix) prefixes.set(gate.prefix, new Set([...(prefixes.get(gate.prefix) ?? []), ...gate.options]));
  const classGatesRecord = boundedMap(prefixes, LIMITS.gates, (key) => key.length <= LIMITS.property);
  if (classGatesRecord) result.classGates = classGatesRecord;
  const unread = [...optionNames].filter((name) => !used.has(name)).sort();
  if (unread.length) result.unread = unread.slice(0, LIMITS.unread);

  // An overall budget in UTF-8 bytes, as the record is sent: drop the
  // largest layers' entries until it fits with room left for `truncated`.
  const bytes = (value: unknown) => ENCODER.encode(JSON.stringify(value)).length;
  const budget = LIMITS.bytes - bytes({ truncated: true });
  let size = bytes(result);
  if (size > LIMITS.bytes || (truncated && size > budget)) {
    truncated = true;
    for (const [oid, entry] of Object.entries(result.layers).sort(([, a], [, b]) => bytes(b) - bytes(a))) {
      if (size <= budget) break;
      size -= bytes({ [oid]: entry }) - 1;
      delete result.layers[oid];
    }
  }
  if (truncated) result.truncated = true;
  return Object.keys(result.layers).length || result.vars || result.gates || result.unread ? result : undefined;
}
