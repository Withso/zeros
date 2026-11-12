// PURPOSE: An instance's inner parts can be selected and read, never written:
// what a component offers is in its Options, and the rest is changed on the
// main component. Every node write the canvas and the Style panel make goes
// through the workspace cache, which refuses one that names a part before
// anything is sent; the engine would find no such layer either.

import type { DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { designComponentPartOf } from "@zeros/protocol/design-runtime";
import { designRuntimeLayerDisplayName } from "../design-layer-label";

export const isDesignComponentPartNodeId = (nodeId: string | null | undefined): nodeId is string =>
  typeof nodeId === "string" && designComponentPartOf(nodeId) !== null;

/** The host layer a part belongs to, or the id itself for any other layer. */
export function designComponentPartHost(nodeId: string): string {
  return designComponentPartOf(nodeId)?.host ?? nodeId;
}

export class DesignComponentPartWriteError extends Error {
  constructor() {
    super("That layer is part of a component instance. Change it with the instance's Options, or on the main component.");
    this.name = "DesignComponentPartWriteError";
  }
}

/** Throw when a write's input names a part anywhere a layer id can go. */
export function refuseDesignComponentPartWrite(input: unknown, depth = 0): void {
  if (typeof input === "string") {
    if (isDesignComponentPartNodeId(input)) throw new DesignComponentPartWriteError();
    return;
  }
  if (!input || typeof input !== "object" || depth > 3) return;
  for (const value of Array.isArray(input) ? input : Object.values(input)) refuseDesignComponentPartWrite(value, depth + 1);
}

/** An option's label as its declaration gives it, without reading the whole
 * declaration: its label, else its name as a sentence. */
function optionLabel(component: DesignFrameComponent, name: string): string {
  const element = component.elements.find((candidate) =>
    candidate.tag === "zd-option" && candidate.attributes.some((attribute) => attribute.name === "name" && attribute.value === name));
  const label = element?.attributes.find((attribute) => attribute.name === "label")?.value;
  if (label) return label;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why a layer's text cannot be typed over: it is an instance's part, or a
 * hole on the main component fills it from an option. Null when it can. */
export function designComponentTextLock(
  frame: { component?: DesignFrameComponent },
  nodeId: string,
): { kind: "part"; message: string } | { kind: "option"; message: string } | null {
  if (isDesignComponentPartNodeId(nodeId)) return { kind: "part", message: new DesignComponentPartWriteError().message };
  const options = frame.component?.boundText?.[nodeId];
  if (!options || !frame.component) return null;
  return { kind: "option", message: options.length
    ? `Set by option ${options.map((name) => optionLabel(frame.component!, name)).join(", ")}`
    : "Set by the component's template" };
}

/** A main component frame, by the same record that titles its header
 * "Component". Placing instances never makes a frame one. */
export function designFrameIsComponent(frame: { component?: DesignFrameComponent }): boolean {
  return frame.component !== undefined;
}

/** A component's name as people read it: its main frame's title, else its
 * file name as a sentence. */
export function designComponentDisplayTitle(
  name: string,
  component: { file: string; frame: boolean },
  mainTitle: (file: string) => string | undefined,
): string {
  const title = component.frame ? mainTitle(component.file) : undefined;
  if (title) return title;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The component a selected layer is an instance of, or null. Own entries
 * only: a layer id such as "constructor" is not a host. A part is not itself
 * an instance. */
export function designComponentInstanceMark(
  frame: { instances?: DesignFrameInstances },
  nodeId: string | null,
  mainTitle: (file: string) => string | undefined,
): { component: string; title: string } | null {
  const instances = frame.instances;
  if (!instances || !nodeId || !Object.hasOwn(instances.hosts, nodeId)) return null;
  const name = instances.hosts[nodeId]!.component;
  if (!Object.hasOwn(instances.components, name)) return null;
  return { component: name, title: designComponentDisplayTitle(name, instances.components[name]!, mainTitle) };
}

/** The component a selected instance names when no component has that name
 * any more (its main was deleted, renamed or registered under another name),
 * or null. Own entries only, as above. */
export function designMissingComponentOf(frame: { instances?: DesignFrameInstances }, nodeId: string | null): string | null {
  const instances = frame.instances;
  if (!instances || !nodeId || !Object.hasOwn(instances.hosts, nodeId)) return null;
  const host = instances.hosts[nodeId]!;
  return host.missing ? host.component : null;
}

/** A layer's name in Layers and in the selection path. An instance of a
 * component that is gone is named by the component it asks for: it renders
 * nothing, so the generic "Frame" would say nothing about it. A frame still
 * revalidating answers from the generation it shows. */
export function designLayerDisplayName(
  frame: object,
  node: Parameters<typeof designRuntimeLayerDisplayName>[0] & { oid: string },
): string {
  const presented = (Object.hasOwn(frame, "instances") ? frame : (frame as { previous?: object }).previous ?? frame) as { instances?: DesignFrameInstances };
  const missing = designMissingComponentOf(presented, node.oid);
  return missing ? `zd-${missing}` : designRuntimeLayerDisplayName(node);
}

const NO_MISSING: readonly string[] = Object.freeze([]);
const missingByInstances = new WeakMap<DesignFrameInstances, readonly string[]>();

/** Each component a frame's instances name that no component answers to,
 * once, in the order first placed. Shared per record for the canvas. */
export function designFrameMissingComponents(frame: { instances?: DesignFrameInstances }): readonly string[] {
  const instances = frame.instances;
  if (!instances) return NO_MISSING;
  const known = missingByInstances.get(instances);
  if (known) return known;
  const names = [...new Set(Object.values(instances.hosts).filter((host) => host.missing).map((host) => host.component))];
  const result = names.length ? Object.freeze(names) : NO_MISSING;
  missingByInstances.set(instances, result);
  return result;
}
