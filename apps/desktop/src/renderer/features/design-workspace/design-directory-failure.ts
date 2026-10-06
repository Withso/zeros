import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { toast } from "../../shared/ui/primitives/elements";
import { errorMessage } from "./design-workspace-error";

const verbs = { create: "create", open: "open", register: "register", rename: "rename", unregister: "unregister", inspect: "inspect" } as const;
export type DesignDirectoryAction = keyof typeof verbs;

/** Cloud command errors can contain argv and VM paths. Keep action feedback
 * short and diagnostics closed; preserve the existing Local toast contract. */
export function reportDesignDirectoryFailure(workspaceId: string, action: DesignDirectoryAction, cause: unknown): void {
  if (!isCloudWorkspace(workspaceId)) {
    toast.error(`Couldn't ${verbs[action]} Design directory`, { description: errorMessage(cause) });
    return;
  }
  const message = cause instanceof Error ? cause.message : "";
  const reason = message.startsWith("Command failed:") ? "git_command_failed"
    : message.startsWith("Request timeout:") ? "request_timeout" : "operation_rejected";
  console.warn("[Design] Cloud directory action failed", { action, reason });
  toast.error(`Couldn't ${verbs[action]} the Design directory. Try again.`);
}
