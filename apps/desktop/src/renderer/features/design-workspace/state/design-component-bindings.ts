// PURPOSE: Which controls a layer of a component reads, from the engine's
// `bindings` on the component record (the main's own frame record, or the
// instance's frame's record for its component). One owner for every reader:
// selection inside an instance (only parts a control drives, and slots, can
// be selected), a part's Controls (only its bound rows), Size (a bound axis
// shows its control) and the cache's refusal of raw size writes. Fails
// closed: with no `bindings` (an older engine, or a record past its limits)
// no part is selectable and every control stays at the instance's level.

import type { DesignComponentBindings, DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { designComponentPartOf, designComponentSlotOf, type DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";

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

/** Which of an instance host's axes a control drives, for the canvas. */
export function designBoundSizeAxes(frame: InstancesFrame | null | undefined, host: string): { width: boolean; height: boolean } {
  const bound = designRootSizeControls(designInstanceBindings(frame, host));
  return { width: bound.width.length > 0, height: bound.height.length > 0 };
}

/** A layout action's styles for one layer, without the size an instance's
 * control drives: moving the instance among its siblings must not freeze
 * that size raw over the control. Null when nothing is left to write. */
export function designWithoutBoundSize(
  frame: InstancesFrame | null | undefined,
  nodeId: string,
  styles: Readonly<Record<string, string | null>>,
): Record<string, string | null> | null {
  const bound = designBoundSizeAxes(frame, nodeId);
  if (!bound.width && !bound.height) return { ...styles };
  const kept = Object.fromEntries(Object.entries(styles).filter(([property, value]) =>
    value === null || !((property === "width" && bound.width) || (property === "height" && bound.height))));
  return Object.keys(kept).length ? kept : null;
}
