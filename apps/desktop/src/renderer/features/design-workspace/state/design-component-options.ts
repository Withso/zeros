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
} from "@zeros/design-core/component-options";
import {
  designComponentRecordLimitMessage,
  type DesignFrameComponent,
  type DesignFrameInstances,
} from "@zeros/protocol/design-catalog";
import { isDesignComponentVariantName } from "@zeros/protocol/design-path";
import { DESIGN_RUNTIME_INSTANCE_TARGET } from "@zeros/protocol/design-runtime";

import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { designBackgroundWork } from "./design-background-work";
import { applyDesignEditCached } from "./design-workspace-cache";

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
  const resettable = [...written.keys()].some((name) => name === COMPONENT_VARIANT_ATTRIBUTE || declaration.options.some((option) => option.name === name));
  return { variant, inherited, values, changed, resettable };
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
