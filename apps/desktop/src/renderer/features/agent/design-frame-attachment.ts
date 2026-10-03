import { DESIGN_FRAME_AUTHORING_INSTRUCTION, type ComposerMode } from "@zeros/protocol/composer-mode";
import type { DesignContextReference } from "@zeros/protocol/design-context";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { captureDesignFrameContext, createDesignFrameContext, inspectDesignFrameContext } from "../../platform/bridge/design-context-bridge";
import { filesToAttachments, textFileAttachment } from "./composer-editor/attachment-io";

export interface DesignFrameAttachmentTarget {
  workspaceId: string;
  directoryId: string;
  frame: string;
  nodeId?: string;
  intent: ComposerMode;
  frameId?: string;
  revision?: string;
  includeScreenshot?: boolean;
}

function sameReference(left: DesignContextReference, right: DesignContextReference): boolean {
  return left.workspaceId === right.workspaceId && left.directoryId === right.directoryId &&
    left.frame === right.frame && left.frameId === right.frameId && left.nodeId === right.nodeId &&
    left.revision === right.revision;
}

/** Freeze the caller's target before I/O. Later canvas selections never enter
 * this request; the result uses normal attachment persistence and delivery. */
export async function prepareDesignFrameAttachments(
  bridge: RuntimeClient,
  input: DesignFrameAttachmentTarget,
) {
  const target = { ...input };
  const reference = await createDesignFrameContext(
    bridge, target.workspaceId, target.frame, target.nodeId, target.directoryId,
  );
  if (reference.workspaceId !== target.workspaceId || reference.directoryId !== target.directoryId ||
      reference.frame !== target.frame || reference.nodeId !== target.nodeId ||
      (target.frameId && reference.frameId !== target.frameId) ||
      (target.revision && reference.revision !== target.revision)) {
    throw new Error("The selected frame context changed. Select it again before sending.");
  }
  const inspection = await inspectDesignFrameContext(bridge, reference);
  if (inspection.status !== "ready") {
    throw new Error(inspection.status === "stale"
      ? "The selected frame changed while preparing its context. Send again to use its current revision."
      : "The selected frame was removed or its directory changed. Select it again or remove the frame context.");
  }
  if (!sameReference(inspection.reference, reference))
    throw new Error("The selected frame context changed while reading. Select it again before sending.");
  const text = [
    "# Selected Design frame",
    `Default intent for this message: ${target.intent === "design" ? "edit Design source" : "implement application code using this frame as reference"}. The user's explicit request takes precedence.`,
    `Source path relative to the workspace: ${JSON.stringify(`${inspection.directory}/${reference.frame}`)}`,
    `Frame identity: ${JSON.stringify(reference)}`,
    `Viewport: ${inspection.width} × ${inspection.height}.`,
    ...(inspection.previewUrl ? [`HTTP frame preview: ${inspection.previewUrl}`] : []),
    ...(inspection.verification ? [
      `Native verification command: ${inspection.verification.command} validate --url '${inspection.verification.url}' --frame '${reference.frame}'`,
      `For PNG capture use the same command with capture and --output '.context/frame.png'. Inspect the PNG using your normal image tool. Add --revision '${reference.revision}' to require this attached revision; omit it after editing to capture current source.`,
    ] : []),
    DESIGN_FRAME_AUTHORING_INSTRUCTION,
    "This is a source snapshot from the stated revision. Re-read the working files before editing; preserve later changes and stable IDs.",
    "",
    "## Authored source snapshot",
    "```html",
    inspection.source,
    "```",
  ].join("\n");
  const attachments = [textFileAttachment(`design-${reference.frame}.md`, text)];
  if (target.includeScreenshot) {
    const capture = await captureDesignFrameContext(bridge, reference);
    if (!sameReference(capture.reference, reference))
      throw new Error("The frame changed while capturing its image. Send again to use the current frame.");
    const bytes = Uint8Array.from(atob(capture.data), (char) => char.charCodeAt(0));
    attachments.push(...await filesToAttachments([new File([bytes], `design-${reference.frame}.png`, { type: "image/png" })], {
      agentName: undefined, agentSupportsImage: undefined, modelId: undefined,
    }));
  }
  return attachments;
}
