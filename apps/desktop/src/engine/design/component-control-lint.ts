// Warnings that keep a component's controls the only way to change it: a
// declared control nothing in the main reads; a style over a property a
// control drives (on a main's layer, an instance host's own style, or an
// older zd-style-<part> override on a bound layer); and an instance override
// no control stands for. They read the bindings the engine already computes
// for the main; all are warnings, so they never block a save.

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
      .filter((property) => controlsOver(bound, property).length > 0);
    if (!shadowed.length) continue;
    const unique = [...new Set(shadowed)].slice(0, PROPERTY_LIMIT);
    violations.push(violation("component-control-shadowed",
      `${unique.join(", ")} on this layer ${unique.length === 1 ? "sits" : "sit"} over ${controlsFor(elements, unique.flatMap((property) => controlsOver(bound, property)))}.`,
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

/** On a frame that places instances: host styles and older part overrides
 * over a bound property, and those no control stands for. */
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
    const axes = { width: controlsOver(root, "width").length > 0, height: controlsOver(root, "height").length > 0 };
    for (const property of host.style ? declaredProperties(host.style) : []) {
      if (!componentInstanceOlderOverride(property, axes)) continue;
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
    const tag = new RegExp(`<zd-[a-z0-9-]+\\b[^>]*\\sdata-oid=["']${escapeRegExp(oid)}["']`, "i").exec(source);
    const location = lineAt(tag?.index ?? 0);
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
