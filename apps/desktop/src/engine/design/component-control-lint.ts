// Warnings that keep a component's controls the only way to change it:
// a declared control nothing in the main reads, and a style that sits over a
// property a control drives (on a main's layer, an instance host's own style
// outside its place and size, or an older zd-style-<part> override on a bound
// layer). They read the bindings the engine already computes for the main;
// both are warnings, so they never block a save.

import postcss from "postcss";
import { componentInstanceHostStyleAllowed } from "@zeros/design-core/component-options";
import type { DesignComponentBindings, DesignFrameInstances } from "@zeros/protocol/design-catalog";

import type { DesignLintViolation } from "./document-model";

type Location = { startLine: number; startCol: number };
type Elements = readonly { tag: string; attributes: readonly { name: string; value: string }[] }[];

const PROPERTY_LIMIT = 6;

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
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** On a main: controls nothing reads, and inline or own-rule styles over a bound property. */
export function designMainControlViolations(input: {
  file: string;
  source: string;
  elements: Elements;
  bindings: DesignComponentBindings | undefined;
  lineAt: (offset: number) => Location;
}): DesignLintViolation[] {
  const { file, source, elements, bindings, lineAt } = input;
  if (!bindings) return [];
  const readsControl = controlReader(bindings);
  const violations: DesignLintViolation[] = [];
  const at = (needle: RegExp) => lineAt(needle.exec(source)?.index ?? 0);
  const violation = (ruleId: DesignLintViolation["ruleId"], message: string, location: Location, fix: string, oid?: string): DesignLintViolation => ({
    ruleId, severity: "warning", message, file, line: location.startLine, column: location.startCol, ...(oid ? { oid } : {}), fix,
  });
  for (const name of bindings.unread ?? [])
    violations.push(violation("component-control-unread",
      `Control ${labelOf(elements, name)} is declared but nothing in the main reads it.`,
      at(new RegExp(`<zd-option\\b[^>]*\\sname=["']${escapeRegExp(name)}["']`)),
      `Read it in the main ({{ ${name} }}, data-zd-if, an attribute, or var(--zd-${name}) in its CSS), or remove its <zd-option>.`));
  // A layer's own declarations (its style attribute, or a rule that targets
  // only it) sit over any rule a control reaches, in every variant.
  for (const [oid, layer] of Object.entries(bindings.layers)) {
    const bound = layer.styles ?? {};
    if (!Object.keys(bound).length) continue;
    const tag = new RegExp(`<[a-z][^>]*\\sdata-oid=["']${escapeRegExp(oid)}["'][^>]*>`, "i").exec(source);
    const style = tag ? /\sstyle=(["'])([\s\S]*?)\1/i.exec(tag[0])?.[2] : undefined;
    const shadowed = [...(style ? declaredProperties(style, readsControl) : []), ...ownRuleProperties(source, oid, readsControl)]
      .filter((property) => Object.hasOwn(bound, property));
    if (!shadowed.length) continue;
    const unique = [...new Set(shadowed)].slice(0, PROPERTY_LIMIT);
    violations.push(violation("component-control-shadowed",
      `${unique.join(", ")} on this layer ${unique.length === 1 ? "sits" : "sit"} over ${controlsFor(elements, unique.flatMap((property) => bound[property]!))}.`,
      lineAt(tag?.index ?? 0),
      "Remove the layer's own value so the control sets it, or ask for a new control.", oid));
  }
  return violations;
}

function ownRuleProperties(source: string, oid: string, readsControl: (value: string) => boolean): string[] {
  const properties: string[] = [];
  for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    try {
      postcss.parse(match[1]!).walkRules((rule) => {
        const own = /^\[data-oid=(["'])([\s\S]*)\1\]$/.exec(rule.selector.trim());
        if (own?.[2] === oid) rule.walkDecls((declaration) => {
          if (!readsControl(declaration.value)) properties.push(declaration.prop.toLowerCase());
        });
      });
    } catch {
      // CSS that does not parse is reported elsewhere.
    }
  }
  return properties;
}

/** On a frame that places instances: host styles and older part overrides over a bound property. */
export function designInstanceControlViolations(input: {
  file: string;
  source: string;
  instances: Pick<DesignFrameInstances, "components" | "hosts">;
  lineAt: (offset: number) => Location;
}): DesignLintViolation[] {
  const { file, source, instances, lineAt } = input;
  const violations: DesignLintViolation[] = [];
  for (const [oid, host] of Object.entries(instances.hosts)) {
    if (!Object.hasOwn(instances.components, host.component)) continue;
    const component = instances.components[host.component]!;
    const bindings = component.bindings;
    if (!bindings) continue;
    const layers = new Map(Object.entries(bindings.layers).map(([layer, entry]) => [layer.toLowerCase(), entry.styles ?? {}]));
    const shadowed: Array<[string, readonly string[]]> = [];
    // Place and size are the host's own; anything else over the root's bindings.
    const root = bindings.root ? layers.get(bindings.root.toLowerCase()) ?? {} : {};
    for (const property of host.style ? declaredProperties(host.style) : [])
      if (!componentInstanceHostStyleAllowed(property) && Object.hasOwn(root, property)) shadowed.push([property, root[property]!]);
    for (const [part, declarations] of Object.entries(host.overrides ?? {})) {
      const bound = layers.get(part) ?? {};
      for (const property of declaredProperties(declarations))
        if (Object.hasOwn(bound, property)) shadowed.push([`${property} on ${part}`, bound[property]!]);
    }
    if (!shadowed.length) continue;
    const tag = new RegExp(`<zd-[a-z0-9-]+\\b[^>]*\\sdata-oid=["']${escapeRegExp(oid)}["']`, "i").exec(source);
    const shown = shadowed.slice(0, PROPERTY_LIMIT);
    const location = lineAt(tag?.index ?? 0);
    violations.push({
      ruleId: "component-control-shadowed",
      severity: "warning",
      message: `This instance sets ${shown.map(([property]) => property).join(", ")} over ${controlsFor(component.elements, shown.flatMap(([, controls]) => controls))}.`,
      file,
      line: location.startLine,
      column: location.startCol,
      oid,
      fix: "Remove those styles (Reset in its Controls, or delete them from style and zd-style-<part>) and set the controls instead.",
    });
  }
  return violations;
}
