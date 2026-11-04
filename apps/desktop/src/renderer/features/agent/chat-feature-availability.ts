import { isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import type { SessionMode } from "../../platform/bridge/agent-events";

/** Older cloud workers have no mode vocabulary; Local keeps its pre-bind menu. */
export function permissionModesAvailable(folder: string | null | undefined, modes: readonly SessionMode[] = []): boolean {
  return !isCloudWorkspace(folder) || modes.some(mode => mode.id === "plan" || mode.id === "read-only") &&
    modes.some(mode => mode.id === "bypass" || mode.id === "full-access" || mode.id === "agent");
}

/** Cloud footers use mirrored summaries without waking the VM. Explicit
 * Review and Reset actions reach the worker separately. */
export function turnCheckpointsAvailable(chatId: string): boolean {
  return !parseCloudScopedId(chatId);
}
