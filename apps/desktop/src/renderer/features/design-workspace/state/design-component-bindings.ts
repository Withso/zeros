// PURPOSE: Which controls a layer of a component reads, from the engine's
// `bindings` on the component record (the main's own frame record, or the
// instance's frame's record for its component). One owner for every reader:
// selection inside an instance (only parts a control drives, and slots, can
// be selected), a part's Controls (only its bound rows), Size (a bound axis
// shows its control) and the cache's refusal of raw size writes. Fails
// closed: with no `bindings` (an older engine, or a record past its limits)
// no part is selectable and every control stays at the instance's level.

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

/** What a layer of a main reads, from the main's own record; null without bindings. */
export function designMainLayerControls(component: DesignFrameComponent | undefined, oid: string): string[] | null {
  const bindings = component?.bindings;
  if (!bindings) return null;
  return Object.hasOwn(bindings.layers, oid) ? designBindingControls(bindings.layers[oid]) : [];
}

/** The controls that drive the root's width and height: an instance's Size
 * shows them in place of a raw field, and nothing writes that axis raw. */
export function designRootSizeControls(bindings: DesignComponentBindings | null | undefined): { width: string[]; height: string[] } {
  const root = bindings?.root;
  const styles = root && Object.hasOwn(bindings!.layers, root) ? bindings!.layers[root]!.styles ?? {} : {};
  const read = (property: string) => Object.hasOwn(styles, property) ? [...styles[property]!] : [];
  return { width: read("width"), height: read("height") };
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
const remembered = new Map<string, BoundStyles>();
const EMPTY: BoundStyles = Object.freeze({});

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

/** The properties a layer's authored winners bind, and to which controls. */
export function designRuntimeBoundStyles(record: BindingRecord, authored: DesignRuntimeNodeDetails["authoredStyles"]): BoundStyles {
  if (!authored) return EMPTY;
  const vars = componentVarOptions(record);
  const gates = record.bindings?.gates ?? {};
  const out: Record<string, string[]> = {};
  for (const [property, winner] of Object.entries(authored)) {
    const found = new Set<string>();
    for (const match of winner.value.matchAll(RUNTIME_VAR)) for (const option of vars.get(match[1]!) ?? []) found.add(option);
    for (const match of (winner.selector ?? "").matchAll(SELECTOR_ATTRIBUTE)) {
      const name = match[1]!.toLowerCase();
      if (name !== "class" && Object.hasOwn(gates, name)) for (const option of gates[name]!) found.add(option);
    }
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
  const bound = designRuntimeBoundStyles(target.record, details.authoredStyles);
  const key = rememberedKey(workspaceId, frame.file, frame.sourceVersion, details.oid);
  if (bound === EMPTY && !remembered.has(key)) return;
  remembered.delete(key);
  remembered.set(key, bound);
  while (remembered.size > REMEMBERED_LIMIT) remembered.delete(remembered.keys().next().value!);
}

export function resetDesignRuntimeBindingsForTests(): void {
  remembered.clear();
}

/** Every property a control drives on this layer, to the controls: what the
 * engine found in the main's own markup and CSS, and what the runtime
 * reported for it at this generation. An instance host answers for its
 * root. Empty for a layer no component owns. */
export function designLayerBoundStyles(workspaceId: string, frame: BindingFrame | null | undefined, nodeId: string): BoundStyles {
  if (!frame) return EMPTY;
  const target = bindingTarget(frame, nodeId);
  if (!target) return EMPTY;
  const layers = target.record.bindings?.layers;
  const own = target.layer && layers && Object.hasOwn(layers, target.layer) ? layers[target.layer]!.styles ?? {} : {};
  const runtime = remembered.get(rememberedKey(workspaceId, frame.file, frame.sourceVersion, nodeId)) ?? EMPTY;
  if (runtime === EMPTY) return Object.keys(own).length ? own : EMPTY;
  const merged: Record<string, string[]> = {};
  for (const source of [own, runtime])
    for (const [property, controls] of Object.entries(source))
      merged[property] = [...new Set([...(merged[property] ?? []), ...controls])].sort();
  return merged;
}

/** Which of a layer's axes a control drives (an instance host's root, or a
 * main's layer), for the canvas. */
export function designBoundSizeAxes(workspaceId: string, frame: BindingFrame | null | undefined, nodeId: string): { width: boolean; height: boolean } {
  const bound = designLayerBoundStyles(workspaceId, frame, nodeId);
  return { width: Object.hasOwn(bound, "width"), height: Object.hasOwn(bound, "height") };
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
  const kept = Object.fromEntries(Object.entries(styles).filter(([property, value]) => value === null || !Object.hasOwn(bound, property)));
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
    for (const [property, value] of Object.entries(operation.styles as Record<string, unknown>))
      if (value !== null && Object.hasOwn(bound, property))
        throw new DesignControlBoundWriteError(property, designControlLabels(frame, operation.nodeId, bound[property]!));
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
