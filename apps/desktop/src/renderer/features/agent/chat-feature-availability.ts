import { isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import type { SessionMode } from "../../platform/bridge/agent-events";

/** Older cloud workers have no mode vocabulary; Local keeps its pre-bind menu. */
export function permissionModesAvailable(folder: string | null | undefined, modes: readonly SessionMode[] = []): boolean {
  return !isCloudWorkspace(folder) || modes.some(mode => mode.id === "plan" || mode.id === "read-only") &&
    modes.some(mode => mode.id === "bypass" || mode.id === "full-access" || mode.id === "agent");
}

/** Reset/undo and native footer reads remain Local-only. Cloud footers use
 * mirrored summaries; explicit Review reads the worker's recorded diffs. */
export function turnCheckpointsAvailable(chatId: string): boolean {
  return !parseCloudScopedId(chatId);
}

/** Edit-and-resend rewinds the transcript (`messages.truncateFrom`), which the
 * cloud v2 worker does not serve yet. */
export function messageEditAvailable(folder: string | null | undefined): boolean {
  return !isCloudWorkspace(folder);
}
