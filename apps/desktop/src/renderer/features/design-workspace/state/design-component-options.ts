// PURPOSE: A component frame's options in the Style panel. The declaration
// arrives with the frame's prepared record (exact to its generation) and is
// read once per record. A value that reaches the frame only through CSS is
// previewed by setting its custom properties in the frame, at most once per
// animation frame and never through the engine; every commit writes one
// option's default in one transaction, so it is one undo step. Local only:
// cloud workspaces have no Design surface.

import {
  componentOptionCss,
  readComponentDeclaration,
  type ComponentDeclaration,
  type ComponentEasing,
  type ComponentOptionValue,
} from "@zeros/design-core/component-options";
import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";

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

/** Write one option's default: one transaction, one undo step. */
export function commitDesignComponentOption(
  workspaceId: string,
  frame: { file: string; sourceVersion: string },
  option: string,
  value: ComponentOptionValue,
) {
  return applyDesignEditCached(workspaceId, frame, {
    schemaVersion: 1,
    transactionId: `desktop:${crypto.randomUUID()}`,
    actor: { kind: "human", id: "desktop" },
    intent: `Set ${option}`,
    createdAt: Date.now(),
    operations: [{ operationId: "set-option", type: "component.set-option", file: frame.file, option, variant: null, value: attributeValue(value) }],
  });
}

let messages = 0;

/** One frame's preview while a row is adjusted. The latest values go to the
 * frame's document once per animation frame; another generation's document,
 * or one that cannot preview, is left alone. */
export function createDesignComponentPreview(workspaceId: string, frame: string, sourceVersion: string) {
  let latest: Record<string, string> | null = null;
  let scheduled: number | null = null;
  let shown = false;
  // Held from the first previewed value until it is cleared (a cancel, a
  // failed commit, or the commit's own generation replacing this one), as a
  // layout gesture holds it: no still of an unwritten value is captured.
  let resumeBackground: (() => void) | null = null;
  const runtime = () => {
    const connection = designFrameRuntime(workspaceId, frame);
    return connection && connection.sourceVersion === sourceVersion && connection.supports("previewComponentOptions") &&
      connection.previewComponentOptions ? connection : null;
  };
  const send = () => {
    scheduled = null;
    const properties = latest;
    const connection = runtime();
    if (!properties || !connection) return;
    messages += 1;
    shown = true;
    void connection.previewComponentOptions!(properties).catch(() => {});
  };
  return {
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
        void connection.previewComponentOptions!(null).catch(() => {});
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
