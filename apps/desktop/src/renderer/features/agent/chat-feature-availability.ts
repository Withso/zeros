import { isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";

/** Cloud v2 agents run with full permissions and accept no mode changes yet,
 * so Plan and the other native permission modes are Local-only for now. */
export function permissionModesAvailable(folder: string | null | undefined): boolean {
  return !isCloudWorkspace(folder);
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
