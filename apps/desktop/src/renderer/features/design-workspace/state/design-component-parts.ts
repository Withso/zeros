// PURPOSE: An instance's inner parts can be selected and read, never written:
// what a component offers is in its Options, and the rest is changed on the
// main component. Every node write the canvas and the Style panel make goes
// through the workspace cache, which refuses one that names a part before
// anything is sent; the engine would find no such layer either.

import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";
import { designComponentPartOf } from "@zeros/protocol/design-runtime";

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
