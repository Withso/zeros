// PURPOSE: An instance is changed from outside only through its Controls
// (host attributes), its size and place, and its slots. Its inner parts can be
// selected and hidden on the canvas (the Layers eye), but nothing writes to
// them: their layers, structure, text and styles belong to the main component.
// A frame the main marks as a slot takes layers instead: one moved or drawn
// into it lands in the instance with slot="<name>". Every node write the
// canvas and the inspector make goes through the workspace cache, which
// refuses a write that names a part or slot, or that styles an instance host
// beyond its size and place, before anything is sent.

import type { DesignComponentIdentity, DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { componentInstanceHostStyleAllowed } from "@zeros/design-core/component-options";
import { designComponentPartOf, designComponentSlotOf } from "@zeros/protocol/design-runtime";
import { designRuntimeLayerDisplayName } from "../design-layer-label";

/** A layer inside an instance: one of its parts, or one of its slots, which
 * are parts too except that layers can be put in them. Neither moves,
 * resizes, duplicates or deletes. */
export const isDesignComponentPartNodeId = (nodeId: string | null | undefined): nodeId is string =>
  typeof nodeId === "string" && (designComponentPartOf(nodeId) !== null || designComponentSlotOf(nodeId) !== null);

export const isDesignComponentSlotNodeId = (nodeId: unknown): nodeId is string =>
  typeof nodeId === "string" && designComponentSlotOf(nodeId) !== null;

/** The host layer a part or slot belongs to, or the id itself for any other layer. */
export function designComponentPartHost(nodeId: string): string {
  return designComponentPartOf(nodeId)?.host ?? designComponentSlotOf(nodeId)?.host ?? nodeId;
}

/** A slot's name as people read it: "Content", or "Content" for the default slot. */
export function designComponentSlotLabel(name: string): string {
  const words = (name || "content").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class DesignComponentPartWriteError extends Error {
  constructor() {
    super("That layer is part of a component instance. Change it with the instance's Controls, or on the main component.");
    this.name = "DesignComponentPartWriteError";
  }
}

export class DesignInstanceHostStyleError extends Error {
  constructor(readonly properties: readonly string[]) {
    super(`Make component instance changes through its Controls. Here you can change its size and place, not ${properties.slice(0, 3).join(", ")}.`);
    this.name = "DesignInstanceHostStyleError";
  }
}

/** Whether the canvas's style tools (padding and gap handles with their
 * entry, the motion timeline) stay away from a selection: any of it is an
 * instance host, which takes only size and place, or a part or slot, which
 * take nothing. Their writes would be refused, so they are not offered. */
export function designCanvasStyleToolsBlocked(
  frame: { instances?: DesignFrameInstances } | null | undefined,
  nodeIds: readonly (string | null | undefined)[],
): boolean {
  const hosts = frame?.instances?.hosts;
  return nodeIds.some((nodeId) => isDesignComponentPartNodeId(nodeId) || (!!nodeId && !!hosts && Object.hasOwn(hosts, nodeId)));
}

/** Throw when a style write sets a property outside the host allowlist on
 * one of the frame's instance hosts (own entries only, so a layer id such as
 * "constructor" is not a host). Accepts one write's styles by node, or a
 * transaction's operations. */
export function refuseDesignInstanceHostStyleWrite(
  hosts: DesignFrameInstances["hosts"] | undefined,
  write: { nodeId: string; styles: Readonly<Record<string, string | null>> } | readonly unknown[],
): void {
  if (!hosts) return;
  const writes = Array.isArray(write) ? write : [write];
  for (const entry of writes) {
    const operation = entry as { type?: unknown; nodeId?: unknown; styles?: unknown; attribute?: unknown; value?: unknown };
    // A part override is a style too: the app only removes older ones.
    if (Array.isArray(write) && operation.type === "node.set-attribute" && typeof operation.nodeId === "string" &&
      Object.hasOwn(hosts, operation.nodeId) && typeof operation.attribute === "string" &&
      operation.attribute.toLowerCase().startsWith("zd-style-") && operation.value !== null)
      throw new DesignInstanceHostStyleError([operation.attribute]);
    if (Array.isArray(write) && operation.type !== "node.set-styles") continue;
    if (typeof operation.nodeId !== "string" || !Object.hasOwn(hosts, operation.nodeId)) continue;
    if (!operation.styles || typeof operation.styles !== "object") continue;
    const refused = Object.entries(operation.styles as Record<string, unknown>)
      .filter(([property, value]) => value !== null && !componentInstanceHostStyleAllowed(property))
      .map(([property]) => property);
    if (refused.length) throw new DesignInstanceHostStyleError(refused);
  }
}

/** The key an instance's record gives a part's override, and the host
 * attribute that holds it: shared by a part's repeated copies ("chip#1"),
 * lowercased as HTML names attributes. */
export function designPartOverrideKey(part: string): string {
  return part.replace(/#\d+$/, "").toLowerCase();
}
export const designPartOverrideAttribute = (part: string) => `zd-style-${designPartOverrideKey(part)}`;

/** Throw when a write's input names a part or slot anywhere a layer id can
 * go, except a slot as the parent a layer moves into or the layer drawn
 * layers are added to, and direct text on the default slot. The engine still
 * applies a part's style write as the instance's override for older callers;
 * the app no longer makes one. */
export function refuseDesignComponentPartWrite(input: unknown, depth = 0): void {
  if (typeof input === "string") {
    if (isDesignComponentPartNodeId(input)) throw new DesignComponentPartWriteError();
    return;
  }
  if (!input || typeof input !== "object" || depth > 3) return;
  const operation = input as { type?: unknown; nodeId?: unknown; mode?: unknown };
  const appendsToSlot = operation.type === "node.set-html" && operation.mode === "append" && isDesignComponentSlotNodeId(operation.nodeId);
  const setsDefaultSlotText = operation.type === "node.set-text" && typeof operation.nodeId === "string" &&
    designComponentSlotOf(operation.nodeId)?.name === "";
  const entries: Array<[string | number, unknown]> = Array.isArray(input) ? [...input.entries()] : Object.entries(input);
  for (const [key, value] of entries) {
    if ((key === "parentId" || (key === "nodeId" && (appendsToSlot || setsDefaultSlotText))) && isDesignComponentSlotNodeId(value)) continue;
    refuseDesignComponentPartWrite(value, depth + 1);
  }
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
    ? `Set by control ${options.map((name) => optionLabel(frame.component!, name)).join(", ")}`
    : "Set by the component's template" };
}

/** A main component frame, by the same record that titles its header
 * "Component". Placing instances never makes a frame one. */
export function designFrameIsComponent(frame: { component?: DesignFrameComponent }): boolean {
  return frame.component !== undefined;
}

export type DesignFrameComponentPresentation = {
  kind: "main" | "instance";
  label: string;
  rootNodeId: string | null;
};

/** The prepared identity is authoritative when present. An omitted identity
 * is an older engine response: only its existing declaration may identify a
 * main; it must not infer an instance from a runtime or a sole host. */
export function designFrameComponentPresentation(
  frame: {
    title: string;
    component?: DesignFrameComponent;
    componentIdentity?: DesignComponentIdentity | null;
    instances?: DesignFrameInstances;
  },
  mainTitle: (file: string) => string | undefined = () => undefined,
): DesignFrameComponentPresentation | null {
  const identity = frame.componentIdentity;
  if (identity === null) return null;
  if (identity?.kind === "main") return { kind: "main", label: frame.title, rootNodeId: null };
  if (identity?.kind === "instance") {
    const host = frame.instances && Object.hasOwn(frame.instances.hosts, identity.nodeId)
      ? frame.instances.hosts[identity.nodeId]
      : undefined;
    const component = host && frame.instances && Object.hasOwn(frame.instances.components, host.component)
      ? frame.instances.components[host.component]
      : undefined;
    if (!host || !component) return null;
    return {
      kind: "instance",
      label: designComponentInstanceIdentity(frame, identity.nodeId, mainTitle) ?? frame.title,
      rootNodeId: identity.nodeId,
    };
  }
  return frame.component ? { kind: "main", label: frame.title, rootNodeId: null } : null;
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

/** A component's identity stays explicit even when its layer has a nickname. */
export function designComponentIdentityLabel(title: string, variant: string | null): string {
  const label = variant
    ? variant.replace(/-/g, " ").replace(/^./, (first) => first.toUpperCase())
    : "Default";
  return `${title}/${label}`;
}

export function designComponentSelectionIdentity(
  singleSelection: boolean,
  mainRoot: boolean,
  mainIdentity: string | null,
  instanceIdentity: string | null,
): string | null {
  if (!singleSelection) return null;
  return mainRoot ? mainIdentity : instanceIdentity;
}

export function designComponentInstanceVariant(
  frame: { instances?: DesignFrameInstances },
  nodeId: string | null,
): string | null {
  const mark = designComponentInstanceMark(frame, nodeId, () => undefined);
  const instances = frame.instances;
  if (!mark || !instances || !nodeId) return null;
  const variant = instances.hosts[nodeId]!.attributes["zd-variant"];
  return variant && instances.components[mark.component]!.elements.some((element) =>
    element.tag === "zd-variant" && element.attributes.some((attribute) => attribute.name === "name" && attribute.value === variant))
    ? variant
    : null;
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

/** A placed instance's current declared option preset, or Default when its
 * saved attribute no longer names a declared variant. */
export function designComponentInstanceIdentity(
  frame: { instances?: DesignFrameInstances },
  nodeId: string | null,
  mainTitle: (file: string) => string | undefined = () => undefined,
): string | null {
  const mark = designComponentInstanceMark(frame, nodeId, mainTitle);
  return mark ? designComponentIdentityLabel(mark.title, designComponentInstanceVariant(frame, nodeId)) : null;
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

/** The frame a layer row reads instances from: a frame still revalidating
 * answers from the generation it shows. */
const presentedInstances = (frame: object) =>
  ((Object.hasOwn(frame, "instances") ? frame : (frame as { previous?: object }).previous ?? frame) as { instances?: DesignFrameInstances });

/** A layer's name in Layers and in the selection path. An instance is named
 * by its component unless a person named the layer; one whose component is
 * gone is named by the component it asks for, as it renders nothing and the
 * generic "Frame" would say nothing about it. */
export function designLayerDisplayName(
  frame: object,
  node: Parameters<typeof designRuntimeLayerDisplayName>[0] & { oid: string },
  mainTitle: (file: string) => string | undefined = () => undefined,
): string {
  const slot = designComponentSlotOf(node.oid);
  const presented = presentedInstances(frame);
  if (slot) {
    const owner = designComponentInstanceIdentity(presented, slot.host, mainTitle);
    const name = `${designComponentSlotLabel(slot.name)} slot`;
    return owner ? `${owner} · ${name}` : name;
  }
  const missing = designMissingComponentOf(presented, node.oid);
  if (missing) return `zd-${missing}`;
  if (isDesignComponentPartNodeId(node.oid)) {
    const owner = designComponentInstanceIdentity(presented, designComponentPartHost(node.oid), mainTitle);
    const name = designRuntimeLayerDisplayName(node);
    return owner ? `${owner} · ${name}` : name;
  }
  const instance = designComponentInstanceIdentity(presented, node.oid, mainTitle);
  const name = node.layerName?.trim();
  return instance ? name ? `${instance} · ${name}` : instance : designRuntimeLayerDisplayName(node);
}

/** What a Layers row is: an instance of a component, one of an instance's
 * parts (hidden and restyled, never renamed), or any other layer. */
export function designLayerRowKind(frame: object, nodeId: string): "instance" | "part" | "slot" | "layer" {
  if (isDesignComponentSlotNodeId(nodeId)) return "slot";
  if (isDesignComponentPartNodeId(nodeId)) return "part";
  return designComponentInstanceMark(presentedInstances(frame), nodeId, () => undefined) ? "instance" : "layer";
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

/** What a frame shows when options did not apply, as its Controls section
 * and its canvas mark say it. */
export const DESIGN_OPTIONS_NOT_APPLIED_MESSAGES = Object.freeze({
  "last-good": "The frame shows its last good render.",
  defaults: "The frame shows the component's defaults.",
  nothing: "The frame shows nothing in its place.",
} satisfies Record<NonNullable<DesignFrameComponent["notApplied"]>, string>);

const optionsProblemByInstances = new WeakMap<DesignFrameInstances, string | null>();

/** Why a frame is not showing the options it was given, or null: its own
 * options (a main component frame) or an instance's it places. The engine
 * marks every host of a component whose options stop applying, so each of
 * those frames answers here before anything is selected. */
export function designFrameOptionsProblem(frame: { component?: DesignFrameComponent; instances?: DesignFrameInstances }): string | null {
  const own = frame.component?.notApplied;
  if (own) return `These controls could not be applied. ${DESIGN_OPTIONS_NOT_APPLIED_MESSAGES[own]}`;
  const instances = frame.instances;
  if (!instances) return null;
  const known = optionsProblemByInstances.get(instances);
  if (known !== undefined) return known;
  const names = [...new Set(Object.values(instances.hosts).filter((host) => host.failed).map((host) => `zd-${host.component}`))];
  // As the instance's Controls section reads it: a failed host with nothing
  // named shows the defaults.
  const problem = names.length
    ? `The controls of ${names.join(", ")} could not be applied. ${DESIGN_OPTIONS_NOT_APPLIED_MESSAGES[instances.notApplied ?? "defaults"]}`
    : null;
  optionsProblemByInstances.set(instances, problem);
  return problem;
}
