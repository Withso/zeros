import { DESIGN_TRANSACTION_MAX_OPERATIONS } from "@zeros/design-core";
// PURPOSE: A component frame's options in the Style panel. The declaration
// arrives with the frame's prepared record (exact to its generation) and is
// read once per record. A value that reaches the frame only through CSS is
// previewed by setting its custom properties in the frame, at most once per
// animation frame and never through the engine; every commit writes one
// option's default in one transaction, so it is one undo step. Local only:
// cloud workspaces have no Design surface.

import {
  COMPONENT_VARIANT_ATTRIBUTE,
  componentIgnoredAttributeMessage,
  componentInheritedValues,
  componentOptionCss,
  componentOptionValues,
  readComponentDeclaration,
  type ComponentDeclaration,
  type ComponentEasing,
  type ComponentOptionValue,
  type ComponentVariantState,
} from "@zeros/design-core/component-options";
import {
  designComponentRecordLimitMessage,
  type DesignFrameComponent,
  type DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { isDesignComponentVariantName } from "@zeros/protocol/design-path";
import { designComponentSlotNodeId, DESIGN_RUNTIME_INSTANCE_TARGET } from "@zeros/protocol/design-runtime";

import { designFrameRuntime, waitForDesignFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { designBackgroundWork } from "./design-background-work";
import { designPartOverrideAttribute } from "./design-component-parts";
import { applyDesignEditCached, designWorkspaceSnapshotCache } from "./design-workspace-cache";
import { preparedDesignSnapshot } from "./design-frame-view";
import { foldTransformOffset, hasLegacyRelocationCandidate } from "../design-layout-values";

export interface DesignFrameComponentView {
  declaration: ComponentDeclaration;
  reach: DesignFrameComponent["reach"];
  notApplied?: DesignFrameComponent["notApplied"];
}

const views = new WeakMap<DesignFrameComponent, DesignFrameComponentView>();

/** The frame's declaration as the Design core reads it, once per record. */
export function readDesignFrameComponent(component: DesignFrameComponent): DesignFrameComponentView {
  let view = views.get(component);
  if (!view) {
    const { declaration } = readComponentDeclaration(component.elements.map((element) => ({ ...element, offset: 0 })));
    view = { declaration, reach: component.reach, ...(component.notApplied ? { notApplied: component.notApplied } : {}) };
    views.set(component, view);
  }
  return view;
}

/** Why a component's Options cannot be listed: its declaration is past a
 * limit of the record, so the engine reported it without one. Null when the
 * declaration arrived. */
export function designComponentRecordProblem(
  component: DesignFrameComponent | DesignFrameInstances["components"][string],
  title: string,
): string | null {
  return component.exceeds ? designComponentRecordLimitMessage(title, component.exceeds) : null;
}

/** The custom properties these values set, in the strict forms the core
 * writes; derived values follow. */
export function designComponentPreviewProperties(
  declaration: ComponentDeclaration,
  values: ReadonlyMap<string, ComponentOptionValue>,
): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const declarationText of componentOptionCss(declaration, values).split(/;\s*/)) {
    const split = declarationText.indexOf(":");
    if (split > 0) properties[declarationText.slice(0, split).trim()] = declarationText.slice(split + 1).trim();
  }
  return properties;
}

const attributeValue = (value: ComponentOptionValue): string | number | boolean =>
  typeof value === "object" ? `${(value as ComponentEasing).curve} ${(value as ComponentEasing).duration}ms` : value;

/** An option value as an instance attribute's text. */
export const designComponentAttributeText = (value: ComponentOptionValue): string => String(attributeValue(value));

export const sameDesignComponentValue = (left: ComponentOptionValue | undefined, right: ComponentOptionValue | undefined) =>
  typeof left === "object" && typeof right === "object"
    ? left.curve === right.curve && left.duration === right.duration
    : left === right;

const edit = (intent: string, operations: Record<string, unknown>[]) => ({
  schemaVersion: 1 as const,
  transactionId: `desktop:${crypto.randomUUID()}`,
  actor: { kind: "human" as const, id: "desktop" },
  intent,
  createdAt: Date.now(),
  operations: operations as never,
});

/** Write one option's default, or the value of the variant the main shows:
 * one transaction, one undo step. */
export function commitDesignComponentOption(
  workspaceId: string,
  frame: { file: string; sourceVersion: string },
  option: string,
  value: ComponentOptionValue,
  variant: string | null = null,
) {
  return applyDesignEditCached(workspaceId, frame,
    edit(`Set ${option}`, [{ operationId: "set-option", type: "component.set-option", file: frame.file, option, variant, value: attributeValue(value) }]));
}

/** The variant name a typed one becomes, or why it cannot be one. */
export function designComponentVariantName(declaration: ComponentDeclaration, typed: string): { name: string } | { error: string } {
  const name = typed.trim().toLowerCase().replace(/\s+/g, "-");
  if (name === "default") return { error: "Default is the declared defaults; choose another name." };
  if (!isDesignComponentVariantName(name)) return { error: "Use up to 32 letters, digits and single spaces or hyphens, starting with a letter." };
  if (declaration.variants.some((variant) => variant.name === name)) return { error: `There is already a variant ${name}.` };
  return { name };
}

/** Save the values the main shows as a new variant: one added line that
 * names only what differs from the defaults. */
export function commitDesignComponentVariant(
  workspaceId: string,
  frame: { file: string; sourceVersion: string },
  declaration: ComponentDeclaration,
  name: string,
  shown: ReadonlyMap<string, ComponentOptionValue>,
) {
  const values: Record<string, string | number | boolean> = Object.fromEntries(
    declaration.options.flatMap((option) => {
      const value = shown.get(option.name);
      return value !== undefined && !sameDesignComponentValue(value, option.default) ? [[option.name, attributeValue(value)] as const] : [];
    }),
  );
  return applyDesignEditCached(workspaceId, frame,
    edit(`Save variant ${name}`, [{ operationId: "save-variant", type: "component.save-variant", file: frame.file, name, values }]));
}

/** Add one of the state variants (Hover, Pressed, Focus, Disabled): a line
 * that names its CSS state and sets no option. */
export function commitDesignComponentStateVariant(
  workspaceId: string,
  frame: { file: string; sourceVersion: string },
  preset: { name: string; state: ComponentVariantState; label: string },
) {
  return applyDesignEditCached(workspaceId, frame,
    edit(`Add ${preset.label} state`, [{ operationId: "save-state-variant", type: "component.save-variant", file: frame.file, name: preset.name, values: {}, state: preset.state }]));
}

/** An instance's options as its host's attributes give them: its values,
 * what it inherits (its variant's, else the defaults), which differ, and
 * whether anything is set that Reset would remove. */
export function designInstanceOptionState(declaration: ComponentDeclaration, attributes: Readonly<Record<string, string>>) {
  const written = new Map(Object.entries(attributes));
  const named = written.get(COMPONENT_VARIANT_ATTRIBUTE);
  const variant = named && declaration.variants.some((entry) => entry.name === named) ? named : null;
  const inherited = componentInheritedValues(declaration, variant);
  const { values } = componentOptionValues(declaration, written);
  const changed = new Set(declaration.options.filter((option) => !sameDesignComponentValue(values.get(option.name), inherited.get(option.name))).map((option) => option.name));
  const overridden = new Set(declaration.options.filter((option) => option.kind !== "slot" && written.has(option.name)).map((option) => option.name));
  return { variant, inherited, values, changed, overridden, resettable: overridden.size > 0 };
}

export function designInstanceHasSuppliedContent(slottedLayers: readonly string[], text: string | undefined): boolean {
  return slottedLayers.length > 0 || Boolean(text?.length);
}

/** Reset All is one transaction, one undo step, so it is offered only when one
 * transaction holds every reset: the legacy placement fold shares the style write. */
export function designInstanceResetAllFits(counts: { options: number; parts: number; style: boolean; slotted: number; text: boolean }): boolean {
  return counts.options + counts.parts + Number(counts.style) + counts.slotted + Number(counts.text) <= DESIGN_TRANSACTION_MAX_OPERATIONS;
}

type DesignInstanceResetKind = "style" | "all";
type DesignInstanceResetFrame = { file: string; sourceVersion: string; frameId?: string };

function resetError(nodeId: string): Error {
  return new Error(`The component instance ${nodeId} is no longer available in the current prepared frame.`);
}

async function prepareDesignInstanceReset(
  workspaceId: string,
  frame: DesignInstanceResetFrame,
  nodeId: string,
  kind: DesignInstanceResetKind,
  assertCurrent: () => void,
) {
  assertCurrent();
  const snapshot = preparedDesignSnapshot(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data);
  const currentFrame = snapshot?.frames.find((candidate) =>
    candidate.file === frame.file && (!frame.frameId || candidate.frameId === frame.frameId));
  if (!currentFrame) throw resetError(nodeId);
  const host = currentFrame.instances?.hosts[nodeId];
  const component = host && currentFrame.instances?.components[host.component];
  if (!host || !component) throw resetError(nodeId);
  const declaration = readDesignFrameComponent(component).declaration;
  const optionState = designInstanceOptionState(declaration, host.attributes);
  const parts = Object.keys(host.overrides ?? {});
  const properties = designInstanceVisualStyleProperties(host.style);
  const styleUpdates: Record<string, string | null> = Object.fromEntries(properties.map((property) => [property, null]));

  if (host.style && hasLegacyRelocationCandidate(host.style)) {
    const runtime = await waitForDesignFrameRuntime(workspaceId, currentFrame.file, 2_000, {
      sourceVersion: currentFrame.sourceVersion,
    });
    assertCurrent();
    if (!runtime || runtime.sourceVersion !== currentFrame.sourceVersion || designFrameRuntime(workspaceId, currentFrame.file) !== runtime)
      throw new Error(`The current runtime for ${currentFrame.file} is unavailable; placement was not reset.`);
    let details;
    try {
      details = await runtime.getNodeDetails(nodeId, undefined, { relocation: true });
    } catch {
      throw new Error(`Fresh runtime details for ${nodeId} are unavailable; placement was not reset.`);
    }
    assertCurrent();
    if (designFrameRuntime(workspaceId, currentFrame.file) !== runtime || details.oid !== nodeId || details.sourceVersion !== currentFrame.sourceVersion)
      throw new Error(`The current runtime details for ${nodeId} are stale; placement was not reset.`);
    const folded = foldTransformOffset(details);
    if (folded) {
      for (const property of ["left", "right", "top", "bottom"]) {
        const value = folded.styles[property];
        if (value !== undefined) styleUpdates[property] = value;
      }
    }
  }

  const operations: Record<string, unknown>[] = [];
  if (kind === "all") {
    for (const attribute of optionState.overridden) operations.push({ operationId: `reset-option-${operations.length}`, type: "node.set-attribute", nodeId, attribute, value: null });
  }
  for (const part of parts) operations.push({ operationId: `reset-part-${operations.length}`, type: "node.set-attribute", nodeId, attribute: designPartOverrideAttribute(part), value: null });
  if (Object.keys(styleUpdates).length) operations.push({ operationId: "reset-style", type: "node.set-styles", nodeId, styles: styleUpdates, scope: "inline", responsiveContext: "base", stateContext: "default" });
  if (kind === "all") {
    for (const layer of [...new Set(Object.values(host.slotted ?? {}).flat())]) operations.push({ operationId: `reset-slot-${operations.length}`, type: "node.delete", nodeId: layer });
    if (host.text?.length) operations.push({ operationId: "reset-text", type: "node.set-text", nodeId: defaultSlotTextTarget(nodeId, host.mixedText), text: "" });
  }
  if (!operations.length) return null;
  if (operations.length > DESIGN_TRANSACTION_MAX_OPERATIONS)
    throw new Error(`${nodeId} supplies too many layers to reset in one step; reset its slots one at a time.`);
  return edit(kind === "all" ? "Reset all overrides" : "Reset overrides", operations);
}

/** Set or remove (null) attributes of one instance's host: one transaction,
 * one undo step. */
export function commitDesignInstanceAttributes(
  workspaceId: string,
  frame: { file: string; sourceVersion: string },
  nodeId: string,
  attributes: Readonly<Record<string, string | null>>,
  intent: string,
) {
  return applyDesignEditCached(workspaceId, frame, edit(intent, Object.entries(attributes).map(([attribute, value], index) =>
    ({ operationId: `set-attribute-${index}`, type: "node.set-attribute", nodeId, attribute, value }))));
}

/** The properties a declaration list sets, as written: split at its
 * top-level semicolons, so a value's own (in quotes or parentheses) stays. */
export function designDeclaredProperties(list: string): string[] {
  const properties: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const take = (end: number) => {
    const text = list.slice(start, end);
    const colon = text.indexOf(":");
    const property = colon > 0 ? text.slice(0, colon).trim() : "";
    if (property) properties.push(property.startsWith("--") ? property : property.toLowerCase());
    start = end + 1;
  };
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) take(index);
  }
  take(list.length);
  return properties;
}

const INSTANCE_PLACEMENT_PROPERTIES = new Set([
  "bottom", "inset", "inset-block", "inset-block-end", "inset-block-start", "inset-inline",
  "inset-inline-end", "inset-inline-start", "left", "position", "right", "top",
]);

/** CSS positioning belongs to the canvas; visual sizing and transforms reset with Style. */
export function designInstanceVisualStyleProperties(style: string | undefined): string[] {
  return style ? designDeclaredProperties(style).filter((property) => !INSTANCE_PLACEMENT_PROPERTIES.has(property)) : [];
}

/** Reset an instance's overrides in one step: each part's zd-style-<part>,
 * and the style the instance sets on its root (its host's own style). */
export function commitDesignInstanceOverridesReset(
  workspaceId: string,
  frame: DesignInstanceResetFrame,
  nodeId: string,
) {
  return applyDesignEditCached(workspaceId, frame,
    ({ assertCurrent }) => prepareDesignInstanceReset(workspaceId, frame, nodeId, "style", assertCurrent));
}

/** Reset local component values, styles and supplied slots without changing
 * the selected variant or the instance's canvas placement. */
export function commitDesignInstanceAllOverridesReset(
  workspaceId: string,
  frame: DesignInstanceResetFrame,
  nodeId: string,
) {
  return applyDesignEditCached(workspaceId, frame,
    ({ assertCurrent }) => prepareDesignInstanceReset(workspaceId, frame, nodeId, "all", assertCurrent));
}

/** The direct text of a host's default slot. Text beside other children comes
 * only from an engine that negotiated slot text and is written through the
 * virtual default slot; text alone is the host's own text, which every engine
 * writes. The record decides, so a disconnected bridge cannot change it. */
function defaultSlotTextTarget(nodeId: string, mixedText: boolean | undefined): string {
  return mixedText ? designComponentSlotNodeId(nodeId, "") : nodeId;
}

/** Set the text a plain component's instance fills its default slot with:
 * its host's own text. */
export function commitDesignInstanceText(workspaceId: string, frame: { file: string; sourceVersion: string }, nodeId: string, text: string,
  record: { mixedText?: boolean } = {}) {
  return applyDesignEditCached(workspaceId, frame, edit("Set text", [{ operationId: "set-text", type: "node.set-text", nodeId: defaultSlotTextTarget(nodeId, record.mixedText), text }]));
}

/** Empty an instance's slot back to what its main puts there: delete the
 * frame's own layers it holds, in one step. */
export function commitDesignInstanceSlotReset(workspaceId: string, frame: { file: string; sourceVersion: string }, layers: readonly string[], label: string) {
  if (!layers.length) return Promise.resolve(undefined);
  return applyDesignEditCached(workspaceId, frame, edit(`Reset ${label}`, layers.map((nodeId, index) =>
    ({ operationId: `reset-slot-${index}`, type: "node.delete", nodeId }))));
}

let messages = 0;

/** One frame's preview while a row is adjusted. The latest values go to the
 * frame's document once per animation frame; another generation's document,
 * or one that cannot preview, is left alone. */
export function createDesignComponentPreview(workspaceId: string, frame: string, sourceVersion: string,
  /** An instance's host layer: its own values are previewed, not the frame's. */
  host?: string) {
  let latest: Record<string, string> | null = null;
  let scheduled: number | null = null;
  let shown = false;
  // Held from the first previewed value until it is cleared (a cancel, a
  // failed commit, or the commit's own generation replacing this one), as a
  // layout gesture holds it: no still of an unwritten value is captured.
  let resumeBackground: (() => void) | null = null;
  const method = host === undefined ? "previewComponentOptions" : "previewComponentInstanceOptions";
  const runtime = () => {
    if (host !== undefined && !DESIGN_RUNTIME_INSTANCE_TARGET.test(host)) return null;
    const connection = designFrameRuntime(workspaceId, frame);
    return connection && connection.sourceVersion === sourceVersion && connection.supports(method) &&
      connection[method] ? connection : null;
  };
  const post = (connection: NonNullable<ReturnType<typeof runtime>>, properties: Record<string, string> | null) =>
    host === undefined ? connection.previewComponentOptions!(properties) : connection.previewComponentInstanceOptions!(host, properties);
  const send = () => {
    scheduled = null;
    const properties = latest;
    const connection = runtime();
    if (!properties || !connection) return;
    messages += 1;
    shown = true;
    void post(connection, properties).catch(() => {});
  };
  return {
    /** Whether a value reaching only CSS can show before it is written. */
    supported: () => runtime() !== null,
    set(properties: Record<string, string>) {
      resumeBackground ??= designBackgroundWork.pause();
      latest = properties;
      if (scheduled === null) scheduled = requestAnimationFrame(send);
    },
    /** Take the preview back (a cancelled drag, or a commit that failed). A
     * commit's own generation replaces the document, and the preview with it. */
    clear() {
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      scheduled = null;
      latest = null;
      resumeBackground?.();
      resumeBackground = null;
      if (!shown) return;
      shown = false;
      const connection = runtime();
      if (connection) {
        messages += 1;
        void post(connection, null).catch(() => {});
      }
    },
  };
}

export function designComponentPreviewMessagesForTests(): number {
  return messages;
}

export function resetDesignComponentOptionsForTests(): void {
  messages = 0;
}

/** What an instance sets that its component ignores: one line per attribute
 * that names no option, as the engine's warning reads. */
export function designInstanceIgnoredAttributes(host: DesignFrameInstances["hosts"][string]): string[] {
  return Object.entries(host.ignored ?? {}).map(([name, value]) => componentIgnoredAttributeMessage(name, value));
}
