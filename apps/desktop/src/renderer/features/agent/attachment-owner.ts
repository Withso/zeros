import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { cachedBridgeWorkspaceRootForCwd } from "../../platform/bridge/workspace-id-resolver";
import { folderIsWithinRoot } from "../../state/workspace-resolution";
import type { ComposerAttachment } from "./composer-attachments";

let localHost: string | undefined;
function localRuntime(): string {
  if (typeof localStorage === "undefined") return "local";
  if (!localHost) {
    try {
      localHost =
        localStorage.getItem("zeros:attachment-host:v1") ?? crypto.randomUUID();
      localStorage.setItem("zeros:attachment-host:v1", localHost);
    } catch {
      localHost = crypto.randomUUID();
    }
  }
  return `local:${localHost}`;
}

export function attachmentOwner(
  cwd: string,
): NonNullable<ComposerAttachment["owner"]> {
  const bridge = getActiveBridge();
  const identity = bridge?.executionIdentity;
  const root = bridge
    ? (cachedBridgeWorkspaceRootForCwd(bridge, cwd) ?? cwd)
    : cwd;
  return {
    runtime:
      identity?.kind === "cloud"
        ? `cloud:${identity.organizationId}:${identity.workspaceId}`
        : localRuntime(),
    cwd: root.replace(/\/+/g, "/").replace(/\/$/, "") || "/",
  };
}

export function sameAttachmentOwner(
  a: ComposerAttachment["owner"],
  b: ComposerAttachment["owner"],
): boolean {
  return (
    !!a &&
    !!b &&
    a.runtime === b.runtime &&
    folderIsWithinRoot(a.cwd, b.cwd) &&
    folderIsWithinRoot(b.cwd, a.cwd)
  );
}
