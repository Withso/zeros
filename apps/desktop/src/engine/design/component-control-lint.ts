// Warnings that keep a component's controls the only way to change it: a
// declared control nothing in the main reads; a style over a property a
// control drives (on a main's layer, an instance host's own style, or an
// older zd-style-<part> override on a bound layer); and an instance override
// no control stands for. They read the bindings the engine already computes
// for the main; all are warnings, so they never block a save.

import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import { componentInstanceOlderOverride } from "@zeros/design-core/component-options";
import { cssOverlappingProperties } from "@zeros/design-core/css-longhands";
import type { DesignComponentBindings, DesignFrameInstances } from "@zeros/protocol/design-catalog";

import type { DesignLintViolation } from "./document-model";

type Location = { startLine: number; startCol: number };
type Elements = readonly { tag: string; attributes: readonly { name: string; value: string }[] }[];

const PROPERTY_LIMIT = 6;
/** The controls a bound record gives a written property, by overlap (a
 * longhand over a bound shorthand, or the reverse); empty when none. */
const controlsOver = (bound: Readonly<Record<string, readonly string[]>>, property: string) =>
  [...new Set(cssOverlappingProperties(bound, property).flatMap((key) => bound[key]!))];

/** Each property a declaration list sets, as written. */
function declaredProperties(list: string, readsControl: (value: string) => boolean = () => false): string[] {
  try {
    const properties: string[] = [];
    postcss.parse(`a{${list}}`).walkDecls((declaration) => {
      if (!readsControl(declaration.value)) properties.push(declaration.prop.toLowerCase());
    });
    return properties;
  } catch {
    return [];
  }
}

/** A value that reads a control is the control's own, wherever it is written. */
const controlReader = (bindings: DesignComponentBindings) => (value: string) =>
  [...value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].some(([, name]) => name!.startsWith("--zd-") || Object.hasOwn(bindings.vars ?? {}, name!));

function labelOf(elements: Elements, name: string): string {
  const element = elements.find((candidate) => candidate.tag === "zd-option" &&
    candidate.attributes.some((attribute) => attribute.name === "name" && attribute.value === name));
  return element?.attributes.find((attribute) => attribute.name === "label")?.value || name;
}

const controlsFor = (elements: Elements, names: readonly string[]) => [...new Set(names)].map((name) => labelOf(elements, name)).join(", ");

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** Where things are in a source, from one parse (no pattern over the source,
 * so the cost stays linear in its size): each layer's first element by
 * data-oid with its style, each <zd-option> by name, and every <style> text. */
interface SourceIndex {
  layers: Map<string, { offset: number; style?: string }>;
  options: Map<string, number>;
  styles: string[];
}

/** `parsed` is the lint's own located parse of this source, when it has one. */
function indexSource(source: string, parsed?: DefaultTreeAdapterTypes.Document): SourceIndex {
  const index: SourceIndex = { layers: new Map(), options: new Map(), styles: [] };
  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = parsed ?? parse(source, { sourceCodeLocationInfo: true });
  } catch {
    return index;
  }
  // Depth first in document order, so a repeated id or name keeps its first.
  const pending: ParentNode[] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) {
      const element = node as Element;
      const offset = element.sourceCodeLocation?.startOffset ?? 0;
      const attribute = (name: string) => element.attrs.find((entry) => entry.name === name)?.value;
      const oid = attribute("data-oid");
      const style = attribute("style");
      if (oid !== undefined && !index.layers.has(oid)) index.layers.set(oid, { offset, ...(style !== undefined ? { style } : {}) });
      const name = element.tagName === "zd-option" ? attribute("name") : undefined;
      if (name !== undefined && !index.options.has(name)) index.options.set(name, offset);
      if (element.tagName === "style")
        index.styles.push(element.childNodes.map((text) => ("value" in text ? (text as DefaultTreeAdapterTypes.TextNode).value : "")).join(""));
    }
    // A template in foreign content (SVG metadata) has no template content.
    const content = node.nodeName === "template" ? (node as Partial<DefaultTreeAdapterTypes.Template>).content : undefined;
    const children = content?.childNodes ?? node.childNodes;
    for (let child = children.length - 1; child >= 0; child -= 1)
      if ("childNodes" in children[child]!) pending.push(children[child] as ParentNode);
  }
  return index;
}

/** On a main: controls nothing reads, and inline or own-rule styles over a bound property. */
export function designMainControlViolations(input: {
  file: string;
  source: string;
  elements: Elements;
  bindings: DesignComponentBindings | undefined;
  lineAt: (offset: number) => Location;
  /** The lint's located parse of `source`, so it is not parsed again. */
  document?: DefaultTreeAdapterTypes.Document;
}): DesignLintViolation[] {
  const { file, source, elements, bindings, lineAt } = input;
  if (!bindings) return [];
  const readsControl = controlReader(bindings);
  const violations: DesignLintViolation[] = [];
  const found = indexSource(source, input.document);
  const ownRules = ownRuleProperties(found.styles, readsControl);
  const violation = (ruleId: DesignLintViolation["ruleId"], message: string, location: Location, fix: string, oid?: string): DesignLintViolation => ({
    ruleId, severity: "warning", message, file, line: location.startLine, column: location.startCol, ...(oid ? { oid } : {}), fix,
  });
  for (const name of bindings.unread ?? [])
    violations.push(violation("component-control-unread",
      `Control ${labelOf(elements, name)} is declared but nothing in the main reads it.`,
      lineAt(found.options.get(name) ?? 0),
      `Read it in the main ({{ ${name} }}, data-zd-if, an attribute, or var(--zd-${name}) in its CSS), or remove its <zd-option>.`));
  // A layer's own declarations (its style attribute, or a rule that targets
  // only it) sit over any rule a control reaches, in every variant.
  for (const [oid, layer] of Object.entries(bindings.layers)) {
    const bound = layer.styles ?? {};
    if (!Object.keys(bound).length) continue;
    const layerAt = found.layers.get(oid);
    const style = layerAt?.style;
    const shadowed = [...(style ? declaredProperties(style, readsControl) : []), ...(ownRules.get(oid) ?? [])]
      .filter((property) => controlsOver(bound, property).length > 0);
    if (!shadowed.length) continue;
    const unique = [...new Set(shadowed)].slice(0, PROPERTY_LIMIT);
    violations.push(violation("component-control-shadowed",
      `${unique.join(", ")} on this layer ${unique.length === 1 ? "sits" : "sit"} over ${controlsFor(elements, unique.flatMap((property) => controlsOver(bound, property)))}.`,
      lineAt(layerAt?.offset ?? 0),
      "Remove the layer's own value so the control sets it, or ask for a new control.", oid));
  }
  return violations;
}

/** The properties each layer's own rule (`[data-oid="…"]` alone) sets,
 * other than values that read a control. */
function ownRuleProperties(styles: readonly string[], readsControl: (value: string) => boolean): Map<string, string[]> {
  const byLayer = new Map<string, string[]>();
  for (const text of styles) {
    try {
      postcss.parse(text).walkRules((rule) => {
        const selector = rule.selector.trim();
        if (!selector.startsWith("[data-oid=") || !selector.endsWith("]")) return;
        const quoted = selector.slice("[data-oid=".length, -1);
        const quote = quoted[0];
        if ((quote !== '"' && quote !== "'") || quoted.length < 2 || quoted[quoted.length - 1] !== quote) return;
        const oid = quoted.slice(1, -1);
        const list = byLayer.get(oid) ?? [];
        rule.walkDecls((declaration) => {
          if (!readsControl(declaration.value)) list.push(declaration.prop.toLowerCase());
        });
        byLayer.set(oid, list);
      });
    } catch {
      // CSS that does not parse is reported elsewhere.
    }
  }
  return byLayer;
}

/** On a frame that places instances: host styles and older part overrides
 * over a bound property, and those no control stands for. */
export function designInstanceControlViolations(input: {
  file: string;
  source: string;
  instances: Pick<DesignFrameInstances, "components" | "hosts">;
  lineAt: (offset: number) => Location;
  /** The lint's located parse of `source`, so it is not parsed again. */
  document?: DefaultTreeAdapterTypes.Document;
}): DesignLintViolation[] {
  const { file, source, instances, lineAt } = input;
  const violations: DesignLintViolation[] = [];
  let found: SourceIndex | null = null;
  for (const [oid, host] of Object.entries(instances.hosts)) {
    if (!Object.hasOwn(instances.components, host.component)) continue;
    const component = instances.components[host.component]!;
    // A main with no controls binds nothing, but its instances' overrides
    // are still overrides. A components/ file's host keeps its own box.
    const bindings = component.bindings ?? (component.frame ? { layers: {} } : null);
    if (!bindings) continue;
    const layers = new Map(Object.entries(bindings.layers).map(([layer, entry]) => [layer.toLowerCase(), entry.styles ?? {}]));
    const shadowed: Array<[string, readonly string[]]> = [];
    const overrides: string[] = [];
    // Place and size are the host's own, except an axis a control sets on
    // the root (the renderer's fence refuses that write too); anything else
    // is over the root's bindings or an override no control stands for.
    const root = bindings.root ? layers.get(bindings.root.toLowerCase()) ?? {} : {};
    // The same classification as the app's older overrides and their Reset.
    const rootProperties = Object.keys(root);
    for (const property of host.style ? declaredProperties(host.style) : []) {
      if (!componentInstanceOlderOverride(property, rootProperties)) continue;
      const controls = controlsOver(root, property);
      if (controls.length) shadowed.push([property, controls]);
      else overrides.push(property);
    }
    for (const [part, declarations] of Object.entries(host.overrides ?? {})) {
      const bound = layers.get(part) ?? {};
      for (const property of declaredProperties(declarations)) {
        const controls = controlsOver(bound, property);
        if (controls.length) shadowed.push([`${property} on ${part}`, controls]);
        else overrides.push(`${property} on ${part}`);
      }
    }
    if (!shadowed.length && !overrides.length) continue;
    found ??= indexSource(source, input.document);
    const location = lineAt(found.layers.get(oid)?.offset ?? 0);
    const at = { file, line: location.startLine, column: location.startCol, oid };
    if (shadowed.length) {
      const shown = shadowed.slice(0, PROPERTY_LIMIT);
      violations.push({
        ruleId: "component-control-shadowed",
        severity: "warning",
        message: `This instance sets ${shown.map(([property]) => property).join(", ")} over ${controlsFor(component.elements, shown.flatMap(([, controls]) => controls))}.`,
        ...at,
        fix: "Remove those styles (Reset in its Controls, or delete them from style and zd-style-<part>) and set the controls instead.",
      });
    }
    if (overrides.length) {
      const shown = [...new Set(overrides)];
      violations.push({
        ruleId: "component-instance-override",
        severity: "warning",
        message: `This instance overrides ${shown.slice(0, PROPERTY_LIMIT).join(", ")}${shown.length > PROPERTY_LIMIT ? ` and ${shown.length - PROPERTY_LIMIT} more` : ""}, which no control sets.`,
        ...at,
        fix: "Make it a control on the main, or remove it (Reset in its Controls).",
      });
    }
  }
  return violations;
}
