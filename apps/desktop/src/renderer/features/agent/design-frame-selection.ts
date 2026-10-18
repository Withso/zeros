import { isDesignFrameFile } from "@zeros/protocol/design-path";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import type { DesignFrameAttachmentSelection } from "./design-frame-attachment";

export function hasDesignFrameAttachmentSelection(value: unknown): value is DesignFrameAttachmentSelection {
  const targets = Array.isArray(value) ? value : [value];
  if (!targets.length || targets.length > DESIGN_SELECTION_NODE_LIMIT) return false;
  const first = targets[0];
  return Array.from(targets).every(target => target && typeof target === "object" && !Array.isArray(target) &&
    typeof target.workspaceId === "string" && target.workspaceId.trim().length > 0 &&
    typeof target.directoryId === "string" && target.directoryId.trim().length > 0 &&
    isDesignFrameFile(target.frame) && (target.intent === "code" || target.intent === "design") &&
    (target.nodeId === undefined || typeof target.nodeId === "string" && target.nodeId.trim().length > 0 && target.nodeId.length <= 256 && !Array.from(target.nodeId as string).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) &&
    (target.includeScreenshot === undefined || typeof target.includeScreenshot === "boolean") &&
    (target.placement === undefined || target.placement === "local" || target.placement === "cloud") &&
    (target.organizationId === undefined || target.organizationId === null || typeof target.organizationId === "string") &&
    ["pageId", "frameId", "revision"].every(key => target[key] === undefined || typeof target[key] === "string" && target[key].trim().length > 0) &&
    ["selectionEvent", "ownerRevision"].every(key => target[key] === undefined || Number.isSafeInteger(target[key]) && target[key] >= 0) &&
    target.workspaceId === first.workspaceId && target.directoryId === first.directoryId &&
    target.pageId === first.pageId && target.organizationId === first.organizationId && target.placement === first.placement);
}
