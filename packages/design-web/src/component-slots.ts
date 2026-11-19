// PURPOSE: An instance's slots: frames in the main component (data-zd-slot="<name>")
// that each instance fills with its own layers, which carry slot="<name>".
// A bare <slot> is the default slot: it takes the instance's other layers.
// On the canvas a slot is a drop target named by a slot id (its host and its
// name, empty for the default slot); a move or insertion into it lands in the
// host with the layer's slot attribute set.

import { componentOptionNameProblem } from "@zeros/design-core/components";
import { DESIGN_COMPONENT_RECORD_LIMITS, DESIGN_FRAME_INSTANCE_LIMITS } from "@zeros/protocol/design-catalog";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

/** Mirrors DESIGN_COMPONENT_SLOT_PREFIX in the protocol's design runtime. */
const SLOT_NODE_PREFIX = "::zeros-slot:";
export const DESIGN_SLOT_ATTRIBUTE = "data-zd-slot";

/** The host and slot name a slot id names (an empty name is the default
 * slot); null for any other id. */
export function designSlotOfNodeId(nodeId: string): { host: string; name: string } | null {
  if (!nodeId.startsWith(SLOT_NODE_PREFIX)) return null;
  const rest = nodeId.slice(SLOT_NODE_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || rest.indexOf(":", split + 1) >= 0) return null;
  try {
    const host = decodeURIComponent(rest.slice(0, split));
    const name = decodeURIComponent(rest.slice(split + 1));
    return name === "" || isDesignSlotName(name) ? { host, name } : null;
  } catch {
    return null;
  }
}

/** A name a slot can take: an option name. */
export const isDesignSlotName = (name: string) => componentOptionNameProblem(name) === null;

/** The slots these nodes mark, in order, each once. Slots inside a nested
 * instance are that instance's. */
export function designSlotsOfNodes(nodes: readonly DefaultTreeAdapterTypes.ChildNode[]): string[] {
  const names: string[] = [];
  const visit = (children: readonly DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of children) {
      if (!("tagName" in node)) continue;
      const name = node.attrs.find((attribute) => attribute.name === DESIGN_SLOT_ATTRIBUTE)?.value;
      if (name && isDesignSlotName(name) && !names.includes(name)) names.push(name);
      if (!node.tagName.startsWith("zd-")) visit(node.tagName === "template" ? (node as DefaultTreeAdapterTypes.Template).content.childNodes : node.childNodes);
    }
  };
  visit(nodes);
  return names;
}

/** The slots a component's body marks, in order, each once. */
export function designComponentBodySlots(body: string): string[] {
  return designComponentBodySlotShape(body).names;
}

const shapes = new Map<string, { names: string[]; fallback: boolean }>();

/** A body's named slots, and whether it has a default slot: a bare <slot>
 * (one with data-zd-attr is an attribute's text, not a slot for layers). */
export function designComponentBodySlotShape(body: string): { names: string[]; fallback: boolean } {
  if (!body.includes(DESIGN_SLOT_ATTRIBUTE) && !/<slot\b/i.test(body)) return { names: [], fallback: false };
  const known = shapes.get(body);
  if (known) return known;
  const nodes = parseFragment(body).childNodes;
  let fallback = false;
  const visit = (children: readonly DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of children) {
      if (fallback || !("tagName" in node)) continue;
      if (node.tagName === "slot" && !node.attrs.some((attribute) => attribute.name === "data-zd-attr")) fallback = true;
      else visit(node.childNodes);
    }
  };
  visit(nodes);
  const shape = { names: designSlotsOfNodes(nodes), fallback };
  if (shapes.size >= 64) shapes.clear();
  shapes.set(body, shape);
  return shape;
}

/** The frame's own layers (by data-oid) an instance places in each of its
 * component's slots: its top-level children, by their slot attribute, the
 * rest in the default slot when there is one. A slot past the limits is left
 * out rather than reported in part. */
export function designInstanceSlottedLayers(
  instance: DefaultTreeAdapterTypes.Element,
  shape: { names: readonly string[]; fallback: boolean },
): Record<string, string[]> | undefined {
  if (!shape.names.length && !shape.fallback) return undefined;
  const slotted = new Map<string, string[] | null>();
  for (const child of instance.childNodes) {
    if (!("tagName" in child)) continue;
    const oid = child.attrs.find((attribute) => attribute.name === "data-oid")?.value;
    if (!oid) continue;
    const named = child.attrs.find((attribute) => attribute.name === "slot")?.value;
    const slot = named && shape.names.includes(named) ? named : shape.fallback ? "" : null;
    if (slot === null) continue;
    const layers = slotted.has(slot) ? slotted.get(slot)! : [];
    if (layers === null) continue;
    if (oid.length > DESIGN_COMPONENT_RECORD_LIMITS.layerId || layers.length >= DESIGN_FRAME_INSTANCE_LIMITS.slotted) slotted.set(slot, null);
    else slotted.set(slot, [...layers, oid]);
  }
  const reported = [...slotted].filter((entry): entry is [string, string[]] => entry[1] !== null).slice(0, DESIGN_FRAME_INSTANCE_LIMITS.slots);
  return reported.length ? Object.fromEntries(reported) : undefined;
}

/** A declaration's elements with a slot option for each of these slots (as
 * its body marks them) that no option declares, so a frame marked as a slot
 * is one. */
export function withDesignSlotOptions<T extends { tag: string; attributes: readonly { name: string; value: string }[] }>(
  elements: readonly T[],
  slots: readonly string[],
  make: (name: string) => T,
): T[] {
  if (!slots.length) return [...elements];
  const declared = new Set(elements.filter((element) => element.tag === "zd-option")
    .map((element) => element.attributes.find((attribute) => attribute.name === "name")?.value));
  return [...elements, ...slots.filter((name) => !declared.has(name)).map(make)];
}

export function designSlotOptionElement(name: string): { tag: string; attributes: { name: string; value: string }[] } {
  return { tag: "zd-option", attributes: [{ name: "name", value: name }, { name: "type", value: "slot" }] };
}

/** A fragment with slot="<name>" on each of its top-level elements (none for
 * the default slot, which takes layers without one). */
export function designSlottedFragment(html: string, name: string): string {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of fragment.childNodes) {
    if (!("tagName" in node) || !node.sourceCodeLocation?.startTag) continue;
    const existing = node.sourceCodeLocation.attrs?.slot;
    const text = name ? ` slot="${name}"` : "";
    if (existing) edits.push({ start: existing.startOffset - 1, end: existing.endOffset, text });
    else if (text) {
      const tag = node.sourceCodeLocation.startTag;
      const at = tag.startOffset + 1 + node.tagName.length;
      edits.push({ start: at, end: at, text });
    }
  }
  let result = html;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return result;
}
