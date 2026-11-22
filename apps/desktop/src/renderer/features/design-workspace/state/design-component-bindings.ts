// PURPOSE: Which controls a layer of a component reads, from the engine's
// `bindings` on the component record (the main's own frame record, or the
// instance's frame's record for its component). One owner for every reader:
// selection inside an instance (only parts a control drives, and slots, can
// be selected), a part's Controls (only its bound rows), Size (a bound axis
// shows its control) and the cache's refusal of raw size writes. Fails
// closed: with no `bindings` (an older engine, or a record past its limits)
// no part is selectable and every control stays at the instance's level.

import { cssOverlappingProperties } from "@zeros/design-core/css-longhands";
import type { DesignComponentBindings, DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { designComponentPartOf, designComponentSlotOf, type DesignRuntimeNodeDetails, type DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";

type BindingLayer = DesignComponentBindings["layers"][string];
type InstancesFrame = { instances?: DesignFrameInstances };

/** A part's main layer: its id without a repeat's "#n" (case kept, unlike an override key). */
export function designBindingLayerId(part: string): string {
  return part.replace(/#[\d.]+$/, "");
}

/** The controls one binding entry reads, sorted and deduplicated. */
export function designBindingControls(entry: BindingLayer | undefined): string[] {
  if (!entry) return [];
  const names = new Set<string>([...(entry.text ?? []), ...(entry.visible ?? []), ...(entry.attributes ?? [])]);
  for (const options of Object.values(entry.styles ?? {})) for (const name of options) names.add(name);
  return [...names].sort();
}

/** The bindings of the component an instance host places, or null. */
export function designInstanceBindings(frame: InstancesFrame | null | undefined, host: string): DesignComponentBindings | null {
  const instances = frame?.instances;
  if (!instances || !Object.hasOwn(instances.hosts, host)) return null;
  const component = instances.hosts[host]!.component;
  if (!Object.hasOwn(instances.components, component)) return null;
  return instances.components[component]!.bindings ?? null;
}

/** What a part of an instance reads: null when the part's component has no
 * bindings (fail closed), an empty list when it reads nothing. */
export function designPartControls(frame: InstancesFrame | null | undefined, nodeId: string): string[] | null {
  const part = designComponentPartOf(nodeId);
  if (!part) return null;
  const bindings = designInstanceBindings(frame, part.host);
  if (!bindings) return null;
  const layer = designBindingLayerId(part.part);
  return Object.hasOwn(bindings.layers, layer) ? designBindingControls(bindings.layers[layer]) : [];
}

/** A layer inside an instance a person can select: a slot, or a part at
 * least one control drives. */
export function designPartSelectable(frame: InstancesFrame | null | undefined, nodeId: string): boolean {
  if (designComponentSlotOf(nodeId)) return true;
  return (designPartControls(frame, nodeId)?.length ?? 0) > 0;
}

const selectableByInstances = new WeakMap<DesignFrameInstances, Map<string, readonly string[] | null>>();

/** The main layer ids of a host's selectable parts, for the runtime's hit
 * test; null without bindings. Stable per record. */
export function designSelectablePartLayers(frame: InstancesFrame | null | undefined, host: string): readonly string[] | null {
  const instances = frame?.instances;
  if (!instances) return null;
  let byHost = selectableByInstances.get(instances);
  if (!byHost) selectableByInstances.set(instances, byHost = new Map());
  if (byHost.has(host)) return byHost.get(host)!;
  const bindings = designInstanceBindings(frame, host);
  const layers = bindings
    ? Object.freeze(Object.entries(bindings.layers).filter(([, entry]) => designBindingControls(entry).length > 0).map(([layer]) => layer).sort())
    : null;
  byHost.set(host, layers);
  return layers;
}

/** The controls above a main layer's Style: those that set its text, whether
 * it shows, or its attributes; null without bindings. A control its style
 * reads takes that field's place instead, so none shows twice. */
export function designMainLayerControls(component: DesignFrameComponent | undefined, oid: string): string[] | null {
  const bindings = component?.bindings;
  if (!bindings) return null;
  if (!Object.hasOwn(bindings.layers, oid)) return [];
  const { styles: _styles, ...rest } = bindings.layers[oid]!;
  return designBindingControls(rest);
}

/** The controls a property-keyed record gives a written property, by the
 * longhands each sets: bindings keep properties as authored (`gap`), and the
 * panel writes longhands (`row-gap`), or the reverse. */
export function designBoundControlsFor(bound: Readonly<Record<string, readonly string[]>>, property: string): string[] {
  const keys = cssOverlappingProperties(bound, property);
  return keys.length ? [...new Set(keys.flatMap((key) => bound[key]!))].sort() : [];
}

/** Size's controls per axis, each shown once: height lists only those width
 * does not, and `heightShared` says H is taken by a control W shows. */
export function designSizeAxisControls(axes: { width: readonly string[]; height: readonly string[] }): { width: string[]; height: string[]; heightShared: boolean } {
  const height = axes.height.filter((name) => !axes.width.includes(name));
  return { width: [...axes.width], height, heightShared: axes.height.length > 0 && height.length === 0 };
}

/** The controls that drive the root's width and height: an instance's Size
 * shows them in place of a raw field, and nothing writes that axis raw. */
export function designRootSizeControls(bindings: DesignComponentBindings | null | undefined): { width: string[]; height: string[] } {
  const root = bindings?.root;
  const styles = root && Object.hasOwn(bindings!.layers, root) ? bindings!.layers[root]!.styles ?? {} : {};
  return { width: designBoundControlsFor(styles, "width"), height: designBoundControlsFor(styles, "height") };
}

const treesByNodes = new WeakMap<readonly DesignRuntimeTreeNode[], WeakMap<DesignFrameInstances, readonly DesignRuntimeTreeNode[]>>();

/** The layer tree people navigate: a part no control drives has no row of
 * its own, and the parts and slots under it move up to its place. Layers,
 * keyboard travel and hover targets all read this one tree. The same nodes
 * come back when nothing is hidden, and a result is reused per tree and
 * record, so selectors stay stable. */
export function designSelectableLayerTree(
  nodes: readonly DesignRuntimeTreeNode[],
  frame: InstancesFrame | null | undefined,
): readonly DesignRuntimeTreeNode[] {
  const instances = frame?.instances;
  if (!instances || !Object.keys(instances.hosts).length) return nodes;
  let byInstances = treesByNodes.get(nodes);
  const cached = byInstances?.get(instances);
  if (cached) return cached;
  const filter = (list: readonly DesignRuntimeTreeNode[]): readonly DesignRuntimeTreeNode[] => {
    let changed = false;
    const out: DesignRuntimeTreeNode[] = [];
    for (const node of list) {
      const children = filter(node.children);
      if (designComponentPartOf(node.oid) && !designPartSelectable(frame, node.oid)) {
        changed = true;
        out.push(...children);
      } else if (children !== node.children) {
        changed = true;
        out.push({ ...node, children: children as DesignRuntimeTreeNode[] });
      } else out.push(node);
    }
    return changed ? out : list;
  };
  const result = filter(nodes);
  if (!byInstances) treesByNodes.set(nodes, byInstances = new WeakMap());
  byInstances.set(instances, result);
  return result;
}

// Runtime completion. The engine binds only what a main's own markup and CSS
// show; a winner from a linked stylesheet (`.btn { border-radius:
// var(--btn-radius) }` in ui.css, `.btn[data-size="sm"] { height: 30px }`)
// is bound once the runtime reports it for a selected layer: its value reads
// a control's custom property or one in `bindings.vars`, or its selector
// tests an attribute in `bindings.gates`. Remembered per generation and node
// so the cache can refuse with the same answer; bounded.

type BindingRecord = { elements: DesignFrameComponent["elements"]; bindings?: DesignComponentBindings };
type BoundStyles = Readonly<Record<string, readonly string[]>>;
const RUNTIME_VAR = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const SELECTOR_ATTRIBUTE = /\[\s*([^\s~|^$*=\]]+)/g;
const REMEMBERED_LIMIT = 512;
/** Per key, what the winners bind, and the same without bindings only a
 * truncated record's guess makes (`assumedVars`). */
const remembered = new Map<string, { all: BoundStyles; confirmed: BoundStyles }>();
/** What rules gated on a control's attribute or class would set, whatever
 * the value now (getGatedStyles), per the same key; bounded alike. */
const rememberedGated = new Map<string, BoundStyles>();
const EMPTY: BoundStyles = Object.freeze({});
const listeners = new Set<() => void>();
let rememberedVersion = 0;

/** Changes when a gated read lands, so a panel showing that layer re-reads it. */
export function subscribeDesignRuntimeBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function designRuntimeBindingsVersion(): number {
  return rememberedVersion;
}

/** Which options each of a component's own custom properties carries. */
const varsByRecord = new WeakMap<object, ReadonlyMap<string, readonly string[]>>();
function componentVarOptions(record: BindingRecord): ReadonlyMap<string, readonly string[]> {
  const cached = varsByRecord.get(record);
  if (cached) return cached;
  const vars = new Map<string, readonly string[]>();
  const attribute = (element: BindingRecord["elements"][number], name: string) => element.attributes.find((entry) => entry.name === name)?.value;
  const options = new Set<string>();
  for (const element of record.elements) {
    const name = attribute(element, "name");
    if (!name || element.tag !== "zd-option") continue;
    options.add(name);
    if (attribute(element, "type") === "easing") {
      vars.set(`--zd-${name}-easing`, [name]);
      vars.set(`--zd-${name}-duration`, [name]);
    } else vars.set(`--zd-${name}`, [name]);
  }
  // A derived value carries what its expression reads: the names in it that
  // are options or earlier derived values.
  for (const element of record.elements) {
    const name = attribute(element, "name");
    const value = attribute(element, "value");
    if (!name || !value || element.tag !== "zd-derive") continue;
    const reads = new Set<string>();
    for (const word of value.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? []) {
      if (options.has(word)) reads.add(word);
      for (const option of vars.get(`--zd-${word}`) ?? []) if (!options.has(word)) reads.add(option);
    }
    if (reads.size) vars.set(`--zd-${name}`, [...reads].sort());
  }
  for (const [name, read] of Object.entries(record.bindings?.vars ?? {})) vars.set(name, read);
  varsByRecord.set(record, vars);
  return vars;
}

/** A selector list's top-level arms, outside brackets, parentheses and quotes. */
function selectorArms(selector: string): string[] {
  const arms: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "\\") { index += 1; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) { arms.push(selector.slice(start, index)); start = index + 1; }
  }
  arms.push(selector.slice(start));
  return arms.map((arm) => arm.trim()).filter(Boolean);
}

/** The options a winner's selector gates on. The winner does not say which
 * arm of a list matched, so a list binds only when every arm tests a gate;
 * getGatedStyles answers per arm for the rest. */
function selectorGateOptions(selector: string, gates: Readonly<Record<string, readonly string[]>>): Set<string> {
  const found = new Set<string>();
  for (const arm of selectorArms(selector)) {
    const options = new Set<string>();
    for (const match of arm.matchAll(SELECTOR_ATTRIBUTE)) {
      const name = match[1]!.toLowerCase();
      if (name !== "class" && Object.hasOwn(gates, name)) for (const option of gates[name]!) options.add(option);
    }
    if (!options.size) return new Set();
    for (const option of options) found.add(option);
  }
  return found;
}

/** The properties a layer's authored winners bind, and to which controls;
 * `assumed: false` leaves out what only a truncated record's guess binds. */
export function designRuntimeBoundStyles(record: BindingRecord, authored: DesignRuntimeNodeDetails["authoredStyles"], { assumed = true } = {}): BoundStyles {
  if (!authored) return EMPTY;
  const confirmed = componentVarOptions(record);
  const guessed = assumed ? record.bindings?.assumedVars : undefined;
  const vars = guessed ? new Map([...confirmed, ...Object.entries(guessed)]) : confirmed;
  const gates = record.bindings?.gates ?? {};
  const out: Record<string, string[]> = {};
  for (const [property, winner] of Object.entries(authored)) {
    const found = new Set<string>();
    for (const match of winner.value.matchAll(RUNTIME_VAR)) for (const option of vars.get(match[1]!) ?? []) found.add(option);
    for (const option of selectorGateOptions(winner.selector ?? "", gates)) found.add(option);
    if (found.size) out[property] = [...found].sort();
  }
  return Object.keys(out).length ? out : EMPTY;
}

const rememberedKey = (workspaceId: string, file: string, sourceVersion: string, nodeId: string) =>
  `${workspaceId}\u0000${file}\u0000${sourceVersion}\u0000${nodeId}`;

/** The component record a layer's styles are bound by: an instance host's
 * component (its root), or the main's own record for one of its layers. */
function bindingTarget(frame: InstancesFrame & { component?: DesignFrameComponent }, nodeId: string): { record: BindingRecord; layer: string | undefined } | null {
  const instances = frame.instances;
  if (instances && Object.hasOwn(instances.hosts, nodeId)) {
    const component = instances.hosts[nodeId]!.component;
    if (!Object.hasOwn(instances.components, component)) return null;
    const record = instances.components[component]!;
    return { record, layer: record.bindings?.root };
  }
  if (frame.component && !designComponentPartOf(nodeId) && !designComponentSlotOf(nodeId)) return { record: frame.component, layer: nodeId };
  return null;
}

type BindingFrame = InstancesFrame & { component?: DesignFrameComponent; file: string; sourceVersion: string };

/** Note what a selected layer's runtime details bind. Idempotent; called
 * wherever those details arrive. */
export function rememberDesignRuntimeBindings(workspaceId: string, frame: BindingFrame, details: DesignRuntimeNodeDetails | null | undefined): void {
  if (!details || details.sourceVersion !== frame.sourceVersion) return;
  const target = bindingTarget(frame, details.oid);
  if (!target) return;
  const all = designRuntimeBoundStyles(target.record, details.authoredStyles);
  const confirmed = target.record.bindings?.assumedVars ? designRuntimeBoundStyles(target.record, details.authoredStyles, { assumed: false }) : all;
  const key = rememberedKey(workspaceId, frame.file, frame.sourceVersion, details.oid);
  remembered.delete(key);
  remembered.set(key, { all, confirmed });
  while (remembered.size > REMEMBERED_LIMIT) remembered.delete(remembered.keys().next().value!);
}

/** The gates a record's controls fill, as the runtime takes them; null when none. */
function gatesOf(record: BindingRecord): { attributes: string[]; classPrefixes: string[] } | null {
  const attributes = Object.keys(record.bindings?.gates ?? {}).filter((name) => name !== "class");
  const classPrefixes = Object.keys(record.bindings?.classGates ?? {});
  return attributes.length || classPrefixes.length ? { attributes, classPrefixes } : null;
}

type GatedReader = {
  /** The document generation it reads. */
  readonly sourceVersion: string;
  supports(method: string): boolean;
  getGatedStyles?(nodeId: string, gates: { attributes: readonly string[]; classPrefixes: readonly string[] }): Promise<Record<string, string[]>>;
};

/** Whether a layer's component has gates this generation has not read
 * there yet: the one check before a panel asks the runtime. */
export function designGatedReadPending(workspaceId: string, frame: BindingFrame, nodeId: string): boolean {
  const target = bindingTarget(frame, nodeId);
  return !!target && !!gatesOf(target.record) && !rememberedGated.has(rememberedKey(workspaceId, frame.file, frame.sourceVersion, nodeId));
}

/** Read once per layer and generation what the rules gated on its
 * component's controls would set there at some value: at a value no gated
 * rule matches (a Button at its default size) the winners name nothing. An
 * older runtime has no such read, and the winners alone decide. */
export async function readDesignGatedBindings(workspaceId: string, frame: BindingFrame, nodeId: string, runtime: GatedReader | null | undefined): Promise<void> {
  const target = bindingTarget(frame, nodeId);
  const gates = target && gatesOf(target.record);
  const key = rememberedKey(workspaceId, frame.file, frame.sourceVersion, nodeId);
  if (!target || !gates || rememberedGated.has(key) || !runtime?.supports("getGatedStyles") || !runtime.getGatedStyles) return;
  // Only this generation's document answers for this generation's key,
  // when asked and when it replies.
  if (runtime.sourceVersion !== frame.sourceVersion) return;
  const gated = await runtime.getGatedStyles(nodeId, gates).catch(() => null);
  if (!gated || runtime.sourceVersion !== frame.sourceVersion) return;
  const options: Record<string, string[]> = {};
  const gateOptions = target.record.bindings?.gates ?? {};
  const classOptions = target.record.bindings?.classGates ?? {};
  for (const [property, keys] of Object.entries(gated)) {
    const found = new Set<string>();
    for (const gate of keys) {
      const record = gate.startsWith(".") ? classOptions : gateOptions;
      const name = gate.startsWith(".") ? gate.slice(1) : gate;
      if (Object.hasOwn(record, name)) for (const option of record[name]!) found.add(option);
    }
    if (found.size) options[property] = [...found].sort();
  }
  rememberedGated.delete(key);
  rememberedGated.set(key, Object.keys(options).length ? options : EMPTY);
  while (rememberedGated.size > REMEMBERED_LIMIT) rememberedGated.delete(rememberedGated.keys().next().value!);
  rememberedVersion += 1;
  for (const listener of [...listeners]) listener();
}

/** Untracked targets one write reads; past this the static bindings decide
 * for the rest, so a large selection costs a bounded number of reads. */
export const DESIGN_BOUND_COMPLETION_LIMIT = 32;

/** Before the fence decides on a write, read the runtime winners of each
 * target this generation has not reported (a child a parent's layout action
 * moves, a multi-select's other layers): once each, in parallel, and only
 * where a component owns the layer. A failed read leaves the static half. */
export async function completeDesignRuntimeBindings(
  workspaceId: string,
  frame: BindingFrame,
  write: readonly unknown[] | { nodeId: string; styles: Readonly<Record<string, string | null>> },
  read: (nodeId: string) => Promise<DesignRuntimeNodeDetails | null>,
  runtime?: GatedReader | null,
): Promise<void> {
  const targets = new Set<string>();
  const gated = new Set<string>();
  for (const entry of Array.isArray(write) ? write : [write]) {
    const operation = entry as { type?: unknown; nodeId?: unknown; styles?: unknown };
    if (Array.isArray(write) && operation.type !== "node.set-styles") continue;
    if (typeof operation.nodeId !== "string" || !operation.styles || typeof operation.styles !== "object") continue;
    if (!Object.values(operation.styles as Record<string, unknown>).some((value) => value !== null)) continue;
    const key = rememberedKey(workspaceId, frame.file, frame.sourceVersion, operation.nodeId);
    const target = bindingTarget(frame, operation.nodeId);
    if (!target) continue;
    if (!remembered.has(key)) targets.add(operation.nodeId);
    if (runtime && gatesOf(target.record) && !rememberedGated.has(key)) gated.add(operation.nodeId);
    if (new Set([...targets, ...gated]).size >= DESIGN_BOUND_COMPLETION_LIMIT) break;
  }
  if (!targets.size && !gated.size) return;
  const [details] = await Promise.all([
    Promise.all([...targets].map((nodeId) => read(nodeId).catch(() => null))),
    Promise.all([...gated].map((nodeId) => readDesignGatedBindings(workspaceId, frame, nodeId, runtime))),
  ]);
  for (const entry of details) rememberDesignRuntimeBindings(workspaceId, frame, entry);
}

export function resetDesignRuntimeBindingsForTests(): void {
  remembered.clear();
  rememberedGated.clear();
}

/** Every property a control drives on this layer, to the controls: what the
 * engine found in the main's own markup and CSS, and what the runtime
 * reported for it at this generation. An instance host answers for its
 * root. Empty for a layer no component owns. A fence takes everything,
 * including what a truncated record only guesses; `confirmed` leaves that
 * guess out, for anything destructive (older overrides and their Reset). */
export function designLayerBoundStyles(workspaceId: string, frame: BindingFrame | null | undefined, nodeId: string, { confirmed = false } = {}): BoundStyles {
  if (!frame) return EMPTY;
  const target = bindingTarget(frame, nodeId);
  if (!target) return EMPTY;
  const layers = target.record.bindings?.layers;
  const entry = target.layer && layers && Object.hasOwn(layers, target.layer) ? layers[target.layer]! : undefined;
  const ownStyles = entry?.styles ?? {};
  const own = !confirmed && entry?.assumed ? mergeBound([ownStyles, entry.assumed]) : ownStyles;
  const key = rememberedKey(workspaceId, frame.file, frame.sourceVersion, nodeId);
  const winners = remembered.get(key);
  const runtime = (confirmed ? winners?.confirmed : winners?.all) ?? EMPTY;
  const gated = rememberedGated.get(key) ?? EMPTY;
  if (runtime === EMPTY && gated === EMPTY) return Object.keys(own).length ? own : EMPTY;
  return mergeBound([own, runtime, gated]);
}

function mergeBound(sources: readonly BoundStyles[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources)
    for (const [property, controls] of Object.entries(source))
      merged[property] = [...new Set([...(merged[property] ?? []), ...controls])].sort();
  return merged;
}

/** Which of a layer's axes a control drives (an instance host's root, or a
 * main's layer), for the canvas. */
export function designBoundSizeAxes(workspaceId: string, frame: BindingFrame | null | undefined, nodeId: string): { width: boolean; height: boolean } {
  const bound = designLayerBoundStyles(workspaceId, frame, nodeId);
  return { width: designBoundControlsFor(bound, "width").length > 0, height: designBoundControlsFor(bound, "height").length > 0 };
}

/** The layers a Size mode change (Fill, Hug, Fixed, relative) on one axis
 * may touch: one whose axis a control drives is left out whole, its flex
 * sizing, alignment and any parent change made for it included, since each
 * would sit over the control as a sizing input. */
export function designSizingTargets<T extends { oid: string }>(workspaceId: string, frame: BindingFrame | null | undefined, nodes: readonly T[], axis: "x" | "y"): T[] {
  return nodes.filter((node) => !designBoundSizeAxes(workspaceId, frame, node.oid)[axis === "x" ? "width" : "height"]);
}

/** A layout action's styles for one layer, without what a control drives:
 * moving a layer among its siblings must not freeze those values raw over
 * the control. Null when nothing is left to write. */
export function designWithoutBoundStyles(
  workspaceId: string,
  frame: BindingFrame | null | undefined,
  nodeId: string,
  styles: Readonly<Record<string, string | null>>,
): Record<string, string | null> | null {
  const bound = designLayerBoundStyles(workspaceId, frame, nodeId);
  const kept = Object.fromEntries(Object.entries(styles).filter(([property, value]) => value === null || !designBoundControlsFor(bound, property).length));
  return Object.keys(kept).length ? kept : null;
}

/** A keyboard resize's styles: each axis a control drives is left out. */
export function designKeyboardResizeStyles(workspaceId: string, gesture: { frame: BindingFrame; nodeId: string; width: number; height: number; dw: number; dh: number }): Record<string, string> {
  const bound = designBoundSizeAxes(workspaceId, gesture.frame, gesture.nodeId);
  return {
    ...(bound.width ? {} : { width: `${Math.max(1, Math.round(gesture.width + gesture.dw))}px` }),
    ...(bound.height ? {} : { height: `${Math.max(1, Math.round(gesture.height + gesture.dh))}px` }),
  };
}

/** People read controls by their labels. */
export function designControlLabels(frame: BindingFrame, nodeId: string, names: readonly string[]): string[] {
  const target = bindingTarget(frame, nodeId);
  return names.map((name) => {
    const element = target?.record.elements.find((candidate) => candidate.tag === "zd-option" &&
      candidate.attributes.some((attribute) => attribute.name === "name" && attribute.value === name));
    const label = element?.attributes.find((attribute) => attribute.name === "label")?.value;
    return label || name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");
  });
}

export class DesignControlBoundWriteError extends Error {
  constructor(readonly property: string, readonly controls: readonly string[]) {
    super(`${property.charAt(0).toUpperCase()}${property.slice(1)} is set by the ${controls.join(", ")} control. Change it there.`);
    this.name = "DesignControlBoundWriteError";
  }
}

/** Throw when a style write sets a property a control drives on that layer
 * (an instance's root size, or anything bound on a main's layer, in any
 * state): a raw value would sit over the control in every variant. Removing
 * a value stays allowed. */
export function refuseDesignBoundStyleWrite(
  workspaceId: string,
  frame: BindingFrame | null | undefined,
  write: { nodeId: string; styles: Readonly<Record<string, string | null>> } | readonly unknown[],
): void {
  if (!frame) return;
  for (const entry of Array.isArray(write) ? write : [write]) {
    const operation = entry as { type?: unknown; nodeId?: unknown; styles?: unknown };
    if (Array.isArray(write) && operation.type !== "node.set-styles") continue;
    if (typeof operation.nodeId !== "string" || !operation.styles || typeof operation.styles !== "object") continue;
    const bound = designLayerBoundStyles(workspaceId, frame, operation.nodeId);
    for (const [property, value] of Object.entries(operation.styles as Record<string, unknown>)) {
      if (value === null) continue;
      const controls = designBoundControlsFor(bound, property);
      if (controls.length) throw new DesignControlBoundWriteError(property, designControlLabels(frame, operation.nodeId, controls));
    }
  }
}

/** The controls (by label) that drive anything in these layers of a main or
 * the layers inside them: deleting them leaves those controls setting
 * nothing there, so a person is asked first. Empty outside a main. */
export function designDeleteBoundControls(
  workspaceId: string,
  frame: BindingFrame | null | undefined,
  tree: readonly DesignRuntimeTreeNode[],
  nodeIds: readonly string[],
): string[] {
  const layers = frame?.component?.bindings?.layers;
  if (!frame?.component || !nodeIds.length) return [];
  const ids = new Set(nodeIds);
  const visit = (node: DesignRuntimeTreeNode, inside: boolean) => {
    const within = inside || ids.has(node.oid);
    if (within) ids.add(node.oid);
    for (const child of node.children) visit(child, within);
  };
  for (const node of tree) visit(node, false);
  const names = new Set<string>();
  for (const oid of ids) {
    if (designComponentPartOf(oid) || designComponentSlotOf(oid)) continue;
    if (layers && Object.hasOwn(layers, oid)) for (const name of designBindingControls(layers[oid])) names.add(name);
    for (const controls of Object.values(designLayerBoundStyles(workspaceId, frame, oid))) for (const name of controls) names.add(name);
  }
  return [...new Set(designControlLabels(frame, nodeIds[0]!, [...names].sort()))];
}
